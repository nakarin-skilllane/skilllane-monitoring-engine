//! skilllane-monitoring ingest: HTTP ingest + one queue consumer → ClickHouse, the engine's ingest role
//! (apps/engine/src/main.ts + ingest/ingest.service.ts) as one Rust process. Configured by the same env
//! (config.rs). `ingest map <envelopes.jsonl> <logs.out> <spans.out>` writes the rows of a fixture instead
//! (for a diff against expected-*.jsonl).
//!
//! Start: HTTP listens at once; ClickHouse is waited for (`/ping` + table `logs`) and only then the consumer
//! starts, retried with backoff while the queue is unreachable. Every 30 s a stats line. SIGTERM / SIGINT:
//! stop accepting HTTP → stop the consumer and flush the writer → close → final stats line → exit 0.

use ingest::config::{Config, Transport};
use ingest::consumer::Consumer;
use ingest::http::{router, AppState};
use ingest::ingest::Ingest;
use ingest::mappers::{map_log, map_span, parse_envelope, Stream};
use ingest::stats::{self, Stats};
use ingest::writer::{ClickhouseConfig, Writer};
use ingest::{kafka, rabbitmq};
use std::io::{BufRead, BufWriter, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const STATS_EVERY: Duration = Duration::from_secs(30);
/// The stats line waits this long for the consumer's lag, then goes out without it.
const LAG_TIMEOUT: Duration = Duration::from_secs(2);
/// The engine's rule (ingest.service.ts startWithRetry): 2 s × attempt, at most 15 s.
const START_BACKOFF_STEP: Duration = Duration::from_secs(2);
const START_BACKOFF_MAX: Duration = Duration::from_secs(15);
const CONTEXT: &str = "Ingest";

fn map_fixture(input: &str, logs_out: &str, spans_out: &str) -> Result<(), String> {
    let file = std::fs::File::open(input).map_err(|e| e.to_string())?;
    let mut logs = BufWriter::new(std::fs::File::create(logs_out).map_err(|e| e.to_string())?);
    let mut spans = BufWriter::new(std::fs::File::create(spans_out).map_err(|e| e.to_string())?);
    let (mut n_logs, mut n_spans, mut bad) = (0usize, 0usize, 0usize);
    for line in std::io::BufReader::new(file).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let envelope = parse_envelope(value)?;
        for item in &envelope.items {
            match envelope.stream {
                Stream::Logs => match map_log(item, &envelope.resource, &envelope.sent_at) {
                    Ok(row) => {
                        serde_json::to_writer(&mut logs, &row).map_err(|e| e.to_string())?;
                        logs.write_all(b"\n").map_err(|e| e.to_string())?;
                        n_logs += 1;
                    }
                    Err(err) => {
                        bad += 1;
                        eprintln!("bad log item: {err}");
                    }
                },
                Stream::Spans => match map_span(item, &envelope.resource) {
                    Ok(row) => {
                        serde_json::to_writer(&mut spans, &row).map_err(|e| e.to_string())?;
                        spans.write_all(b"\n").map_err(|e| e.to_string())?;
                        n_spans += 1;
                    }
                    Err(err) => {
                        bad += 1;
                        eprintln!("bad span item: {err}");
                    }
                },
            }
        }
    }
    logs.flush().map_err(|e| e.to_string())?;
    spans.flush().map_err(|e| e.to_string())?;
    println!("log rows {n_logs} · span rows {n_spans} · bad items {bad}");
    Ok(())
}

/// The consumer for LOG_EXPORT (IngestService.createConsumer), None when this process consumes no queue.
fn create_consumer(config: &Config, ingest: &Ingest) -> Option<Arc<dyn Consumer>> {
    let mode = config.transport.name();
    let created = match config.transport {
        Transport::Kafka => kafka::new(config, ingest.clone()),
        Transport::Rabbitmq => rabbitmq::new(config, ingest.clone()),
        Transport::Bullmq => {
            // Decided 2026-11-05: bullmq jobs are taken by apps/bullmq-bridge (Node) and posted here over HTTP.
            stats::info(CONTEXT, "bullmq: jobs arrive through bullmq-bridge over HTTP");
            if !config.ingest_http {
                stats::warn(CONTEXT, "bullmq-bridge posts to HTTP ingest but ENGINE_INGEST_HTTP=false: nothing to ingest");
            }
            return None;
        }
        Transport::Http | Transport::Otlp | Transport::Stdout => {
            if config.ingest_http {
                stats::info(CONTEXT, &format!("No queue configured (LOG_EXPORT resolves to {mode}): HTTP ingest only"));
            } else {
                stats::warn(CONTEXT, &format!("LOG_EXPORT resolves to {mode} and ENGINE_INGEST_HTTP=false: nothing to ingest"));
            }
            return None;
        }
    };
    match created {
        Ok(consumer) => Some(Arc::from(consumer)),
        Err(err) => {
            stats::error(CONTEXT, &format!("Cannot consume {mode}: {err}"));
            None
        }
    }
}

