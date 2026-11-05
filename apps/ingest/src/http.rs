//! The HTTP side of the process, the engine's two public endpoints:
//!
//! POST /api/ingest/{stream} (apps/engine http-ingest.controller.ts): 404 when ENGINE_INGEST_HTTP=false;
//! 401 without a valid bearer token when ENGINE_INGEST_TOKEN is set (SHA-256 digests compared in constant
//! time, one warning a minute at most, the token never logged); 400 for an unknown stream, a body that is
//! not a v1 envelope or a stream that does not match the path; 413 when the (gunzipped) body is over
//! ENGINE_INGEST_MAX_BYTES; 503 + Retry-After: 2 when ENGINE_INGEST_MAX_INFLIGHT requests are in flight,
//! the writer is at its high-water mark or the insert failed; 202 {"items": n} once the rows are in
//! ClickHouse.
//!
//! GET /api/health (apps/engine health.controller.ts): { ok, clickhouse, role: "ingest", transport, pending }
//! within 1 s even while the broker hangs (ping cut at 800 ms, pending at 700 ms → null); concurrent
//! health calls share one broker read.

use crate::config::Config;
use crate::consumer::Consumer;
use crate::ingest::{gunzip, Ingest};
use crate::mappers::Stream;
use crate::stats;
use axum::body::{to_bytes, Body};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures::future::{BoxFuture, FutureExt, Shared};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::{Choice, ConstantTimeEq};

const RETRY_AFTER_S: &str = "2";
const PING_TIMEOUT: Duration = Duration::from_millis(800);
const PENDING_TIMEOUT: Duration = Duration::from_millis(700);
const AUTH_LOG_EVERY: Duration = Duration::from_secs(60);

type PendingFuture = Shared<BoxFuture<'static, Option<u64>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub ingest: Ingest,
    pub consumer: Option<Arc<dyn Consumer>>,
    inflight: Arc<AtomicUsize>,
    tokens: Arc<Vec<[u8; 32]>>,
    last_auth_log: Arc<Mutex<Option<Instant>>>,
    /// The broker read in progress, shared by concurrent health calls.
    pending_call: Arc<Mutex<Option<PendingFuture>>>,
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl AppState {
    pub fn new(config: Arc<Config>, ingest: Ingest, consumer: Option<Arc<dyn Consumer>>) -> AppState {
        let tokens = config.ingest_tokens.iter().map(|t| digest(t)).collect();
        AppState {
            config,
            ingest,
            consumer,
            inflight: Arc::new(AtomicUsize::new(0)),
            tokens: Arc::new(tokens),
            last_auth_log: Arc::new(Mutex::new(None)),
            pending_call: Arc::new(Mutex::new(None)),
        }
    }

    /// Requests being written right now.
    pub fn inflight(&self) -> usize {
        self.inflight.load(Ordering::Acquire)
    }

    /// Bearer token against ENGINE_INGEST_TOKEN, in constant time; the token itself is never logged.
    fn authorize(&self, authorization: Option<&str>) -> Result<(), Response> {
        let given = bearer(authorization.unwrap_or("")).map(digest);
        if let Some(given) = &given {
            let matched = self.tokens.iter().fold(Choice::from(0u8), |acc, token| acc | token.ct_eq(given));
            if bool::from(matched) {
                return Ok(());
            }
        }
        let log_it = {
            let mut last = self.last_auth_log.lock().unwrap();
            let due = last.map_or(true, |t| t.elapsed() > AUTH_LOG_EVERY);
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        if log_it {
            stats::warn(
                "HttpIngest",
                &format!("Rejected ingest without a valid token ({})", if given.is_some() { "wrong token" } else { "no bearer token" }),
            );
        }
        Err(error(StatusCode::UNAUTHORIZED, "invalid ingest token"))
    }

    /// Messages not yet in ClickHouse: the consumer's backlog plus the rows buffered in the writer; None without
    /// a consumer or when the queue cannot be read. One broker read at a time: concurrent calls share it, and
    /// a driver task runs it to the end even when every caller was cut by its timeout.
    pub fn pending(&self) -> PendingFuture {
        let mut slot = self.pending_call.lock().unwrap();
        if let Some(call) = slot.as_ref() {
            return call.clone();
        }
        let consumer = self.consumer.clone();
        let writer = self.ingest.writer.clone();
        let call: PendingFuture = async move {
            let queued = consumer?.pending().await?;
            let buffered = writer.buffered();
            Some(queued + buffered[0] as u64 + buffered[1] as u64)
        }
        .boxed()
        .shared();
        *slot = Some(call.clone());
        let driven = call.clone();
        let slot_ref = self.pending_call.clone();
        tokio::spawn(async move {
            driven.clone().await;
            let mut slot = slot_ref.lock().unwrap();
            if slot.as_ref().is_some_and(|current| current.ptr_eq(&driven)) {
                *slot = None;
            }
        });
        call
    }
}

/// The token of `Bearer <token>` (the engine's `/^Bearer\s+(.+)$/i` on the trimmed header).
fn bearer(authorization: &str) -> Option<&str> {
    let value = authorization.trim();
    let (scheme, rest) = value.split_at_checked(6)?;
    if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let token = rest.trim_start();
    (!token.is_empty()).then_some(token)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/ingest/{stream}", post(ingest))
        .with_state(state)
}

fn json(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body).into_response()
}

