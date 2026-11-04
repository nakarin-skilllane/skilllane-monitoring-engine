package main

// Port of skilllane-monitoring/contract mask/io.js maskStatement (the span
// statement rule). maskBodyText / maskHeaderJson belong to the span I/O columns,
// which this prototype leaves to ClickHouse defaults.

import "strings"

func firstNonSpace(text string) byte {
	for i := 0; i < len(text); i++ {
		if text[i] > 32 && !strings.HasPrefix(text[i:], bomUTF8) {
			return text[i]
		}
		if strings.HasPrefix(text[i:], bomUTF8) {
			i += 2
		}
	}
	return 0
}

// MaskStatement: a db statement by its system: Redis → the value rule, JSON
// (Mongo and friends) → the JSON rule, anything else → the SQL rule. Cut to maxBytes.
func MaskStatement(statement, system string, maxBytes int) string {
	text, truncated := TruncateUTF8(statement, maxBytes)
	if strings.Contains(strings.ToLower(system), "redis") {
		out, _ := TruncateUTF8(RedactValue(text), maxBytes)
		return out
	}
	first := firstNonSpace(text)
	if first == '{' || first == '[' {
		out, _ := TruncateUTF8(MaskJsonText(text, !truncated), maxBytes)
		return out
	}
	out, _ := TruncateUTF8(MaskSql(text), maxBytes)
	return out
}
