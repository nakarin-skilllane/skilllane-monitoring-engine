//! skilllane-monitoring/contract mask/redis.js: `maskRedisKey`, `maskIdentifier`,
//! `isSensitiveRedisKey`, `quoteRedisArg` and `redisCommand` (a command line of a Redis call
//! with its secrets masked and its length capped).

use super::keys::{is_sensitive_key, REDACTED};
use super::value::{mask_json_text, redact_value, truncate_utf8};
use super::web::js_string;
use crate::js::{is_js_whitespace, string_to_number};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

static SECRET_PREFIXES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    ["pwreset", "reset", "verify", "verification", "magic", "invite", "confirm", "csrf", "nonce"].into_iter().collect()
});

fn key_like(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| is_js_whitespace(c) || matches!(c, '"' | '\'' | '{' | '}' | '[' | ']'))
}

pub fn mask_redis_key(key: &str) -> String {
    if !key.contains(':') || !key_like(key) {
        return key.to_string();
    }
    let segments: Vec<&str> = key.split(':').collect();
    for i in 0..segments.len() - 1 {
        let segment = segments[i];
        if !segment.is_empty() && (is_sensitive_key(segment) || SECRET_PREFIXES.contains(segment.to_lowercase().as_str())) {
            let rest = segments[i + 1..].join(":");
            return if rest == REDACTED { key.to_string() } else { format!("{}:{REDACTED}", segments[..=i].join(":")) };
        }
    }
    key.to_string()
}

pub fn mask_identifier(text: &str) -> String {
    redact_value(&mask_redis_key(text))
}

pub fn is_sensitive_redis_key(key: &str) -> bool {
    !key.is_empty() && (is_sensitive_key(key) || mask_redis_key(key) != key)
}

fn eq_any_ci(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.eq_ignore_ascii_case(w))
}

const KEY_VALUE: &[&str] = &[
    "set", "setnx", "setex", "psetex", "getset", "append", "setrange", "lpush", "rpush", "lpushx", "rpushx", "lset",
    "linsert", "lrem", "sadd", "srem", "sismember", "smismember", "zadd", "zrem", "publish", "spublish", "pfadd",
];
const FIELD_VALUE: &[&str] = &["hset", "hsetnx", "hmset"];
const PAIRS: &[&str] = &["mset", "msetnx"];
const EVAL: &[&str] = &["eval", "evalsha", "eval_ro", "evalsha_ro", "fcall", "fcall_ro"];
const SET_OPTIONS: &[&str] = &["EX", "PX", "EXAT", "PXAT", "NX", "XX", "KEEPTTL", "GET"];
const EXPIRES: &[&str] = &["EX", "PX", "EXAT", "PXAT"];

fn is_control(c: char) -> bool {
    (c as u32) < 0x20 || c == '\u{7f}'
}

fn mask_arg(text: &str, cut: bool) -> String {
    let key = mask_redis_key(text);
    if key != text {
        return key;
    }
    if cut {
        let first = text.trim_start_matches(is_js_whitespace).chars().next();
        if matches!(first, Some('{') | Some('[')) {
            return mask_json_text(text, false);
        }
    }
    redact_value(text)
}

pub fn quote_redis_arg(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".into();
    }
    let control = text.chars().any(is_control);
    if !control && !text.chars().any(|c| is_js_whitespace(c) || matches!(c, '"' | '\'' | '\\')) {
        return text.to_string();
    }
    if !control && !text.contains('\'') && !text.ends_with('\\') {
        return format!("'{text}'");
    }
    let mut escaped = String::with_capacity(text.len() + 2);
    for c in text.chars() {
        match c {
            '\\' | '"' => {
                escaped.push('\\');
                escaped.push(c);
            }
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if is_control(c) => escaped.push_str(&format!("\\x{:02x}", c as u32)),
            c => escaped.push(c),
        }
    }
    format!("\"{escaped}\"")
}

