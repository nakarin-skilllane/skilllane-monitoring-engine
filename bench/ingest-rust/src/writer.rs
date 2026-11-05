//! ClickHouse writer, the same contract as apps/engine clickhouse-writer.ts: rows buffered per
//! table (already serialised as JSONEachRow lines), one insert in flight per table, a flush
//! when ENGINE_FLUSH_ROWS rows wait or ENGINE_FLUSH_MS after the first buffered row; every
//! enqueue resolves once its rows are in ClickHouse (rejects when the insert failed);
//! backpressure at 4 × flushRows (enqueue waits; HTTP answers 503 instead via `saturated`).

use crate::mappers::Stream;
use crate::stats::Stats;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;

pub struct ClickhouseConfig {
    pub url: String,
    pub user: String,
    pub password: String,
    pub database: String,
}

type Waiter = oneshot::Sender<Result<(), String>>;

#[derive(Default)]
struct Buffer {
    lines: Vec<String>,
    bytes: usize,
    waiters: Vec<Waiter>,
    timer: Option<JoinHandle<()>>,
    inflight: bool,
    /// A flush was asked for while an insert was running.
    again: bool,
}

struct Inner {
    client: reqwest::Client,
    config: ClickhouseConfig,
    flush_rows: usize,
    flush_ms: u64,
    high_water: usize,
    buffers: [Mutex<Buffer>; 2],
    drained: Notify,
    stats: Arc<Stats>,
    last_error_log: Mutex<Option<Instant>>,
}

#[derive(Clone)]
pub struct Writer(Arc<Inner>);

fn index(table: Stream) -> usize {
    match table {
        Stream::Logs => 0,
        Stream::Spans => 1,
    }
}

impl Writer {
    pub fn new(config: ClickhouseConfig, flush_rows: usize, flush_ms: u64, stats: Arc<Stats>) -> Writer {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(4)
            .build()
            .expect("reqwest client");
        Writer(Arc::new(Inner {
            client,
            config,
            flush_rows,
            flush_ms,
            high_water: flush_rows * 4,
            buffers: [Mutex::new(Buffer::default()), Mutex::new(Buffer::default())],
            drained: Notify::new(),
            stats,
            last_error_log: Mutex::new(None),
        }))
    }

    /// Rows waiting per table (not counting a running insert).
    pub fn buffered(&self) -> [usize; 2] {
        [self.0.buffers[0].lock().unwrap().lines.len(), self.0.buffers[1].lock().unwrap().lines.len()]
    }

    /// At the backpressure mark: an enqueue now would wait (HTTP ingest answers 503 instead).
    pub fn saturated(&self, table: Stream) -> bool {
        self.0.buffers[index(table)].lock().unwrap().lines.len() >= self.0.high_water
    }

