//! JavaScript semantics the port needs bit for bit: `String(number)`, `JSON.stringify`
//! (key order and number format), `Number()`, `parseInt()`, `Date.parse()` for ISO text,
//! `Date#toISOString()`, and the contract's nanos → DateTime64 text.

use serde_json::{Map, Number, Value};

/// `String(x)` for a finite double (ES 6.1.6.1.20 Number::toString).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let neg = x < 0.0;
    let mut buf = ryu::Buffer::new();
    let s = buf.format_finite(x.abs());
    // ryu gives the shortest round-trip digits; take them apart into digits + exponent.
    let (mant, exp) = match s.find('e') {
        Some(i) => (&s[..i], s[i + 1..].parse::<i32>().unwrap_or(0)),
        None => (s, 0),
    };
    let (int_part, frac_part) = match mant.find('.') {
        Some(i) => (&mant[..i], &mant[i + 1..]),
        None => (mant, ""),
    };
    let mut digits: Vec<u8> = int_part.bytes().chain(frac_part.bytes()).collect();
    let mut n = int_part.len() as i32 + exp;
    while digits.len() > 1 && digits[0] == b'0' {
        digits.remove(0);
        n -= 1;
    }
    while digits.len() > 1 && *digits.last().unwrap() == b'0' {
        digits.pop();
    }
    let k = digits.len() as i32;
    let d = String::from_utf8(digits).unwrap();
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&d);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&d[..n as usize]);
        out.push('.');
        out.push_str(&d[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&d);
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            out.push_str(&d);
        } else {
            out.push_str(&d[..1]);
            out.push('.');
            out.push_str(&d[1..]);
        }
        out.push('e');
        out.push(sign);
        out.push_str(&e.abs().to_string());
    }
    out
}

const MAX_SAFE: u64 = 9_007_199_254_740_992;

/// A JSON number as JS would print it (JS parsed it into a double first).
pub fn json_number_string(n: &Number) -> String {
    if let Some(u) = n.as_u64() {
        if u <= MAX_SAFE {
            return u.to_string();
        }
        return number_to_string(u as f64);
    }
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= MAX_SAFE {
            return i.to_string();
        }
        return number_to_string(i as f64);
    }
    number_to_string(n.as_f64().unwrap_or(0.0))
}

/// A canonical array index ("0", "42", never "01"): JS lists those keys first, ascending.
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u32::MAX as u64 {
        Some(n as u32)
    } else {
        None
    }
}

/// JS object key order: integer-like keys ascending, then the rest in insertion order.
pub fn ordered_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut indexed: Vec<(u32, &String)> = Vec::new();
    let mut rest: Vec<&String> = Vec::new();
    for key in map.keys() {
        match array_index(key) {
            Some(i) => indexed.push((i, key)),
            None => rest.push(key),
        }
    }
    if indexed.is_empty() {
        return rest;
    }
    indexed.sort_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, k)| k).chain(rest).collect()
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

pub fn write_json_string(s: &str, out: &mut String) {
    // serde_json escapes exactly what JSON.stringify escapes: " \ and U+0000..U+001F.
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()));
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&json_number_string(n)),
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, key) in ordered_keys(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_json(&map[key], out);
            }
            out.push('}');
        }
    }
}

/// mappers.ts `str()`: '' for null, text as is, numbers / booleans as JS prints them, JSON otherwise.
pub fn to_str(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => json_number_string(n),
        Some(Value::Bool(b)) => (if *b { "true" } else { "false" }).to_string(),
        Some(other) => stringify(other),
    }
}