fn keeps_arg(command: &str, args: &[String], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    if (command == "setex" || command == "psetex") && index == 1 {
        return true;
    }
    command == "set" && index >= 2 && (eq_any_ci(&args[index], SET_OPTIONS) || eq_any_ci(&args[index - 1], EXPIRES))
}

fn pass_or_auth(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("pass") || lower.contains("auth")
}

fn mask_args(command: &str, args: &[String], cut: &[bool]) -> Vec<String> {
    let value = |i: usize| mask_arg(&args[i], cut[i]);
    let redacted = || REDACTED.to_string();
    if command == "auth" {
        return args.iter().map(|_| redacted()).collect();
    }
    if command == "hello" {
        let auth = args.iter().position(|arg| arg.to_lowercase() == "auth");
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| match auth {
                Some(a) if i > a && i <= a + 2 => redacted(),
                _ => arg.clone(),
            })
            .collect();
    }
    if command == "config" && args.first().is_some_and(|a| a.to_lowercase() == "set") {
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if i >= 2 && i % 2 == 0 && (is_sensitive_key(&args[i - 1]) || pass_or_auth(&args[i - 1])) {
                    redacted()
                } else {
                    arg.clone()
                }
            })
            .collect();
    }
    if command == "acl" {
        return args
            .iter()
            .map(|arg| if arg.starts_with(['>', '#', '<', '!']) { redacted() } else { arg.clone() })
            .collect();
    }
    if command == "migrate" {
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                let before = if i >= 1 { Some(args[i - 1].to_uppercase()) } else { None };
                let before2 = if i >= 2 { Some(args[i - 2].to_uppercase()) } else { None };
                if before.as_deref() == Some("AUTH") || before2.as_deref() == Some("AUTH2") {
                    return redacted();
                }
                if before.as_deref() == Some("AUTH2") {
                    arg.clone()
                } else {
                    mask_redis_key(arg)
                }
            })
            .collect();
    }
    if eq_any_ci(command, EVAL) {
        let numkeys = args.get(1).map(|a| string_to_number(a)).unwrap_or(f64::NAN);
        let key_count = if numkeys.is_finite() && numkeys.fract() == 0.0 && numkeys >= 0.0 { numkeys as usize } else { 0 };
        let secret = args.iter().skip(2).take(key_count).any(|k| is_sensitive_redis_key(k));
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if i < 2 {
                    arg.clone()
                } else if i < 2 + key_count {
                    mask_redis_key(arg)
                } else if secret {
                    redacted()
                } else {
                    value(i)
                }
            })
            .collect();
    }
    if eq_any_ci(command, KEY_VALUE) && args.first().is_some_and(|k| is_sensitive_redis_key(k)) {
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if keeps_arg(command, args, i) {
                    if i == 0 {
                        mask_redis_key(arg)
                    } else {
                        arg.clone()
                    }
                } else {
                    redacted()
                }
            })
            .collect();
    }
    if eq_any_ci(command, FIELD_VALUE) {
        let secret_key = args.first().is_some_and(|k| is_sensitive_redis_key(k));
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if i == 0 {
                    mask_redis_key(arg)
                } else if i % 2 == 1 {
                    arg.clone()
                } else if secret_key || is_sensitive_key(&args[i - 1]) {
                    redacted()
                } else {
                    value(i)
                }
            })
            .collect();
    }
    if command == "xadd" {
        let at = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
        let mut i = 1;
        if at(i).eq_ignore_ascii_case("NOMKSTREAM") {
            i += 1;
        }
        if eq_any_ci(at(i), &["MAXLEN", "MINID"]) {
            i += 1;
            if at(i) == "=" || at(i) == "~" {
                i += 1;
            }
            i += 1;
            if at(i).eq_ignore_ascii_case("LIMIT") {
                i += 2;
            }
        }
        let id = i;
        let secret_key = args.first().is_some_and(|k| is_sensitive_redis_key(k));
        return args
            .iter()
            .enumerate()
            .map(|(k, arg)| {
                if k == 0 {
                    mask_redis_key(arg)
                } else if k <= id || (k - id) % 2 == 1 {
                    arg.clone()
                } else if secret_key || is_sensitive_key(&args[k - 1]) {
                    redacted()
                } else {
                    value(k)
                }
            })
            .collect();
    }
    if eq_any_ci(command, PAIRS) {
        return args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if i % 2 == 0 {
                    mask_redis_key(arg)
                } else if is_sensitive_redis_key(&args[i - 1]) {
                    redacted()
                } else {
                    value(i)
                }
            })
            .collect();
    }
    (0..args.len()).map(value).collect()
}

