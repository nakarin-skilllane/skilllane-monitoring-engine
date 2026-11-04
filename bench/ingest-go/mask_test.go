package main

// The SDK's mask cases (bench/fixture/mask-cases.json, copied to testdata/):
// every `required` case must match bit for bit; `optional` rules are counted.
// Prints: mask: required 5/5 · optional <passed>/<total> (skipped: a, b, c)

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

type maskCase struct {
	Input  json.RawMessage `json:"input"`
	Output json.RawMessage `json:"output"`
}

type maskCases struct {
	Required map[string][]maskCase `json:"required"`
	Optional map[string][]maskCase `json:"optional"`
}

func loadMaskCases(t *testing.T) *maskCases {
	t.Helper()
	path := os.Getenv("MASK_CASES")
	if path == "" {
		path = "testdata/mask-cases.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("mask cases: %v", err)
	}
	var cases maskCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("mask cases: %v", err)
	}
	return &cases
}

func jsonString(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("case value %s is not a string", raw)
	}
	return s
}

func jsonPair(t *testing.T, raw json.RawMessage) (string, string) {
	t.Helper()
	var pair []string
	if err := json.Unmarshal(raw, &pair); err != nil || len(pair) != 2 {
		t.Fatalf("case value %s is not [string, string]", raw)
	}
	return pair[0], pair[1]
}

// ruleRunner returns the rule's output for a case, or false when the rule is not ported.
func ruleRunner(t *testing.T, rule string) (func(c maskCase) any, bool) {
	str := func(fn func(string) string) func(c maskCase) any {
		return func(c maskCase) any { return fn(jsonString(t, c.Input)) }
	}
	boolean := func(fn func(string) bool) func(c maskCase) any {
		return func(c maskCase) any { return fn(jsonString(t, c.Input)) }
	}
	switch rule {
	case "redactValue":
		return str(RedactValue), true
	case "redactText":
		return str(RedactText), true
	case "isSensitiveKey":
		return boolean(IsSensitiveKey), true
	case "maskSql":
		return str(MaskSql), true
	case "maskPathByRoute":
		return func(c maskCase) any { p, r := jsonPair(t, c.Input); return MaskPathByRoute(p, r) }, true
	case "maskJsonText":
		return func(c maskCase) any { return MaskJsonText(jsonString(t, c.Input), true) }, true
	case "maskUrl":
		return str(MaskUrl), true
	case "maskQuery":
		return str(MaskQuery), true
	case "maskHeaderValue":
		return func(c maskCase) any { n, v := jsonPair(t, c.Input); return MaskHeaderValue(n, v) }, true
	case "isSensitiveHeader":
		return boolean(IsSensitiveHeader), true
	case "maskStatement":
		return func(c maskCase) any { s, sys := jsonPair(t, c.Input); return MaskStatement(s, sys, 65536) }, true
	case "maskIdentifier":
		return str(MaskIdentifier), true
	case "isThaiNationalId":
		return boolean(IsThaiNationalId), true
	case "maskNumber":
		// the SDK's case passes the id as a string: maskNumber leaves non-numbers as they are
		return func(c maskCase) any {
			v, _ := ParseJSON(c.Input)
			return MaskNumber(v)
		}, true
	}
	return nil, false
}

func runRule(t *testing.T, rule string, cases []maskCase) (passed int, failed []string) {
	run, ok := ruleRunner(t, rule)
	if !ok {
		return 0, nil
	}
	for i, c := range cases {
		got := run(c)
		gotJSON, _ := json.Marshal(got)
		var want any
		_ = json.Unmarshal(c.Output, &want)
		wantJSON, _ := json.Marshal(want)
		if string(gotJSON) == string(wantJSON) {
			passed++
		} else {
			failed = append(failed, fmt.Sprintf("%s[%d] input %s\n    want %s\n    got  %s", rule, i, c.Input, wantJSON, gotJSON))
		}
	}
	return passed, failed
}

func TestMaskCases(t *testing.T) {
	cases := loadMaskCases(t)
	requiredRules := sortedKeys(cases.Required)
	requiredPassed, requiredCases, requiredCasesPassed := 0, 0, 0
	for _, rule := range requiredRules {
		if _, ok := ruleRunner(t, rule); !ok {
			t.Errorf("required rule %s is not ported", rule)
			continue
		}
		passed, failed := runRule(t, rule, cases.Required[rule])
		requiredCases += len(cases.Required[rule])
		requiredCasesPassed += passed
		if len(failed) == 0 {
			requiredPassed++
		}
		for _, f := range failed {
			t.Errorf("required %s", f)
		}
	}
	optionalTotal, optionalPassed := 0, 0
	var skipped []string
	for _, rule := range sortedKeys(cases.Optional) {
		list := cases.Optional[rule]
		optionalTotal += len(list)
		if _, ok := ruleRunner(t, rule); !ok {
			skipped = append(skipped, rule)
			continue
		}
		passed, failed := runRule(t, rule, list)
		optionalPassed += passed
		for _, f := range failed {
			t.Logf("optional %s", f)
		}
	}
	line := fmt.Sprintf("mask: required %d/%d · optional %d/%d (skipped: %s)",
		requiredPassed, len(requiredRules), optionalPassed, optionalTotal, strings.Join(skipped, ", "))
	fmt.Println(line)
	fmt.Printf("mask: required cases %d/%d\n", requiredCasesPassed, requiredCases)
	if requiredPassed != len(requiredRules) {
		t.Fatalf("required mask cases failed")
	}
}

func sortedKeys(m map[string][]maskCase) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
