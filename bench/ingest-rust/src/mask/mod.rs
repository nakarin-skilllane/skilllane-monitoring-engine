//! The SDK's mask rules (skilllane-monitoring/contract src/mask), ported for the ingest.

pub mod io;
pub mod keys;
pub mod redis;
pub mod sql;
pub mod value;
pub mod web;

pub use io::{mask_body_text, mask_header_json, mask_statement};
pub use keys::{is_sensitive_header, is_sensitive_key, is_sensitive_query_name, MASK_RESOURCE_KEY, MASK_VERSION, REDACTED};
pub use redis::{mask_identifier, mask_redis_key};
pub use sql::mask_sql;
pub use value::{is_thai_national_id, mask_json_text, mask_json_value, mask_number, redact_text, redact_value, truncate_utf8};
pub use web::{mask_endpoint, mask_header_value, mask_headers, mask_path_by_route, mask_query, mask_url};

use crate::js::to_number;
use serde_json::{Map, Value};

/// The sender masked its items with these rules (or newer ones).
pub fn masked_by_sender(resource: &Map<String, Value>) -> bool {
    let version = to_number(resource.get(MASK_RESOURCE_KEY));
    version.is_finite() && version >= MASK_VERSION
}
