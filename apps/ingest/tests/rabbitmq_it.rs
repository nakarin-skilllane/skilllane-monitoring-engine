//! RabbitMQ consumer against the dev compose broker (`docker compose up -d --wait rabbitmq` at the repo root).
//! Runs only with `RABBITMQ_IT=1`; `RABBITMQ_IT_URL` overrides the broker URL. ClickHouse is a stub HTTP
//! server here (every insert POST is recorded; one can be told to fail), so only the queue semantics are
//! under test: ack after insert, nack without requeue for a non-envelope, nack + requeue (and success on the
//! redelivery) when the insert failed, stop() cancels the consumers.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Router;
use ingest::config::Config;
use ingest::consumer::Consumer;
use ingest::ingest::{gunzip, Ingest};
use ingest::stats::Stats;
use ingest::writer::{ClickhouseConfig, Writer};
use lapin::options::{BasicPublishOptions, ExchangeDeleteOptions, QueueDeclareOptions, QueueDeleteOptions};
use lapin::types::FieldTable;
use lapin::uri::AMQPUri;
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_URL: &str = "amqp://skilllane_monitoring:skilllane_monitoring@localhost:5673/";

/// The stub ClickHouse: records every insert body (gunzipped JSONEachRow) and fails the next one on request.
#[derive(Default)]
struct Stub {
    posts: AtomicUsize,
    bodies: Mutex<Vec<String>>,
    fail_next: AtomicBool,
}

