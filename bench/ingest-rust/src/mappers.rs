//! Envelope items → ClickHouse rows: a 1:1 port of apps/engine/src/ingest/mappers.ts (and the
//! `attributes` half of span-io.ts). Rows are structs serialised for JSONEachRow; every column
//! gets a value of the right type ('' / 0 / [] / null), so one odd item never fails an insert.
//! Span I/O columns (req_*, res_*, msg_*, db_params, url_query, db_param_count) are left out of
//! the insert; ClickHouse defaults them.

use crate::js::{date_parse, iso_from_ms, iso_to_nanos, nanos_to_datetime64, parse_int, stringify, to_number, to_str};
use crate::mask::{
    is_sensitive_key, mask_endpoint, mask_identifier, mask_json_text, mask_path_by_route, mask_sql, mask_statement,
    mask_url, masked_by_sender, redact_text, redact_value, REDACTED,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub type StringMap = IndexMap<String, String>;

/// An envelope as the SDK sends it (`{ v: 1, stream, resource, sentAt, items }`).
pub struct Envelope {
    pub stream: Stream,
    pub resource: Map<String, Value>,
    pub sent_at: String,
    pub items: Vec<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Stream {
    Logs,
    Spans,
}

impl Stream {
    pub fn table(self) -> &'static str {
        match self {
            Stream::Logs => "logs",
            Stream::Spans => "spans",
        }
    }
    pub fn parse(text: &str) -> Option<Stream> {
        match text {
            "logs" => Some(Stream::Logs),
            "spans" => Some(Stream::Spans),
            _ => None,
        }
    }
}

/// contract `parseEnvelope`: v === 1, stream, items array, resource object with service.name.
pub fn parse_envelope(value: Value) -> Result<Envelope, String> {
    let Value::Object(mut map) = value else { return Err("Not an skilllane-monitoring-contract v1 envelope".into()) };
    let v_ok = map.get("v").and_then(Value::as_f64) == Some(1.0);
    let stream = map.get("stream").and_then(Value::as_str).and_then(Stream::parse);
    let items_ok = map.get("items").is_some_and(Value::is_array);
    let resource_ok = map
        .get("resource")
        .and_then(Value::as_object)
        .is_some_and(|r| r.get("service.name").is_some_and(Value::is_string));
    let (Some(stream), true, true, true) = (stream, v_ok, items_ok, resource_ok) else {
        return Err("Not an skilllane-monitoring-contract v1 envelope".into());
    };
    let Value::Array(items) = map.remove("items").unwrap() else { unreachable!() };
    let Value::Object(resource) = map.remove("resource").unwrap() else { unreachable!() };
    let sent_at = to_str(map.get("sentAt"));
    Ok(Envelope { stream, resource, sent_at, items })
}

// ---------- small value helpers ----------

fn str_of(value: Option<&Value>) -> String {
    to_str(value)
}

/// Non-negative integer clamped to `max` (UInt16 / UInt8 columns).
fn uint(value: Option<&Value>, max: f64) -> u64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        other => parse_int(&str_of(other)),
    };
    if !n.is_finite() || n < 0.0 {
        return 0;
    }
    n.trunc().min(max) as u64
}

fn float(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        other => {
            let n = to_number(other);
            if n.is_finite() {
                Some(n)
            } else {
                None
            }
        }
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) if s.is_empty() => Vec::new(),
        Some(Value::Array(items)) => items.iter().filter(|v| !v.is_null()).map(|v| str_of(Some(v))).collect(),
        other => vec![str_of(other)],
    }
}

/// Map(String, String): strings as is, anything else JSON-encoded.
fn string_map(value: Option<&Value>) -> StringMap {
    let mut out = StringMap::new();
    match value {
        Some(Value::Object(map)) => {
            for (key, v) in map {
                out.insert(key.clone(), str_of(Some(v)));
            }
        }
        Some(Value::Array(items)) => {
            for (i, v) in items.iter().enumerate() {
                out.insert(i.to_string(), str_of(Some(v)));
            }
        }
        _ => {}
    }
    out
}

