//! Captured I/O of a span: a 1:1 port of apps/engine/src/ingest/span-io.ts. Request / response
//! headers and bodies, the query string, SQL bind values and queue messages leave `attributes`
//! for their own columns (SPEC.md section 7); the statement too (`db_statement` /
//! `db_statement_full`). Items of a sender that masked them with the current rules are stored
//! as they are; anything else is masked here with the SDK's rules (crate::mask). Other
//! instrumentations' bind and header names (fallbacks) are always masked.

use crate::js::{json_number_string, number_to_string, string_to_number, stringify, to_number, to_str};
use crate::mappers::StringMap;
use crate::mask::{
    db_parameters_json, is_sensitive_key, js_string, mask_body_text, mask_header_json, mask_header_value,
    mask_identifier, mask_path_by_route, mask_query, mask_url, redact_value, DbParameter, REDACTED,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::LazyLock;

/// `db_statement` keeps this many characters; a longer statement also goes to `db_statement_full`.
pub const DB_STATEMENT_MAX: usize = 2000;
/// What the engine masks of one value from a sender that did not (and keeps: the rest is cut).
pub const FALLBACK_MAX_BYTES: usize = 262_144;
const FALLBACK_VALUE_MAX: usize = FALLBACK_MAX_BYTES / 4;

/// Attribute names that become columns (the SDK's, and school-core-api's same-named ones).
static IO_KEYS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "url.query",
        "http.request.headers",
        "http.response.headers",
        "http.request.body",
        "http.response.body",
        "http.request.body.size",
        "http.response.body.size",
        "http.request.body.truncated",
        "http.response.body.truncated",
        "skilllane.monitoring.db.parameters",
        // opentelemetry-instrumentation-typeorm collectParameters: JSON of the query builder's parameters
        "db.statement.parameters",
        // @opentelemetry/instrumentation-pg enhancedDatabaseReporting: string[] of $1, $2 …
        "db.postgresql.values",
        "messaging.message.body",
        "messaging.message.body.size",
        "messaging.message.body.truncated",
        "messaging.message.headers",
    ]
    .into_iter()
    .collect()
});
// Semconv per-key forms (0-based index for positional binds); oracledb writes db.operation.parameter.*.
const QUERY_PARAMETER: &str = "db.query.parameter.";
const OPERATION_PARAMETER: &str = "db.operation.parameter.";
const REQUEST_HEADER: &str = "http.request.header.";
const RESPONSE_HEADER: &str = "http.response.header.";

const URL_ATTRIBUTES: [&str; 3] = ["url.full", "http.url", "http.target"];
const ID_ATTRIBUTES: [&str; 4] =
    ["job.id", "messaging.message.id", "messaging.message.conversation_id", "messaging.kafka.message.key"];

static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$").unwrap()
});

/// The 18 I/O columns of a span row.
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
pub struct SpanIo {
    pub url_query: String,
    pub req_headers: String,
    pub res_headers: String,
    pub req_body: String,
    pub res_body: String,
    pub req_body_size: u64,
    pub res_body_size: u64,
    pub req_body_truncated: u8,
    pub res_body_truncated: u8,
    pub db_params: String,
    pub db_statement_full: String,
    pub msg_body: String,
    pub msg_headers: String,
    pub msg_body_size: u64,
    pub msg_body_truncated: u8,
    pub req_header_count: u16,
    pub res_header_count: u16,
    pub db_param_count: u16,
}

/// span-io.ts `text()`: '' for null, strings as is, numbers / booleans as JS prints them, JSON otherwise.
fn text(value: Option<&Value>) -> String {
    to_str(value)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Non-negative integer (UInt64 columns).
fn size(value: Option<&Value>) -> u64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        other => string_to_number(&text(other)),
    };
    if n.is_finite() && n > 0.0 {
        n.trunc().min(9007199254740991.0) as u64
    } else {
        0
    }
}

fn flag(value: Option<&Value>) -> u8 {
    match value {
        Some(Value::Bool(true)) => 1,
        Some(Value::Number(n)) if n.as_f64() == Some(1.0) => 1,
        Some(Value::String(s)) if s == "true" || s == "1" => 1,
        _ => 0,
    }
}

/// Keys of a JSON object / items of a JSON array (UInt16); 0 when not JSON.
fn count_of(json: &str) -> u16 {
    if json.is_empty() {
        return 0;
    }
    let n = match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(items)) => items.len(),
        Ok(Value::Object(map)) => map.len(),
        _ => 0,
    };
    n.min(65535) as u16
}