async fn insert(State(stub): State<Arc<Stub>>, body: Bytes) -> StatusCode {
    let rows = gunzip(&body, 64 << 20).expect("gzip body");
    stub.bodies.lock().unwrap().push(String::from_utf8(rows).expect("utf-8 rows"));
    stub.posts.fetch_add(1, Ordering::SeqCst);
    if stub.fail_next.swap(false, Ordering::SeqCst) {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}

async fn start_stub(stub: Arc<Stub>) -> String {
    let router = Router::new().fallback(insert).with_state(stub);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
    let addr = listener.local_addr().expect("stub addr");
    tokio::spawn(async move { axum::serve(listener, router).await.expect("stub serve") });
    format!("http://{addr}")
}

fn envelope(stream: &str, message: &str) -> Vec<u8> {
    let item = match stream {
        "logs" => serde_json::json!({
            "timestamp": "2026-11-05T00:00:00.000Z", "level": "info", "message": message, "labels": { "job": "rabbit-it" }
        }),
        _ => serde_json::json!({
            "traceId": "0af7651916cd43dd8448eb211c80319c", "spanId": "b7ad6b7169203331", "name": message,
            "kind": "internal", "startTimeUnixNano": "1793836800000000000", "endTimeUnixNano": "1793836800010000000",
            "status": { "code": "ok" }, "attributes": {}
        }),
    };
    serde_json::to_vec(&serde_json::json!({
        "v": 1, "stream": stream, "resource": { "service.name": "rabbit-it" },
        "sentAt": "2026-11-05T00:00:00.000Z", "items": [item]
    }))
    .unwrap()
}

fn gzipped(raw: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(raw).unwrap();
    encoder.finish().unwrap()
}

async fn publish(channel: &Channel, exchange: &str, routing_key: &str, body: &[u8]) {
    channel
        .basic_publish(exchange, routing_key, BasicPublishOptions::default(), body, BasicProperties::default())
        .await
        .expect("publish")
        .await
        .expect("publish confirm");
}

async fn ready(channel: &Channel, queue: &str) -> (u32, u32) {
    let q = channel
        .queue_declare(queue, QueueDeclareOptions { passive: true, ..Default::default() }, FieldTable::default())
        .await
        .expect("passive declare");
    (q.message_count(), q.consumer_count())
}

/// Polls `check` every 50 ms for up to `secs` seconds.
async fn wait_for<F: FnMut() -> bool>(what: &str, secs: u64, mut check: F) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_async<F, Fut>(what: &str, secs: u64, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !check().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn mgmt_url() -> String {
    std::env::var("RABBITMQ_IT_MGMT").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "http://localhost:15673".into())
}

fn mgmt_get(client: &reqwest::Client, uri: &AMQPUri, url: String) -> reqwest::RequestBuilder {
    client.get(url).basic_auth(&uri.authority.userinfo.username, Some(&uri.authority.userinfo.password))
}

/// The management API's name of the connection with `connection_name` (polled: the list lags a few seconds).
async fn find_connection(mgmt: &str, uri: &AMQPUri, connection_name: &str) -> Option<String> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let response = mgmt_get(&client, uri, format!("{mgmt}/api/connections")).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let list: serde_json::Value = serde_json::from_str(&response.text().await.ok()?).ok()?;
        let found = list.as_array()?.iter().find(|c| {
            c.pointer("/client_properties/connection_name").and_then(|n| n.as_str()) == Some(connection_name)
                && c.get("vhost").and_then(|v| v.as_str()) == Some(uri.vhost.as_str())
        });
        if let Some(name) = found.and_then(|c| c.get("name")).and_then(|n| n.as_str()) {
            return Some(name.to_string());
        }
        if Instant::now() > deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn close_connection(mgmt: &str, uri: &AMQPUri, name: &str) {
    let encoded: String = name
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    let client = reqwest::Client::new();
    let response = client
        .delete(format!("{mgmt}/api/connections/{encoded}"))
        .basic_auth(&uri.authority.userinfo.username, Some(&uri.authority.userinfo.password))
        .send()
        .await
        .expect("management delete");
    assert!(response.status().is_success(), "force close {name}: HTTP {}", response.status());
}

fn rows_of(stub: &Stub) -> Vec<serde_json::Value> {
    let bodies = stub.bodies.lock().unwrap();
    bodies
        .iter()
        .flat_map(|b| b.lines().map(|l| serde_json::from_str::<serde_json::Value>(l).expect("row json")).collect::<Vec<_>>())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rabbitmq_consumer_semantics() {
    if std::env::var("RABBITMQ_IT").ok().as_deref() != Some("1") {
        eprintln!("rabbitmq_it skipped (set RABBITMQ_IT=1 with the dev compose broker running)");
        return;
    }
    let url = std::env::var("RABBITMQ_IT_URL").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.into());
    let run = format!("rabbit-it-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis());
    let exchange = format!("{run}.telemetry");
    let logs_queue = format!("{run}.logs");
    let spans_queue = format!("{run}.spans");

    // Writer against the stub, flushing every row on its own so each envelope is one insert.
    let stub = Arc::new(Stub::default());
    let stub_url = start_stub(stub.clone()).await;
    let stats = Arc::new(Stats::default());
    let writer = Writer::new(
        ClickhouseConfig { url: stub_url, user: "u".into(), password: "p".into(), database: "db".into(), ..Default::default() },
        1,
        50,
        stats.clone(),
    );
    let ingest = Ingest { writer, stats: stats.clone() };

    let mut config = Config::from_env();
    config.rabbitmq_url = Some(url.clone());
    config.rabbitmq_exchange = exchange.clone();
    config.topic_logs = logs_queue.clone();
    config.topic_spans = spans_queue.clone();
    config.concurrency = 4;

    let mut without_url = config.clone();
    without_url.rabbitmq_url = None;
    assert!(ingest::rabbitmq::new(&without_url, ingest.clone()).is_err(), "new() must fail without LOG_RABBITMQ_URL");

    let consumer = ingest::rabbitmq::new(&config, ingest.clone()).expect("consumer");
    let consumer: &dyn Consumer = &*consumer;
    assert_eq!(consumer.name(), "rabbitmq");
    consumer.start().await.expect("start");

    // The test's own publisher connection (lapin reads a trailing `/` as the vhost ``; the consumer maps it to `/`).
    let mut uri: AMQPUri = url.parse().expect("broker url");
    if uri.vhost.is_empty() {
        uri.vhost = "/".into();
    }
    let connection = Connection::connect_uri(uri.clone(), ConnectionProperties::default()).await.expect("test connect");
    let channel = connection.create_channel().await.expect("test channel");
    assert_eq!(ready(&channel, &logs_queue).await, (0, 1), "logs queue asserted with one consumer");
    assert_eq!(ready(&channel, &spans_queue).await, (0, 1), "spans queue asserted with one consumer");
    assert_eq!(consumer.lag().await.as_deref(), Some(format!("{logs_queue}=0 ready {spans_queue}=0 ready").as_str()));
    assert_eq!(consumer.pending().await, Some(0));

    // 1. Envelopes (one gzipped) arrive, are inserted and acked.
    publish(&channel, &exchange, &logs_queue, &envelope("logs", "one")).await;
    publish(&channel, &exchange, &logs_queue, &gzipped(&envelope("logs", "two"))).await;
    publish(&channel, &exchange, &logs_queue, &envelope("logs", "three")).await;
    publish(&channel, &exchange, &spans_queue, &envelope("spans", "span-one")).await;
    wait_for("3 log rows + 1 span row inserted", 10, || {
        stats.tables[0].rows.load(Ordering::Relaxed) == 3 && stats.tables[1].rows.load(Ordering::Relaxed) == 1
    })
    .await;
    wait_for_async("every delivery acked", 5, move || async move { consumer.pending().await == Some(0) }).await;
    assert_eq!(ready(&channel, &logs_queue).await.0, 0, "logs queue empty after acks");
    assert_eq!(ready(&channel, &spans_queue).await.0, 0, "spans queue empty after acks");
    let rows = rows_of(&stub);
    let messages: Vec<&str> = rows.iter().filter_map(|r| r.get("message").and_then(|m| m.as_str())).collect();
    for expected in ["one", "two", "three"] {
        assert!(messages.contains(&expected), "row with message {expected:?} inserted (got {messages:?})");
    }
    assert!(rows.iter().any(|r| r.get("name").and_then(|n| n.as_str()) == Some("span-one")), "span row inserted");
    assert_eq!(stats.messages.load(Ordering::Relaxed), 4);
    assert_eq!(stats.bad_envelopes.load(Ordering::Relaxed), 0);

    // 2. A body that is not an envelope: counted, nacked without requeue (the queue is empty, nothing inserted).
    let posts_before = stub.posts.load(Ordering::SeqCst);
    publish(&channel, &exchange, &logs_queue, b"this is not json").await;
    publish(&channel, &exchange, &logs_queue, br#"{"v":2,"stream":"logs","items":[]}"#).await;
    wait_for("2 bad envelopes counted", 10, || stats.bad_envelopes.load(Ordering::Relaxed) == 2).await;
    wait_for_async("bad envelopes settled", 5, move || async move { consumer.pending().await == Some(0) }).await;
    assert_eq!(ready(&channel, &logs_queue).await.0, 0, "bad envelopes are not requeued");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stub.posts.load(Ordering::SeqCst), posts_before, "nothing inserted for a bad envelope");
    assert_eq!(stats.messages.load(Ordering::Relaxed), 6);

    // 3. The insert fails once: nack + requeue after ~1 s, the redelivery is inserted and acked.
    let posts_before = stub.posts.load(Ordering::SeqCst);
    stub.fail_next.store(true, Ordering::SeqCst);
    let started = Instant::now();
    publish(&channel, &exchange, &logs_queue, &envelope("logs", "retried")).await;
    wait_for("one insert failure", 10, || stats.tables[0].failures.load(Ordering::Relaxed) == 1).await;
    wait_for("the retried row inserted", 10, || stats.tables[0].rows.load(Ordering::Relaxed) == 4).await;
    assert!(started.elapsed() >= Duration::from_millis(900), "the requeue waits about a second: {:?}", started.elapsed());
    wait_for_async("the redelivery acked", 5, move || async move { consumer.pending().await == Some(0) }).await;
    assert_eq!(ready(&channel, &logs_queue).await.0, 0, "queue empty after the redelivery was acked");
    assert_eq!(stub.posts.load(Ordering::SeqCst), posts_before + 2, "the failed insert and the successful retry");
    let retried: Vec<_> = rows_of(&stub).into_iter().filter(|r| r.get("message").and_then(|m| m.as_str()) == Some("retried")).collect();
    assert_eq!(retried.len(), 2, "the same row was posted twice (failure, then the redelivery)");
    assert_eq!(retried[0], retried[1]);
    assert_eq!(stats.messages.load(Ordering::Relaxed), 8, "parse counts the redelivery as a message");

    // 4. The broker drops the consumer's connection: it reconnects (1 s backoff) and keeps consuming. Needs the
    //    management API (port 15673 of the dev compose); skipped when it is unreachable.
    let mut expected_messages = 8;
    if let Some(name) = find_connection(&mgmt_url(), &uri, "skilllane-monitoring-ingest").await {
        close_connection(&mgmt_url(), &uri, &name).await;
        wait_for_async("the consumer gone after the forced close", 15, || async {
            ready(&channel, &logs_queue).await.1 == 0
        })
        .await;
        wait_for_async("the consumer back after the reconnect", 20, || async { ready(&channel, &logs_queue).await.1 == 1 })
            .await;
        publish(&channel, &exchange, &logs_queue, &envelope("logs", "after-reconnect")).await;
        wait_for("the row after the reconnect inserted", 10, || stats.tables[0].rows.load(Ordering::Relaxed) == 5).await;
        wait_for_async("the delivery after the reconnect acked", 5, move || async move { consumer.pending().await == Some(0) })
            .await;
        assert_eq!(ready(&channel, &logs_queue).await, (0, 1));
        expected_messages += 1;
        assert_eq!(stats.messages.load(Ordering::Relaxed), expected_messages);
    } else {
        eprintln!("management API not reachable at {}: reconnect check skipped", mgmt_url());
    }

    // 5. stop() cancels the consumers and closes; the queues stay (durable).
    consumer.stop().await;
    assert_eq!(consumer.lag().await, None, "no channel after stop");
    assert_eq!(consumer.pending().await, None);
    assert_eq!(ready(&channel, &logs_queue).await, (0, 0), "logs consumer cancelled");
    assert_eq!(ready(&channel, &spans_queue).await, (0, 0), "spans consumer cancelled");

    for queue in [&logs_queue, &spans_queue] {
        channel.queue_delete(queue, QueueDeleteOptions::default()).await.expect("queue delete");
    }
    channel.exchange_delete(&exchange, ExchangeDeleteOptions::default()).await.expect("exchange delete");
    let _ = connection.close(200, "done").await;
}