fn present(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

fn first<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|v| present(*v))
}

static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").unwrap());
static SCHEME_AUTHORITY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://[^/?#]*").unwrap());

/// Path of a URL or of a request target; never the query string or fragment.
fn path_of(value: Option<&Value>) -> String {
    let raw = str_of(value);
    if raw.is_empty() {
        return raw;
    }
    let path: String = if SCHEME.is_match(&raw) {
        match url::Url::parse(&raw) {
            Ok(u) => u.path().to_string(),
            Err(_) => SCHEME_AUTHORITY.replace(&raw, "").into_owned(),
        }
    } else {
        raw
    };
    match path.find(|c: char| c == '?' || c == '#') {
        Some(i) => path[..i].to_string(),
        None => path,
    }
}

// ---------- resource ----------

#[derive(Serialize)]
struct ResourceColumns {
    env: String,
    service: String,
    role: String,
    version: String,
    host: String,
}

fn resource_columns(resource: &Map<String, Value>, record: Option<&Map<String, Value>>) -> ResourceColumns {
    let get = |key: &str| record.and_then(|r| r.get(key));
    let record_service = str_of(get("service.name"));
    let slash = record_service.find('/');
    let (service_part, role_part): (Value, Option<Value>) = match slash {
        Some(i) => (Value::String(record_service[..i].to_string()), Some(Value::String(record_service[i + 1..].to_string()))),
        None => (Value::String(record_service.clone()), None),
    };
    let env = str_of(first(&[resource.get("deployment.environment.name"), get("service.environment")]));
    ResourceColumns {
        env: if env.is_empty() { "unknown".into() } else { env },
        service: str_of(first(&[resource.get("service.name"), Some(&service_part)])),
        role: str_of(first(&[resource.get("app.role"), role_part.as_ref()])),
        version: str_of(first(&[resource.get("service.version"), get("service.version")])),
        host: str_of(first(&[resource.get("host.name"), get("host.name")])),
    }
}

// ---------- logs ----------

static LOG_COLUMN_KEYS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "@timestamp", "service.name", "service.version", "service.environment", "host.name", "log.level", "log.logger",
        "event.code", "event.module", "message", "trace.id", "span.id", "user.id", "user.roles", "organization.id",
        "http.request.method", "http.route", "url.path", "url.domain", "http.response.status_code", "duration_ms",
        "error.type", "error.code", "error.message", "error.hint", "error.detail", "error.how_to_fix", "error.stack_trace",
        "error.cause", "log.origin.function", "log.origin.file.name", "db.statement", "dependency.type",
        "dependency.name", "dependency.host", "dependency.port", "job.queue", "job.type", "job.id", "job.attempt",
        "job.max_attempts", "job.final", "job.inflight", "reason", "labels",
    ]
    .into_iter()
    .collect()
});

const LABEL_COLUMNS: [&str; 4] = ["error_category", "error_target", "usecase", "failed_step"];

fn now_iso() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    iso_from_ms(ms).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

/// ISO text → DateTime64(3) text; falls back when the value does not parse.
fn log_timestamp(value: Option<&Value>, fallback_iso: &str) -> String {
    let iso = str_of(value);
    let parsed = if !iso.is_empty() && date_parse(&iso).is_some() { iso.as_str() } else { fallback_iso };
    nanos_to_datetime64(iso_to_nanos(parsed), 3).unwrap_or_else(|| "1970-01-01 00:00:00.000".into())
}

fn job_final(value: Option<&Value>) -> u8 {
    match value {
        Some(Value::Bool(true)) => 1,
        Some(Value::Number(n)) if n.as_f64() == Some(1.0) => 1,
        Some(Value::String(s)) if s == "true" || s == "1" => 1,
        _ => 0,
    }
}

fn text_of(out: &mut Map<String, Value>, key: &str, mask: impl Fn(&str) -> String) {
    if let Some(Value::String(s)) = out.get(key) {
        let masked = mask(s);
        out.insert(key.to_string(), Value::String(masked));
    }
}

