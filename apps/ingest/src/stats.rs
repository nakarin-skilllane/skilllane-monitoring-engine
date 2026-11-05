//! Ingest counters and the stats line printed every 30 s (apps/engine ingest.stats.ts), plus the process's
//! log line: one line per event with a UTC time, no colour (the engine prints Nest's logger to stdout).

use crate::mappers::Stream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// `2026-11-05T10:00:00.123Z  LOG [Ingest] message` on stdout (everything this process says goes there).
pub fn log(level: &str, context: &str, message: &str) {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    println!("{now} {level:>5} [{context}] {message}");
}
pub fn info(context: &str, message: &str) {
    log("LOG", context, message);
}
pub fn warn(context: &str, message: &str) {
    log("WARN", context, message);
}
pub fn error(context: &str, message: &str) {
    log("ERROR", context, message);
}

#[derive(Default)]
pub struct TableCounters {
    pub rows: AtomicU64,
    pub inserts: AtomicU64,
    pub failures: AtomicU64,
    pub last_insert_ms: AtomicU64,
}

struct Tick {
    at: Instant,
    logs: u64,
    spans: u64,
    failures: u64,
    bad: u64,
}

pub struct Stats {
    pub tables: [TableCounters; 2],
    pub messages: AtomicU64,
    pub bad_envelopes: AtomicU64,
    pub bad_items: AtomicU64,
    first_bad: Mutex<Option<String>>,
    logged_bad: AtomicU64,
    last_tick: Mutex<Tick>,
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            tables: Default::default(),
            messages: AtomicU64::new(0),
            bad_envelopes: AtomicU64::new(0),
            bad_items: AtomicU64::new(0),
            first_bad: Mutex::new(None),
            logged_bad: AtomicU64::new(0),
            last_tick: Mutex::new(Tick { at: Instant::now(), logs: 0, spans: 0, failures: 0, bad: 0 }),
        }
    }
}

impl Stats {
    fn table(&self, table: Stream) -> &TableCounters {
        &self.tables[match table {
            Stream::Logs => 0,
            Stream::Spans => 1,
        }]
    }

    pub fn inserted(&self, table: Stream, rows: usize, ms: u64) {
        let t = self.table(table);
        t.rows.fetch_add(rows as u64, Ordering::Relaxed);
        t.inserts.fetch_add(1, Ordering::Relaxed);
        t.last_insert_ms.store(ms, Ordering::Relaxed);
    }

    pub fn insert_failed(&self, table: Stream) {
        self.table(table).failures.fetch_add(1, Ordering::Relaxed);
    }

    /// A message that is not a v1 envelope. Logged in full for the first few only.
    pub fn bad_envelope(&self, source: &str, err: &str) {
        self.bad_envelopes.fetch_add(1, Ordering::Relaxed);
        self.note_bad(&format!("bad envelope from {source}"), err);
    }

    /// An item inside a valid envelope that could not become a row.
    pub fn bad_item(&self, stream: Stream, err: &str) {
        self.bad_items.fetch_add(1, Ordering::Relaxed);
        self.note_bad(&format!("bad {} item", stream.table()), err);
    }

    fn note_bad(&self, what: &str, err: &str) {
        let mut first = self.first_bad.lock().unwrap();
        if first.is_none() {
            *first = Some(format!("{what}: {err}"));
        }
        let logged = self.logged_bad.fetch_add(1, Ordering::Relaxed) + 1;
        if logged <= 5 {
            warn("IngestStats", &format!("{what} skipped: {err}{}", if logged == 5 { " (further ones only counted)" } else { "" }));
        }
    }

    /// One line for stdout; `lag` comes from the active consumer when cheap to read.
    pub fn line(&self, buffered: [usize; 2], lag: Option<&str>) -> String {
        let now = Instant::now();
        let mut tick = self.last_tick.lock().unwrap();
        let seconds = now.duration_since(tick.at).as_secs_f64().max(0.001);
        let logs = self.tables[0].rows.load(Ordering::Relaxed);
        let spans = self.tables[1].rows.load(Ordering::Relaxed);
        let failures = self.tables[0].failures.load(Ordering::Relaxed) + self.tables[1].failures.load(Ordering::Relaxed);
        let bad_envelopes = self.bad_envelopes.load(Ordering::Relaxed);
        let bad_items = self.bad_items.load(Ordering::Relaxed);
        let bad = bad_envelopes + bad_items;
        let mut parts = vec![
            format!(
                "logs {:.1} rows/s (last insert {} ms, buffered {})",
                (logs - tick.logs) as f64 / seconds,
                self.tables[0].last_insert_ms.load(Ordering::Relaxed),
                buffered[0]
            ),
            format!(
                "spans {:.1} rows/s (last insert {} ms, buffered {})",
                (spans - tick.spans) as f64 / seconds,
                self.tables[1].last_insert_ms.load(Ordering::Relaxed),
                buffered[1]
            ),
            format!("insert failures {failures} (+{})", failures - tick.failures),
            format!("bad envelopes {bad_envelopes}, bad items {bad_items} (+{})", bad - tick.bad),
            format!("messages {}", self.messages.load(Ordering::Relaxed)),
        ];
        if let Some(lag) = lag.filter(|l| !l.is_empty()) {
            parts.push(format!("lag {lag}"));
        }
        if bad > tick.bad {
            if let Some(first) = self.first_bad.lock().unwrap().as_ref() {
                parts.push(format!("first bad: {first}"));
            }
        }
        *tick = Tick { at: now, logs, spans, failures, bad };
        parts.join(" · ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_has_the_engine_shape() {
        let stats = Stats::default();
        let line = stats.line([0, 0], None);
        assert_eq!(
            line,
            "logs 0.0 rows/s (last insert 0 ms, buffered 0) · spans 0.0 rows/s (last insert 0 ms, buffered 0) · insert failures 0 (+0) · bad envelopes 0, bad items 0 (+0) · messages 0"
        );
    }

    #[test]
    fn line_counts_lag_and_the_first_bad_input() {
        let stats = Stats::default();
        stats.inserted(Stream::Logs, 120, 42);
        stats.inserted(Stream::Spans, 7, 9);
        stats.insert_failed(Stream::Spans);
        stats.messages.fetch_add(3, Ordering::Relaxed);
        stats.bad_envelope("kafka t[0]@5", "Not a v1 envelope");
        stats.bad_item(Stream::Logs, "log item is not an object");
        let line = stats.line([4, 2], Some("skilllane-monitoring.logs[0]=12"));
        let parts: Vec<&str> = line.split(" · ").collect();
        assert_eq!(parts.len(), 7, "{line}");
        assert!(parts[0].starts_with("logs ") && parts[0].ends_with(" rows/s (last insert 42 ms, buffered 4)"), "{line}");
        assert!(parts[1].starts_with("spans ") && parts[1].ends_with(" rows/s (last insert 9 ms, buffered 2)"), "{line}");
        assert_eq!(parts[2], "insert failures 1 (+1)");
        assert_eq!(parts[3], "bad envelopes 1, bad items 1 (+2)");
        assert_eq!(parts[4], "messages 3");
        assert_eq!(parts[5], "lag skilllane-monitoring.logs[0]=12");
        assert_eq!(parts[6], "first bad: bad envelope from kafka t[0]@5: Not a v1 envelope");

        // The next tick: deltas reset, the first bad error is only shown when new bad input arrived.
        let line = stats.line([0, 0], Some(""));
        assert!(line.ends_with("insert failures 1 (+0) · bad envelopes 1, bad items 1 (+0) · messages 3"), "{line}");
    }
}
