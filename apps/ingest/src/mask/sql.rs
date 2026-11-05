//! skilllane-monitoring/contract mask/sql.js: `maskSql` — literals bound to a sensitive column
//! (or any string literal of a statement that names a secret) → '[REDACTED]', then the value
//! rule in SQL mode — and `sqlPlaceholders` / `dbParametersJson`, the bind-value rules the
//! span I/O `db_params` column is built with.

use super::keys::{is_sensitive_key, REDACTED};
use super::value::{is_masked_number, mask_json_text, redact_value, redact_value_mode, truncate_utf8};
use crate::js::{string_to_number, stringify};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

const OPERATORS: &[&str] = &["<>", "!=", "<=", ">=", "=", "<", ">"];
const SCAN_MAX: usize = 200_000;
const NOT_COLUMNS: &[&str] = &[
    "AND", "OR", "NOT", "WHERE", "SET", "ON", "WHEN", "THEN", "ELSE", "SELECT", "NEXT", "FIRST", "LIMIT", "OFFSET",
    "CASE", "END", "NULL", "IS", "DISTINCT", "VALUES", "FROM", "AS",
];
const STRUCTURAL: &[&str] = &["LIMIT", "OFFSET", "FETCH", "FIRST", "NEXT", "TOP", "ROWS", "SKIP", "PERCENT"];
const NOT_FUNCTIONS: &[&str] = &[
    "IN", "VALUES", "AS", "AND", "OR", "NOT", "WHERE", "ON", "SET", "SELECT", "FROM", "JOIN", "EXISTS", "ANY", "ALL",
    "SOME", "USING", "INTO", "THEN", "ELSE", "WHEN", "CASE", "RETURNING", "BY", "OVER", "TABLE", "WITH", "UNION",
    "HAVING", "LIMIT", "OFFSET", "IS", "LIKE", "ILIKE", "BETWEEN", "DISTINCT", "ESCAPE", "INSERT", "UPDATE", "DELETE",
    "MERGE", "CALL", "EXEC", "EXECUTE", "BEGIN", "END", "RETURN", "DO", "IF",
];
const SELECT_END: &[&str] = &["FROM", "WHERE", "UNION", "GROUP", "ORDER", "HAVING", "RETURNING", "ON", "LIMIT"];
const BETWEEN_STOP: &[&str] = &["AND", "OR", "WHERE", "ON", "WHEN", "SET"];

static NOT_COLUMNS_SET: LazyLock<HashSet<&'static str>> = LazyLock::new(|| NOT_COLUMNS.iter().copied().collect());
static STRUCTURAL_SET: LazyLock<HashSet<&'static str>> = LazyLock::new(|| STRUCTURAL.iter().copied().collect());
static NOT_FUNCTIONS_SET: LazyLock<HashSet<&'static str>> = LazyLock::new(|| NOT_FUNCTIONS.iter().copied().collect());

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Id,
    Str,
    Num,
    Ph,
    Op,
    Punct,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub kind: Kind,
    pub text: String,
    /// Upper-cased text of a bare (unquoted) identifier.
    pub upper: Option<String>,
    pub start: usize,
    pub end: usize,
}

fn push_name(tokens: &mut Vec<Token>, name: &str, bare: bool, start: usize, end: usize) {
    let mut from = start;
    let n = tokens.len();
    if n >= 2 && tokens[n - 1].kind == Kind::Punct && tokens[n - 1].text == "." && tokens[n - 2].kind == Kind::Id {
        from = tokens[n - 2].start;
        tokens.truncate(n - 2);
    }
    tokens.push(Token {
        kind: Kind::Id,
        text: name.to_string(),
        upper: if bare { Some(name.to_ascii_uppercase()) } else { None },
        start: from,
        end,
    });
}

fn is_id_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_id_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b'#')
}

fn scan_while(b: &[u8], from: usize, window: usize, pred: impl Fn(u8) -> bool) -> usize {
    let limit = (from + window).min(b.len());
    let mut i = from;
    while i < limit && pred(b[i]) {
        i += 1;
    }
    i
}