/// Waits for ClickHouse, then starts the consumer; a failed start is cleaned up and retried with backoff
/// (1 s doubling to 30 s) until it starts or the process stops.
async fn start_consumer(writer: Writer, consumer: Option<Arc<dyn Consumer>>, stopping: CancellationToken) {
    tokio::select! {
        _ = stopping.cancelled() => return,
        _ = writer.wait_ready() => {}
    }
    stats::info("ClickHouse", "ClickHouse answers and table logs exists");
    let Some(consumer) = consumer else { return };
    for attempt in 1u32.. {
        let delay = (START_BACKOFF_STEP * attempt).min(START_BACKOFF_MAX);
        if stopping.is_cancelled() {
            return;
        }
        match consumer.start().await {
            Ok(()) => return,
            Err(err) => {
                stats::error(
                    CONTEXT,
                    &format!("{} consumer did not start (attempt {attempt}): {err}; retrying in {} ms", consumer.name(), delay.as_millis()),
                );
                consumer.stop().await;
                tokio::select! {
                    _ = stopping.cancelled() => return,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

async fn log_stats(stats: &Stats, writer: &Writer, consumer: Option<&Arc<dyn Consumer>>) {
    let lag = match consumer {
        Some(consumer) => tokio::time::timeout(LAG_TIMEOUT, consumer.lag()).await.ok().flatten(),
        None => None,
    };
    stats::info(CONTEXT, &stats.line(writer.buffered(), lag.as_deref()));
}

async fn signal() -> &'static str {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => "SIGINT",
            _ = term.recv() => "SIGTERM",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
        "SIGINT"
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("map") {
        if args.len() != 5 {
            eprintln!("usage: ingest map <envelopes.jsonl> <logs.out> <spans.out>");
            std::process::exit(2);
        }
        if let Err(err) = map_fixture(&args[2], &args[3], &args[4]) {
            eprintln!("{err}");
            std::process::exit(1);
        }
        return;
    }

    let config = Arc::new(Config::from_env());
    if let Some(invalid) = &config.transport_invalid {
        stats::warn(CONTEXT, &format!("LOG_EXPORT={invalid} is not a mode; using {}", config.transport.name()));
    }
    let stats = Arc::new(Stats::default());
    let writer = Writer::with_inflight(ClickhouseConfig::from(&config), config.flush_rows, config.flush_ms, config.insert_inflight, stats.clone());
    let ingest = Ingest { writer: writer.clone(), stats: stats.clone() };
    let consumer = create_consumer(&config, &ingest);

    // HTTP first: health answers while ClickHouse and the queue are still being waited for.
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await {
        Ok(listener) => listener,
        Err(err) => {
            stats::error(CONTEXT, &format!("skilllane-monitoring ingest failed to start: cannot listen on :{}: {err}", config.port));
            std::process::exit(1);
        }
    };
    let stopping = CancellationToken::new();
    let state = AppState::new(config.clone(), ingest.clone(), consumer.clone());
    let server = {
        let stopping = stopping.clone();
        tokio::spawn(async move {
            axum::serve(listener, router(state)).with_graceful_shutdown(async move { stopping.cancelled().await }).await
        })
    };
    stats::info(
        "Engine",
        &format!(
            "skilllane-monitoring ingest listening on :{} role=ingest transport={}{}{}",
            config.port,
            config.transport.name(),
            config.transport_invalid.as_ref().map(|v| format!(" (ignored LOG_EXPORT={v})")).unwrap_or_default(),
            if !config.ingest_http {
                " http-ingest=off"
            } else if config.ingest_tokens.is_empty() {
                " http-ingest=on"
            } else {
                " http-ingest=on (token)"
            },
        ),
    );
    if config.ingest_http && config.ingest_tokens.is_empty() {
        stats::warn("HttpIngest", "HTTP ingest takes no token: keep the ingest port on the internal network (or set ENGINE_INGEST_TOKEN)");
    }

    let starting = tokio::spawn(start_consumer(writer.clone(), consumer.clone(), stopping.clone()));
    let stats_task = {
        let (stats, writer, consumer, stopping) = (stats.clone(), writer.clone(), consumer.clone(), stopping.clone());
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(STATS_EVERY);
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = stopping.cancelled() => return,
                    _ = interval.tick() => log_stats(&stats, &writer, consumer.as_ref()).await,
                }
            }
        })
    };

    let signal = signal().await;
    stats::info(CONTEXT, &format!("Stopping ingest ({signal})"));
    stopping.cancel();
    let _ = starting.await;
    let _ = stats_task.await;
    // Rows of the messages still in progress go out now, so their ack / commit can happen.
    match &consumer {
        Some(consumer) => {
            tokio::join!(consumer.stop(), writer.flush_all());
        }
        None => writer.flush_all().await,
    }
    writer.close().await;
    if tokio::time::timeout(Duration::from_secs(10), server).await.is_err() {
        stats::warn(CONTEXT, "HTTP connections still open after 10 s; closing anyway");
    }
    stats::info(CONTEXT, &stats.line(writer.buffered(), None));
    stats::info(CONTEXT, "Ingest stopped");
    std::process::exit(0);
}