/// A log record from a sender that did not mask it: the SDK's redactRecord rules, on a copy.
fn mask_log_record(r: &Map<String, Value>) -> Map<String, Value> {
    let mut out = r.clone();
    for key in ["message", "error.message", "error.stack_trace", "error.hint", "error.detail", "error.how_to_fix", "reason"] {
        text_of(&mut out, key, redact_text);
    }
    text_of(&mut out, "db.statement", mask_sql);
    text_of(&mut out, "user.id", redact_value);
    text_of(&mut out, "url.domain", redact_value);
    text_of(&mut out, "job.id", mask_identifier);
    text_of(&mut out, "dependency.name", mask_endpoint);
    text_of(&mut out, "dependency.host", mask_endpoint);
    if let Some(Value::String(path)) = out.get("url.path") {
        let path = match path.find('?') {
            Some(i) => &path[..i],
            None => path.as_str(),
        };
        let route = match out.get("http.route") {
            Some(Value::String(r)) => r.clone(),
            _ => String::new(),
        };
        let masked = mask_path_by_route(&redact_value(path), &route);
        out.insert("url.path".into(), Value::String(masked));
    }
    if let Some(cause) = out.get("error.cause") {
        let text = match cause {
            Value::String(s) => s.clone(),
            other => stringify(other),
        };
        out.insert("error.cause".into(), Value::String(mask_json_text(&text, true)));
    }
    out
}

#[derive(Serialize)]
pub struct LogRow {
    pub timestamp: String,
    #[serde(flatten)]
    resource: ResourceColumns,
    level: String,
    logger: String,
    event_code: String,
    event_module: String,
    message: String,
    trace_id: String,
    span_id: String,
    correlation_id: String,
    user_id: String,
    user_roles: Vec<String>,
    organization_id: String,
    http_method: String,
    http_route: String,
    url_path: String,
    url_domain: String,
    http_status: u64,
    duration_ms: Option<f64>,
    error_type: String,
    error_code: String,
    error_message: String,
    error_hint: String,
    error_detail: String,
    error_how_to_fix: String,
    error_stack: String,
    error_cause: String,
    error_category: String,
    error_target: String,
    usecase: String,
    failed_step: String,
    origin_function: String,
    origin_file: String,
    db_statement: String,
    dependency_type: String,
    dependency_name: String,
    dependency_host: String,
    dependency_port: u64,
    job_queue: String,
    job_type: String,
    job_id: String,
    job_attempt: u64,
    job_max_attempts: u64,
    job_final: u8,
    job_inflight: Vec<String>,
    reason: String,
    labels: StringMap,
    fields: StringMap,
}

