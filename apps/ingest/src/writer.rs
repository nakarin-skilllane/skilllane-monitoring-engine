//! ClickHouse writer, the same contract as apps/engine clickhouse-writer.ts: rows buffered per
//! table (already encoded: JSONEachRow lines, or RowBinary rows when CLICKHOUSE_INSERT_FORMAT says
//! so; `format()` tells the mapper which), ENGINE_INSERT_INFLIGHT inserts in flight per
//! table (default 1, the engine's), a flush when ENGINE_FLUSH_ROWS rows wait or ENGINE_FLUSH_MS
//! after the first buffered row; every enqueue resolves once its rows are in ClickHouse (rejects
//! when the insert failed); backpressure at 4 × flushRows (enqueue waits; HTTP answers 503 instead
//! via `saturated`); `close` flushes once more and rejects later enqueues.
//! Also the process's ClickHouse checks: `ping` (health) and `wait_ready` (start).

use crate::config::InsertFormat;
use crate::mappers::Stream;
use crate::rowbinary;
use crate::stats::{self, Stats};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;

#[derive(Clone, Default)]
pub struct ClickhouseConfig {
    pub url: String,
    pub user: String,
    pub password: String,
    pub database: String,
    /// ENGINE_ASYNC_INSERT: every insert carries `async_insert=1&wait_for_async_insert=1`, so ClickHouse
    /// merges the batches of every ingest process into one part per flush of its own and answers once the
    /// rows are on disk (the enqueue contract holds). Off = one part per insert, the engine's behaviour.
    pub async_insert: bool,
    /// CLICKHOUSE_INSERT_FORMAT: the encoding of the rows given to `enqueue` and the INSERT's FORMAT.
    pub format: InsertFormat,
}

impl ClickhouseConfig {
    pub fn from(config: &crate::config::Config) -> ClickhouseConfig {
        ClickhouseConfig {
            url: config.clickhouse_url.clone(),
            user: config.clickhouse_user.clone(),
            password: config.clickhouse_password.clone(),
            database: config.clickhouse_database.clone(),
            async_insert: config.async_insert,
            format: config.insert_format,
        }
    }
}

type Waiter = oneshot::Sender<Result<(), String>>;

#[derive(Default)]
struct Buffer {
    /// Encoded rows (a JSON line without its newline, or a RowBinary row).
    lines: Vec<Vec<u8>>,
    bytes: usize,
    waiters: Vec<Waiter>,
    timer: Option<JoinHandle<()>>,
    /// Inserts running now (at most `max_inflight`).
    inflight: usize,
    /// A flush was asked for while every insert slot was busy.
    again: bool,
}

struct Inner {
    client: reqwest::Client,
    config: ClickhouseConfig,
    flush_rows: usize,
    flush_ms: u64,
    max_inflight: usize,
    high_water: usize,
    buffers: [Mutex<Buffer>; 2],
    drained: Notify,
    stats: Arc<Stats>,
    last_error_log: Mutex<Option<Instant>>,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct Writer(Arc<Inner>);

fn index(table: Stream) -> usize {
    match table {
        Stream::Logs => 0,
        Stream::Spans => 1,
    }
}

const CLOSED: &str = "ClickhouseWriter is closed";

impl Writer {
    /// One insert in flight per table (the engine's behaviour).
    pub fn new(config: ClickhouseConfig, flush_rows: usize, flush_ms: u64, stats: Arc<Stats>) -> Writer {
        Writer::with_inflight(config, flush_rows, flush_ms, 1, stats)
    }

    /// `max_inflight` inserts per table at once (ENGINE_INSERT_INFLIGHT).
    pub fn with_inflight(config: ClickhouseConfig, flush_rows: usize, flush_ms: u64, max_inflight: usize, stats: Arc<Stats>) -> Writer {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(4)
            .build()
            .expect("reqwest client");
        Writer(Arc::new(Inner {
            client,
            config,
            flush_rows: flush_rows.max(1),
            flush_ms,
            max_inflight: max_inflight.max(1),
            high_water: flush_rows.max(1) * 4,
            buffers: [Mutex::new(Buffer::default()), Mutex::new(Buffer::default())],
            drained: Notify::new(),
            stats,
            last_error_log: Mutex::new(None),
            closed: AtomicBool::new(false),
        }))
    }