pub fn tokenize(sql: &str, max_placeholders: usize) -> Vec<Token> {
    let b = sql.as_bytes();
    let n = b.len().min(SCAN_MAX);
    let mut tokens: Vec<Token> = Vec::new();
    let mut placeholders = 0usize;
    let mut stop_at = usize::MAX;
    let mut i = 0;
    let placeholder = |tokens: &Vec<Token>, placeholders: &mut usize, stop_at: &mut usize| {
        *placeholders += 1;
        if *placeholders >= max_placeholders {
            *stop_at = (*stop_at).min(tokens.len() + 16);
        }
    };
    while i < n && tokens.len() < stop_at {
        let c = b[i];
        if matches!(c, b' ' | b'\n' | b'\r' | b'\t') {
            i += 1;
        } else if c == b'-' && i + 1 < b.len() && b[i + 1] == b'-' {
            i = match sql[i..].find('\n') {
                Some(rel) => i + rel + 1,
                None => n,
            };
        } else if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i = match sql[i + 2..].find("*/") {
                Some(rel) => i + 2 + rel + 2,
                None => n,
            };
        } else if c == b'\'' {
            let mut j = i + 1;
            while j < n {
                if b[j] == b'\'' {
                    if j + 1 < b.len() && b[j + 1] == b'\'' {
                        j += 2;
                    } else {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            tokens.push(Token { kind: Kind::Str, text: String::new(), upper: None, start: i, end: (j + 1).min(n) });
            i = j + 1;
        } else if c == b'"' || c == b'`' {
            let end = sql[i + 1..].find(c as char).map(|rel| i + 1 + rel);
            let name_end = end.unwrap_or(n);
            let name = &sql[i + 1..name_end.max(i + 1)];
            let next = match end {
                Some(e) => e + 1,
                None => n,
            };
            push_name(&mut tokens, name, false, i, next);
            i = next;
        } else if c == b':' {
            if i + 1 < b.len() && (b[i + 1] == b':' || b[i + 1] == b'=') {
                tokens.push(Token { kind: Kind::Op, text: sql[i..i + 2].to_string(), upper: None, start: i, end: i + 2 });
                i += 2;
                continue;
            }
            // ^:(\.\.\.)?([A-Za-z0-9_$#]+) in a 130-char window
            let mut j = i + 1;
            if sql[j..].starts_with("...") {
                j += 3;
            }
            let name_end = scan_while(b, j, 130 - (j - i), is_id_char);
            if name_end > j {
                tokens.push(Token {
                    kind: Kind::Ph,
                    text: format!(":{}", &sql[j..name_end]),
                    upper: None,
                    start: i,
                    end: name_end,
                });
                i = name_end;
                placeholder(&tokens, &mut placeholders, &mut stop_at);
            } else {
                tokens.push(Token { kind: Kind::Punct, text: ":".into(), upper: None, start: i, end: i + 1 });
                i += 1;
            }
        } else if c == b'?' {
            tokens.push(Token { kind: Kind::Ph, text: "?".into(), upper: None, start: i, end: i + 1 });
            i += 1;
            placeholder(&tokens, &mut placeholders, &mut stop_at);
        } else if c == b'$' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
            let end = scan_while(b, i + 1, 11, |d| d.is_ascii_digit());
            tokens.push(Token { kind: Kind::Ph, text: sql[i..end].to_string(), upper: None, start: i, end });
            i = end;
            placeholder(&tokens, &mut placeholders, &mut stop_at);
        } else if c == b'@' && i + 1 < b.len() && (b[i + 1].is_ascii_alphabetic() || b[i + 1] == b'_') {
            let end = scan_while(b, i + 1, 129, |d| d.is_ascii_alphanumeric() || d == b'_');
            tokens.push(Token { kind: Kind::Ph, text: sql[i..end].to_string(), upper: None, start: i, end });
            i = end;
            placeholder(&tokens, &mut placeholders, &mut stop_at);
        } else if is_id_start(c) {
            let end = scan_while(b, i + 1, 129, is_id_char);
            push_name(&mut tokens, &sql[i..end], true, i, end);
            i = end;
        } else if c.is_ascii_digit() {
            let mut end = scan_while(b, i, 40, |d| d.is_ascii_digit());
            if end < b.len() && end < i + 40 && b[end] == b'.' {
                let frac = scan_while(b, end + 1, 40 - (end + 1 - i), |d| d.is_ascii_digit());
                if frac > end + 1 {
                    end = frac;
                }
            }
            tokens.push(Token { kind: Kind::Num, text: sql[i..end].to_string(), upper: None, start: i, end });
            i = end;
        } else if let Some(op) = OPERATORS.iter().find(|op| sql[i..].starts_with(**op)) {
            tokens.push(Token { kind: Kind::Op, text: op.to_string(), upper: None, start: i, end: i + op.len() });
            i += op.len();
        } else {
            let len = sql[i..].chars().next().map_or(1, char::len_utf8);
            tokens.push(Token { kind: Kind::Punct, text: sql[i..i + len].to_string(), upper: None, start: i, end: i + len });
            i += len;
        }
    }
    tokens
}

pub struct Context {
    pub tokens: Vec<Token>,
    parent: Vec<i64>,
    matched: Vec<i64>,
}

fn context(tokens: Vec<Token>) -> Context {
    let n = tokens.len();
    let mut parent = vec![-1i64; n];
    let mut matched = vec![-1i64; n];
    let mut stack: Vec<usize> = Vec::new();
    for i in 0..n {
        parent[i] = stack.last().map_or(-1, |s| *s as i64);
        let token = &tokens[i];
        if token.kind != Kind::Punct {
            continue;
        }
        if token.text == "(" {
            stack.push(i);
        } else if token.text == ")" {
            if let Some(open) = stack.pop() {
                matched[open] = i as i64;
                matched[i] = open as i64;
            }
        }
    }
    for open in stack {
        matched[open] = n as i64 - 1;
    }
    Context { tokens, parent, matched }
}

impl Context {
    fn tok(&self, index: i64) -> Option<&Token> {
        if index < 0 {
            None
        } else {
            self.tokens.get(index as usize)
        }
    }
    fn is_word(&self, index: i64, word: &str) -> bool {
        self.tok(index).is_some_and(|t| t.kind == Kind::Id && t.upper.as_deref() == Some(word))
    }
    fn is_punct(&self, index: i64, text: &str) -> bool {
        self.tok(index).is_some_and(|t| t.kind == Kind::Punct && t.text == text)
    }
    fn is_compare_op(&self, index: i64) -> bool {
        self.tok(index).is_some_and(|t| t.kind == Kind::Op && t.text != "::" && t.text != ":=")
    }
    fn upper_in(&self, index: i64, set: &HashSet<&'static str>) -> bool {
        self.tok(index).is_some_and(|t| t.kind == Kind::Id && t.upper.as_deref().is_some_and(|u| set.contains(u)))
    }
    fn matched_of(&self, index: i64) -> i64 {
        if index < 0 {
            -1
        } else {
            self.matched.get(index as usize).copied().unwrap_or(-1)
        }
    }
    fn parent_of(&self, index: i64) -> i64 {
        if index < 0 {
            -1
        } else {
            self.parent.get(index as usize).copied().unwrap_or(-1)
        }
    }
}

fn not_column(token: &Token) -> bool {
    NOT_COLUMNS_SET.contains(token.upper.as_deref().unwrap_or(""))
}

/// The column name left of `index` (an operator), when the token there names one.
fn column_before(c: &Context, index: i64) -> Option<String> {
    let left = c.tok(index - 1);
    if let Some(left) = left {
        if left.kind == Kind::Id {
            return if not_column(left) { None } else { Some(left.text.clone()) };
        }
    }
    if c.is_punct(index - 1, "]") && c.tok(index - 2).is_some_and(|t| t.kind == Kind::Id) && c.is_punct(index - 3, "[") {
        return Some(c.tok(index - 2).unwrap().text.clone());
    }
    if !c.is_punct(index - 1, ")") {
        return None;
    }
    let open = c.matched_of(index - 1);
    if open < 0 {
        return None;
    }
    let mut j = open + 1;
    while j < index - 1 && j < open + 64 {
        let token = c.tok(j).unwrap();
        if token.kind == Kind::Id && !not_column(token) && !c.is_punct(j + 1, "(") {
            return Some(token.text.clone());
        }
        j += 1;
    }
    None
}

fn between_for(c: &Context, and: i64) -> i64 {
    let mut j = and - 1;
    let mut steps = 0;
    while j >= 0 && steps < 16 {
        let token = c.tok(j).unwrap();
        if c.is_punct(j, ")") {
            j = c.matched_of(j) - 1;
        } else if c.is_word(j, "BETWEEN") {
            return j;
        } else if token.kind == Kind::Id && token.upper.as_deref().is_some_and(|u| BETWEEN_STOP.contains(&u)) {
            return -1;
        } else if c.is_punct(j, ",") || c.is_punct(j, "(") {
            return -1;
        } else {
            j -= 1;
        }
        steps += 1;
    }
    -1
}

fn tuple_column(c: &Context, right_open: i64, start: i64) -> Option<String> {
    let mut item = 0usize;
    let mut j = right_open + 1;
    while j < start {
        if c.is_punct(j, ",") && c.parent_of(j) == right_open {
            item += 1;
        }
        j += 1;
    }
    let left_open = c.matched_of(right_open - 2);
    if left_open < 0 {
        return None;
    }
    let mut names: Vec<String> = Vec::new();
    let mut j = left_open + 1;
    while j < right_open - 2 {
        if c.parent_of(j) == left_open && c.tok(j).is_some_and(|t| t.kind == Kind::Id) {
            names.push(c.tok(j).unwrap().text.clone());
        }
        j += 1;
    }
    names.get(item).cloned()
}

fn truthy(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|s| !s.is_empty())
}

