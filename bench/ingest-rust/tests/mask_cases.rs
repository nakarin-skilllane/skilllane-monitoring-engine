//! Every case of bench/fixture/mask-cases.json against the port. Required rules must pass bit
//! for bit; optional ones are counted. Prints the coverage line the brief asks for.
//! Reads `MASK_CASES` (a path), else ../fixture/mask-cases.json, else the copy in testdata/.

use ingest_rust::mask;
use serde_json::{Map, Value};
use std::path::PathBuf;

fn cases_path() -> PathBuf {
    if let Ok(path) = std::env::var("MASK_CASES") {
        return PathBuf::from(path);
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture = here.join("../fixture/mask-cases.json");
    if fixture.exists() {
        fixture
    } else {
        here.join("testdata/mask-cases.json")
    }
}

fn s(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

fn arg(v: &Value, i: usize) -> String {
    s(&v[i])
}

/// The port's answer for one case of `rule`, None when the rule is skipped.
fn run(rule: &str, input: &Value) -> Option<Value> {
    Some(match rule {
        "redactValue" => Value::String(mask::redact_value(&s(input))),
        "redactText" => Value::String(mask::redact_text(&s(input))),
        "isSensitiveKey" => Value::Bool(mask::is_sensitive_key(&s(input))),
        "maskSql" => Value::String(mask::mask_sql(&s(input))),
        "maskPathByRoute" => Value::String(mask::mask_path_by_route(&arg(input, 0), &arg(input, 1))),
        "maskJsonText" => Value::String(mask::mask_json_text(&s(input), true)),
        "maskUrl" => Value::String(mask::mask_url(&s(input))),
        "maskQuery" => Value::String(mask::mask_query(&s(input))),
        "maskHeaderJson" => Value::String(mask::mask_header_json(&s(input), true, usize::MAX)),
        "maskHeaderValue" => Value::String(mask::mask_header_value(&arg(input, 0), &arg(input, 1))),
        "isSensitiveHeader" => Value::Bool(mask::is_sensitive_header(&s(input))),
        "maskStatement" => Value::String(mask::mask_statement(&arg(input, 0), &arg(input, 1), 65536)),
        "maskIdentifier" => Value::String(mask::mask_identifier(&s(input))),
        "isThaiNationalId" => Value::Bool(mask::is_thai_national_id(&s(input))),
        "maskNumber" => mask::mask_number(input),
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
    let (req_pass, req_total, req_rules_pass, req_rules, _, req_failures) =
        check(cases["required"].as_object().unwrap(), true);
    let (opt_pass, opt_total, _, _, skipped, opt_failures) = check(cases["optional"].as_object().unwrap(), false);
    for f in req_failures.iter().chain(opt_failures.iter()) {
        eprintln!("FAIL {f}");
    }
    println!(
        "mask: required {req_rules_pass}/{req_rules} · optional {opt_pass}/{opt_total} (skipped: {})",
        if skipped.is_empty() { "none".to_string() } else { skipped.join(", ") }
    );
    println!("mask cases: required {req_pass}/{req_total}, optional {opt_pass}/{opt_total}");
    assert!(req_failures.is_empty(), "{} required mask case(s) failed", req_failures.len());
    assert_eq!(req_pass, req_total);
}
