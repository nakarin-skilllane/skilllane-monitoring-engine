//! skilllane-monitoring/contract mask/redis.js: `maskRedisKey` and `maskIdentifier`
//! (`redisCommand` is not ported: no Redis statements are mapped by this prototype).

use super::keys::{is_sensitive_key, REDACTED};
use super::value::redact_value;
use std::collections::HashSet;
use std::sync::LazyLock;

static SECRET_PREFIXES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    ["pwreset", "reset", "verify", "verification", "magic", "invite", "confirm", "csrf", "nonce"].into_iter().collect()
});

fn key_like(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '{' | '}' | '[' | ']'))
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