/// The column a value at tokens[start..=end] belongs to: Some("") = structural (LIMIT 10),
/// None = unknown.
fn column_around(c: &Context, start: i64, end: i64) -> Option<String> {
    let prev = start - 1;
    let next = end + 1;
    let prev_tok = c.tok(prev);
    if c.is_compare_op(prev) {
        let column = column_before(c, prev);
        if truthy(&column) {
            return column;
        }
    } else if prev_tok.is_some_and(|t| t.kind == Kind::Id && matches!(t.upper.as_deref(), Some("LIKE") | Some("ILIKE"))) {
        return column_before(c, if c.is_word(start - 2, "NOT") { start - 2 } else { prev });
    } else if c.is_word(prev, "BETWEEN") {
        return column_before(c, if c.is_word(start - 2, "NOT") { start - 2 } else { prev });
    } else if c.is_word(prev, "AND") {
        let between = between_for(c, prev);
        if between != -1 {
            return column_before(c, if c.is_word(between - 1, "NOT") { between - 1 } else { between });
        }
    } else if c.upper_in(prev, &STRUCTURAL_SET) {
        return Some(String::new());
    }
    if c.is_compare_op(next) {
        if let Some(after) = c.tok(end + 2) {
            if after.kind == Kind::Id && !not_column(after) {
                if !c.is_punct(end + 3, "(") {
                    return Some(after.text.clone());
                }
                let close = c.matched_of(end + 3);
                let mut j = end + 4;
                while j < close && j < end + 64 {
                    let t = c.tok(j).unwrap();
                    if t.kind == Kind::Id && !c.is_punct(j + 1, "(") {
                        return Some(t.text.clone());
                    }
                    j += 1;
                }
            }
        }
    }
    if c.is_word(next, "AS") {
        if let Some(t) = c.tok(end + 2) {
            if t.kind == Kind::Id {
                return Some(t.text.clone());
            }
        }
    }
    if c.is_punct(prev, "(") || c.is_punct(prev, ",") {
        let open = c.parent_of(start);
        if open >= 0 {
            if c.is_word(open - 1, "IN") {
                return column_before(c, if c.is_word(open - 2, "NOT") { open - 2 } else { open - 1 });
            }
            if c.is_compare_op(open - 1) && c.is_punct(open - 2, ")") {
                return tuple_column(c, open, start);
            }
        }
    }
    None
}