    /// The encoding `enqueue` expects its rows in.
    pub fn format(&self) -> InsertFormat {
        self.0.config.format
    }

    /// Rows waiting per table (not counting a running insert).
    pub fn buffered(&self) -> [usize; 2] {
        [self.0.buffers[0].lock().unwrap().lines.len(), self.0.buffers[1].lock().unwrap().lines.len()]
    }

    /// At the backpressure mark (or closed): an enqueue now would wait (HTTP ingest answers 503 instead).
    pub fn saturated(&self, table: Stream) -> bool {
        self.0.closed.load(Ordering::Acquire) || self.0.buffers[index(table)].lock().unwrap().lines.len() >= self.0.high_water
    }

    /// Buffers the rows (encoded as `format()` says); resolves once they are inserted.
    pub async fn enqueue(&self, table: Stream, lines: Vec<Vec<u8>>) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(CLOSED.into());
        }
        let i = index(table);
        let mut pending = Some(lines);
        let rx = loop {
            // Registered before the check, so a notify between the check and the await is not missed.
            let mut notified = pin!(self.0.drained.notified());
            notified.as_mut().enable();
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
                None => {
                    notified.await;
                    if self.0.closed.load(Ordering::Acquire) {
                        return Err(CLOSED.into());
                    }
                }
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

    /// Starts an insert of everything buffered for `table` (or marks one to follow when every slot is busy).
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
            if buffer.inflight >= self.0.max_inflight {
                buffer.again = true;
                return;
            }
            buffer.inflight += 1;
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
                buffer.inflight -= 1;
                writer.0.drained.notify_waiters();
                if buffer.lines.is_empty() {
                    return;
                }
                if buffer.again || buffer.lines.len() >= writer.0.flush_rows || writer.0.closed.load(Ordering::Acquire) {
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
                b.inflight > 0 || !b.lines.is_empty()
            });
            if !busy {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Final flush on shutdown; later enqueues reject.
    pub async fn close(&self) {
        self.flush_all().await;
        self.0.closed.store(true, Ordering::Release);
        self.0.drained.notify_waiters();
    }

    async fn insert(&self, table: Stream, lines: Vec<Vec<u8>>, bytes: usize, waiters: Vec<Waiter>) {
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
                let log_it = {
                    let mut last = self.0.last_error_log.lock().unwrap();
                    let due = last.map_or(true, |t| t.elapsed() > Duration::from_secs(5));
                    if due {
                        *last = Some(Instant::now());
                    }
                    due
                };
                if log_it {
                    stats::error("ClickhouseWriter", &format!("Insert of {} rows into {} failed: {err}", lines.len(), table.table()));
                }
                for w in waiters {
                    let _ = w.send(Err(message.clone()));
                }
            }
        }
    }

    /// The insert URL of `table`: the statement in the configured format (JSONEachRow with the engine's
    /// `date_time_input_format`, or RowBinary with its column list), the async settings when on.
    fn insert_url(&self, table: Stream) -> String {
        let c = &self.0.config;
        let (query, settings) = match c.format {
            InsertFormat::JsonEachRow => (format!("INSERT INTO {}.{} FORMAT JSONEachRow", c.database, table.table()), "&date_time_input_format=best_effort"),
            InsertFormat::RowBinary => (rowbinary::insert_statement(&c.database, table), ""),
        };
        format!(
            "{}/?query={}{settings}{}",
            c.url.trim_end_matches('/'),
            percent_encode(&query),
            if c.async_insert { "&async_insert=1&wait_for_async_insert=1" } else { "" }
        )
    }

    async fn post(&self, table: Stream, lines: &[Vec<u8>], bytes: usize) -> Result<(), String> {
        let c = &self.0.config;
        let newline = c.format == InsertFormat::JsonEachRow;
        let body = tokio::task::block_in_place(|| gzip_rows(lines, bytes, newline)).map_err(|e| e.to_string())?;
        let response = self
            .0
            .client
            .post(self.insert_url(table))
            .basic_auth(&c.user, Some(&c.password))
            .header("Content-Encoding", "gzip")
            .header("Content-Type", if newline { "application/x-ndjson" } else { "application/octet-stream" })
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

    /// True when ClickHouse answers `/ping` as the writer's user (the health endpoint cuts it at 800 ms).
    pub async fn ping(&self) -> bool {
        let c = &self.0.config;
        let url = format!("{}/ping", c.url.trim_end_matches('/'));
        match self.0.client.get(url).basic_auth(&c.user, Some(&c.password)).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    /// Why ClickHouse is not ready for inserts yet: unreachable, or table `logs` missing (the engine applies
    /// the schema; this process only waits for it). None = ready.
    pub async fn not_ready(&self) -> Option<String> {
        let c = &self.0.config;
        let ping = format!("{}/ping", c.url.trim_end_matches('/'));
        match self.0.client.get(ping).basic_auth(&c.user, Some(&c.password)).send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => return Some(format!("ping: HTTP {}", response.status().as_u16())),
            Err(err) => return Some(format!("ping: {err}")),
        }
        let query = format!("EXISTS TABLE {}.logs", c.database);
        let url = format!("{}/?query={}", c.url.trim_end_matches('/'), percent_encode(&query));
        match self.0.client.get(url).basic_auth(&c.user, Some(&c.password)).send().await {
            Ok(response) if response.status().is_success() => {
                let text = response.text().await.unwrap_or_default();
                if text.trim() == "1" {
                    None
                } else {
                    Some(format!("table {}.logs does not exist yet (the engine applies the schema)", c.database))
                }
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let text = response.text().await.unwrap_or_default();
                Some(format!("HTTP {status}: {}", text.lines().next().unwrap_or("").chars().take(200).collect::<String>()))
            }
            Err(err) => Some(err.to_string()),
        }
    }

    /// Waits (retry every 2 s, forever) until `not_ready` is None; one log line a minute while waiting.
    pub async fn wait_ready(&self) {
        let started = Instant::now();
        let mut last_log: Option<Instant> = None;
        while let Some(reason) = self.not_ready().await {
            if last_log.map_or(true, |t| t.elapsed() >= Duration::from_secs(60)) {
                last_log = Some(Instant::now());
                stats::warn(
                    "ClickHouse",
                    &format!("waiting for ClickHouse at {} ({reason}); {} s so far", self.0.config.url, started.elapsed().as_secs()),
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
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

/// The gzip body: the rows one after another, each followed by a newline for JSONEachRow (RowBinary rows are
/// self-delimiting).
fn gzip_rows(rows: &[Vec<u8>], bytes: usize, newline: bool) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes / 4 + 64), Compression::fast());
    for row in rows {
        encoder.write_all(row)?;
        if newline {
            encoder.write_all(b"\n")?;
        }
    }
    encoder.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// A ClickHouse that accepts the connection and never answers: inserts hang until the 60 s timeout.
    async fn hanging_clickhouse() -> String {
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

    fn writer(url: String, flush_rows: usize, inflight: usize) -> Writer {
        let config = ClickhouseConfig { url, user: "u".into(), password: "p".into(), database: "db".into(), ..Default::default() };
        Writer::with_inflight(config, flush_rows, 10_000, inflight, Arc::new(Stats::default()))
    }

    #[test]
    fn insert_url_follows_the_format_and_the_async_setting() {
        let off = writer("http://ch:8123/".into(), 10, 1);
        assert_eq!(off.format(), InsertFormat::JsonEachRow);
        assert_eq!(
            off.insert_url(Stream::Logs),
            "http://ch:8123/?query=INSERT%20INTO%20db.logs%20FORMAT%20JSONEachRow&date_time_input_format=best_effort"
        );
        let mut config = off.0.config.clone();
        config.async_insert = true;
        let on = Writer::with_inflight(config.clone(), 10, 10_000, 1, Arc::new(Stats::default()));
        assert_eq!(
            on.insert_url(Stream::Spans),
            "http://ch:8123/?query=INSERT%20INTO%20db.spans%20FORMAT%20JSONEachRow&date_time_input_format=best_effort&async_insert=1&wait_for_async_insert=1"
        );
        config.format = InsertFormat::RowBinary;
        let binary = Writer::with_inflight(config, 10, 10_000, 1, Arc::new(Stats::default()));
        let url = binary.insert_url(Stream::Logs);
        assert!(url.starts_with("http://ch:8123/?query=INSERT%20INTO%20db.logs%20%28timestamp%2C%20env%2C%20"), "{url}");
        assert!(url.ends_with("%29%20FORMAT%20RowBinary&async_insert=1&wait_for_async_insert=1"), "{url}");
        assert!(!url.contains("date_time_input_format"));
    }

    #[test]
    fn the_body_has_newlines_only_for_json() {
        let rows = vec![b"{}".to_vec(), b"{}".to_vec()];
        let json = gzip_rows(&rows, 6, true).unwrap();
        let binary = gzip_rows(&rows, 4, false).unwrap();
        let mut text = Vec::new();
        flate2::read::GzDecoder::new(json.as_slice()).read_to_end(&mut text).unwrap();
        assert_eq!(text, b"{}\n{}\n");
        text.clear();
        flate2::read::GzDecoder::new(binary.as_slice()).read_to_end(&mut text).unwrap();
        assert_eq!(text, b"{}{}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enqueue_rejects_when_the_insert_fails() {
        // Nothing listens on port 1: the insert fails at once and the enqueue rejects with the engine's message.
        let w = writer("http://127.0.0.1:1".into(), 1, 1);
        let err = w.enqueue(Stream::Logs, vec!["{}".into()]).await.unwrap_err();
        assert!(err.starts_with("ClickHouse insert into logs failed: "), "{err}");
        assert_eq!(w.0.stats.tables[0].failures.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inserts_in_flight_are_capped_per_table_and_the_rest_saturates() {
        let url = hanging_clickhouse().await;
        let w = writer(url, 1, 2);
        // Each enqueue of one row flushes at once; the first two take the two slots, the rest wait buffered.
        for _ in 0..6 {
            let w2 = w.clone();
            tokio::spawn(async move { w2.enqueue(Stream::Logs, vec!["{}".into()]).await });
        }
        // The six tasks are scheduled whenever the runtime gets to them (a loaded build host takes a while).
        for _ in 0..200 {
            if w.0.buffers[0].lock().unwrap().inflight == 2 && w.buffered() == [4, 0] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(w.0.buffers[0].lock().unwrap().inflight, 2);
        assert_eq!(w.buffered(), [4, 0]);
        assert!(w.saturated(Stream::Logs), "4 rows = high water (4 × 1)");
        assert!(!w.saturated(Stream::Spans));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_rejects_later_enqueues() {
        let w = writer("http://127.0.0.1:1".into(), 10, 1);
        w.close().await;
        assert!(w.saturated(Stream::Logs));
        assert_eq!(w.enqueue(Stream::Logs, vec!["{}".into()]).await.unwrap_err(), CLOSED);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn not_ready_names_the_reason() {
        let w = writer("http://127.0.0.1:1".into(), 10, 1);
        let reason = w.not_ready().await.unwrap();
        assert!(reason.starts_with("ping: "), "{reason}");
        assert!(!w.ping().await);
    }
}