/// Nest's exception body: { statusCode, message, error }.
fn error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({
        "statusCode": status.as_u16(),
        "message": message,
        "error": status.canonical_reason().unwrap_or("Error"),
    })
    .to_string();
    json(status, body)
}

fn busy(message: &str) -> Response {
    let mut response = error(StatusCode::SERVICE_UNAVAILABLE, message);
    response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static(RETRY_AFTER_S));
    response
}

struct InflightGuard(Arc<AtomicUsize>);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn ingest(State(state): State<AppState>, Path(stream): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let config = &state.config;
    // The body parser runs first in the engine too: the limit applies before gzip is undone and after.
    let Ok(body) = to_bytes(body, config.ingest_max_bytes).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "request entity too large");
    };
    if !config.ingest_http {
        return error(StatusCode::NOT_FOUND, "HTTP ingest is off (ENGINE_INGEST_HTTP=false)");
    }
    if !state.tokens.is_empty() {
        if let Err(response) = state.authorize(headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())) {
            return response;
        }
    }
    let Some(stream) = Stream::parse(&stream) else {
        return error(StatusCode::BAD_REQUEST, &format!("unknown stream {stream}"));
    };
    if state.inflight() >= config.ingest_max_inflight || state.ingest.writer.saturated(stream) {
        return busy("ingest is busy, retry later");
    }
    let gzipped = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().eq_ignore_ascii_case("gzip")));
    let raw: Vec<u8> = if gzipped {
        match gunzip(&body, config.ingest_max_bytes) {
            Ok(bytes) => bytes,
            Err(e) if e == "too large" => return error(StatusCode::PAYLOAD_TOO_LARGE, "request entity too large"),
            Err(e) => return error(StatusCode::BAD_REQUEST, &e),
        }
    } else {
        body.to_vec()
    };
    let envelope = match state.ingest.parse(&raw, "http") {
        Ok(envelope) => envelope,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    if envelope.stream != stream {
        return error(
            StatusCode::BAD_REQUEST,
            &format!("envelope stream {} posted to /{}", envelope.stream.table(), stream.table()),
        );
    }
    state.inflight.fetch_add(1, Ordering::AcqRel);
    let _guard = InflightGuard(state.inflight.clone());
    let items = envelope.items.len();
    match state.ingest.write(std::slice::from_ref(&envelope)).await {
        Ok(()) => json(StatusCode::ACCEPTED, format!("{{\"items\":{items}}}")),
        Err(err) => busy(&format!("not written: {err}")),
    }
}

/// `future`, or `fallback` after `limit`.
async fn within<T>(future: impl std::future::Future<Output = T>, limit: Duration, fallback: T) -> T {
    tokio::time::timeout(limit, future).await.unwrap_or(fallback)
}

