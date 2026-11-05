//! ingest-rust: HTTP + Kafka ingest → ClickHouse. `ingest-rust map <envelopes.jsonl> <logs.out>
//! <spans.out>` writes the rows of a fixture instead (for a diff against expected-*.jsonl).

use ingest_rust::http::{router, AppState};
use ingest_rust::ingest::Ingest;
use ingest_rust::kafka::{self, KafkaConfig};
use ingest_rust::mappers::{map_log, map_span, parse_envelope, Stream};
use ingest_rust::stats::Stats;
use ingest_rust::writer::{ClickhouseConfig, Writer};
use std::io::{BufRead, BufWriter, Write};
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Duration;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

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

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("map") {
        if args.len() != 5 {
            eprintln!("usage: ingest-rust map <envelopes.jsonl> <logs.out> <spans.out>");
            std::process::exit(2);
        }
        if let Err(err) = map_fixture(&args[2], &args[3], &args[4]) {
            eprintln!("{err}");
            std::process::exit(1);
        }
        return;
    }

    let port: u16 = env_num("PORT", 5100);
    let flush_ms: u64 = env_num("ENGINE_FLUSH_MS", 1000);
    let flush_rows: usize = env_num("ENGINE_FLUSH_ROWS", 5000);
    let max_inflight: usize = env_num("ENGINE_INGEST_MAX_INFLIGHT", 64);
    let clickhouse = ClickhouseConfig {
        url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
        user: env_or("CLICKHOUSE_USER", "default"),
        password: std::env::var("CLICKHOUSE_PASSWORD").unwrap_or_default(),
        database: env_or("CLICKHOUSE_DATABASE", "skilllane_monitoring"),
    };
    let brokers = env_or("LOG_KAFKA_BROKERS", "");

    let stats = Arc::new(Stats::default());
    let writer = Writer::new(clickhouse, flush_rows, flush_ms, stats.clone());
    let ingest = Ingest { writer: writer.clone(), stats: stats.clone() };

    {
        let stats = stats.clone();
        let writer = writer.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await;
            loop {
                interval.tick().await;
                println!("{}", stats.line(writer.buffered()));
            }
        });
    }

    if !brokers.is_empty() {
        let config = KafkaConfig {
            brokers,
            group: env_or("BENCH_CONSUMER_GROUP", "bench-rust"),
            topics: vec![
                env_or("LOG_TOPIC_LOGS", "skilllane-monitoring.logs"),
                env_or("LOG_TOPIC_SPANS", "skilllane-monitoring.spans"),
            ],
        };
        let ingest = ingest.clone();
        tokio::spawn(async move {
            if let Err(err) = kafka::run(config, ingest).await {
                eprintln!("kafka consumer stopped: {err}");
            }
        });
    }

    let state = AppState { ingest, inflight: Arc::new(AtomicUsize::new(0)), max_inflight };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    println!("ingest-rust listening on :{port} (flush {flush_rows} rows / {flush_ms} ms, max inflight {max_inflight})");
    let shutdown = async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
            tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
        }
    };
    axum::serve(listener, router(state)).with_graceful_shutdown(shutdown).await.expect("serve");
    writer.flush_all().await;
    println!("{}", stats.line(writer.buffered()));
}