fn slot_column(c: &Context, index: i64, walk_out: bool) -> Option<String> {
    let mut start = index;
    let mut end = index;
    for _ in 0..8 {
        let column = column_around(c, start, end);
        if column.is_some() || !walk_out {
            return column;
        }
        let open = c.parent_of(start);
        if open < 1 {
            return None;
        }
        let func = c.tok(open - 1).unwrap();
        if func.kind != Kind::Id || NOT_FUNCTIONS_SET.contains(func.upper.as_deref().unwrap_or("")) {
            return None;
        }
        start = open - 1;
        end = c.matched_of(open);
    }
    None
}

fn is_value_token(token: &Token) -> bool {
    matches!(token.kind, Kind::Ph | Kind::Str | Kind::Num)
}

#[derive(Default, Clone, Debug)]
pub struct Slot {
    pub column: Option<String>,
    pub structural: bool,
}

fn column_list(c: &Context, open: i64) -> Vec<String> {
    let close = c.matched_of(open);
    let mut columns = Vec::new();
    let mut j = open + 1;
    while j < close {
        if c.parent_of(j) == open {
            if let Some(t) = c.tok(j) {
                if t.kind == Kind::Id {
                    columns.push(t.text.clone());
                }
            }
        }
        j += 1;
    }
    columns
}

