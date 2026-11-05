//! skilllane-monitoring/contract mask/value.js: the value rule (`redactValue`), the text rule
//! (`redactText`), JSON masking (`maskJsonText`, `maskJsonValue`) and `truncateUtf8`.
//! The SDK's EMAIL_RUN, THAI_ID and PAIR regexes use lookbehind; here they are hand scanners
//! with the same semantics (the cases in bench/fixture/mask-cases.json decide).

use super::keys::{is_sensitive_key, is_sensitive_query_name, REDACTED};
use crate::js::{stringify, write_json_string};
use regex::{NoExpand, Regex};
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// JS `\s` (no `u` flag) as a regex character-class body.
pub const JS_WS: &str = r"\t\n\x0B\x0C\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap());
static EMAIL_BOUNDED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}").unwrap());
const EMAIL_RUN_MAX: usize = 1_024;
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap());
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)(?-u:\b)(Bearer|Basic)[{JS_WS}]+[A-Za-z0-9._~+/=-]+")).unwrap());
static BEARER_HINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)bearer|basic").unwrap());
static USERINFO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)(?-u:\b)([a-z][a-z0-9+.-]*://)([^{JS_WS}:@/?#\[\]]*)(?::([^{JS_WS}@/?#]*))?@")).unwrap()
});
static URL_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"((?:https?://[^{JS_WS}?#"']+)|(?:/[A-Za-z0-9_\-./%~]*))\?[^{JS_WS}#"']*"#)).unwrap()
});
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?::(?:\.\.\.)?[A-Za-z0-9_$#]+|\?|\$[0-9]+|@[A-Za-z0-9_]+)$").unwrap());
static NUMERIC_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?\.?[0-9]").unwrap());
static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z][A-Za-z0-9_.+-]*)[ \t]+[^\s]").unwrap());
const MAX_DEPTH: usize = 32;
const QUOTED_REDACTED: &str = "\"[REDACTED]\"";

pub fn is_thai_national_id(digits: &str) -> bool {
    let b = digits.as_bytes();
    if b.len() != 13 || !b.iter().all(u8::is_ascii_digit) || b[0] == b'0' {
        return false;
    }
    let mut sum = 0u32;
    for (i, c) in b.iter().take(12).enumerate() {
        sum += (c - b'0') as u32 * (13 - i as u32);
    }
    (11 - (sum % 11)) % 10 == (b[12] - b'0') as u32
}

pub fn strip_query(path: &str) -> &str {
    match path.find('?') {
        Some(i) => &path[..i],
        None => path,
    }
}

fn is_run_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'@' | b'-')
}

/// EMAIL_RUN `(?<![A-Za-z0-9._%+@-])[A-Za-z0-9._%+@-]+`: maximal runs of the class; a run with
/// an @ has its email matches replaced (the bounded pattern on a run over 1,024 chars).
fn redact_emails(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        if !is_run_char(b[i]) {
            let start = i;
            while i < b.len() && !is_run_char(b[i]) {
                i += 1;
            }
            out.push_str(&text[start..i]);
            continue;
        }
        let start = i;
        while i < b.len() && is_run_char(b[i]) {
            i += 1;
        }
        let run = &text[start..i];
        if run.contains('@') {
            let re: &Regex = if run.len() > EMAIL_RUN_MAX { &*EMAIL_BOUNDED } else { &*EMAIL };
            out.push_str(&re.replace_all(run, NoExpand(REDACTED)));
        } else {
            out.push_str(run);
        }
    }
    out
}

