//! RowBinary rows (CLICKHOUSE_INSERT_FORMAT=rowbinary): the row struct's JSON value (what JSONEachRow sends)
//! written as ClickHouse's RowBinary instead, column by column in the INSERT's column list, so the server stores
//! the same values without parsing JSON text. Types follow clickhouse/schema.sql; a column the schema fills
//! itself (`error_fingerprint`, `pattern`, `ingested_at`) is not sent, as in JSONEachRow. The column lists
//! mirror the field order of `LogRow` / `SpanRow` (a test checks); any mismatch with the schema is an insert
//! error ("Cannot read all data" / a type mismatch), which `bench/load/verify.mjs` catches before it ships.
//!
//! RowBinary: integers little-endian at their width, String = LEB128 length + bytes, Array / Map = LEB128 count
//! + items, Nullable = 1 null byte then the value, DateTime64(n) = Int64 ticks of 10^-n s.

use crate::mappers::Stream;
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    /// String and LowCardinality(String).
    Str,
    U8,
    U16,
    U64,
    NullableF64,
    /// Array(String) and Array(LowCardinality(String)).
    ArrayStr,
    /// Map(LowCardinality(String), String).
    MapStr,
    /// DateTime64(digits, 'UTC'), the mappers' "YYYY-MM-DD HH:MM:SS.fff…" text.
    DateTime64(usize),
}

pub struct Column {
    pub name: &'static str,
    pub kind: Type,
}

const fn c(name: &'static str, kind: Type) -> Column {
    Column { name, kind }
}

use Type::*;

/// `logs`: the columns of a `LogRow` in its field order.
pub const LOGS: &[Column] = &[
    c("timestamp", DateTime64(3)),
    c("env", Str),
    c("service", Str),
    c("role", Str),
    c("version", Str),
    c("host", Str),
    c("level", Str),
    c("logger", Str),
    c("event_code", Str),
    c("event_module", Str),
    c("message", Str),
    c("trace_id", Str),
    c("span_id", Str),
    c("correlation_id", Str),
    c("user_id", Str),
    c("user_roles", ArrayStr),
    c("organization_id", Str),
    c("http_method", Str),
    c("http_route", Str),
    c("url_path", Str),
    c("url_domain", Str),
    c("http_status", U16),
    c("duration_ms", NullableF64),
    c("error_type", Str),
    c("error_code", Str),
    c("error_message", Str),
    c("error_hint", Str),
    c("error_detail", Str),
    c("error_how_to_fix", Str),
    c("error_stack", Str),
    c("error_cause", Str),
    c("error_category", Str),
    c("error_target", Str),
    c("usecase", Str),
    c("failed_step", Str),
    c("origin_function", Str),
    c("origin_file", Str),
    c("db_statement", Str),
    c("dependency_type", Str),
    c("dependency_name", Str),
    c("dependency_host", Str),
    c("dependency_port", U16),
    c("job_queue", Str),
    c("job_type", Str),
    c("job_id", Str),
    c("job_attempt", U16),
    c("job_max_attempts", U16),
    c("job_final", U8),
    c("job_inflight", ArrayStr),
    c("reason", Str),
    c("labels", MapStr),
    c("fields", MapStr),
];

/// `spans`: the columns of a `SpanRow` in its field order (the 18 I/O columns of `SpanIo` last).
pub const SPANS: &[Column] = &[
    c("timestamp", DateTime64(6)),
    c("duration_ns", U64),
    c("env", Str),
    c("service", Str),
    c("role", Str),
    c("version", Str),
    c("host", Str),
    c("trace_id", Str),
    c("span_id", Str),
    c("parent_span_id", Str),
    c("is_entry", U8),
    c("name", Str),
    c("kind", Str),
    c("status_code", Str),
    c("status_message", Str),
    c("scope_name", Str),
    c("http_method", Str),
    c("http_route", Str),
    c("http_status", U16),
    c("url_path", Str),
    c("db_system", Str),
    c("db_statement", Str),
    c("peer", Str),
    c("exception_type", Str),
    c("exception_message", Str),
    c("attributes", MapStr),
    c("resource", MapStr),
    c("events", Str),
    c("url_query", Str),
    c("req_headers", Str),
    c("res_headers", Str),
    c("req_body", Str),
    c("res_body", Str),
    c("req_body_size", U64),
    c("res_body_size", U64),
    c("req_body_truncated", U8),
    c("res_body_truncated", U8),
    c("db_params", Str),
    c("db_statement_full", Str),
    c("msg_body", Str),
    c("msg_headers", Str),
    c("msg_body_size", U64),
    c("msg_body_truncated", U8),
    c("req_header_count", U16),
    c("res_header_count", U16),
    c("db_param_count", U16),
];