fn assign_items(c: &Context, slots: &mut BTreeMap<usize, Slot>, from: i64, to: i64, level: i64, columns: &[String]) {
    let mut item = 0usize;
    let mut j = from;
    while j < to {
        if c.is_punct(j, ",") && c.parent_of(j) == level {
            item += 1;
            j += 1;
            continue;
        }
        if j >= 0 {
            if let Some(slot) = slots.get_mut(&(j as usize)) {
                if slot.column.is_none() && !slot.structural {
                    if let Some(col) = columns.get(item) {
                        slot.column = Some(col.clone());
                    }
                }
            }
        }
        j += 1;
    }
}

fn insert_columns(c: &Context, slots: &mut BTreeMap<usize, Slot>) {
    let n = c.tokens.len() as i64;
    for i in 0..n {
        let mut open = -1;
        if c.is_word(i, "INSERT") && c.is_punct(i + 1, "(") {
            open = i + 1;
        } else if c.is_word(i, "INTO") && c.tok(i + 1).is_some_and(|t| t.kind == Kind::Id) && c.is_punct(i + 2, "(") {
            open = i + 2;
        }
        if open == -1 {
            continue;
        }
        let columns = column_list(c, open);
        if columns.is_empty() {
            continue;
        }
        let mut k = c.matched_of(open) + 1;
        if c.is_word(k, "VALUES") {
            k += 1;
            while c.is_punct(k, "(") {
                let close = c.matched_of(k);
                assign_items(c, slots, k + 1, close, k, &columns);
                if c.is_punct(close + 1, ",") && c.is_punct(close + 2, "(") {
                    k = close + 2;
                } else {
                    break;
                }
            }
        } else if c.is_word(k, "SELECT") {
            let level = c.parent_of(k);
            let mut end = k + 1;
            while end < n {
                let token = c.tok(end).unwrap();
                if c.parent_of(end) == level
                    && (token.upper.as_deref().is_some_and(|u| SELECT_END.contains(&u)) || c.is_punct(end, ";"))
                {
                    break;
                }
                if level != -1 && end >= c.matched_of(level) {
                    break;
                }
                end += 1;
            }
            assign_items(c, slots, k + 1, end, level, &columns);
        }
    }
}