/// Binds in skilllane.monitoring.db.parameters, leaving out the SDK's last `{ key: '…', value: '<n> more' }` cut marker.
fn param_count_of(json: &str) -> u16 {
    if json.is_empty() {
        return 0;
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else { return 0 };
    let binds = items
        .iter()
        .filter(|p| !matches!(p, Value::Object(map) if map.get("key").and_then(Value::as_str) == Some("…")))
        .count();
    binds.min(65535) as u16
}

fn is_json(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok()
}

/// A JSON-encoded Node Buffer: { type: 'Buffer', data: number[] }.
fn buffer_data(map: &Map<String, Value>) -> Option<&Vec<Value>> {
    if map.get("type").and_then(Value::as_str) != Some("Buffer") {
        return None;
    }
    map.get("data").and_then(Value::as_array)
}

/// `Buffer.from(number[])`: each element `& 255` after ToNumber.
fn byte_of(value: &Value) -> u8 {
    let n = to_number(Some(value));
    if !n.is_finite() || n.abs() >= 9.223372036854776e18 {
        return 0;
    }
    (n.trunc() as i64).rem_euclid(256) as u8
}

/// One fallback bind value, typed from its JS value (dbParametersJson masks it).
fn param(key: String, value: &Value) -> DbParameter {
    let (r#type, value) = match value {
        Value::Null => ("null", String::new()),
        Value::Number(n) => ("number", json_number_string(n)),
        Value::Bool(b) => ("boolean", (if *b { "true" } else { "false" }).to_string()),
        Value::String(s) => (if ISO_DATE.is_match(s) { "date" } else { "string" }, s.clone()),
        Value::Object(map) if buffer_data(map).is_some() => {
            let data = buffer_data(map).unwrap();
            let hex: String = data.iter().take(2048).map(|v| format!("{:02x}", byte_of(v))).collect();
            ("buffer", hex)
        }
        other => ("object", stringify(other)),
    };
    DbParameter { key, r#type: r#type.to_string(), value, ..Default::default() }
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// Bind values from another instrumentation's attributes, as the `db_params` JSON ('' when none).
fn fallback_params(per_key: Option<&[(String, Value)]>, io: &Map<String, Value>, statement: &str) -> String {
    let mut params: Vec<DbParameter> = Vec::new();
    if let Some(per_key) = per_key.filter(|p| !p.is_empty()) {
        // Positional keys from a 0-based index become "1", "2" …; names stay. Sorted by position.
        params = per_key
            .iter()
            .map(|(key, value)| {
                let key = if is_digits(key) { number_to_string(string_to_number(key) + 1.0) } else { key.clone() };
                param(key, value)
            })
            .collect();
        if params.iter().all(|p| is_digits(&p.key)) {
            params.sort_by(|a, b| {
                string_to_number(&a.key).partial_cmp(&string_to_number(&b.key)).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    } else if let Some(raw) = io.get("db.statement.parameters") {
        match serde_json::from_str::<Value>(&text(Some(raw))) {
            Ok(Value::Array(items)) => {
                params = items.iter().enumerate().map(|(i, v)| param((i + 1).to_string(), v)).collect();
            }
            Ok(Value::Object(map)) => {
                params = map.iter().map(|(k, v)| param(k.clone(), v)).collect();
            }
            _ => {}
        }
    } else if let Some(Value::Array(values)) = io.get("db.postgresql.values") {
        // the pg instrumentation writes 'null' for SQL NULL
        params = values
            .iter()
            .enumerate()
            .map(|(i, v)| param((i + 1).to_string(), if v.as_str() == Some("null") { &Value::Null } else { v }))
            .collect();
    }
    params_of(statement, &params)
}

/// The shared rules (columns from the statement, key / fail-closed / value rule, caps) on a list of binds.
fn params_of(statement: &str, params: &[DbParameter]) -> String {
    if params.is_empty() {
        return String::new();
    }
    db_parameters_json(statement, params, FALLBACK_MAX_BYTES, FALLBACK_VALUE_MAX)
}

/// `skilllane.monitoring.db.parameters` from a sender that did not mask it: parsed and masked again.
fn remask_params(json: &str, statement: &str) -> String {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else { return String::new() };
    let empty = Map::new();
    let params: Vec<DbParameter> = items
        .iter()
        .filter_map(|p| match p {
            Value::Object(map) => Some(map),
            Value::Array(_) => Some(&empty),
            _ => None,
        })
        .map(|p| {
            let key = match p.get("key") {
                None | Some(Value::Null) => String::new(),
                Some(v) => js_string(v),
            };
            let r#type = match p.get("type") {
                Some(Value::String(t)) => t.clone(),
                _ => "string".to_string(),
            };
            let value = match p.get("value") {
                Some(Value::String(v)) => v.clone(),
                None | Some(Value::Null) => "\"\"".to_string(),
                Some(other) => stringify(other),
            };
            let column = match p.get("column") {
                Some(Value::String(c)) if !c.is_empty() => Some(c.clone()),
                _ => None,
            };
            DbParameter { key, r#type, value, column, truncated: p.get("truncated") == Some(&Value::Bool(true)), masked: None }
        })
        .collect();
    params_of(statement, &params)
}

/// Semconv per-header attributes (`http.request.header.content_type`) → the headers JSON object, masked.
fn headers_json(collected: Option<&Vec<(String, Value)>>) -> String {
    let Some(collected) = collected else { return String::new() };
    let mut out: Map<String, Value> = Map::new();
    for (suffix, value) in collected {
        let name = suffix.to_lowercase().replace('_', "-");
        let masked = match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|v| Value::String(mask_header_value(&name, &text(Some(v))))).collect())
            }
            other => Value::String(mask_header_value(&name, &text(Some(other)))),
        };
        out.insert(name, masked);
    }
    stringify(&Value::Object(out))
}

/// One attribute of a sender that did not mask: URLs by their query, ids by their segments, the rest by key and value.
pub fn mask_attribute_text(key: &str, value: &str, route: &str) -> String {
    if URL_ATTRIBUTES.contains(&key) {
        return if key == "http.target" { mask_path_by_route(&mask_url(value), route) } else { mask_url(value) };
    }
    if key == "url.path" {
        return mask_path_by_route(&redact_value(value), route);
    }
    if is_sensitive_key(key) {
        return REDACTED.to_string();
    }
    if ID_ATTRIBUTES.contains(&key) {
        return mask_identifier(value);
    }
    redact_value(value)
}

/// A body (or message payload) from a sender that did not mask it, and whether masking cut it.
fn masked_body(body: &str) -> (String, bool) {
    if body.is_empty() {
        return (String::new(), false);
    }
    (mask_body_text(body, FALLBACK_MAX_BYTES), body.len() > FALLBACK_MAX_BYTES)
}

/// school-core-api's own hook cuts a body at 1000 characters and appends '...' (it sends no size or flag).
fn cut_at_1000(body: &str, size_attr: Option<&Value>, flag_attr: Option<&Value>) -> u8 {
    if size_attr.is_none() && flag_attr.is_none() && body.ends_with("...") && utf16_len(body) == 1003 {
        1
    } else {
        0
    }
}

/// Splits span attributes into the `attributes` map (strings, non-strings JSON-encoded) and
/// the I/O columns. The statement (`db.query.text` / `db.statement`) always leaves
/// `attributes`: it is the `db_statement` column, and whole in `db_statement_full` when longer
/// than DB_STATEMENT_MAX. `masked`: the sender masked everything already (else it is masked
/// here); `statement`: already masked when the sender did not.
pub fn split_span_attributes(attrs: &Map<String, Value>, statement: &str, masked: bool) -> (StringMap, SpanIo) {
    let long_statement = utf16_len(statement) > DB_STATEMENT_MAX;
    let route = match attrs.get("http.route") {
        Some(Value::String(r)) => r.clone(),
        _ => String::new(),
    };
    let mut attributes = StringMap::new();
    let mut io: Map<String, Value> = Map::new();
    let mut query_params: Option<Vec<(String, Value)>> = None;
    let mut operation_params: Option<Vec<(String, Value)>> = None;
    let mut req_headers: Option<Vec<(String, Value)>> = None;
    let mut res_headers: Option<Vec<(String, Value)>> = None;
    for (key, value) in attrs {
        if IO_KEYS.contains(key.as_str()) {
            io.insert(key.clone(), value.clone());
            continue;
        }
        if key.starts_with("db.") {
            if let Some(suffix) = key.strip_prefix(QUERY_PARAMETER) {
                query_params.get_or_insert_with(Vec::new).push((suffix.to_string(), value.clone()));
                continue;
            }
            if let Some(suffix) = key.strip_prefix(OPERATION_PARAMETER) {
                operation_params.get_or_insert_with(Vec::new).push((suffix.to_string(), value.clone()));
                continue;
            }
            if key == "db.query.text" || key == "db.statement" {
                continue;
            }
        } else if key.starts_with("http.") {
            if let Some(suffix) = key.strip_prefix(REQUEST_HEADER) {
                push_header(&mut req_headers, suffix, value);
                continue;
            }
            if let Some(suffix) = key.strip_prefix(RESPONSE_HEADER) {
                push_header(&mut res_headers, suffix, value);
                continue;
            }
        }
        let value_text = text(Some(value));
        attributes.insert(key.clone(), if masked { value_text } else { mask_attribute_text(key, &value_text, &route) });
    }

    let raw_req = text(io.get("http.request.body"));
    let raw_res = text(io.get("http.response.body"));
    let raw_msg = text(io.get("messaging.message.body"));
    let (req_body, req_cut) = if masked { (raw_req.clone(), false) } else { masked_body(&raw_req) };
    let (res_body, res_cut) = if masked { (raw_res.clone(), false) } else { masked_body(&raw_res) };
    let (msg_body, msg_cut) = if masked { (raw_msg.clone(), false) } else { masked_body(&raw_msg) };
    // Sizes of what the sender sent, before any masking here.
    let msg_size = {
        let s = size(io.get("messaging.message.body.size"));
        if s != 0 {
            s
        } else {
            raw_msg.len() as u64
        }
    };
    let msg_flag = io.get("messaging.message.body.truncated");
    let header_text = |key: &str, lower_case: bool| -> String {
        let value = text(io.get(key));
        if masked || value.is_empty() {
            value
        } else {
            mask_header_json(&value, lower_case, FALLBACK_MAX_BYTES)
        }
    };
    let req_headers_json = {
        let own = header_text("http.request.headers", true);
        if own.is_empty() {
            headers_json(req_headers.as_ref())
        } else {
            own
        }
    };
    let res_headers_json = {
        let own = header_text("http.response.headers", true);
        if own.is_empty() {
            headers_json(res_headers.as_ref())
        } else {
            own
        }
    };
    let sdk_params = text(io.get("skilllane.monitoring.db.parameters"));
    let db_params = if !sdk_params.is_empty() {
        if masked {
            sdk_params
        } else {
            remask_params(&sdk_params, statement)
        }
    } else {
        fallback_params(query_params.as_deref().or(operation_params.as_deref()), &io, statement)
    };
    let query_raw = text(io.get("url.query"));
    let query = query_raw.strip_prefix('?').unwrap_or(&query_raw);
    let req_size_attr = io.get("http.request.body.size");
    let req_flag_attr = io.get("http.request.body.truncated");
    let res_size_attr = io.get("http.response.body.size");
    let res_flag_attr = io.get("http.response.body.truncated");
    let truncated = |flag_attr: Option<&Value>, cut: bool, raw: &str, size_attr: Option<&Value>| -> u8 {
        if flag(flag_attr) == 1 || cut {
            1
        } else {
            cut_at_1000(raw, size_attr, flag_attr)
        }
    };
    let msg_body_truncated = match msg_flag {
        // Without the flag: cut when the original was bigger and the text is no longer whole JSON.
        Some(f) => {
            if flag(Some(f)) == 1 || msg_cut {
                1
            } else {
                0
            }
        }
        None => {
            if msg_cut || (!raw_msg.is_empty() && msg_size > raw_msg.len() as u64 && !is_json(&raw_msg)) {
                1
            } else {
                0
            }
        }
    };
    let io_columns = SpanIo {
        url_query: if masked { query.to_string() } else { mask_query(query) },
        req_header_count: count_of(&req_headers_json),
        res_header_count: count_of(&res_headers_json),
        db_param_count: param_count_of(&db_params),
        req_headers: req_headers_json,
        res_headers: res_headers_json,
        req_body_size: {
            let s = size(req_size_attr);
            if s != 0 {
                s
            } else {
                raw_req.len() as u64
            }
        },
        res_body_size: {
            let s = size(res_size_attr);
            if s != 0 {
                s
            } else {
                raw_res.len() as u64
            }
        },
        req_body_truncated: truncated(req_flag_attr, req_cut, &raw_req, req_size_attr),
        res_body_truncated: truncated(res_flag_attr, res_cut, &raw_res, res_size_attr),
        req_body,
        res_body,
        db_params,
        db_statement_full: if long_statement { statement.to_string() } else { String::new() },
        msg_body,
        msg_headers: header_text("messaging.message.headers", false),
        msg_body_size: msg_size,
        msg_body_truncated,
    };
    (attributes, io_columns)
}

/// `(collected ??= {})[suffix] = value`: a repeated suffix keeps its first position, last value.
fn push_header(collected: &mut Option<Vec<(String, Value)>>, suffix: &str, value: &Value) {
    let list = collected.get_or_insert_with(Vec::new);
    if let Some(entry) = list.iter_mut().find(|(k, _)| k == suffix) {
        entry.1 = value.clone();
    } else {
        list.push((suffix.to_string(), value.clone()));
    }
}