pub fn columns(table: Stream) -> &'static [Column] {
    match table {
        Stream::Logs => LOGS,
        Stream::Spans => SPANS,
    }
}

/// `INSERT INTO db.table (col, …) FORMAT RowBinary`.
pub fn insert_statement(database: &str, table: Stream) -> String {
    let names: Vec<&str> = columns(table).iter().map(|c| c.name).collect();
    format!("INSERT INTO {database}.{} ({}) FORMAT RowBinary", table.table(), names.join(", "))
}

/// One row as RowBinary bytes; an error names the column whose value the schema cannot hold.
pub fn encode<T: Serialize>(table: Stream, row: &T) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(row).map_err(|e| e.to_string())?;
    let Value::Object(fields) = &value else {
        return Err("row is not an object".into());
    };
    let mut out = Vec::with_capacity(512);
    for column in columns(table) {
        write(&mut out, column, fields.get(column.name).unwrap_or(&Value::Null))?;
    }
    Ok(out)
}

/// `value` as `column`'s type. Null is the type's default (what JSONEachRow does with `input_format_null_as_default`).
fn write(out: &mut Vec<u8>, column: &Column, value: &Value) -> Result<(), String> {
    let bad = || format!("{}: {} does not fit {:?}", column.name, kind_of(value), column.kind);
    match column.kind {
        Str => match value {
            Value::String(s) => string(out, s),
            Value::Null => string(out, ""),
            _ => return Err(bad()),
        },
        U8 => out.push(u8::try_from(uint(value).ok_or_else(bad)?).map_err(|_| bad())?),
        U16 => out.extend_from_slice(&u16::try_from(uint(value).ok_or_else(bad)?).map_err(|_| bad())?.to_le_bytes()),
        U64 => out.extend_from_slice(&uint(value).ok_or_else(bad)?.to_le_bytes()),
        NullableF64 => match value {
            Value::Null => out.push(1),
            Value::Number(n) => {
                out.push(0);
                out.extend_from_slice(&n.as_f64().ok_or_else(bad)?.to_le_bytes());
            }
            _ => return Err(bad()),
        },
        ArrayStr => match value {
            Value::Array(items) => {
                varint(out, items.len() as u64);
                for item in items {
                    string(out, item.as_str().ok_or_else(bad)?);
                }
            }
            Value::Null => varint(out, 0),
            _ => return Err(bad()),
        },
        MapStr => match value {
            Value::Object(entries) => {
                varint(out, entries.len() as u64);
                for (key, item) in entries {
                    string(out, key);
                    string(out, item.as_str().ok_or_else(bad)?);
                }
            }
            Value::Null => varint(out, 0),
            _ => return Err(bad()),
        },
        DateTime64(digits) => {
            let text = value.as_str().ok_or_else(bad)?;
            out.extend_from_slice(&ticks(text, digits).ok_or_else(bad)?.to_le_bytes());
        }
    }
    Ok(())
}

/// Ticks of 10^-digits s since the epoch of a "YYYY-MM-DD HH:MM:SS.fff…" UTC text (the mappers' form).
fn ticks(text: &str, digits: usize) -> Option<i64> {
    let t = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").ok()?.and_utc();
    match digits {
        3 => Some(t.timestamp_millis()),
        6 => Some(t.timestamp_micros()),
        9 => t.timestamp_nanos_opt(),
        0 => Some(t.timestamp()),
        _ => None,
    }
}