fn has_digits5(text: &str) -> bool {
    let mut run = 0;
    for b in text.bytes() {
        if b.is_ascii_digit() {
            run += 1;
            if run == 5 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// THAI_ID `(?<!\d)(\d)-?(\d{4})-?(\d{5})-?(\d{2})-?(\d)(?!\d)`: a match at `i` (bytes), with the
/// 13 digits, when one starts there.
fn thai_id_at(b: &[u8], i: usize) -> Option<(usize, String)> {
    let mut digits = String::with_capacity(13);
    let mut p = i;
    for (g, count) in [1usize, 4, 5, 2, 1].into_iter().enumerate() {
        if g > 0 && p < b.len() && b[p] == b'-' {
            p += 1;
        }
        for _ in 0..count {
            if p >= b.len() || !b[p].is_ascii_digit() {
                return None;
            }
            digits.push(b[p] as char);
            p += 1;
        }
    }
    if p < b.len() && b[p].is_ascii_digit() {
        return None;
    }
    Some((p, digits))
}

fn redact_thai_ids(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
            if let Some((end, digits)) = thai_id_at(b, i) {
                if is_thai_national_id(&digits) {
                    out.push_str(&text[last..i]);
                    out.push_str(REDACTED);
                    last = end;
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    if last == 0 {
        return text.to_string();
    }
    out.push_str(&text[last..]);
    out
}

fn line_end(b: &[u8], from: usize) -> usize {
    for (i, c) in b.iter().enumerate().skip(from) {
        if *c == b'\n' || *c == b'\r' {
            return i;
        }
    }
    b.len()
}

fn quote_end(b: &[u8], start: usize, quote: u8) -> Option<usize> {
    let mut i = start + 1;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            i += 2;
            continue;
        }
        if c == quote {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn container_end(b: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut i = start;
    while i < b.len() {
        let c = b[i];
        if c == b'"' {
            match quote_end(b, i, b'"') {
                Some(end) => i = end,
                None => return b.len(),
            }
        } else if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    b.len()
}

fn bare_stop(c: u8, json: bool) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b',' | b'"' | b'\'' | b'&' | b';') || (json && (c == b'}' || c == b']'))
}

#[derive(Clone, Copy)]
struct Mode {
    sql: bool,
    json: bool,
}

/// The value after `name =` at `p`: where it ends and what replaces it (None: leave it).
fn masked_value(text: &str, p: usize, name: &str, mode: Mode) -> (usize, Option<String>) {
    let b = text.as_bytes();
    if p >= b.len() {
        return (p, None);
    }
    let c = b[p];
    if c == b'"' || c == b'\'' {
        let q = c as char;
        return match quote_end(b, p, c) {
            None => (if mode.json { b.len() } else { line_end(b, p) }, Some(format!("{q}{REDACTED}"))),
            Some(close) => (
                close + 1,
                if &text[p + 1..close] == REDACTED { None } else { Some(format!("{q}{REDACTED}{q}")) },
            ),
        };
    }
    if c == b'\\' && p + 1 < b.len() && (b[p + 1] == b'"' || b[p + 1] == b'\'') {
        let quote = &text[p..p + 2];
        return match text[p + 2..].find(quote) {
            None => (line_end(b, p), Some(format!("{quote}{REDACTED}"))),
            Some(rel) => (p + 2 + rel + 2, Some(format!("{quote}{REDACTED}{quote}"))),
        };
    }
    let lower = name.to_lowercase();
    if !mode.json && !mode.sql && (lower.ends_with("authorization") || lower == "cookie" || lower == "set-cookie") {
        let end = line_end(b, p);
        let rest = &text[p..end];
        let masked = match SCHEME.captures(rest) {
            Some(m) => format!("{} {}", &m[1], REDACTED),
            None => REDACTED.to_string(),
        };
        return (end, if masked == rest { None } else { Some(masked) });
    }
    if mode.json && (c == b'{' || c == b'[') {
        return (container_end(b, p), Some(QUOTED_REDACTED.to_string()));
    }
    let mut end = p;
    while end < b.len() && !bare_stop(b[end], mode.json) {
        end += 1;
    }
    if end == p {
        return (p, None);
    }
    let value = &text[p..end];
    if value == REDACTED {
        return (end, None);
    }
    if mode.sql && (PLACEHOLDER.is_match(value) || !NUMERIC_START.is_match(value)) {
        return (end, None);
    }
    (end, Some(REDACTED.to_string()))
}

fn is_name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-')
}

struct Pair {
    start: usize,
    name_start: usize,
    name_end: usize,
    /// End of the whole match (after the operator and its trailing blanks).
    end: usize,
}

/// `[ \t]*(===|=>|:=|==|[:=])[ \t]*` at `q`: the end of the match.
fn operator_end(b: &[u8], mut q: usize) -> Option<usize> {
    while q < b.len() && (b[q] == b' ' || b[q] == b'\t') {
        q += 1;
    }
    let rest = &b[q..];
    let len = if rest.starts_with(b"===") {
        3
    } else if rest.starts_with(b"=>") || rest.starts_with(b":=") || rest.starts_with(b"==") {
        2
    } else if rest.first().is_some_and(|c| *c == b':' || *c == b'=') {
        1
    } else {
        return None;
    };
    q += len;
    while q < b.len() && (b[q] == b' ' || b[q] == b'\t') {
        q += 1;
    }
    Some(q)
}

/// A name of 1..64 name chars at `q` that is not followed by another name char.
fn name_run(b: &[u8], q: usize) -> Option<usize> {
    let mut end = q;
    while end < b.len() && is_name_char(b[end]) {
        end += 1;
        if end - q > 64 {
            return None;
        }
    }
    if end == q {
        None
    } else {
        Some(end)
    }
}

/// PAIR `(?:(\\?["'])([A-Za-z0-9_.-]{1,64})\1|(?<![A-Za-z0-9_.\-\\])([A-Za-z0-9_.-]{1,64}))[ \t]*(===|=>|:=|==|[:=])[ \t]*`
/// as `exec` would find it from `from`: the first match at the lowest position.
fn find_pair(text: &str, from: usize) -> Option<Pair> {
    let b = text.as_bytes();
    let mut p = from;
    while p < b.len() {
        // alternative 1: quoted name
        let mut q = p;
        let backslash = b[q] == b'\\';
        if backslash {
            q += 1;
        }
        if q < b.len() && (b[q] == b'"' || b[q] == b'\'') {
            let quote = b[q];
            let name_start = q + 1;
            if let Some(name_end) = name_run(b, name_start) {
                let closed = if backslash {
                    name_end + 1 < b.len() && b[name_end] == b'\\' && b[name_end + 1] == quote
                } else {
                    name_end < b.len() && b[name_end] == quote
                };
                if closed {
                    let after = name_end + if backslash { 2 } else { 1 };
                    if let Some(end) = operator_end(b, after) {
                        return Some(Pair { start: p, name_start, name_end, end });
                    }
                }
            }
        }
        // alternative 2: bare name, not preceded by a name char or a backslash
        if is_name_char(b[p]) && (p == 0 || !(is_name_char(b[p - 1]) || b[p - 1] == b'\\')) {
            if let Some(name_end) = name_run(b, p) {
                if let Some(end) = operator_end(b, name_end) {
                    return Some(Pair { start: p, name_start: p, name_end, end });
                }
            }
        }
        p += 1;
        while p < b.len() && (b[p] & 0xC0) == 0x80 {
            p += 1;
        }
    }
    None
}

fn redact_pairs(text: &str, mode: Mode) -> String {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut last_index = 0;
    let mut changed = false;
    while let Some(m) = find_pair(text, last_index) {
        last_index = m.end;
        let name = &text[m.name_start..m.name_end];
        let before = if m.start > 0 { b[m.start - 1] } else { 0 };
        let sensitive = if before == b'?' || before == b'&' || before == b'#' {
            is_sensitive_query_name(name)
        } else {
            is_sensitive_key(name)
        };
        if !sensitive {
            continue;
        }
        let (end, masked) = masked_value(text, m.end, name, mode);
        let Some(masked) = masked else { continue };
        out.push_str(&text[last..m.end]);
        out.push_str(&masked);
        last = end;
        changed = true;
        if last_index < end {
            last_index = end;
        }
    }
    if changed {
        out.push_str(&text[last..]);
        out
    } else {
        text.to_string()
    }
}

fn redact_userinfo(text: &str) -> String {
    USERINFO
        .replace_all(text, |caps: &regex::Captures| {
            let scheme = &caps[1];
            let user = &caps[2];
            match caps.get(3) {
                Some(password) => {
                    if password.as_str().is_empty() {
                        caps[0].to_string()
                    } else {
                        format!("{scheme}{user}:{REDACTED}@")
                    }
                }
                None => {
                    if !user.is_empty() && user != REDACTED {
                        format!("{scheme}{REDACTED}@")
                    } else {
                        caps[0].to_string()
                    }
                }
            }
        })
        .into_owned()
}

fn mask_json_in_text(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut first = 0;
    while first < b.len() && b[first] <= 32 {
        first += 1;
    }
    let open = *b.get(first)?;
    if open != b'{' && open != b'[' {
        return None;
    }
    let mut last = b.len() - 1;
    while last > first && b[last] <= 32 {
        last -= 1;
    }
    if b[last] != if open == b'{' { b'}' } else { b']' } {
        return None;
    }
    let mut parsed: Value = serde_json::from_str(text).ok()?;
    let mut changed = false;
    mask_parsed(&mut parsed, 0, &mut changed);
    Some(if changed { stringify(&parsed) } else { text.to_string() })
}

/// The value rule: secrets and personal data in one text → [REDACTED].
pub fn redact_value(text: &str) -> String {
    redact_value_mode(text, false)
}

pub fn redact_value_mode(text: &str, sql: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    if !sql {
        if let Some(json) = mask_json_in_text(text) {
            return json;
        }
    }
    let mut out: String = text.to_string();
    if out.contains("eyJ") {
        out = JWT.replace_all(&out, NoExpand(REDACTED)).into_owned();
    }
    if BEARER_HINT.is_match(&out) {
        out = BEARER.replace_all(&out, format!("$1 {REDACTED}").as_str()).into_owned();
    }
    if out.contains('@') && out.contains("://") {
        out = redact_userinfo(&out);
    }
    if out.contains('=') || out.contains(':') {
        out = redact_pairs(&out, Mode { sql, json: false });
    }
    if out.contains('@') {
        out = redact_emails(&out);
    }
    if has_digits5(&out) {
        out = redact_thai_ids(&out);
    }
    out
}

/// The text rule: the value rule after the query string of every URL is dropped.
pub fn redact_text(text: &str) -> String {
    if text.contains('?') {
        redact_value(&URL_QUERY.replace_all(text, "$1"))
    } else {
        redact_value(text)
    }
}

/// `maskNumber`: a 13-digit integer that is a Thai national id → [REDACTED].
pub fn is_masked_number(x: f64) -> bool {
    x.fract() == 0.0 && x.is_finite() && (1e12..1e13).contains(&x) && is_thai_national_id(&format!("{}", x as u64))
}

pub fn mask_number(value: &Value) -> Value {
    if let Value::Number(n) = value {
        if n.as_f64().is_some_and(is_masked_number) {
            return Value::String(REDACTED.into());
        }
    }
    value.clone()
}

fn mask_key(key: &str) -> String {
    if key.contains('@') || has_digits5(key) {
        redact_value(key)
    } else {
        key.to_string()
    }
}

fn rename_keys(record: Map<String, Value>, renamed: &[(String, String)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in record {
        let mut name = renamed.iter().find(|(k, _)| *k == key).map(|(_, n)| n.clone()).unwrap_or_else(|| key.clone());
        if let Some((_, base)) = renamed.iter().find(|(k, _)| *k == key) {
            let mut n = 2;
            while out.contains_key(&name) {
                name = format!("{base}#{n}");
                n += 1;
            }
        }
        out.insert(name, value);
    }
    out
}

fn mask_parsed(value: &mut Value, depth: usize, changed: &mut bool) {
    match value {
        Value::String(s) => {
            let masked = redact_value(s);
            if masked != *s {
                *changed = true;
                *s = masked;
            }
        }
        Value::Number(n) => {
            if n.as_f64().is_some_and(is_masked_number) {
                *changed = true;
                *value = Value::String(REDACTED.into());
            }
        }
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                *changed = true;
                *value = Value::String("[…]".into());
                return;
            }
            for item in items.iter_mut() {
                mask_parsed(item, depth + 1, changed);
            }
        }
        Value::Object(record) => {
            if depth >= MAX_DEPTH {
                *changed = true;
                *value = Value::String("[…]".into());
                return;
            }
            let mut renamed: Vec<(String, String)> = Vec::new();
            for (key, item) in record.iter_mut() {
                if is_sensitive_key(key) {
                    if item.as_str() != Some(REDACTED) {
                        *item = Value::String(REDACTED.into());
                        *changed = true;
                    }
                } else {
                    mask_parsed(item, depth + 1, changed);
                }
                let name = mask_key(key);
                if name != *key {
                    renamed.push((key.clone(), name));
                }
            }
            if !renamed.is_empty() {
                *changed = true;
                let taken = std::mem::take(record);
                *record = rename_keys(taken, &renamed);
            }
        }
        _ => {}
    }
}

pub fn mask_json_value(mut value: Value) -> Value {
    let mut changed = false;
    mask_parsed(&mut value, 0, &mut changed);
    value
}

/// `maskJsonText(text, complete)`: masked JSON; a text that does not parse (or is cut) goes
/// through the loose scanner.
pub fn mask_json_text(text: &str, complete: bool) -> String {
    let mut start = 0;
    let b = text.as_bytes();
    loop {
        if start < b.len() && b[start] <= 32 {
            start += 1;
        } else if text[start..].starts_with('\u{FEFF}') {
            start += 3;
        } else {
            break;
        }
    }
    let body = &text[start..];
    if complete {
        match serde_json::from_str::<Value>(body) {
            Ok(mut parsed) => {
                let mut changed = false;
                mask_parsed(&mut parsed, 0, &mut changed);
                return stringify(&parsed);
            }
            Err(_) => return mask_json_loose(body),
        }
    }
    mask_json_loose(body)
}

fn bom_at(text: &str, i: usize) -> bool {
    text.as_bytes()[i] == 0xEF && text[i..].starts_with('\u{FEFF}')
}

fn bare_end(text: &str, start: usize) -> usize {
    let b = text.as_bytes();
    let mut end = start;
    while end < b.len() {
        let c = b[end];
        if matches!(c, b',' | b'}' | b']' | b':' | b'{' | b'[' | b'"' | b'\'' | b' ' | b'\n' | b'\r' | b'\t')
            || bom_at(text, end)
            || (c == b'/' && end + 1 < b.len() && (b[end + 1] == b'*' || b[end + 1] == b'/'))
        {
            break;
        }
        end += 1;
    }
    if end == start {
        // one JS code unit; here: one char
        start + text[start..].chars().next().map_or(1, char::len_utf8)
    } else {
        end
    }
}

fn next_char(text: &str, from: usize) -> Option<u8> {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() {
        if b[i] > 32 && !bom_at(text, i) {
            return Some(b[i]);
        }
        i += 1;
    }
    None
}

fn token_text(token: &str, quote: u8, whole: bool) -> Option<String> {
    let inner = if whole { &token[1..token.len() - 1] } else { &token[1..] };
    if quote != b'"' || !whole || !inner.contains('\\') {
        return Some(inner.to_string());
    }
    serde_json::from_str::<String>(token).ok()
}

fn mask_string_token(token: &str, quote: u8, whole: bool) -> String {
    let Some(value) = token_text(token, quote, whole) else { return redact_value(token) };
    let masked = redact_value(&value);
    if masked == value {
        return token.to_string();
    }
    let q = quote as char;
    if !whole {
        return format!("{q}{masked}");
    }
    if quote == b'"' {
        let mut out = String::new();
        write_json_string(&masked, &mut out);
        out
    } else {
        format!("'{}'", masked.replace('\'', "\\'"))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Key,
    Colon,
    Value,
    After,
}

struct Frame {
    object: bool,
    phase: Phase,
    sensitive: bool,
}

fn mask_json_loose(text: &str) -> String {
    let b = text.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let mut stack: Vec<Frame> = Vec::new();
    let mut lost = false;
    let mut i = 0;
    while i < n {
        let c = b[i];
        let phase = stack.last().map_or(Phase::Value, |f| f.phase);
        let sensitive = stack.last().is_some_and(|f| f.object && f.sensitive && (phase == Phase::Value || phase == Phase::Colon));
        if matches!(c, b' ' | b'\n' | b'\r' | b'\t') {
            i += 1;
        } else if bom_at(text, i) {
            i += 3;
        } else if c == b'/' && i + 1 < n && (b[i + 1] == b'*' || b[i + 1] == b'/') {
            if b[i + 1] == b'*' {
                i = match text[i + 2..].find("*/") {
                    Some(rel) => i + 2 + rel + 2,
                    None => n,
                };
            } else {
                i = line_end(b, i);
            }
        } else if c == b'{' || c == b'[' {
            if phase != Phase::Value {
                lost = true;
            }
            if sensitive {
                out.push_str(QUOTED_REDACTED);
                if let Some(f) = stack.last_mut() {
                    f.phase = Phase::After;
                }
                i = container_end(b, i);
            } else {
                out.push(c as char);
                stack.push(Frame { object: c == b'{', phase: if c == b'{' { Phase::Key } else { Phase::Value }, sensitive: false });
                i += 1;
            }
        } else if c == b'}' || c == b']' {
            out.push(c as char);
            match stack.last() {
                None => lost = true,
                Some(f) => {
                    if f.object != (c == b'}') || (f.object && phase != Phase::After && phase != Phase::Key) {
                        lost = true;
                    }
                }
            }
            stack.pop();
            if let Some(f) = stack.last_mut() {
                f.phase = Phase::After;
            }
            i += 1;
        } else if c == b',' {
            out.push(',');
            if let Some(f) = stack.last_mut() {
                if phase != Phase::After {
                    lost = true;
                }
                f.phase = if f.object { Phase::Key } else { Phase::Value };
                f.sensitive = false;
            }
            i += 1;
        } else if c == b':' {
            out.push(':');
            match stack.last_mut() {
                Some(f) if f.phase == Phase::Colon => f.phase = Phase::Value,
                _ => lost = true,
            }
            i += 1;
        } else if c == b'"' || c == b'\'' {
            let end = quote_end(b, i, c);
            let whole = end.is_some();
            let token = match end {
                Some(e) => &text[i..e + 1],
                None => &text[i..],
            };
            let key_after_value = phase == Phase::After && whole && next_char(text, end.unwrap() + 1) == Some(b':');
            let in_object = stack.last().is_some_and(|f| f.object);
            if in_object && (phase == Phase::Key || key_after_value) {
                if key_after_value {
                    lost = true;
                }
                let key = token_text(token, c, whole).unwrap_or_else(|| token.to_string());
                let f = stack.last_mut().unwrap();
                f.sensitive = is_sensitive_key(&key);
                f.phase = Phase::Colon;
                let name = mask_key(&key);
                if name == key {
                    out.push_str(token);
                } else {
                    write_json_string(&name, &mut out);
                }
            } else {
                if phase != Phase::Value {
                    lost = true;
                }
                if sensitive {
                    out.push_str(QUOTED_REDACTED);
                } else {
                    out.push_str(&mask_string_token(token, c, whole));
                }
                if let Some(f) = stack.last_mut() {
                    f.phase = Phase::After;
                }
            }
            i = match end {
                Some(e) => e + 1,
                None => n,
            };
        } else {
            let end = bare_end(text, i);
            let token = &text[i..end];
            let in_object = stack.last().is_some_and(|f| f.object);
            if in_object && phase == Phase::Key && next_char(text, end) == Some(b':') {
                let f = stack.last_mut().unwrap();
                f.sensitive = is_sensitive_key(token);
                f.phase = Phase::Colon;
                out.push_str(token);
            } else {
                if phase != Phase::Value {
                    lost = true;
                }
                let thai = token.len() == 13 && token.bytes().all(|d| d.is_ascii_digit()) && is_thai_national_id(token);
                if sensitive || thai {
                    out.push_str(QUOTED_REDACTED);
                } else {
                    out.push_str(token);
                }
                if let Some(f) = stack.last_mut() {
                    f.phase = Phase::After;
                }
            }
            i = end;
        }
    }
    if lost {
        redact_pairs(&out, Mode { sql: false, json: true })
    } else {
        out
    }
}

pub struct Truncated {
    pub text: String,
    pub truncated: bool,
}

/// `truncateUtf8`: at most `max_bytes` of UTF-8, never a cut character.
pub fn truncate_utf8(text: &str, max_bytes: usize) -> Truncated {
    if text.len() <= max_bytes {
        return Truncated { text: text.to_string(), truncated: false };
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = text[..cut].to_string();
    while out.ends_with('\u{FFFD}') {
        out.pop();
    }
    Truncated { text: out, truncated: true }
}
