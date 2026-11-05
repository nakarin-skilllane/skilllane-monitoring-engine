//! skilllane-monitoring/contract mask/keys.js: which names mean a secret.

use regex::Regex;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const REDACTED: &str = "[REDACTED]";
pub const MASK_VERSION: f64 = 2.0;
pub const MASK_RESOURCE_KEY: &str = "skilllane.monitoring.mask";

pub const SENSITIVE_KEYS: &[&str] = &[
    "password", "confirmpassword", "token", "secret", "authorization", "cookie", "session", "passwd", "pwd",
    "apikey", "api_key", "api-key", "credential", "privatekey", "private_key",
];
pub const SENSITIVE_WORDS: &[&str] = &[
    "pass", "pw", "pwd", "pin", "otp", "totp", "cvv", "cvc", "passcode", "passphrase", "sid", "sess", "sig",
    "signature", "auth", "authentication", "oauth", "jwt", "refresh", "creds",
];
const KEY_QUALIFIERS: &[&str] = &[
    "api", "access", "secret", "private", "client", "signing", "encryption", "master", "ssh", "hmac", "jwt", "license",
];
pub const METADATA_WORDS: &[&str] = &[
    "type", "at", "date", "time", "ts", "changed", "updated", "created", "expires", "expiry", "expired", "exp", "ttl",
    "timeout", "interval", "period", "length", "min", "max", "policy", "required", "enabled", "count", "strength",
    "hint", "name", "consent", "format", "version",
];
pub const SENSITIVE_HEADERS: &[&str] = &["authorization", "proxy-authorization", "cookie", "set-cookie"];
pub const SENSITIVE_QUERY_NAMES: &[&str] = &["code", "key", "ticket"];

static WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| SENSITIVE_WORDS.iter().copied().collect());
static METADATA: LazyLock<HashSet<&'static str>> = LazyLock::new(|| METADATA_WORDS.iter().copied().collect());
static QUALIFIERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| KEY_QUALIFIERS.iter().copied().collect());
static QUERY_NAMES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| SENSITIVE_QUERY_NAMES.iter().copied().collect());
static HEADERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| SENSITIVE_HEADERS.iter().copied().collect());
static CAMEL1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static CAMEL2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Z]+)([A-Z][a-z])").unwrap());
static QUALIFIED_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("^({})key$", KEY_QUALIFIERS.join("|"))).unwrap()
});

/// Words of a key: camelCase split, lower-cased, non-alphanumerics as separators.
pub fn key_words(key: &str) -> Vec<String> {
    let spaced = CAMEL1.replace_all(key, "$1 $2");
    let spaced = CAMEL2.replace_all(&spaced, "$1 $2");
    spaced
        .to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

fn judge(key: &str) -> bool {
    let words = key_words(key);
    let last = words.last().map(String::as_str).unwrap_or("");
    if words.len() > 1 && METADATA.contains(last) {
        return false;
    }
    let lower = key.to_lowercase();
    if SENSITIVE_KEYS.iter().any(|word| lower.contains(*word)) {
        return true;
    }
    if words.iter().any(|word| WORDS.contains(word.as_str())) {
        return true;
    }
    if last == "key" {
        return words.iter().any(|word| QUALIFIERS.contains(word.as_str()));
    }
    words.len() == 1 && QUALIFIED_KEY.is_match(last)
}

const CACHE_MAX: usize = 10_000;
const CACHE_KEY_MAX: usize = 64;

thread_local! {
    static VERDICTS: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
}

pub fn is_sensitive_key(key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    if let Some(known) = VERDICTS.with(|v| v.borrow().get(key).copied()) {
        return known;
    }
    let verdict = judge(key);
    if key.len() <= CACHE_KEY_MAX {
        VERDICTS.with(|v| {
            let mut v = v.borrow_mut();
            if v.len() >= CACHE_MAX {
                v.clear();
            }
            v.insert(key.to_string(), verdict);
        });
    }
    verdict
}

pub fn is_sensitive_query_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    QUERY_NAMES.contains(name.to_lowercase().as_str()) || is_sensitive_key(name)
}

pub fn is_sensitive_header(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    HEADERS.contains(name.to_lowercase().as_str()) || is_sensitive_key(name)
}
