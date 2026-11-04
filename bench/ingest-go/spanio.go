package main

// Port of the attribute side of apps/engine/src/ingest/span-io.ts: the captured
// I/O keys leave `attributes` (their columns are left to ClickHouse defaults in
// this prototype); the rest is stringified and, for a sender that did not mask,
// masked here. db_statement_full and db_param_count are kept (cheap).

import "strings"

const (
	dbStatementMax   = 2000
	fallbackMaxBytes = 262_144
)

var ioKeys = toSet("url.query", "http.request.headers", "http.response.headers", "http.request.body",
	"http.response.body", "http.request.body.size", "http.response.body.size", "http.request.body.truncated",
	"http.response.body.truncated", "skilllane.monitoring.db.parameters", "db.statement.parameters",
	"db.postgresql.values", "messaging.message.body", "messaging.message.body.size",
	"messaging.message.body.truncated", "messaging.message.headers")

const (
	queryParameterPrefix     = "db.query.parameter."
	operationParameterPrefix = "db.operation.parameter."
	requestHeaderPrefix      = "http.request.header."
	responseHeaderPrefix     = "http.response.header."
)

var urlAttributes = toSet("url.full", "http.url", "http.target")
var idAttributes = toSet("job.id", "messaging.message.id", "messaging.message.conversation_id", "messaging.kafka.message.key")

// maskAttributeText: one attribute of a sender that did not mask: URLs by their
// query, ids by their segments, the rest by key and value.
func maskAttributeText(key, value, route string) string {
	if _, ok := urlAttributes[key]; ok {
		if key == "http.target" {
			return MaskPathByRoute(MaskUrl(value), route)
		}
		return MaskUrl(value)
	}
	if key == "url.path" {
		return MaskPathByRoute(RedactValue(value), route)
	}
	if IsSensitiveKey(key) {
		return REDACTED
	}
	if _, ok := idAttributes[key]; ok {
		return MaskIdentifier(value)
	}
	return RedactValue(value)
}

type spanIO struct {
	attributes      *strMap
	dbStatementFull string
	dbParamCount    int
}

// bindCount: the binds a `db_params` JSON would list (without the SDK's `…` cut marker).
func bindCount(sdkParams any, perKey int, statementParams any, pgValues any) int {
	if sdkParams != nil {
		text := str(sdkParams)
		if text == "" {
			return 0
		}
		parsed, err := ParseJSON([]byte(text))
		if err != nil {
			return 0
		}
		list, ok := parsed.([]any)
		if !ok {
			return 0
		}
		n := 0
		for _, p := range list {
			if o, ok := p.(*Object); ok && o != nil {
				if k, _ := o.Get("key"); k == "…" {
					continue
				}
			}
			n++
		}
		return min(n, 65535)
	}
	if perKey > 0 {
		return min(perKey, 65535)
	}
	if statementParams != nil {
		parsed, err := ParseJSON([]byte(str(statementParams)))
		if err != nil {
			return 0
		}
		switch v := parsed.(type) {
		case []any:
			return min(len(v), 65535)
		case *Object:
			return min(v.Len(), 65535)
		}
		return 0
	}
	if list, ok := pgValues.([]any); ok {
		return min(len(list), 65535)
	}
	return 0
}

// splitSpanAttributes: the `attributes` map (strings, non-strings JSON-encoded)
// without the I/O keys; `statement` is already masked when the sender did not.
func splitSpanAttributes(attrs *Object, statement string, masked bool) spanIO {
	route := ""
	if rv, ok := attrs.Get("http.route"); ok {
		route, _ = rv.(string)
	}
	attributes := &strMap{keys: make([]string, 0, attrs.Len()), vals: make([]string, 0, attrs.Len())}
	var sdkParams, statementParams, pgValues any
	hasSDKParams := false
	queryParams, operationParams := 0, 0
	attrs.Each(func(key string, value any) {
		if _, io := ioKeys[key]; io {
			switch key {
			case "skilllane.monitoring.db.parameters":
				sdkParams, hasSDKParams = value, true
			case "db.statement.parameters":
				statementParams = value
			case "db.postgresql.values":
				pgValues = value
			}
			return
		}
		if strings.HasPrefix(key, "db.") {
			if strings.HasPrefix(key, queryParameterPrefix) {
				queryParams++
				return
			}
			if strings.HasPrefix(key, operationParameterPrefix) {
				operationParams++
				return
			}
			if key == "db.query.text" || key == "db.statement" {
				return
			}
		} else if strings.HasPrefix(key, "http.") {
			if strings.HasPrefix(key, requestHeaderPrefix) || strings.HasPrefix(key, responseHeaderPrefix) {
				return
			}
		}
		if masked {
			attributes.Set(key, str(value))
		} else {
			attributes.Set(key, maskAttributeText(key, str(value), route))
		}
	})
	perKey := queryParams
	if perKey == 0 {
		perKey = operationParams
	}
	out := spanIO{attributes: attributes}
	if utf16Len(statement) > dbStatementMax {
		out.dbStatementFull = statement
	}
	if hasSDKParams && str(sdkParams) != "" {
		out.dbParamCount = bindCount(sdkParams, 0, nil, nil)
	} else {
		out.dbParamCount = bindCount(nil, perKey, statementParams, pgValues)
	}
	return out
}