/// `flatten(args)`: arrays recursively; an object yields its keys and values (values as they
/// are); anything else as is.
fn flatten<'a>(args: &'a [Value], out: &mut Vec<&'a Value>) {
    for arg in args {
        match arg {
            Value::Array(items) => flatten(items, out),
            other => out.push(other),
        }
    }
}

/// The argument texts of `rawArgs` (JS `String()` of each; '' for null), by UTF-16 length.
fn argument_values(raw: &Value) -> Vec<Value> {
    let mut flat: Vec<&Value> = Vec::new();
    let items: Vec<Value> = match raw {
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    flatten(&items, &mut flat);
    let mut out = Vec::new();
    for v in flat {
        match v {
            Value::Object(map) => {
                for (key, value) in map {
                    out.push(Value::String(key.clone()));
                    out.push(value.clone());
                }
            }
            other => out.push(other.clone()),
        }
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, units)` by UTF-16 units, never cutting a character.
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

fn piece(arg: &Value, room: i64) -> (String, bool) {
    let text = match arg {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => js_string(other),
    };
    if room >= 0 && utf16_len(&text) > room as usize {
        (slice_utf16(&text, room as usize).to_string(), true)
    } else {
        (text, false)
    }
}

const MARK_RESERVE: i64 = 32;

/// `redisCommand(name, rawArgs, maxBytes)`: one line of the command and its arguments, masked
/// and capped at `max_bytes` (an omitted tail is counted: ` (n more)`).
pub fn redis_command(name: &str, raw_args: &Value, max_bytes: usize) -> String {
    let command = name.to_string();
    let lower = command.to_lowercase();
    let mut room: i64 = max_bytes as i64 - command.len() as i64;
    let mut args: Vec<String> = Vec::new();
    let mut cut: Vec<bool> = Vec::new();
    let mut omitted = 0usize;
    for arg in argument_values(raw_args) {
        if room <= 0 {
            omitted += 1;
            continue;
        }
        let (text, was_cut) = piece(&arg, room);
        room -= text.len() as i64 + 1;
        args.push(text);
        cut.push(was_cut);
    }
    let masked = mask_args(&lower, &args, &cut);
    let limit = max_bytes as i64 - MARK_RESERVE;
    let mut out = command.clone();
    let mut bytes = out.len() as i64;
    for i in 0..masked.len() {
        let text = quote_redis_arg(&masked[i]);
        let more = cut[i];
        let size = text.len() as i64 + 1;
        if bytes + size > limit {
            let kept = truncate_utf8(&masked[i], (limit - bytes - 8).max(0) as usize).text;
            omitted += masked.len() - i - if kept.is_empty() { 0 } else { 1 };
            if kept.is_empty() {
                out.push_str(" …");
            } else {
                out.push_str(&format!(" {} …", quote_redis_arg(&kept)));
            }
            break;
        }
        out.push(' ');
        out.push_str(&text);
        if more {
            out.push_str(" …");
        }
        bytes += size + if more { 2 } else { 0 };
    }
    if omitted > 0 {
        out.push_str(&format!(" ({omitted} more)"));
    }
    truncate_utf8(&out, max_bytes).text
}