async fn health(State(state): State<AppState>) -> Response {
    let (clickhouse, pending) =
        tokio::join!(within(state.ingest.writer.ping(), PING_TIMEOUT, false), within(state.pending(), PENDING_TIMEOUT, None));
    let body = serde_json::json!({
        "ok": clickhouse,
        "clickhouse": clickhouse,
        "role": "ingest",
        "transport": state.config.transport.name(),
        "pending": pending,
    });
    json(StatusCode::OK, body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::Stats;
    use crate::writer::{ClickhouseConfig, Writer};
    use async_trait::async_trait;
    use axum::http::Request;
    use std::collections::HashMap;
    use tower::ServiceExt;

    const LOGS: &str = r#"{"v":1,"stream":"logs","sentAt":"2026-11-05T10:00:00.000Z","resource":{"service.name":"demo","deployment.environment":"test"},"items":[{"timestamp":"2026-11-05T10:00:00.000Z","severityText":"INFO","body":"hello"}]}"#;

    fn config(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(&|name| map.get(name).cloned())
    }

    /// A ClickHouse that accepts and never answers (inserts hang) when `hang`, else nothing listens (inserts fail).
    async fn clickhouse(hang: bool) -> String {
        if !hang {
            return "http://127.0.0.1:1".into();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        url
    }

    fn state(config: Config, clickhouse_url: String, consumer: Option<Arc<dyn Consumer>>) -> AppState {
        let config = Arc::new(config);
        let ch = ClickhouseConfig { url: clickhouse_url, user: "u".into(), password: "p".into(), database: "db".into() };
        let stats = Arc::new(Stats::default());
        let writer = Writer::with_inflight(ch, config.flush_rows, config.flush_ms, config.insert_inflight, stats.clone());
        AppState::new(config, Ingest { writer, stats }, consumer)
    }

    async fn post(state: &AppState, path: &str, body: &str, headers: &[(&str, &str)]) -> (StatusCode, HeaderMap, String) {
        let mut request = Request::post(path).header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        send(state, request.body(Body::from(body.to_string())).unwrap()).await
    }

    async fn send(state: &AppState, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let response = router(state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
    }

    fn message(body: &str) -> String {
        serde_json::from_str::<serde_json::Value>(body).unwrap()["message"].as_str().unwrap().to_string()
    }

    #[test]
    fn bearer_follows_the_engines_regex() {
        assert_eq!(bearer("Bearer abc"), Some("abc"));
        assert_eq!(bearer("  bEaReR   a b  "), Some("a b"));
        assert_eq!(bearer("Bearer"), None);
        assert_eq!(bearer("Bearer "), None);
        assert_eq!(bearer("Bearerabc"), None);
        assert_eq!(bearer("Basic abc"), None);
        assert_eq!(bearer(""), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn token_check_is_401_for_missing_or_wrong_and_passes_any_configured_token() {
        let s = state(config(&[("ENGINE_INGEST_TOKEN", "first,second")]), clickhouse(false).await, None);
        assert!(s.authorize(None).is_err());
        assert!(s.authorize(Some("Bearer nope")).is_err());
        assert!(s.authorize(Some("Basic first")).is_err());
        assert!(s.authorize(Some("Bearer first")).is_ok());
        assert!(s.authorize(Some("bearer second")).is_ok());

        let (status, _, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(message(&body), "invalid ingest token");
        let (status, _, _) = post(&s, "/api/ingest/logs", LOGS, &[("authorization", "Bearer wrong")]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // The right token gets past auth: the next failure is the (unreachable) ClickHouse, a 503.
        let (status, _, _) = post(&s, "/api/ingest/logs", LOGS, &[("authorization", "Bearer second")]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_token_configured_means_open() {
        let s = state(config(&[]), clickhouse(false).await, None);
        let (status, _, _) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_ne!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn off_is_404() {
        let s = state(config(&[("ENGINE_INGEST_HTTP", "false")]), clickhouse(false).await, None);
        let (status, _, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(message(&body), "HTTP ingest is off (ENGINE_INGEST_HTTP=false)");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["error"], "Not Found");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bad_requests_are_400() {
        let s = state(config(&[]), clickhouse(false).await, None);
        let (status, _, body) = post(&s, "/api/ingest/metrics", LOGS, &[]).await;
        assert_eq!((status, message(&body)), (StatusCode::BAD_REQUEST, "unknown stream metrics".into()));
        let (status, _, body) = post(&s, "/api/ingest/logs", r#"{"v":2}"#, &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message(&body).contains("envelope"), "{body}");
        let (status, _, body) = post(&s, "/api/ingest/logs", "not json", &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message(&body).starts_with("invalid JSON"), "{body}");
        let (status, _, body) = post(&s, "/api/ingest/spans", LOGS, &[]).await;
        assert_eq!((status, message(&body)), (StatusCode::BAD_REQUEST, "envelope stream logs posted to /spans".into()));
        let request = Request::post("/api/ingest/logs")
            .header("content-encoding", "gzip")
            .body(Body::from(b"\x1f\x8bnot gzip".to_vec()))
            .unwrap();
        let (status, _, body) = send(&s, request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message(&body).starts_with("gzip:"), "{body}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn too_large_is_413_raw_and_after_gunzip() {
        let s = state(config(&[("ENGINE_INGEST_MAX_BYTES", "100")]), clickhouse(false).await, None);
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(200));
        let (status, _, body) = post(&s, "/api/ingest/logs", &big, &[]).await;
        assert_eq!((status, message(&body)), (StatusCode::PAYLOAD_TOO_LARGE, "request entity too large".into()));
        // 200 bytes of one letter gzip to far under 100 bytes: only the inflated size is over the limit.
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, big.as_bytes()).unwrap();
        let gz = encoder.finish().unwrap();
        assert!(gz.len() < 100);
        let request = Request::post("/api/ingest/logs").header("content-encoding", "gzip").body(Body::from(gz)).unwrap();
        let (status, _, body) = send(&s, request).await;
        assert_eq!((status, message(&body)), (StatusCode::PAYLOAD_TOO_LARGE, "request entity too large".into()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn busy_is_503_with_retry_after() {
        // inflight ≥ max: max 0 is never reached by the env (positive only), so set it directly.
        let mut c = config(&[]);
        c.ingest_max_inflight = 0;
        let s = state(c, clickhouse(false).await, None);
        let (status, headers, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!((status, message(&body)), (StatusCode::SERVICE_UNAVAILABLE, "ingest is busy, retry later".into()));
        assert_eq!(headers.get("retry-after").unwrap(), "2");

        // The writer at its high-water mark (flush rows 1 → 4 rows; one insert hangs, four more wait).
        let s = state(config(&[("ENGINE_FLUSH_ROWS", "1")]), clickhouse(true).await, None);
        for _ in 0..5 {
            let w = s.ingest.writer.clone();
            tokio::spawn(async move { w.enqueue(Stream::Logs, vec!["{}".into()]).await });
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(s.ingest.writer.saturated(Stream::Logs));
        let (status, headers, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!((status, message(&body)), (StatusCode::SERVICE_UNAVAILABLE, "ingest is busy, retry later".into()));
        assert_eq!(headers.get("retry-after").unwrap(), "2");
        // Spans are not saturated: that path goes on to the insert.
        assert!(!s.ingest.writer.saturated(Stream::Spans));

        // The insert failed (nothing listens): 503 "not written: …", inflight back to 0.
        let s = state(config(&[("ENGINE_FLUSH_ROWS", "1")]), clickhouse(false).await, None);
        let (status, headers, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(message(&body).starts_with("not written: ClickHouse insert into logs failed: "), "{body}");
        assert_eq!(headers.get("retry-after").unwrap(), "2");
        assert_eq!(s.inflight(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn accepted_is_202_with_the_item_count() {
        // A ClickHouse that answers 200 to everything.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
                });
            }
        });
        let s = state(config(&[("ENGINE_FLUSH_ROWS", "1")]), url, None);
        let (status, _, body) = post(&s, "/api/ingest/logs", LOGS, &[]).await;
        assert_eq!((status, body), (StatusCode::ACCEPTED, "{\"items\":1}".into()));
        assert_eq!(s.ingest.stats.tables[0].rows.load(Ordering::Relaxed), 1);
    }

    struct SlowConsumer;

    #[async_trait]
    impl Consumer for SlowConsumer {
        fn name(&self) -> &'static str {
            "kafka"
        }
        async fn start(&self) -> Result<(), String> {
            Ok(())
        }
        async fn stop(&self) {}
        async fn lag(&self) -> Option<String> {
            None
        }
        async fn pending(&self) -> Option<u64> {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Some(1)
        }
    }

    struct QuickConsumer;

    #[async_trait]
    impl Consumer for QuickConsumer {
        fn name(&self) -> &'static str {
            "rabbitmq"
        }
        async fn start(&self) -> Result<(), String> {
            Ok(())
        }
        async fn stop(&self) {}
        async fn lag(&self) -> Option<String> {
            None
        }
        async fn pending(&self) -> Option<u64> {
            Some(7)
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn health_has_the_engines_shape_and_answers_within_a_second() {
        // No consumer, ClickHouse hanging: clickhouse false after 800 ms, pending null.
        let s = state(config(&[]), clickhouse(true).await, None);
        let started = Instant::now();
        let (status, _, body) = send(&s, Request::get("/api/health").body(Body::empty()).unwrap()).await;
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        assert_eq!(status, StatusCode::OK);
        let health: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(health, serde_json::json!({ "ok": false, "clickhouse": false, "role": "ingest", "transport": "stdout", "pending": null }));

        // A consumer whose broker hangs: pending null, still within 1 s; transport named from the config.
        let s = state(config(&[("LOG_EXPORT", "kafka")]), clickhouse(false).await, Some(Arc::new(SlowConsumer)));
        let started = Instant::now();
        let (_, _, body) = send(&s, Request::get("/api/health").body(Body::empty()).unwrap()).await;
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        let health: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(health["transport"], "kafka");
        assert_eq!(health["pending"], serde_json::Value::Null);

        // A consumer that answers: pending = queue + buffered rows.
        let s = state(config(&[("LOG_EXPORT", "rabbitmq")]), clickhouse(false).await, Some(Arc::new(QuickConsumer)));
        let (_, _, body) = send(&s, Request::get("/api/health").body(Body::empty()).unwrap()).await;
        let health: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(health["pending"], 7);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_health_calls_share_one_broker_read() {
        let s = state(config(&[("LOG_EXPORT", "kafka")]), clickhouse(false).await, Some(Arc::new(SlowConsumer)));
        let a = s.pending();
        let b = s.pending();
        assert!(a.ptr_eq(&b), "the second call joins the first");
    }
}
