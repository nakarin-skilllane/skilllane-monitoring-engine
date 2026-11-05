//! Message → envelope → rows → writer (apps/engine envelope-handler.ts). `write` resolves once
//! the rows are inserted (ack / commit on it).

use crate::config::InsertFormat;
use crate::mappers::{map_log, map_span, parse_envelope, Envelope, Stream};
use crate::stats::Stats;
use crate::writer::Writer;

/// A mapped row encoded either way (LogRow and SpanRow, through their Serialize).
mod erased {
    use crate::mappers::Stream;
    use serde::Serialize;

    pub trait Row {
        fn json(&self) -> Result<Vec<u8>, String>;
        fn rowbinary(&self, table: Stream) -> Result<Vec<u8>, String>;
    }

    impl<T: Serialize> Row for T {
        fn json(&self) -> Result<Vec<u8>, String> {
            serde_json::to_vec(self).map_err(|e| e.to_string())
        }
        fn rowbinary(&self, table: Stream) -> Result<Vec<u8>, String> {
            crate::rowbinary::encode(table, self)
        }
    }
}
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

    /// The envelope's items as rows in the writer's format: JSONEachRow lines or RowBinary rows (bad items are
    /// counted and skipped).
    pub fn rows(&self, envelope: &Envelope) -> Vec<Vec<u8>> {
        let mut out = Vec::with_capacity(envelope.items.len());
        let format = self.writer.format();
        let encode = |row: &dyn erased::Row| -> Result<Vec<u8>, String> {
            match format {
                InsertFormat::JsonEachRow => row.json(),
                InsertFormat::RowBinary => row.rowbinary(envelope.stream),
            }
        };
        for item in &envelope.items {
            let encoded = match envelope.stream {
                Stream::Logs => map_log(item, &envelope.resource, &envelope.sent_at).and_then(|row| encode(&row)),
                Stream::Spans => map_span(item, &envelope.resource).and_then(|row| encode(&row)),
            };
            match encoded {
                Ok(bytes) => out.push(bytes),
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
