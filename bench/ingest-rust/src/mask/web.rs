//! skilllane-monitoring/contract mask/web.js: query strings, URLs, cookies, header values,
//! `maskPathByRoute`, `maskEndpoint`. (`maskMarkup` / `maskCsv` are not ported: bodies are
//! not ingested by this prototype.)

use super::keys::{is_sensitive_header, is_sensitive_key, is_sensitive_query_name, REDACTED};
use super::value::redact_value;
use crate::js::{is_js_whitespace, to_str};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// `decodeURIComponent(text.replace(/\+/g, ' '))`; the text as is when that throws.
fn decode_component(text: &str) -> String {
    let plus = text.replace('+', " ");
    let b = plus.as_bytes();
    let mut bytes = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return text.to_string();
            }
            let hex = |c: u8| (c as char).to_digit(16);
            match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => bytes.push((h * 16 + l) as u8),
                _ => return text.to_string(),
            }
            i += 3;
        } else {
            bytes.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| text.to_string())
}

/// `encodeURIComponent(text).replace(/%5BREDACTED%5D/g, '[REDACTED]')`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out.replace("%5BREDACTED%5D", REDACTED)
}

pub fn mask_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    query
        .split('&')
        .map(|pair| {
            if pair.is_empty() {
                return pair.to_string();
            }
            let index = pair.find('=');
            let raw_name = match index {
                Some(i) => &pair[..i],
                None => pair,
            };
            let name = decode_component(raw_name);
            if is_sensitive_query_name(&name) {
                return format!("{raw_name}={REDACTED}");
            }
            let Some(i) = index else {
                let masked = redact_value(&name);
                return if masked == name { pair.to_string() } else { encode_component(&masked) };
            };
            let value = decode_component(&pair[i + 1..]);
            let masked = redact_value(&value);
            if masked == value {
                pair.to_string()
            } else {
                format!("{raw_name}={}", encode_component(&masked))
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

pub fn mask_url(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let hash = url.find('#');
    let query_at = url.find('?');
    let query = match (query_at, hash) {
        (Some(q), None) => Some(q),
        (Some(q), Some(h)) if q < h => Some(q),
        _ => None,
    };
    let path_end = query.or(hash).unwrap_or(url.len());
    let mut out = redact_value(&url[..path_end]);
    if let Some(q) = query {
        out.push('?');
        out.push_str(&mask_query(&url[q + 1..hash.unwrap_or(url.len())]));
    }
    if let Some(h) = hash {
        let fragment = &url[h + 1..];
        out.push('#');
        out.push_str(&if fragment.contains('=') { mask_query(fragment) } else { redact_value(fragment) });
    }
    out
}

pub fn mask_cookie(value: &str) -> String {
    value
        .split(';')
        .map(|part| match part.find('=') {
            None => {
                if part.trim_matches(is_js_whitespace).is_empty() {
                    part.to_string()
                } else {
                    format!("{}{REDACTED}", if part.starts_with(' ') { " " } else { "" })
                }
            }
            Some(i) => format!("{}={REDACTED}", &part[..i]),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// `value.split(/,\s*(?=[^;,=\s]+=)/)`: a comma, blanks, then a cookie name and '=' ahead.
fn split_set_cookie(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < value.len() {
        if value.as_bytes()[i] == b',' {
            let mut j = i + 1;
            for c in value[i + 1..].chars() {
                if is_js_whitespace(c) {
                    j += c.len_utf8();
                } else {
                    break;
                }
            }
            let mut k = j;
            for c in value[j..].chars() {
                if c == ';' || c == ',' || c == '=' || is_js_whitespace(c) {
                    break;
                }
                k += c.len_utf8();
            }
            if k > j && value[k..].starts_with('=') {
                parts.push(&value[start..i]);
                start = j;
                i = j;
                continue;
            }
        }
        i += 1;
        while i < value.len() && !value.is_char_boundary(i) {
            i += 1;
        }
    }
    parts.push(&value[start..]);
    parts
}

pub fn mask_set_cookie(value: &str) -> String {
    split_set_cookie(value)
        .into_iter()
        .map(|cookie| {
            let (first, attributes) = match cookie.find(';') {
                None => (cookie, ""),
                Some(i) => (&cookie[..i], &cookie[i..]),
            };
            let name = match first.find('=') {
                None => "",
                Some(i) => &first[..i],
            };
            format!("{}{REDACTED}{}", if name.is_empty() { String::new() } else { format!("{name}=") }, redact_value(attributes))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

static URLISH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:[a-z][a-z0-9+.-]*://|/)").unwrap());

pub fn mask_header_value(name: &str, value: &str) -> String {
    let lower = name.to_lowercase();
    if lower == "set-cookie" {
        return mask_set_cookie(value);
    }
    if lower == "cookie" {
        return mask_cookie(value);
    }
    if is_sensitive_header(name) {
        return REDACTED.to_string();
    }
    if URLISH.is_match(value) && (value.contains('?') || value.contains('#')) {
        return mask_url(value);
    }
    redact_value(value)
}

/// JS `String(value)` of a header value (objects are "[object Object]").
fn header_text(value: &Value) -> String {
    match value {
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items.iter().map(header_text).collect::<Vec<_>>().join(","),
        Value::Null => "null".into(),
        other => to_str(Some(other)),
    }
}

pub fn mask_headers(headers: &Map<String, Value>, lower_case: bool) -> Map<String, Value> {
    let mut out: Map<String, Value> = Map::new();
    for (name, value) in headers {
        if value.is_null() {
            continue;
        }
        let key = if lower_case { name.to_lowercase() } else { name.clone() };
        let values: Vec<String> = match value {
            Value::Array(items) => items.iter().map(header_text).collect(),
            other => vec![header_text(other)],
        };
        let mut all: Vec<Value> = match out.get(&key) {
            Some(Value::Array(before)) => before.clone(),
            Some(single) => vec![single.clone()],
            None => Vec::new(),
        };
        all.extend(values.iter().map(|item| Value::String(mask_header_value(&key, item))));
        let value = if all.len() == 1 { all.pop().unwrap() } else { Value::Array(all) };
        out.insert(key, value);
    }
    out
}

static ROUTE_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?::([A-Za-z0-9_$]+)\??|\{([A-Za-z0-9_$]+)\})$").unwrap());

fn route_param(part: &str) -> Option<&str> {
    let caps = ROUTE_PARAM.captures(part)?;
    caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str())
}

/// Path segments that a sensitive route parameter names → [REDACTED].
pub fn mask_path_by_route(path: &str, route: &str) -> String {
    if route.is_empty() || path.is_empty() || !route.contains('/') {
        return path.to_string();
    }
    let route_parts: Vec<&str> = route.split('/').collect();
    if !route_parts.iter().any(|part| ROUTE_PARAM.is_match(part)) {
        return path.to_string();
    }
    let query = path.find(|c: char| c == '?' || c == '#');
    let (pathname, rest) = match query {
        None => (path, ""),
        Some(q) => (&path[..q], &path[q..]),
    };
    let mut parts: Vec<String> = pathname.split('/').map(str::to_string).collect();
    let mut changed = false;
    for i in 0..parts.len().min(route_parts.len()) {
        if let Some(name) = route_param(route_parts[i]) {
            if !parts[i].is_empty() && parts[i] != REDACTED && is_sensitive_key(name) {
                parts[i] = REDACTED.to_string();
                changed = true;
            }
        }
    }
    if changed {
        format!("{}{rest}", parts.join("/"))
    } else {
        path.to_string()
    }
}

static ENDPOINT_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^([^{0}:@/]*):([^{0}@/]+)@", super::value::JS_WS)).unwrap());

pub fn mask_endpoint(text: &str) -> String {
    let masked = redact_value(text);
    ENDPOINT_USERINFO
        .replace(&masked, |caps: &regex::Captures| {
            if &caps[2] == REDACTED {
                caps[0].to_string()
            } else {
                format!("{}:{REDACTED}@", &caps[1])
            }
        })
        .into_owned()
}