pub fn map_log(item: &Value, resource: &Map<String, Value>, sent_at: &str) -> Result<LogRow, String> {
    let Value::Object(record) = item else { return Err("log item is not an object".into()) };
    let masked = masked_by_sender(resource);
    let owned;
    let r: &Map<String, Value> = if masked {
        record
    } else {
        owned = mask_log_record(record);
        &owned
    };
    let mut labels = string_map(r.get("labels"));
    // The key rule on every label, whoever sent it; the value rule for other senders.
    for (key, value) in labels.iter_mut() {
        if is_sensitive_key(key) {
            *value = REDACTED.to_string();
        } else if !masked {
            *value = redact_text(value);
        }
    }
    let correlation_id = labels.get("correlation_id").cloned().unwrap_or_default();
    let mut label_columns: [String; 4] = Default::default();
    for (i, key) in LABEL_COLUMNS.iter().enumerate() {
        label_columns[i] = labels.shift_remove(*key).unwrap_or_default();
    }
    let mut fields = StringMap::new();
    for (key, value) in r {
        if LOG_COLUMN_KEYS.contains(key.as_str()) {
            continue;
        }
        let text = str_of(Some(value));
        let masked_text = if masked {
            text
        } else if is_sensitive_key(key) {
            REDACTED.to_string()
        } else {
            redact_value(&text)
        };
        fields.insert(key.clone(), masked_text);
    }
    let fallback_iso = if date_parse(sent_at).is_some() { sent_at.to_string() } else { now_iso() };
    let g = |key: &str| r.get(key);
    let [error_category, error_target, usecase, failed_step] = label_columns;
    Ok(LogRow {
        timestamp: log_timestamp(g("@timestamp"), &fallback_iso),
        resource: resource_columns(resource, Some(r)),
        level: str_of(g("log.level")),
        logger: str_of(g("log.logger")),
        event_code: str_of(g("event.code")),
        event_module: str_of(g("event.module")),
        message: str_of(g("message")),
        trace_id: str_of(g("trace.id")),
        span_id: str_of(g("span.id")),
        correlation_id,
        user_id: str_of(g("user.id")),
        user_roles: string_array(g("user.roles")),
        organization_id: str_of(g("organization.id")),
        http_method: str_of(g("http.request.method")),
        http_route: str_of(g("http.route")),
        url_path: str_of(g("url.path")),
        url_domain: str_of(g("url.domain")),
        http_status: uint(g("http.response.status_code"), 65535.0),
        duration_ms: float(g("duration_ms")),
        error_type: str_of(g("error.type")),
        error_code: str_of(g("error.code")),
        error_message: str_of(g("error.message")),
        error_hint: str_of(g("error.hint")),
        error_detail: str_of(g("error.detail")),
        error_how_to_fix: str_of(g("error.how_to_fix")),
        error_stack: str_of(g("error.stack_trace")),
        error_cause: str_of(g("error.cause")),
        error_category,
        error_target,
        usecase,
        failed_step,
        origin_function: str_of(g("log.origin.function")),
        origin_file: str_of(g("log.origin.file.name")),
        db_statement: str_of(g("db.statement")),
        dependency_type: str_of(g("dependency.type")),
        dependency_name: str_of(g("dependency.name")),
        dependency_host: str_of(g("dependency.host")),
        dependency_port: uint(g("dependency.port"), 65535.0),
        job_queue: str_of(g("job.queue")),
        job_type: str_of(g("job.type")),
        job_id: str_of(g("job.id")),
        job_attempt: uint(g("job.attempt"), 65535.0),
        job_max_attempts: uint(g("job.max_attempts"), 65535.0),
        job_final: job_final(g("job.final")),
        job_inflight: string_array(g("job.inflight")),
        reason: str_of(g("reason")),
        labels,
        fields,
    })
}

// ---------- spans ----------

/// `db_statement` keeps this many characters; a longer statement also goes to `db_statement_full`.
const DB_STATEMENT_MAX: usize = 2000;
/// What the engine masks of one value from a sender that did not (and keeps: the rest is cut).
const FALLBACK_MAX_BYTES: usize = 262_144;

static IO_KEYS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "url.query", "http.request.headers", "http.response.headers", "http.request.body", "http.response.body",
        "http.request.body.size", "http.response.body.size", "http.request.body.truncated",
        "http.response.body.truncated", "skilllane.monitoring.db.parameters", "db.statement.parameters",
        "db.postgresql.values", "messaging.message.body", "messaging.message.body.size",
        "messaging.message.body.truncated", "messaging.message.headers",
    ]
    .into_iter()
    .collect()
});
const QUERY_PARAMETER: &str = "db.query.parameter.";
const OPERATION_PARAMETER: &str = "db.operation.parameter.";
const REQUEST_HEADER: &str = "http.request.header.";
const RESPONSE_HEADER: &str = "http.response.header.";
const URL_ATTRIBUTES: [&str; 3] = ["url.full", "http.url", "http.target"];
const ID_ATTRIBUTES: [&str; 4] =
    ["job.id", "messaging.message.id", "messaging.message.conversation_id", "messaging.kafka.message.key"];

