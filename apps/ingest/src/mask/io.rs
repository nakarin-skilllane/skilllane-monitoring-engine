//! skilllane-monitoring/contract mask/io.js: `maskStatement`, `maskHeaderJson`, `maskBodyText`.

use super::sql::mask_sql;
use super::value::{mask_json_text, redact_value, truncate_utf8};
use super::web::{mask_headers, mask_markup};
use crate::js::stringify;
use serde_json::Value;

fn first_char(text: &str) -> Option<char> {
    text.chars().find(|c| *c as u32 > 32 && *c != '\u{FEFF}')
}

pub fn mask_body_text(value: &str, max_bytes: usize) -> String {
    let cut = truncate_utf8(value, max_bytes);
    let masked = match first_char(&cut.text) {
        Some('{') | Some('[') => mask_json_text(&cut.text, !cut.truncated),
        Some('<') => redact_value(&mask_markup(&cut.text)),
        _ => redact_value(&cut.text),
    };
    truncate_utf8(&masked, max_bytes).text
}

pub fn mask_header_json(text: &str, lower_case: bool, max_bytes: usize) -> String {
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(text) {
        let masked = Value::Object(mask_headers(&parsed, lower_case));
        return truncate_utf8(&stringify(&masked), max_bytes).text;
    }
    truncate_utf8(&mask_body_text(text, max_bytes), max_bytes).text
}

pub fn mask_statement(statement: &str, system: &str, max_bytes: usize) -> String {
    let cut = truncate_utf8(statement, max_bytes);
    if system.to_lowercase().contains("redis") {
        return truncate_utf8(&redact_value(&cut.text), max_bytes).text;
    }
    match first_char(&cut.text) {
        Some('{') | Some('[') => truncate_utf8(&mask_json_text(&cut.text, !cut.truncated), max_bytes).text,
        _ => truncate_utf8(&mask_sql(&cut.text), max_bytes).text,
    }
}
