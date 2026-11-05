//! Message → envelope → rows → writer (apps/engine envelope-handler.ts). `write` resolves once
//! the rows are inserted (ack / commit on it).

use crate::mappers::{map_log, map_span, parse_envelope, Envelope, Stream};
use crate::stats::Stats;
use crate::writer::Writer;
use flate2::read::GzDecoder;
use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;

#[derive(Clone)]
pub struct Ingest {
    pub writer: Writer,
    pub stats: Arc<Stats>,
}

impl Ingest {
    /// Parses a body; counts and fails when it is not an envelope.
    pub fn parse(&self, raw: &[u8], source: &str) -> Result<Envelope, String> {
        self.stats.messages.fetch_add(1, Ordering::Relaxed);
        let parsed = serde_json::from_slice::<serde_json::Value>(raw)
            .map_err(|e| format!("invalid JSON: {e}"))
            .and_then(parse_envelope);
        if let Err(err) = &parsed {
            self.stats.bad_envelope(source, err);
        }
        parsed
    }

    /// JSONEachRow lines of the envelope's items (bad items are counted and skipped).
    pub fn rows(&self, envelope: &Envelope) -> Vec<String> {
        let mut out = Vec::with_capacity(envelope.items.len());
        for item in &envelope.items {
            let line = match envelope.stream {
                Stream::Logs => map_log(item, &envelope.resource, &envelope.sent_at).map(|row| serde_json::to_string(&row)),
                Stream::Spans => map_span(item, &envelope.resource).map(|row| serde_json::to_string(&row)),
            };
            match line {
                Ok(Ok(line)) => out.push(line),
                Ok(Err(err)) => self.stats.bad_item(envelope.stream, &err.to_string()),
                Err(err) => self.stats.bad_item(envelope.stream, &err),
            }
        }
        out
    }

    /// Writes the rows of several envelopes; resolves once all of them are inserted.
    pub async fn write(&self, envelopes: &[Envelope]) -> Result<(), String> {
        let mut logs = Vec::new();
        let mut spans = Vec::new();
        for envelope in envelopes {
            let rows = self.rows(envelope);
            match envelope.stream {
                Stream::Logs => logs.extend(rows),
                Stream::Spans => spans.extend(rows),
            }
        }
        let (a, b) = tokio::join!(self.writer.enqueue(Stream::Logs, logs), self.writer.enqueue(Stream::Spans, spans));
        a.and(b)
    }
}

/// Undoes gzip when the bytes carry the gzip magic; `max` decoded bytes or an error.
pub fn gunzip_if_needed(raw: &[u8], max: usize) -> Result<Vec<u8>, String> {
    if raw.len() < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
        return Ok(raw.to_vec());
    }
    gunzip(raw, max)
}

pub fn gunzip(raw: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((raw.len() * 4).min(max + 1));
    let mut decoder = GzDecoder::new(raw).take(max as u64 + 1);
    decoder.read_to_end(&mut out).map_err(|e| format!("gzip: {e}"))?;
    if out.len() > max {
        return Err("too large".into());
    }
    Ok(out)
}