/// One attribute of a sender that did not mask: URLs by their query, ids by their segments,
/// the rest by key and value.
fn mask_attribute_text(key: &str, value: &str, route: &str) -> String {
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

/// The `attributes` map of span-io.ts `splitSpanAttributes`: the I/O keys and the statement
/// leave it; the rest is text (masked here when the sender did not).
fn split_span_attributes(attrs: &Map<String, Value>, masked: bool) -> StringMap {
    let route = match attrs.get("http.route") {
        Some(Value::String(r)) => r.clone(),
        _ => String::new(),
    };
    let mut attributes = StringMap::new();
    for (key, value) in attrs {
        if IO_KEYS.contains(key.as_str()) {
            continue;
        }
        if key.starts_with("db.") {
            if key.starts_with(QUERY_PARAMETER) || key.starts_with(OPERATION_PARAMETER) {
                continue;
            }
            if key == "db.query.text" || key == "db.statement" {
                continue;
            }
        } else if key.starts_with("http.") && (key.starts_with(REQUEST_HEADER) || key.starts_with(RESPONSE_HEADER)) {
            continue;
        }
        let text = str_of(Some(value));
        attributes.insert(key.clone(), if masked { text } else { mask_attribute_text(key, &text, &route) });
    }
    attributes
}

/// Events of a sender that did not mask: every attribute by the key rule and the value rule.
fn mask_events(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            let Value::Object(e) = event else { return event.clone() };
            let Some(Value::Object(attrs)) = e.get("attributes") else { return event.clone() };
            let mut attributes = Map::new();
            for (key, value) in attrs {
                let masked = match value {
                    Value::String(s) => Value::String(mask_attribute_text(key, s, "")),
                    Value::Array(items) => Value::Array(
                        items
                            .iter()
                            .map(|v| match v {
                                Value::String(s) => Value::String(mask_attribute_text(key, s, "")),
                                other => other.clone(),
                            })
                            .collect(),
                    ),
                    other => {
                        if is_sensitive_key(key) {
                            Value::String(REDACTED.into())
                        } else {
                            other.clone()
                        }
                    }
                };
                attributes.insert(key.clone(), masked);
            }
            let mut out = e.clone();
            out.insert("attributes".into(), Value::Object(attributes));
            Value::Object(out)
        })
        .collect()
}

fn peer_of(attrs: &Map<String, Value>) -> String {
    let host = str_of(first(&[attrs.get("server.address"), attrs.get("net.peer.name")]));
    if host.is_empty() {
        return host;
    }
    let port = str_of(first(&[attrs.get("server.port"), attrs.get("net.peer.port")]));
    if port.is_empty() {
        host
    } else {
        format!("{host}:{port}")
    }
}

fn url_path_of(attrs: &Map<String, Value>) -> String {
    let direct = attrs.get("url.path");
    if direct.is_some_and(|v| v.as_str() != Some("")) {
        return path_of(direct);
    }
    let target = attrs.get("http.target");
    if target.is_some_and(|v| v.as_str() != Some("")) {
        return path_of(target);
    }
    path_of(first(&[attrs.get("url.full"), attrs.get("http.url")]))
}

fn is_nanos(text: &str) -> bool {
    !text.is_empty() && text.len() <= 30 && text.bytes().all(|b| b.is_ascii_digit())
}

fn falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => !*b,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

/// `text.slice(0, n)` by UTF-16 units, never cutting a character.
fn slice_utf16(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (i, c) in text.char_indices() {
        let len = c.len_utf16();
        if count + len > units {
            return &text[..i];
        }
        count += len;
    }
    text
}

#[derive(Serialize)]
pub struct SpanRow {
    pub timestamp: String,
    duration_ns: u64,
    #[serde(flatten)]
    resource: ResourceColumns,
    trace_id: String,
    span_id: String,
    parent_span_id: String,
    is_entry: u8,
    name: String,
    kind: String,
    status_code: String,
    status_message: String,
    scope_name: String,
    http_method: String,
    http_route: String,
    http_status: u64,
    url_path: String,
    db_system: String,
    db_statement: String,
    peer: String,
    exception_type: String,
    exception_message: String,
    attributes: StringMap,
    #[serde(rename = "resource")]
    resource_map: StringMap,
    events: String,
    db_statement_full: String,
}