fn uint(value: &Value) -> Option<u64> {
    match value {
        Value::Null => Some(0),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn string(out: &mut Vec<u8>, text: &str) {
    varint(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

/// Unsigned LEB128.
fn varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mappers::{map_log, map_span};
    use serde_json::json;

    fn bytes(column: &Column, value: Value) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        write(&mut out, column, &value).map(|_| out)
    }

    #[test]
    fn varint_is_leb128() {
        let mut out = Vec::new();
        varint(&mut out, 0);
        varint(&mut out, 127);
        varint(&mut out, 128);
        varint(&mut out, 300);
        assert_eq!(out, vec![0, 127, 0x80, 0x01, 0xac, 0x02]);
    }

    #[test]
    fn every_type_has_its_bytes() {
        assert_eq!(bytes(&c("s", Str), json!("héllo")).unwrap(), [&[6u8][..], "héllo".as_bytes()].concat());
        assert_eq!(bytes(&c("s", Str), Value::Null).unwrap(), vec![0]);
        assert_eq!(bytes(&c("b", U8), json!(1)).unwrap(), vec![1]);
        assert_eq!(bytes(&c("p", U16), json!(8123)).unwrap(), 8123u16.to_le_bytes().to_vec());
        assert_eq!(bytes(&c("n", U64), json!(1_000_000_000_000u64)).unwrap(), 1_000_000_000_000u64.to_le_bytes().to_vec());
        assert_eq!(bytes(&c("n", U64), Value::Null).unwrap(), vec![0; 8]);
        assert_eq!(bytes(&c("d", NullableF64), Value::Null).unwrap(), vec![1]);
        assert_eq!(bytes(&c("d", NullableF64), json!(12.5)).unwrap(), [&[0u8][..], &12.5f64.to_le_bytes()].concat());
        assert_eq!(bytes(&c("a", ArrayStr), json!(["x", "yz"])).unwrap(), vec![2, 1, b'x', 2, b'y', b'z']);
        assert_eq!(bytes(&c("m", MapStr), json!({"k": "v"})).unwrap(), vec![1, 1, b'k', 1, b'v']);
        assert_eq!(bytes(&c("m", MapStr), json!({})).unwrap(), vec![0]);
        // 2026-11-05 12:34:56.789 UTC
        let ms = 1_793_882_096_789i64;
        assert_eq!(bytes(&c("t", DateTime64(3)), json!("2026-11-05 12:34:56.789")).unwrap(), ms.to_le_bytes().to_vec());
        assert_eq!(bytes(&c("t", DateTime64(6)), json!("2026-11-05 12:34:56.789012")).unwrap(), (ms * 1000 + 12).to_le_bytes().to_vec());
        assert_eq!(bytes(&c("t", DateTime64(3)), json!("1970-01-01 00:00:00.000")).unwrap(), vec![0; 8]);
    }

    #[test]
    fn a_value_the_column_cannot_hold_names_the_column() {
        assert_eq!(bytes(&c("http_status", U16), json!(70000)).unwrap_err(), "http_status: a number does not fit U16");
        assert_eq!(bytes(&c("job_final", U8), json!("1")).unwrap_err(), "job_final: a string does not fit U8");
        assert_eq!(bytes(&c("labels", MapStr), json!({"k": 1})).unwrap_err(), "labels: an object does not fit MapStr");
        assert_eq!(bytes(&c("timestamp", DateTime64(3)), json!("2026-11-05T12:34:56Z")).unwrap_err(), "timestamp: a string does not fit DateTime64(3)");
    }

    #[test]
    fn the_column_lists_are_the_row_structs_fields_in_order() {
        let resource = json!({ "service.name": "svc", "app.role": "api", "deployment.environment": "test", "host.name": "h" });
        let resource = resource.as_object().unwrap();
        let log = map_log(&json!({ "@timestamp": "2026-11-05T12:34:56.789Z", "message": "hi", "level": "info" }), resource, "2026-11-05T12:34:56.789Z").unwrap();
        let keys: Vec<String> = serde_json::to_value(&log).unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, LOGS.iter().map(|c| c.name.to_string()).collect::<Vec<_>>());
        let span = map_span(
            &json!({ "traceId": "t1", "spanId": "s1", "name": "GET /x", "startTimeUnixNano": "1793968496789000000", "endTimeUnixNano": "1793968496790000000" }),
            resource,
        )
        .unwrap();
        let keys: Vec<String> = serde_json::to_value(&span).unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, SPANS.iter().map(|c| c.name.to_string()).collect::<Vec<_>>());
        assert_eq!((LOGS.len(), SPANS.len()), (52, 46));
    }

    #[test]
    fn a_mapped_row_encodes_whole() {
        let resource = json!({ "service.name": "svc", "app.role": "api" });
        let log = map_log(&json!({ "message": "hi [Ctx] 42", "level": "warn", "labels": { "a": "b" } }), resource.as_object().unwrap(), "2026-11-05T12:34:56.789Z").unwrap();
        let out = encode(Stream::Logs, &log).unwrap();
        // DateTime64(3) first: 8 bytes, then env … (every String at least its 1-byte length)
        assert!(out.len() > 8 + LOGS.len() - 1, "{} bytes", out.len());
        assert_eq!(insert_statement("db", Stream::Logs).len(), "INSERT INTO db.logs (".len() + LOGS.iter().map(|c| c.name.len() + 2).sum::<usize>() - 2 + ") FORMAT RowBinary".len());
        assert!(insert_statement("db", Stream::Spans).starts_with("INSERT INTO db.spans (timestamp, duration_ns, env, "));
    }
}
