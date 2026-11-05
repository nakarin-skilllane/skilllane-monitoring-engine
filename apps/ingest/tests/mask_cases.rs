//! Every case of bench/fixture/mask-cases.json against the port: every exported mask rule of
//! skilllane-monitoring/contract is `required` and must pass bit for bit (an `optional` group,
//! when present, is only counted). Prints the coverage line the brief asks for.
//! Reads `MASK_CASES` (a path), else ../../bench/fixture/mask-cases.json, else the copy in testdata/.

use ingest::mask::{self, DbParameter};
use serde_json::{Map, Value};
use std::path::PathBuf;

fn cases_path() -> PathBuf {
    if let Ok(path) = std::env::var("MASK_CASES") {
        return PathBuf::from(path);
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for candidate in [here.join("../../bench/fixture/mask-cases.json"), here.join("../fixture/mask-cases.json")] {
        if candidate.exists() {
            return candidate;
        }
    }
    here.join("testdata/mask-cases.json")
}

fn s(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

fn arg(v: &Value, i: usize) -> String {
    s(&v[i])
}

fn arg_usize(v: &Value, i: usize, fallback: usize) -> usize {
    v.get(i).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(fallback)
}

fn arg_bool(v: &Value, i: usize, fallback: bool) -> bool {
    v.get(i).and_then(Value::as_bool).unwrap_or(fallback)
}

fn string_of(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn db_parameter(v: &Value) -> DbParameter {
    DbParameter {
        key: s(&v["key"]),
        r#type: s(&v["type"]),
        value: s(&v["value"]),
        column: string_of(v.get("column")).filter(|c| !c.is_empty()),
        truncated: v.get("truncated") == Some(&Value::Bool(true)),
        masked: string_of(v.get("masked")),
    }
}

/// The port's answer for one case of `rule`, None when the rule is not ported.
fn run(rule: &str, input: &Value) -> Option<Value> {
    let string = |text: String| Value::String(text);
    Some(match rule {
        // value.js
        "redactValue" => string(mask::redact_value(&s(input))),
        "redactText" => string(mask::redact_text(&s(input))),
        "isThaiNationalId" => Value::Bool(mask::is_thai_national_id(&s(input))),
        "stripQuery" => string(mask::strip_query(&s(input)).to_string()),
        "maskNumber" => mask::mask_number(input),
        "maskJsonValue" | "maskObject" => mask::mask_json_value(input.clone()),
        "maskJsonText" => match input {
            Value::Array(_) => string(mask::mask_json_text(&arg(input, 0), arg_bool(input, 1, true))),
            other => string(mask::mask_json_text(&s(other), true)),
        },
        "truncateUtf8" => {
            let cut = mask::truncate_utf8(&arg(input, 0), arg_usize(input, 1, usize::MAX));
            serde_json::json!({ "text": cut.text, "truncated": cut.truncated })
        }
        // keys.js
        "isSensitiveKey" => Value::Bool(mask::is_sensitive_key(&s(input))),
        "isSensitiveQueryName" => Value::Bool(mask::is_sensitive_query_name(&s(input))),
        "isSensitiveHeader" => Value::Bool(mask::is_sensitive_header(&s(input))),
        "keyWords" => Value::Array(mask::key_words(&s(input)).into_iter().map(Value::String).collect()),
        // io.js
        "maskBodyText" => string(mask::mask_body_text(&arg(input, 0), arg_usize(input, 1, usize::MAX))),
        "maskHeaderJson" => match input {
            Value::Array(_) => {
                string(mask::mask_header_json(&arg(input, 0), arg_bool(input, 1, true), arg_usize(input, 2, usize::MAX)))
            }
            other => string(mask::mask_header_json(&s(other), true, usize::MAX)),
        },
        "maskStatement" => string(mask::mask_statement(&arg(input, 0), &arg(input, 1), arg_usize(input, 2, 65536))),
        // web.js
        "maskQuery" => string(mask::mask_query(&s(input))),
        "maskUrl" => string(mask::mask_url(&s(input))),
        "maskCookie" => string(mask::mask_cookie(&s(input))),
        "maskSetCookie" => string(mask::mask_set_cookie(&s(input))),
        "maskHeaderValue" => string(mask::mask_header_value(&arg(input, 0), &arg(input, 1))),
        "maskHeaders" => {
            let headers = input.get(0).and_then(Value::as_object).cloned().unwrap_or_default();
            Value::Object(mask::mask_headers(&headers, arg_bool(input, 1, true)))
        }
        "maskMarkup" => string(mask::mask_markup(&s(input))),
        "maskCsv" => string(mask::mask_csv(&s(input))),
        "maskPathByRoute" => string(mask::mask_path_by_route(&arg(input, 0), &arg(input, 1))),
        "maskEndpoint" => string(mask::mask_endpoint(&s(input))),
        // redis.js
        "maskRedisKey" => string(mask::mask_redis_key(&s(input))),
        "maskIdentifier" => string(mask::mask_identifier(&s(input))),
        "isSensitiveRedisKey" => Value::Bool(mask::is_sensitive_redis_key(&s(input))),
        "quoteRedisArg" => string(mask::quote_redis_arg(&s(input))),
        "redisCommand" => string(mask::redis_command(&arg(input, 0), &input[1], arg_usize(input, 2, 4096))),
        // sql.js
        "maskSql" => string(mask::mask_sql(&s(input))),
        "sqlPlaceholders" => {
            let max = input.get(1).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(usize::MAX);
            serde_json::to_value(mask::sql_placeholders(&arg(input, 0), max)).unwrap()
        }
        "dbParametersJson" => {
            let statement = string_of(input.get(0)).unwrap_or_default();
            let params: Vec<DbParameter> = input[1].as_array().map(|list| list.iter().map(db_parameter).collect()).unwrap_or_default();
            let options = &input[2];
            string(mask::db_parameters_json(
                &statement,
                &params,
                options["maxBytes"].as_u64().unwrap_or(262_144) as usize,
                options["valueMax"].as_u64().unwrap_or(65_536) as usize,
            ))
        }
        _ => return None,
    })
}

fn check(rules: &Map<String, Value>, required: bool) -> (usize, usize, usize, usize, Vec<String>, Vec<String>) {
    let (mut passed, mut total, mut rules_passed, mut rules_total) = (0, 0, 0, 0);
    let mut skipped = Vec::new();
    let mut failures = Vec::new();
    for (rule, cases) in rules {
        let cases = cases.as_array().expect("cases");
        rules_total += 1;
        let mut rule_ok = true;
        let mut any = false;
        for case in cases {
            total += 1;
            match run(rule, &case["input"]) {
                None => {
                    rule_ok = false;
                }
                Some(got) => {
                    any = true;
                    if got == case["output"] {
                        passed += 1;
                    } else {
                        rule_ok = false;
                        failures.push(format!(
                            "{}{rule}({}) → {} (expected {})",
                            if required { "required " } else { "optional " },
                            case["input"],
                            got,
                            case["output"]
                        ));
                    }
                }
            }
        }
        if !any {
            skipped.push(rule.clone());
        }
        if rule_ok {
            rules_passed += 1;
        }
    }
    (passed, total, rules_passed, rules_total, skipped, failures)
}

#[test]
fn mask_cases() {
    let path = cases_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let cases: Value = serde_json::from_str(&text).expect("mask-cases.json");
    let empty = Map::new();
    let (req_pass, req_total, req_rules_pass, req_rules, req_skipped, req_failures) =
        check(cases["required"].as_object().unwrap_or(&empty), true);
    let (opt_pass, opt_total, _, _, opt_skipped, opt_failures) = check(cases["optional"].as_object().unwrap_or(&empty), false);
    for f in req_failures.iter().chain(opt_failures.iter()) {
        eprintln!("FAIL {f}");
    }
    let skipped: Vec<String> = req_skipped.iter().chain(opt_skipped.iter()).cloned().collect();
    println!(
        "mask: required {req_rules_pass}/{req_rules} rules · optional {opt_pass}/{opt_total} (skipped: {})",
        if skipped.is_empty() { "none".to_string() } else { skipped.join(", ") }
    );
    println!("mask cases: required {req_pass}/{req_total}, optional {opt_pass}/{opt_total}");
    assert!(req_skipped.is_empty(), "required rules not ported: {}", req_skipped.join(", "));
    assert!(req_failures.is_empty(), "{} required mask case(s) failed", req_failures.len());
    assert_eq!(req_pass, req_total);
}