pub struct Analysis {
    pub ctx: Context,
    pub slots: BTreeMap<usize, Slot>,
    pub sensitive: bool,
}

pub fn analyse(sql: &str, max_placeholders: usize) -> Analysis {
    let ctx = context(tokenize(sql, max_placeholders));
    let mut slots = BTreeMap::new();
    let mut sensitive = false;
    for (index, token) in ctx.tokens.iter().enumerate() {
        if token.kind == Kind::Id && !sensitive && is_sensitive_key(&token.text) {
            sensitive = true;
        }
        if !is_value_token(token) {
            continue;
        }
        let column = slot_column(&ctx, index as i64, token.kind != Kind::Num);
        let slot = match column {
            Some(ref col) if col.is_empty() => Slot { column: None, structural: true },
            Some(col) => Slot { column: Some(col), structural: false },
            None => Slot::default(),
        };
        slots.insert(index, slot);
    }
    insert_columns(&ctx, &mut slots);
    Analysis { ctx, slots, sensitive }
}

pub fn mask_sql(sql: &str) -> String {
    if sql.is_empty() {
        return String::new();
    }
    let analysis = analyse(sql, usize::MAX);
    let tokens = &analysis.ctx.tokens;
    let mut out = String::new();
    let mut last = 0usize;
    let quoted = format!("'{REDACTED}'");
    for (index, slot) in &analysis.slots {
        let token = &tokens[*index];
        if token.kind == Kind::Ph {
            continue;
        }
        let secret = match &slot.column {
            Some(col) if !col.is_empty() => is_sensitive_key(col),
            _ => token.kind == Kind::Str && analysis.sensitive && !slot.structural,
        };
        if !secret || &sql[token.start..token.end] == quoted {
            continue;
        }
        out.push_str(&sql[last..token.start]);
        out.push_str(&quoted);
        last = token.end;
    }
    let text = if last > 0 {
        out.push_str(&sql[last..]);
        out
    } else {
        sql.to_string()
    };
    redact_value_mode(&text, true)
}

// ---------- sqlPlaceholders / dbParametersJson (sql.js from `placeholdersOf`) ----------

/// One placeholder of a statement, with the column it binds to when the statement says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Placeholder {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub structural: bool,
}

fn placeholders_of(analysis: &Analysis) -> Vec<Placeholder> {
    let mut out = Vec::new();
    for (index, token) in analysis.ctx.tokens.iter().enumerate() {
        if token.kind != Kind::Ph {
            continue;
        }
        let slot = analysis.slots.get(&index).cloned().unwrap_or_default();
        out.push(Placeholder {
            name: token.text.clone(),
            column: slot.column.filter(|c| !c.is_empty()),
            structural: slot.structural,
        });
    }
    out
}

/// `sqlPlaceholders(sql, maxPlaceholders?)`: the placeholders in order (`usize::MAX` = no cap).
pub fn sql_placeholders(sql: &str, max_placeholders: usize) -> Vec<Placeholder> {
    placeholders_of(&analyse(sql, max_placeholders))
}

/// A bind value as the SDK's `DbParameter` (type is the SDK's `DbParamType` text; any text a
/// sender wrote is kept as is).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DbParameter {
    pub key: String,
    pub r#type: String,
    pub value: String,
    /// Non-empty when set (the JS `column?: string` is only ever a truthy string).
    pub column: Option<String>,
    pub truncated: bool,
    pub masked: Option<String>,
}

