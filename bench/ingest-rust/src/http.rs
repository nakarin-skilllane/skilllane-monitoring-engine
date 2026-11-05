//! POST /api/ingest/{stream} (apps/engine http-ingest.controller.ts): 202 once the rows are in
//! ClickHouse; 503 + Retry-After: 2 while the writer is full, too many requests are in flight
//! or ClickHouse fails; 400 for what can never be written; 413 over 2,000,000 bytes.
//! GET /api/health → {"ok":true}.

use crate::ingest::{gunzip, Ingest};
use crate::mappers::Stream;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub const MAX_BODY_BYTES: usize = 2_000_000;
const RETRY_AFTER_S: &str = "2";

#[derive(Clone)]
pub struct AppState {
    pub ingest: Ingest,
    pub inflight: Arc<AtomicUsize>,
    pub max_inflight: usize,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { ([(header::CONTENT_TYPE, "application/json")], "{\"ok\":true}") }))
        .route("/api/ingest/{stream}", post(ingest))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

fn json(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body).into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "statusCode": status.as_u16(), "message": message }).to_string();
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

async fn ingest(State(state): State<AppState>, Path(stream): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(stream) = Stream::parse(&stream) else {
        return error(StatusCode::BAD_REQUEST, &format!("unknown stream {stream}"));
    };
    if state.inflight.load(Ordering::Acquire) >= state.max_inflight || state.ingest.writer.saturated(stream) {
        return busy("ingest is busy, retry later");
    }
    let gzipped = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().eq_ignore_ascii_case("gzip")));
    let raw: Vec<u8> = if gzipped {
        match gunzip(&body, MAX_BODY_BYTES) {
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
