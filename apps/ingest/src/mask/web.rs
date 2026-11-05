//! skilllane-monitoring/contract mask/web.js: query strings, URLs, cookies, header values,
//! `maskHeaders`, `maskMarkup`, `maskCsv`, `maskPathByRoute`, `maskEndpoint`. The markup and
//! CSV rules are hand-rolled: the SDK's regexes use backreferences (`<\/\1>`, a matching quote),
//! which the `regex` crate has no support for.

use super::keys::{is_sensitive_header, is_sensitive_key, is_sensitive_query_name, REDACTED};
use super::value::redact_value;
use crate::js::{is_js_whitespace, json_number_string};
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

/// JS `String(value)` of a JSON value: "null", numbers as JS prints them, arrays joined by ','
/// (null items empty), objects "[object Object]".
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).into(),
        Value::Number(n) => json_number_string(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() { String::new() } else { js_string(v) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn header_text(value: &Value) -> String {
    js_string(value)
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

// ---------- maskMarkup ----------

fn is_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

/// `[\w:.-]` of a tag name (JS `\w` = [A-Za-z0-9_]).
fn is_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-')
}

fn find_from(text: &str, from: usize, needle: &str) -> Option<usize> {
    if from > text.len() {
        return None;
    }
    text[from..].find(needle).map(|rel| from + rel)
}

/// The char at `i` when it is JS whitespace: its byte length.
fn ws_len(text: &str, i: usize) -> Option<usize> {
    text[i..].chars().next().filter(|c| is_js_whitespace(*c)).map(char::len_utf8)
}

/// `<([A-Za-z_][\w:.-]*)` at `at` (the '<'): the end of the name.
fn tag_name_end(text: &str, at: usize) -> Option<usize> {
    let b = text.as_bytes();
    if at + 1 >= b.len() || !is_name_start(b[at + 1]) {
        return None;
    }
    let mut end = at + 2;
    while end < b.len() && is_name_char(b[end]) {
        end += 1;
    }
    Some(end)
}

/// The end of `((?:[^<]|<!\[CDATA\[[\s\S]*?\]\]>)*)` before `close`, with the regex's
/// backtracking (a lazy CDATA section stretches to a later `]]>` when the close tag is not
/// found otherwise).
fn content_end(text: &str, from: usize, close: &str) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    let mut stack: Vec<usize> = Vec::new();
    let mut i = from;
    loop {
        while i < n && b[i] != b'<' {
            i += 1;
        }
        if text[i..].starts_with(close) {
            return Some(i);
        }
        if text[i..].starts_with("<![CDATA[") {
            if let Some(k) = find_from(text, i + 9, "]]>") {
                stack.push(k);
                i = k + 3;
                continue;
            }
        }
        loop {
            let k = stack.pop()?;
            if let Some(k2) = find_from(text, k + 1, "]]>") {
                stack.push(k2);
                i = k2 + 3;
                break;
            }
        }
    }
}

const NAME_WORDS: &[&str] = &["name", "key", "id", "field", "param", "property"];

fn starts_with_ignore_case(text: &str, at: usize, word: &str) -> bool {
    text.len() >= at + word.len() && text.as_bytes()[at..at + word.len()].eq_ignore_ascii_case(word.as_bytes())
}

/// `\s*=\s*(["'])([^"']*)\1` at `at`: (quote position, inner start, end after the closing quote).
fn quoted_value_at(text: &str, at: usize) -> Option<(usize, usize, usize)> {
    let b = text.as_bytes();
    let mut i = at;
    while let Some(len) = ws_len(text, i) {
        i += len;
    }
    if i >= b.len() || b[i] != b'=' {
        return None;
    }
    i += 1;
    while let Some(len) = ws_len(text, i) {
        i += len;
    }
    if i >= b.len() || !matches!(b[i], b'"' | b'\'') {
        return None;
    }
    let quote = b[i];
    let inner = i + 1;
    let mut j = inner;
    while j < b.len() && !matches!(b[j], b'"' | b'\'') {
        j += 1;
    }
    if j < b.len() && b[j] == quote {
        Some((i, inner, j + 1))
    } else {
        None
    }
}

/// `NAME_ATTRIBUTE.exec(attrs)?.[2]`: the value of the first name / key / id / field / param /
/// property attribute.
fn name_attribute(attrs: &str) -> Option<&str> {
    let mut j = 0;
    while j <= attrs.len() {
        let mut starts: Vec<usize> = Vec::new();
        if j == 0 {
            starts.push(0);
        }
        if let Some(len) = ws_len(attrs, j) {
            starts.push(j + len);
        }
        for start in starts {
            for word in NAME_WORDS {
                if starts_with_ignore_case(attrs, start, word) {
                    if let Some((_, inner, end)) = quoted_value_at(attrs, start + word.len()) {
                        return Some(&attrs[inner..end - 1]);
                    }
                }
            }
        }
        if j >= attrs.len() {
            break;
        }
        j += attrs[j..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

fn named_secret(attrs: &str) -> bool {
    !attrs.is_empty() && name_attribute(attrs).is_some_and(is_sensitive_key)
}

/// `attrs.replace(VALUE_ATTRIBUTE, '$1$2[REDACTED]$2')`: every value= / content= attribute.
fn redact_value_attributes(attrs: &str) -> String {
    let mut out = String::with_capacity(attrs.len());
    let mut last = 0;
    let mut j = 0;
    while j < attrs.len() {
        if let Some(len) = ws_len(attrs, j) {
            let start = j + len;
            let mut matched = None;
            for word in ["value", "content"] {
                if starts_with_ignore_case(attrs, start, word) {
                    if let Some((quote, inner, end)) = quoted_value_at(attrs, start + word.len()) {
                        matched = Some((quote, inner, end));
                        break;
                    }
                }
            }
            if let Some((quote, inner, end)) = matched {
                out.push_str(&attrs[last..inner]);
                out.push_str(REDACTED);
                out.push_str(&attrs[quote..quote + 1]);
                last = end;
                j = end;
                continue;
            }
        }
        j += attrs[j..].chars().next().map_or(1, char::len_utf8);
    }
    out.push_str(&attrs[last..]);
    out
}

/// XML / HTML text: an element named like a secret (or whose name= / key= / id= … attribute
/// is), and a start tag whose value= / content= belongs to such a name → [REDACTED].
pub fn mask_markup(text: &str) -> String {
    if !text.contains('<') {
        return text.to_string();
    }
    let b = text.as_bytes();
    // pass 1: XML_ELEMENT
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while let Some(at) = find_from(text, i, "<") {
        i = at + 1;
        let Some(name_end) = tag_name_end(text, at) else { continue };
        let name = &text[at + 1..name_end];
        let (attrs, open_end) = if name_end < b.len() && b[name_end] == b'>' {
            ("", name_end + 1)
        } else if let Some(len) = ws_len(text, name_end) {
            let mut j = name_end + len;
            while j < b.len() && b[j] != b'<' && b[j] != b'>' {
                j += 1;
            }
            if j >= b.len() || b[j] != b'>' {
                continue;
            }
            (&text[name_end..j], j + 1)
        } else {
            continue;
        };
        let close = format!("</{name}>");
        let Some(content_at) = content_end(text, open_end, &close) else { continue };
        let end = content_at + close.len();
        if is_sensitive_key(name) || named_secret(attrs) {
            out.push_str(&text[last..at]);
            out.push_str(&format!("<{name}{attrs}>{REDACTED}</{name}>"));
            last = end;
        }
        i = end;
    }
    out.push_str(&text[last..]);
    // pass 2: START_TAG
    let text = out;
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while let Some(at) = find_from(&text, i, "<") {
        i = at + 1;
        let Some(name_end) = tag_name_end(&text, at) else { continue };
        let Some(len) = ws_len(&text, name_end) else { continue };
        let mut j = name_end + len;
        let mut found = None;
        while j < b.len() {
            if b[j] == b'/' && j + 1 < b.len() && b[j + 1] == b'>' {
                found = Some((j, "/", j + 2));
                break;
            }
            if b[j] == b'>' {
                found = Some((j, "", j + 1));
                break;
            }
            if b[j] == b'<' {
                break;
            }
            j += text[j..].chars().next().map_or(1, char::len_utf8);
        }
        let Some((attrs_end, close, end)) = found else { continue };
        let name = &text[at + 1..name_end];
        let attrs = &text[name_end..attrs_end];
        if named_secret(attrs) {
            out.push_str(&text[last..at]);
            out.push_str(&format!("<{name}{}{close}>", redact_value_attributes(attrs)));
            last = end;
        }
        i = end;
    }
    out.push_str(&text[last..]);
    out
}

// ---------- maskCsv ----------

fn csv_cells(line: &str, separator: u8) -> Vec<&str> {
    let b = line.as_bytes();
    let mut cells = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in b.iter().enumerate() {
        if *c == b'"' {
            quoted = !quoted;
        } else if *c == separator && !quoted {
            cells.push(&line[start..i]);
            start = i + 1;
        }
    }
    cells.push(&line[start..]);
    cells
}

fn unquote(cell: &str) -> String {
    let trimmed = cell.trim_matches(is_js_whitespace);
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].replace("\"\"", "\"")
    } else {
        trimmed.to_string()
    }
}

/// `text.split(/(\r?\n)/)`: lines and the separators between them, alternating.
fn split_lines_keep(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            let sep_start = if i > 0 && b[i - 1] == b'\r' && i - 1 >= start { i - 1 } else { i };
            parts.push(&text[start..sep_start]);
            parts.push(&text[sep_start..i + 1]);
            start = i + 1;
        }
        i += 1;
    }
    parts.push(&text[start..]);
    parts
}

/// CSV text whose header names a secret column: that column's cells → [REDACTED].
pub fn mask_csv(text: &str) -> String {
    let mut parts: Vec<String> = split_lines_keep(text).into_iter().map(str::to_string).collect();
    let header = parts.first().cloned().unwrap_or_default();
    let mut separator = b',';
    let count = |sep: u8| header.bytes().filter(|c| *c == sep).count();
    for candidate in [b';', b'\t', b'|'] {
        if count(candidate) > count(separator) {
            separator = candidate;
        }
    }
    let secret: Vec<bool> = csv_cells(&header, separator).iter().map(|cell| is_sensitive_key(&unquote(cell))).collect();
    if !secret.iter().any(|s| *s) {
        return text.to_string();
    }
    let sep = (separator as char).to_string();
    let mut i = 2;
    while i < parts.len() {
        if !parts[i].is_empty() {
            let cells = csv_cells(&parts[i], separator);
            parts[i] = cells
                .iter()
                .enumerate()
                .map(|(index, cell)| if secret.get(index).copied().unwrap_or(false) { REDACTED } else { cell })
                .collect::<Vec<_>>()
                .join(&sep);
        }
        i += 2;
    }
    parts.concat()
}