const UNRESOLVED_MASKED: &[&str] = &["string", "number", "bigint", "object", "buffer"];

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `finishParam`: the JSON object of one bind (key order as JS builds it).
fn finish_param(param: &DbParameter, placeholder: Option<&Placeholder>, sensitive_statement: bool, value_max: usize) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("key".into(), Value::String(param.key.clone()));
    out.insert("type".into(), Value::String(param.r#type.clone()));
    out.insert("value".into(), Value::String(param.value.clone()));
    let column: Option<String> = placeholder
        .and_then(|p| p.column.clone())
        .or_else(|| param.column.clone())
        .filter(|c| !c.is_empty());
    if let Some(column) = &column {
        out.insert("column".into(), Value::String(column.clone()));
    }
    if param.truncated {
        out.insert("truncated".into(), Value::Bool(true));
    }
    if is_sensitive_key(&param.key) || column.as_deref().is_some_and(is_sensitive_key) {
        out.insert("value".into(), Value::String(REDACTED.into()));
        out.shift_remove("truncated");
        return out;
    }
    if param.value != REDACTED
        && UNRESOLVED_MASKED.contains(&param.r#type.as_str())
        && sensitive_statement
        && column.is_none()
        && !placeholder.is_some_and(|p| p.structural)
    {
        out.insert("value".into(), Value::String(REDACTED.into()));
        out.insert("masked".into(), Value::String("unresolved".into()));
        out.shift_remove("truncated");
        return out;
    }
    if let Some(masked) = &param.masked {
        if !masked.is_empty() {
            out.insert("masked".into(), Value::String(masked.clone()));
        }
    }
    let mut value = param.value.clone();
    let mut truncated = param.truncated;
    let capped = truncate_utf8(&value, value_max);
    if capped.truncated {
        value = capped.text;
        truncated = true;
        out.insert("truncated".into(), Value::Bool(true));
    }
    match param.r#type.as_str() {
        "string" => value = redact_value(&value),
        "number" | "bigint" => {
            if value.len() == 13 && is_digits(&value) && is_masked_number(string_to_number(&value)) {
                value = REDACTED.into();
            }
        }
        "object" if value != "[Lob]" => value = mask_json_text(&value, !truncated),
        _ => {}
    }
    out.insert("value".into(), Value::String(value));
    out
}

const MORE_RESERVE: i64 = 96;

/// `dbParametersJson(statement, count, paramAt, { maxBytes, valueMax })`: the `db_params` JSON
/// of the binds ('' when there are none). An empty statement means none was given.
pub fn db_parameters_json(statement: &str, params: &[DbParameter], max_bytes: usize, value_max: usize) -> String {
    let count = params.len();
    if count == 0 {
        return String::new();
    }
    let max_kept = (max_bytes / 40).max(1);
    let analysis = if statement.is_empty() { None } else { Some(analyse(statement, count.min(max_kept) + 1)) };
    let placeholders = analysis.as_ref().map(placeholders_of).unwrap_or_default();
    let sensitive = analysis.as_ref().is_some_and(|a| a.sensitive);
    let dollar = placeholders.iter().any(|p| p.name.starts_with('$'));
    let mut named: IndexMap<String, &Placeholder> = IndexMap::new();
    for placeholder in &placeholders {
        let name = placeholder.name.strip_prefix([':', '@', '$']).unwrap_or(&placeholder.name).to_string();
        match named.get(&name) {
            Some(known) if known.column.is_some() || placeholder.column.is_none() => {}
            _ => {
                named.insert(name, placeholder);
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    let mut bytes: i64 = 2;
    let mut kept = 0usize;
    for (index, param) in params.iter().enumerate() {
        let positional = is_digits(&param.key);
        let placeholder = if positional && !dollar { placeholders.get(index) } else { named.get(&param.key).copied() };
        let json = stringify(&Value::Object(finish_param(param, placeholder, sensitive, value_max)));
        let size = json.len() as i64 + if kept > 0 { 1 } else { 0 };
        let room = max_bytes as i64 - if index + 1 < count { MORE_RESERVE } else { 0 };
        if bytes + size > room {
            break;
        }
        parts.push(json);
        bytes += size;
        kept += 1;
    }
    if kept < count {
        let mut more = Map::new();
        more.insert("key".into(), Value::String("…".into()));
        more.insert("type".into(), Value::String("null".into()));
        more.insert("value".into(), Value::String(format!("{} more", count - kept)));
        more.insert("truncated".into(), Value::Bool(true));
        parts.push(stringify(&Value::Object(more)));
    }
    format!("[{}]", parts.join(","))
}