    /// Buffers the rows; resolves once they are inserted.
    pub async fn enqueue(&self, table: Stream, lines: Vec<String>) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        let i = index(table);
        let mut pending = Some(lines);
        let rx = loop {
            let notified = self.0.drained.notified();
            // The lock never lives across an await: the guard stays inside this block.
            let outcome = {
                let mut buffer = self.0.buffers[i].lock().unwrap();
                if buffer.lines.len() >= self.0.high_water {
                    None
                } else {
                    let (tx, rx) = oneshot::channel();
                    buffer.waiters.push(tx);
                    let lines = pending.take().unwrap_or_default();
                    for line in &lines {
                        buffer.bytes += line.len() + 1;
                    }
                    buffer.lines.extend(lines);
                    let flush_now = buffer.lines.len() >= self.0.flush_rows;
                    if !flush_now && buffer.timer.is_none() {
                        buffer.timer = Some(self.start_timer(table));
                    }
                    Some((rx, flush_now))
                }
            };
            match outcome {
                Some((rx, flush_now)) => {
                    if flush_now {
                        self.flush(table);
                    }
                    break rx;
                }
                None => notified.await,
            }
        };
        rx.await.unwrap_or_else(|_| Err("writer dropped the batch".into()))
    }

    fn start_timer(&self, table: Stream) -> JoinHandle<()> {
        let writer = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(writer.0.flush_ms)).await;
            writer.0.buffers[index(table)].lock().unwrap().timer = None;
            writer.flush(table);
        })
    }

    /// Starts an insert of everything buffered for `table` (or marks one to follow).
    pub fn flush(&self, table: Stream) {
        let i = index(table);
        let (lines, bytes, waiters) = {
            let mut buffer = self.0.buffers[i].lock().unwrap();
            if let Some(timer) = buffer.timer.take() {
                timer.abort();
            }
            if buffer.lines.is_empty() {
                return;
            }
            if buffer.inflight {
                buffer.again = true;
                return;
            }
            buffer.inflight = true;
            buffer.again = false;
            let bytes = buffer.bytes;
            buffer.bytes = 0;
            (std::mem::take(&mut buffer.lines), bytes, std::mem::take(&mut buffer.waiters))
        };
        let writer = self.clone();
        tokio::spawn(async move {
            writer.insert(table, lines, bytes, waiters).await;
            let again = {
                let mut buffer = writer.0.buffers[i].lock().unwrap();
                buffer.inflight = false;
                writer.0.drained.notify_waiters();
                if buffer.lines.is_empty() {
                    return;
                }
                if buffer.again || buffer.lines.len() >= writer.0.flush_rows {
                    true
                } else {
                    if buffer.timer.is_none() {
                        buffer.timer = Some(writer.start_timer(table));
                    }
                    false
                }
            };
            if again {
                writer.flush(table);
            }
        });
    }

    /// Inserts every buffered row of every table and waits for the inserts to finish.
    pub async fn flush_all(&self) {
        loop {
            for table in [Stream::Logs, Stream::Spans] {
                self.flush(table);
            }
            let busy = self.0.buffers.iter().any(|b| {
                let b = b.lock().unwrap();
                b.inflight || !b.lines.is_empty()
            });
            if !busy {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn insert(&self, table: Stream, lines: Vec<String>, bytes: usize, waiters: Vec<Waiter>) {
        let started = Instant::now();
        let result = self.post(table, &lines, bytes).await;
        let ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(()) => {
                self.0.stats.inserted(table, lines.len(), ms);
                for w in waiters {
                    let _ = w.send(Ok(()));
                }
            }
            Err(err) => {
                self.0.stats.insert_failed(table);
                let message = format!("ClickHouse insert into {} failed: {err}", table.table());
                let mut last = self.0.last_error_log.lock().unwrap();
                if last.map_or(true, |t| t.elapsed() > Duration::from_secs(5)) {
                    *last = Some(Instant::now());
                    eprintln!("Insert of {} rows into {} failed: {err}", lines.len(), table.table());
                }
                for w in waiters {
                    let _ = w.send(Err(message.clone()));
                }
            }
        }
    }

    async fn post(&self, table: Stream, lines: &[String], bytes: usize) -> Result<(), String> {
        let body = tokio::task::block_in_place(|| gzip_lines(lines, bytes)).map_err(|e| e.to_string())?;
        let c = &self.0.config;
        let query = format!("INSERT INTO {}.{} FORMAT JSONEachRow", c.database, table.table());
        let url = format!(
            "{}/?query={}&date_time_input_format=best_effort",
            c.url.trim_end_matches('/'),
            percent_encode(&query)
        );
        let response = self
            .0
            .client
            .post(url)
            .basic_auth(&c.user, Some(&c.password))
            .header("Content-Encoding", "gzip")
            .header("Content-Type", "application/x-ndjson")
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = response.text().await.unwrap_or_default();
        Err(format!("HTTP {}: {}", status.as_u16(), text.lines().next().unwrap_or("").chars().take(300).collect::<String>()))
    }
}

/// Query-string encoding of the INSERT statement (unreserved characters as is).
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn gzip_lines(lines: &[String], bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes / 4 + 64), Compression::fast());
    for line in lines {
        encoder.write_all(line.as_bytes())?;
        encoder.write_all(b"\n")?;
    }
    encoder.finish()
}