/// Fails when the item cannot become a row (missing ids or bad times).
pub fn map_span(item: &Value, resource: &Map<String, Value>) -> Result<SpanRow, String> {
    let Value::Object(it) = item else { return Err("span item is not an object".into()) };
    if falsy(it.get("traceId")) || falsy(it.get("spanId")) {
        return Err("span item without traceId/spanId".into());
    }
    let start = str_of(it.get("startTimeUnixNano"));
    let end_text = str_of(it.get("endTimeUnixNano"));
    let end = if end_text.is_empty() { start.clone() } else { end_text };
    if !is_nanos(&start) || !is_nanos(&end) {
        return Err(format!("span {}: start/end time is not a nanosecond decimal string", str_of(it.get("spanId"))));
    }
    let empty = Map::new();
    let attrs = match it.get("attributes") {
        Some(Value::Object(a)) => a,
        _ => &empty,
    };
    let masked = masked_by_sender(resource);
    let db_system = str_of(first(&[attrs.get("db.system.name"), attrs.get("db.system")]));
    let raw_statement = str_of(first(&[attrs.get("db.query.text"), attrs.get("db.statement")]));
    let statement = if masked || raw_statement.is_empty() {
        raw_statement
    } else {
        mask_statement(&raw_statement, &db_system, FALLBACK_MAX_BYTES)
    };
    let attributes = split_span_attributes(attrs, masked);
    let events: Vec<Value> = match it.get("events") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => {
            if masked {
                list.clone()
            } else {
                mask_events(list)
            }
        }
        Some(_) => return Err("span events is not an array".into()),
    };
    let exception = events.iter().find(|e| e.get("name").and_then(Value::as_str) == Some("exception"));
    let ex_attrs = exception.and_then(|e| e.get("attributes")).and_then(Value::as_object);
    let parent = str_of(it.get("parentSpanId"));
    let route = str_of(attrs.get("http.route"));
    let url_path = url_path_of(attrs);
    let text = |value: Option<&Value>| if masked { str_of(value) } else { redact_value(&str_of(value)) };
    let start_n: i128 = start.parse().map_err(|_| "start time out of range".to_string())?;
    let end_n: i128 = end.parse().map_err(|_| "end time out of range".to_string())?;
    let timestamp = nanos_to_datetime64(start_n, 6).ok_or_else(|| "Invalid time value".to_string())?;
    let duration = (end_n - start_n).max(0);
    let status = it.get("status").and_then(Value::as_object);
    let scope = it.get("scope").and_then(Value::as_object);
    let status_code = str_of(status.and_then(|s| s.get("code")));
    Ok(SpanRow {
        timestamp,
        duration_ns: u64::try_from(duration).unwrap_or(u64::MAX),
        resource: resource_columns(resource, None),
        trace_id: str_of(it.get("traceId")),
        span_id: str_of(it.get("spanId")),
        parent_span_id: parent.clone(),
        is_entry: if parent.is_empty() || it.get("parentIsRemote") == Some(&Value::Bool(true)) { 1 } else { 0 },
        name: text(it.get("name")),
        kind: str_of(it.get("kind")),
        status_code: if status_code.is_empty() { "UNSET".into() } else { status_code },
        status_message: text(status.and_then(|s| s.get("message"))),
        scope_name: str_of(scope.and_then(|s| s.get("name"))),
        http_method: str_of(first(&[attrs.get("http.request.method"), attrs.get("http.method")])),
        http_route: route.clone(),
        http_status: uint(first(&[attrs.get("http.response.status_code"), attrs.get("http.status_code")]), 65535.0),
        url_path: if masked { url_path } else { mask_path_by_route(&redact_value(&url_path), &route) },
        db_system,
        db_statement: slice_utf16(&statement, DB_STATEMENT_MAX).to_string(),
        peer: peer_of(attrs),
        exception_type: str_of(ex_attrs.and_then(|a| a.get("exception.type"))),
        exception_message: str_of(ex_attrs.and_then(|a| a.get("exception.message"))),
        attributes,
        resource_map: string_map(Some(&Value::Object(resource.clone()))),
        events: stringify(&Value::Array(events)),
        db_statement_full: if statement.encode_utf16().count() > DB_STATEMENT_MAX { statement } else { String::new() },
    })
}