/// `Array.prototype.toString` (for `Number([...])`).
fn array_to_string(items: &[Value]) -> String {
    items
        .iter()
        .map(|v| match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            Value::Number(n) => json_number_string(n),
            Value::Bool(b) => b.to_string(),
            Value::Array(a) => array_to_string(a),
            Value::Object(_) => "[object Object]".into(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `Number(text)`.
pub fn string_to_number(text: &str) -> f64 {
    let t = text.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("0x") {
        return u64::from_str_radix(rest, 16).map(|v| v as f64).unwrap_or(f64::NAN);
    }
    if let Some(rest) = lower.strip_prefix("0o") {
        return u64::from_str_radix(rest, 8).map(|v| v as f64).unwrap_or(f64::NAN);
    }
    if let Some(rest) = lower.strip_prefix("0b") {
        return u64::from_str_radix(rest, 2).map(|v| v as f64).unwrap_or(f64::NAN);
    }
    // StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - s;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)`.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(a)) => string_to_number(&array_to_string(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `parseInt(text, 10)`.
pub fn parse_int(text: &str) -> f64 {
    let t = text.trim_start_matches(is_js_whitespace);
    let b = t.as_bytes();
    let mut i = 0;
    let mut neg = false;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        neg = b[i] == b'-';
        i += 1;
    }
    let start = i;
    let mut n = 0f64;
    while i < b.len() && b[i].is_ascii_digit() {
        n = n * 10.0 + (b[i] - b'0') as f64;
        i += 1;
    }
    if i == start {
        return f64::NAN;
    }
    if neg {
        -n
    } else {
        n
    }
}

// ---------- dates ----------

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = (m + 9) % 12;
    let doy = (153 * mp as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

fn digits(b: &[u8], i: &mut usize, count: usize) -> Option<i64> {
    if *i + count > b.len() {
        return None;
    }
    let mut n = 0i64;
    for k in 0..count {
        let c = b[*i + k];
        if !c.is_ascii_digit() {
            return None;
        }
        n = n * 10 + (c - b'0') as i64;
    }
    *i += count;
    Some(n)
}

/// `Date.parse()` for the ISO 8601 forms V8 accepts (date, date-time, Z / ±hh:mm; no offset =
/// local time, UTC in the container). Other legacy formats are not parsed (None, like NaN).
pub fn date_parse(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let mut i = 0;
    let year = if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        let neg = b[i] == b'-';
        i += 1;
        let y = digits(b, &mut i, 6)?;
        if neg && y == 0 {
            return None;
        }
        if neg { -y } else { y }
    } else {
        digits(b, &mut i, 4)?
    };
    let mut month = 1;
    let mut day = 1;
    if i < b.len() && b[i] == b'-' {
        i += 1;
        month = digits(b, &mut i, 2)?;
        if i < b.len() && b[i] == b'-' {
            i += 1;
            day = digits(b, &mut i, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut min, mut s, mut ms) = (0i64, 0i64, 0i64, 0i64);
    let mut offset_ms = 0i64;
    if i < b.len() && (b[i] == b'T' || b[i] == b't' || b[i] == b' ') {
        i += 1;
        h = digits(b, &mut i, 2)?;
        if i >= b.len() || b[i] != b':' {
            return None;
        }
        i += 1;
        min = digits(b, &mut i, 2)?;
        if i < b.len() && b[i] == b':' {
            i += 1;
            s = digits(b, &mut i, 2)?;
            if i < b.len() && (b[i] == b'.' || b[i] == b',') {
                i += 1;
                let start = i;
                let mut frac = 0i64;
                let mut scale = 100;
                while i < b.len() && b[i].is_ascii_digit() {
                    if scale > 0 {
                        frac += (b[i] - b'0') as i64 * scale;
                        scale /= 10;
                    }
                    i += 1;
                }
                if i == start {
                    return None;
                }
                ms = frac;
            }
        }
        if h > 24 || min > 59 || s > 59 || (h == 24 && (min > 0 || s > 0 || ms > 0)) {
            return None;
        }
        if i < b.len() {
            match b[i] {
                b'Z' | b'z' => i += 1,
                b'+' | b'-' => {
                    let neg = b[i] == b'-';
                    i += 1;
                    let oh = digits(b, &mut i, 2)?;
                    let om = if i < b.len() && b[i] == b':' {
                        i += 1;
                        digits(b, &mut i, 2)?
                    } else if i + 2 <= b.len() && b[i].is_ascii_digit() {
                        digits(b, &mut i, 2)?
                    } else {
                        0
                    };
                    if oh > 23 || om > 59 {
                        return None;
                    }
                    offset_ms = (oh * 60 + om) * 60_000 * if neg { -1 } else { 1 };
                }
                _ => return None,
            }
        }
    }
    if i != b.len() {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let total = days * 86_400_000 + ((h * 60 + min) * 60 + s) * 1000 + ms - offset_ms;
    if total.abs() > MAX_DATE_MS {
        return None;
    }
    Some(total)
}

/// `new Date(ms).toISOString()`; None when the Date is invalid (RangeError in JS).
pub fn iso_from_ms(ms: i64) -> Option<String> {
    if ms.abs() > MAX_DATE_MS {
        return None;
    }
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let min = rem % 3_600_000 / 60_000;
    let s = rem % 60_000 / 1000;
    let milli = rem % 1000;
    let year = if (0..=9999).contains(&y) {
        format!("{:04}", y)
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{:06}", y)
    };
    Some(format!("{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, m, d, h, min, s, milli))
}

/// contract `nanosToDateTime64(nanos, digits)`: "YYYY-MM-DD HH:MM:SS.ffffff".
pub fn nanos_to_datetime64(nanos: i128, digits: usize) -> Option<String> {
    let ms = nanos / 1_000_000; // BigInt division truncates toward zero
    let ms_i64 = i64::try_from(ms).ok()?;
    let iso = iso_from_ms(ms_i64)?;
    let fraction = (nanos % 1_000_000_000).to_string();
    let padded = if fraction.len() < 9 { format!("{}{}", "0".repeat(9 - fraction.len()), fraction) } else { fraction };
    let frac: String = padded.chars().take(digits).collect();
    let mut out = String::with_capacity(32);
    out.push_str(&iso[..10]);
    out.push(' ');
    out.push_str(&iso[11..19]);
    if digits > 0 {
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

/// contract `isoToNanos`: ms (0 when the text does not parse) × 1e6.
pub fn iso_to_nanos(iso: &str) -> i128 {
    date_parse(iso).unwrap_or(0) as i128 * 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(number_to_string(1e20), "100000000000000000000");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(123.456), "123.456");
        assert_eq!(number_to_string(0.001), "0.001");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-1.5), "-1.5");
        assert_eq!(number_to_string(1234.0), "1234");
        assert_eq!(number_to_string(1.2345678901234568e20), "123456789012345680000");
    }

    #[test]
    fn dates() {
        assert_eq!(date_parse("2026-11-05T02:00:00.239Z"), Some(1_793_844_000_239));
        assert_eq!(date_parse("2026-11-05"), Some(1_793_836_800_000));
        assert_eq!(date_parse("2026-11-05T09:00:00+07:00"), Some(1_793_844_000_000));
        assert_eq!(date_parse("nope"), None);
        assert_eq!(iso_from_ms(1_793_844_000_239).unwrap(), "2026-11-05T02:00:00.239Z");
        assert_eq!(nanos_to_datetime64(1_793_844_003_410_722_000, 6).unwrap(), "2026-11-05 02:00:03.410722");
        assert_eq!(nanos_to_datetime64(1_793_844_000_000_000_000, 3).unwrap(), "2026-11-05 02:00:00.000");
        assert_eq!(iso_from_ms(0).unwrap(), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn stringify_order() {
        let v: Value = serde_json::from_str(r#"{"b":1,"0":2,"a":[1.0,"x"]}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"0":2,"b":1,"a":[1,"x"]}"#);
        assert_eq!(parse_int(" 42abc"), 42.0);
        assert!(parse_int("abc").is_nan());
        assert_eq!(string_to_number(" 12 "), 12.0);
        assert!(string_to_number("inf").is_nan());
    }
}
