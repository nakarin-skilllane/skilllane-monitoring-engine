package main

// Envelope items → ClickHouse rows: a 1:1 port of apps/engine/src/ingest/mappers.ts
// (same helpers, same fallbacks). A row is written straight to its JSONEachRow
// line, columns in the engine's order.

import (
	"errors"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---------- small value helpers ----------

// str: ” for null/undefined, strings as is, numbers / booleans as String(), else JSON.
func str(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		return JSNumberString(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	}
	return Stringify(value)
}

// parseIntJS: Number.parseInt(text, 10).
func parseIntJS(text string) (float64, bool) {
	i := 0
	for i < len(text) && (isJSSpace(text[i]) || text[i] == 0xa0) {
		i++
	}
	neg := false
	if i < len(text) && (text[i] == '+' || text[i] == '-') {
		neg = text[i] == '-'
		i++
	}
	start := i
	for i < len(text) && isDigit(text[i]) {
		i++
	}
	if i == start {
		return 0, false
	}
	f, err := strconv.ParseFloat(text[start:i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, false
	}
	if neg {
		f = -f
	}
	return f, true
}

// uintOf: non-negative integer clamped to max (UInt16 / UInt8 columns).
func uintOf(value any, max float64) uint64 {
	var n float64
	if f, ok := value.(float64); ok {
		n = f
	} else {
		f, ok := parseIntJS(str(value))
		if !ok {
			return 0
		}
		n = f
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return 0
	}
	return uint64(math.Min(math.Trunc(n), max))
}

// jsNumber: Number(value) → (number, finite).
func jsNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case nil:
		return 0, true
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return 0, true
		}
		if strings.ContainsAny(s, "iInN_") { // Infinity / NaN / Go-only spellings
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// floatOf: Nullable(Float64): nil for ”, null, undefined and anything not finite.
func floatOf(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	if s, ok := value.(string); ok && s == "" {
		return 0, false
	}
	return jsNumber(value)
}

func stringArray(value any) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if e == nil {
				continue
			}
			out = append(out, str(e))
		}
		return out
	}
	return []string{str(value)}
}

// strMap is Map(String, String) in insertion order.
type strMap struct {
	keys []string
	vals []string
}

func (m *strMap) index(key string) int {
	for i, k := range m.keys {
		if k == key {
			return i
		}
	}
	return -1
}

func (m *strMap) Get(key string) (string, bool) {
	if i := m.index(key); i >= 0 {
		return m.vals[i], true
	}
	return "", false
}

func (m *strMap) Set(key, val string) {
	if i := m.index(key); i >= 0 {
		m.vals[i] = val
		return
	}
	m.keys = append(m.keys, key)
	m.vals = append(m.vals, val)
}

func (m *strMap) Delete(key string) {
	if i := m.index(key); i >= 0 {
		m.keys = append(m.keys[:i], m.keys[i+1:]...)
		m.vals = append(m.vals[:i], m.vals[i+1:]...)
	}
}

// stringMap: strings as is, anything else JSON-encoded; nothing when not an object.
func stringMap(value any) *strMap {
	out := &strMap{}
	o, ok := value.(*Object)
	if !ok || o == nil {
		return out
	}
	out.keys = make([]string, 0, o.Len())
	out.vals = make([]string, 0, o.Len())
	o.Each(func(k string, v any) {
		out.Set(k, str(v))
	})
	return out
}

// present: the `first(...)` test: not undefined, null or ”.
func present(v any, ok bool) bool {
	if !ok || v == nil {
		return false
	}
	if s, isStr := v.(string); isStr && s == "" {
		return false
	}
	return true
}

func first(o *Object, keys ...string) any {
	for _, k := range keys {
		if v, ok := o.Get(k); present(v, ok) {
			return v
		}
	}
	return nil
}

var schemeRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
var schemeHostRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://[^/?#]*`)

// pathOf: the path of a URL or a request target; never the query string or fragment.
func pathOf(value any) string {
	raw := str(value)
	if raw == "" {
		return ""
	}
	path := raw
	if schemeRe.MatchString(raw) {
		u, err := url.Parse(raw)
		if err == nil && u.Host != "" || err == nil && strings.EqualFold(u.Scheme, "file") {
			path = u.EscapedPath()
			switch strings.ToLower(u.Scheme) {
			case "http", "https", "ws", "wss", "ftp", "file":
				if path == "" {
					path = "/"
				}
			}
		} else {
			path = schemeHostRe.ReplaceAllString(raw, "")
		}
	}
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	return path
}

// ---------- time ----------

const maxDateMs = 8.64e15

// parseDateJS: Date.parse → milliseconds (ISO forms and the usual RFC formats).
func parseDateJS(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	if len(s) == 24 && s[4] == '-' && s[7] == '-' && s[10] == 'T' && s[13] == ':' && s[16] == ':' && s[19] == '.' && s[23] == 'Z' {
		t, err := time.Parse("2006-01-02T15:04:05.000Z", s)
		if err == nil {
			return t.UnixMilli(), true
		}
	}
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04Z07:00",
		"2006-01-02T15:04",
		"2006-01-02",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		time.RFC1123Z,
		time.RFC1123,
		time.RFC850,
		time.ANSIC,
		time.UnixDate,
	}
	for _, layout := range layouts {
		t, err := time.Parse(layout, s)
		if err == nil {
			ms := t.UnixMilli()
			if math.Abs(float64(ms)) > maxDateMs {
				return 0, false
			}
			return ms, true
		}
	}
	return 0, false
}

// appendDateTime64 writes `YYYY-MM-DD HH:MM:SS.ffffff` (digits of the nanosecond fraction).
func appendDateTime64(dst []byte, ms int64, fracNanos uint64, digits int) []byte {
	t := time.UnixMilli(ms).UTC()
	dst = t.AppendFormat(dst, "2006-01-02 15:04:05")
	if digits > 0 {
		dst = append(dst, '.')
		var frac [9]byte
		for i := 8; i >= 0; i-- {
			frac[i] = byte('0' + fracNanos%10)
			fracNanos /= 10
		}
		dst = append(dst, frac[:digits]...)
	}
	return dst
}

var nanosRe = regexp.MustCompile(`^\d{1,30}$`)

var errSpanTime = errors.New("span time out of range")

// nanosSplit: a nanosecond decimal string → (ms, nanos % 1e9); error when the date is invalid.
func nanosSplit(nanos string) (int64, uint64, error) {
	if len(nanos) <= 19 {
		n, err := strconv.ParseUint(nanos, 10, 64)
		if err != nil {
			return 0, 0, err
		}
		ms := n / 1_000_000
		if float64(ms) > maxDateMs {
			return 0, 0, errSpanTime
		}
		return int64(ms), n % 1_000_000_000, nil
	}
	n, ok := new(big.Int).SetString(nanos, 10)
	if !ok {
		return 0, 0, errSpanTime
	}
	ms := new(big.Int).Div(n, big.NewInt(1_000_000))
	if !ms.IsInt64() || float64(ms.Int64()) > maxDateMs {
		return 0, 0, errSpanTime
	}
	frac := new(big.Int).Mod(n, big.NewInt(1_000_000_000))
	return ms.Int64(), frac.Uint64(), nil
}

// durationNanos: end - start as a float (JS Number(bigint)), 0 when negative.
func durationNanos(start, end string) float64 {
	if len(start) <= 19 && len(end) <= 19 {
		s, _ := strconv.ParseUint(start, 10, 64)
		e, _ := strconv.ParseUint(end, 10, 64)
		if e > s {
			return float64(e - s)
		}
		return 0
	}
	s, _ := new(big.Int).SetString(start, 10)
	e, _ := new(big.Int).SetString(end, 10)
	d := new(big.Int).Sub(e, s)
	if d.Sign() <= 0 {
		return 0
	}
	f, _ := new(big.Float).SetInt(d).Float64()
	return f
}

// ---------- row writer ----------

type rowWriter struct {
	b     []byte
	first bool
}

func newRowWriter(cap int) *rowWriter {
	return &rowWriter{b: make([]byte, 1, cap), first: true}
}

func (w *rowWriter) key(name string) {
	if !w.first {
		w.b = append(w.b, ',')
	}
	w.first = false
	w.b = append(w.b, '"')
	w.b = append(w.b, name...)
	w.b = append(w.b, '"', ':')
}

func (w *rowWriter) str(name, v string) {
	w.key(name)
	w.b = AppendJSONString(w.b, v)
}

func (w *rowWriter) num(name string, v float64) {
	w.key(name)
	w.b = AppendJSNumber(w.b, v)
}

func (w *rowWriter) uint(name string, v uint64) {
	w.key(name)
	w.b = strconv.AppendUint(w.b, v, 10)
}

func (w *rowWriter) nullableFloat(name string, v float64, ok bool) {
	w.key(name)
	if ok {
		w.b = AppendJSNumber(w.b, v)
	} else {
		w.b = append(w.b, "null"...)
	}
}

func (w *rowWriter) strArray(name string, v []string) {
	w.key(name)
	w.b = append(w.b, '[')
	for i, s := range v {
		if i > 0 {
			w.b = append(w.b, ',')
		}
		w.b = AppendJSONString(w.b, s)
	}
	w.b = append(w.b, ']')
}

func (w *rowWriter) strMap(name string, m *strMap) {
	w.key(name)
	w.b = append(w.b, '{')
	for i, k := range m.keys {
		if i > 0 {
			w.b = append(w.b, ',')
		}
		w.b = AppendJSONString(w.b, k)
		w.b = append(w.b, ':')
		w.b = AppendJSONString(w.b, m.vals[i])
	}
	w.b = append(w.b, '}')
}

func (w *rowWriter) line() []byte {
	w.b[0] = '{'
	return append(w.b, '}', '\n')
}

// ---------- resource ----------

type resourceColumns struct {
	env, service, role, version, host string
}

// maskedBySender: the sender masked its items with these rules (or newer ones).
func maskedBySender(resource *Object) bool {
	v, ok := resource.Get(MaskResourceKey)
	if !ok {
		return false
	}
	n, finite := jsNumber(v)
	return finite && n >= MaskVersion
}

func resourceColumnsOf(resource, record *Object) resourceColumns {
	recordService := ""
	if record != nil {
		v, _ := record.Get("service.name")
		recordService = str(v)
	}
	slash := strings.IndexByte(recordService, '/')
	var serviceFallback, roleFallback any
	if slash >= 0 {
		serviceFallback = recordService[:slash]
		roleFallback = recordService[slash+1:]
	} else {
		serviceFallback = recordService
	}
	pick := func(resourceKey string, recordKey string, fallback any) string {
		if v, ok := resource.Get(resourceKey); present(v, ok) {
			return str(v)
		}
		if recordKey != "" && record != nil {
			if v, ok := record.Get(recordKey); present(v, ok) {
				return str(v)
			}
		}
		if present(fallback, fallback != nil) {
			return str(fallback)
		}
		return ""
	}
	env := pick("deployment.environment.name", "service.environment", nil)
	if env == "" {
		env = "unknown"
	}
	return resourceColumns{
		env:     env,
		service: pick("service.name", "", serviceFallback),
		role:    pick("app.role", "", roleFallback),
		version: pick("service.version", "service.version", nil),
		host:    pick("host.name", "host.name", nil),
	}
}

func (w *rowWriter) resource(rc resourceColumns) {
	w.str("env", rc.env)
	w.str("service", rc.service)
	w.str("role", rc.role)
	w.str("version", rc.version)
	w.str("host", rc.host)
}

// ---------- logs ----------

var logColumnKeys = toSet("@timestamp", "service.name", "service.version", "service.environment", "host.name",
	"log.level", "log.logger", "event.code", "event.module", "message", "trace.id", "span.id", "user.id", "user.roles",
	"organization.id", "http.request.method", "http.route", "url.path", "url.domain", "http.response.status_code",
	"duration_ms", "error.type", "error.code", "error.message", "error.hint", "error.detail", "error.how_to_fix",
	"error.stack_trace", "error.cause", "log.origin.function", "log.origin.file.name", "db.statement", "dependency.type",
	"dependency.name", "dependency.host", "dependency.port", "job.queue", "job.type", "job.id", "job.attempt",
	"job.max_attempts", "job.final", "job.inflight", "reason", "labels")

var labelColumns = [...]string{"error_category", "error_target", "usecase", "failed_step"}

var redactTextKeys = [...]string{"message", "error.message", "error.stack_trace", "error.hint", "error.detail", "error.how_to_fix", "reason"}

func jobFinal(value any) uint64 {
	switch v := value.(type) {
	case bool:
		if v {
			return 1
		}
	case float64:
		if v == 1 {
			return 1
		}
	case string:
		if v == "true" || v == "1" {
			return 1
		}
	}
	return 0
}

// maskLogRecord: the SDK's redactRecord rules on a copy of a record its sender did not mask.
func maskLogRecord(r *Object) *Object {
	out := r.Clone()
	textOf := func(key string, mask func(string) string) {
		if i := out.index(key); i >= 0 {
			if s, ok := out.vals[i].(string); ok {
				out.vals[i] = mask(s)
			}
		}
	}
	for _, key := range redactTextKeys {
		textOf(key, RedactText)
	}
	textOf("db.statement", MaskSql)
	textOf("user.id", RedactValue)
	textOf("url.domain", RedactValue)
	textOf("job.id", MaskIdentifier)
	textOf("dependency.name", MaskEndpoint)
	textOf("dependency.host", MaskEndpoint)
	if i := out.index("url.path"); i >= 0 {
		if s, ok := out.vals[i].(string); ok {
			route := ""
			if rv, ok := out.Get("http.route"); ok {
				route, _ = rv.(string)
			}
			out.vals[i] = MaskPathByRoute(RedactValue(StripQuery(s)), route)
		}
	}
	if i := out.index("error.cause"); i >= 0 {
		cause := out.vals[i]
		text, ok := cause.(string)
		if !ok {
			text = Stringify(cause)
		}
		out.vals[i] = MaskJsonText(text, true)
	}
	return out
}

func getStr(o *Object, key string) string {
	v, _ := o.Get(key)
	return str(v)
}

// mapLog: one log item → its JSONEachRow line. fallbackMs is the envelope's sentAt (or now).
func mapLog(item any, resource *Object, fallbackMs int64) ([]byte, error) {
	rec, ok := item.(*Object)
	if !ok || rec == nil {
		return nil, errors.New("log item is not an object")
	}
	masked := maskedBySender(resource)
	r := rec
	if !masked {
		r = maskLogRecord(rec)
	}
	labelsValue, _ := r.Get("labels")
	labels := stringMap(labelsValue)
	for i, key := range labels.keys {
		if IsSensitiveKey(key) {
			labels.vals[i] = REDACTED
		} else if !masked {
			labels.vals[i] = RedactText(labels.vals[i])
		}
	}
	var labelCols [len(labelColumns)]string
	for i, key := range labelColumns {
		labelCols[i], _ = labels.Get(key)
		labels.Delete(key)
	}
	fields := &strMap{}
	r.Each(func(key string, value any) {
		if _, column := logColumnKeys[key]; column {
			return
		}
		switch {
		case masked:
			fields.Set(key, str(value))
		case IsSensitiveKey(key):
			fields.Set(key, REDACTED)
		default:
			fields.Set(key, RedactValue(str(value)))
		}
	})
	ms := fallbackMs
	if tsValue, ok := r.Get("@timestamp"); ok {
		if iso := str(tsValue); iso != "" {
			if parsed, ok := parseDateJS(iso); ok {
				ms = parsed
			}
		}
	}
	correlation, _ := labels.Get("correlation_id")
	w := newRowWriter(1024)
	w.key("timestamp")
	w.b = append(w.b, '"')
	w.b = appendDateTime64(w.b, ms, uint64(((ms%1000)+1000)%1000)*1_000_000, 3)
	w.b = append(w.b, '"')
	w.resource(resourceColumnsOf(resource, r))
	w.str("level", getStr(r, "log.level"))
	w.str("logger", getStr(r, "log.logger"))
	w.str("event_code", getStr(r, "event.code"))
	w.str("event_module", getStr(r, "event.module"))
	w.str("message", getStr(r, "message"))
	w.str("trace_id", getStr(r, "trace.id"))
	w.str("span_id", getStr(r, "span.id"))
	w.str("correlation_id", correlation)
	w.str("user_id", getStr(r, "user.id"))
	rolesValue, _ := r.Get("user.roles")
	w.strArray("user_roles", stringArray(rolesValue))
	w.str("organization_id", getStr(r, "organization.id"))
	w.str("http_method", getStr(r, "http.request.method"))
	w.str("http_route", getStr(r, "http.route"))
	w.str("url_path", getStr(r, "url.path"))
	w.str("url_domain", getStr(r, "url.domain"))
	statusValue, _ := r.Get("http.response.status_code")
	w.uint("http_status", uintOf(statusValue, 65535))
	durationValue, _ := r.Get("duration_ms")
	duration, hasDuration := floatOf(durationValue)
	w.nullableFloat("duration_ms", duration, hasDuration)
	w.str("error_type", getStr(r, "error.type"))
	w.str("error_code", getStr(r, "error.code"))
	w.str("error_message", getStr(r, "error.message"))
	w.str("error_hint", getStr(r, "error.hint"))
	w.str("error_detail", getStr(r, "error.detail"))
	w.str("error_how_to_fix", getStr(r, "error.how_to_fix"))
	w.str("error_stack", getStr(r, "error.stack_trace"))
	w.str("error_cause", getStr(r, "error.cause"))
	w.str("error_category", labelCols[0])
	w.str("error_target", labelCols[1])
	w.str("usecase", labelCols[2])
	w.str("failed_step", labelCols[3])
	w.str("origin_function", getStr(r, "log.origin.function"))
	w.str("origin_file", getStr(r, "log.origin.file.name"))
	w.str("db_statement", getStr(r, "db.statement"))
	w.str("dependency_type", getStr(r, "dependency.type"))
	w.str("dependency_name", getStr(r, "dependency.name"))
	w.str("dependency_host", getStr(r, "dependency.host"))
	portValue, _ := r.Get("dependency.port")
	w.uint("dependency_port", uintOf(portValue, 65535))
	w.str("job_queue", getStr(r, "job.queue"))
	w.str("job_type", getStr(r, "job.type"))
	w.str("job_id", getStr(r, "job.id"))
	attemptValue, _ := r.Get("job.attempt")
	w.uint("job_attempt", uintOf(attemptValue, 65535))
	maxAttemptsValue, _ := r.Get("job.max_attempts")
	w.uint("job_max_attempts", uintOf(maxAttemptsValue, 65535))
	finalValue, _ := r.Get("job.final")
	w.uint("job_final", jobFinal(finalValue))
	inflightValue, _ := r.Get("job.inflight")
	w.strArray("job_inflight", stringArray(inflightValue))
	w.str("reason", getStr(r, "reason"))
	w.strMap("labels", labels)
	w.strMap("fields", fields)
	return w.line(), nil
}

// ---------- spans ----------

func peerOf(attrs *Object) string {
	host := str(first(attrs, "server.address", "net.peer.name"))
	if host == "" {
		return ""
	}
	port := str(first(attrs, "server.port", "net.peer.port"))
	if port != "" {
		return host + ":" + port
	}
	return host
}

func urlPathOf(attrs *Object) string {
	if direct, ok := attrs.Get("url.path"); ok && direct != "" {
		return pathOf(direct)
	}
	if target, ok := attrs.Get("http.target"); ok && target != "" {
		return pathOf(target)
	}
	return pathOf(first(attrs, "url.full", "http.url"))
}

func objectOf(v any) *Object {
	if o, ok := v.(*Object); ok && o != nil {
		return o
	}
	return newObject(0)
}

// truthy: JavaScript's `!value` negated.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// mapSpan: one span item → its JSONEachRow line; an error when it cannot become a row.
func mapSpan(item any, resource *Object) ([]byte, error) {
	sp, ok := item.(*Object)
	if !ok || sp == nil {
		return nil, errors.New("span item is not an object")
	}
	traceID, _ := sp.Get("traceId")
	spanID, _ := sp.Get("spanId")
	if !truthy(traceID) || !truthy(spanID) {
		return nil, errors.New("span item without traceId/spanId")
	}
	startValue, _ := sp.Get("startTimeUnixNano")
	start := str(startValue)
	endValue, _ := sp.Get("endTimeUnixNano")
	end := str(endValue)
	if end == "" {
		end = start
	}
	if !nanosRe.MatchString(start) || !nanosRe.MatchString(end) {
		return nil, errors.New("span " + str(spanID) + ": start/end time is not a nanosecond decimal string")
	}
	ms, frac, err := nanosSplit(start)
	if err != nil {
		return nil, errors.New("span " + str(spanID) + ": invalid start time")
	}
	attrsValue, _ := sp.Get("attributes")
	attrs := objectOf(attrsValue)
	masked := maskedBySender(resource)
	dbSystem := str(first(attrs, "db.system.name", "db.system"))
	rawStatement := str(first(attrs, "db.query.text", "db.statement"))
	statement := rawStatement
	if !masked && rawStatement != "" {
		statement = MaskStatement(rawStatement, dbSystem, fallbackMaxBytes)
	}
	io := splitSpanAttributes(attrs, statement, masked)
	var events []any
	if ev, ok := sp.Get("events"); ok && ev != nil {
		list, isList := ev.([]any)
		if !isList {
			return nil, errors.New("span " + str(spanID) + ": events is not an array")
		}
		events = list
	}
	if !masked {
		events = maskEvents(events)
	}
	var exAttrs *Object
	for _, e := range events {
		if eo, ok := e.(*Object); ok && eo != nil {
			if name, _ := eo.Get("name"); name == "exception" {
				av, _ := eo.Get("attributes")
				exAttrs = objectOf(av)
				break
			}
		}
	}
	if exAttrs == nil {
		exAttrs = newObject(0)
	}
	parentValue, _ := sp.Get("parentSpanId")
	parent := str(parentValue)
	route := getStr(attrs, "http.route")
	urlPath := urlPathOf(attrs)
	text := func(v any) string {
		if masked {
			return str(v)
		}
		return RedactValue(str(v))
	}
	statusValue, _ := sp.Get("status")
	status := objectOf(statusValue)
	scopeValue, _ := sp.Get("scope")
	scope := objectOf(scopeValue)
	remote, _ := sp.Get("parentIsRemote")
	isEntry := uint64(0)
	if parent == "" || remote == true {
		isEntry = 1
	}
	statusCode := getStr(status, "code")
	if statusCode == "" {
		statusCode = "UNSET"
	}
	w := newRowWriter(2048)
	w.key("timestamp")
	w.b = append(w.b, '"')
	w.b = appendDateTime64(w.b, ms, frac, 6)
	w.b = append(w.b, '"')
	w.num("duration_ns", durationNanos(start, end))
	w.resource(resourceColumnsOf(resource, nil))
	w.str("trace_id", str(traceID))
	w.str("span_id", str(spanID))
	w.str("parent_span_id", parent)
	w.uint("is_entry", isEntry)
	nameValue, _ := sp.Get("name")
	w.str("name", text(nameValue))
	w.str("kind", getStr(sp, "kind"))
	w.str("status_code", statusCode)
	messageValue, _ := status.Get("message")
	w.str("status_message", text(messageValue))
	w.str("scope_name", getStr(scope, "name"))
	w.str("http_method", str(first(attrs, "http.request.method", "http.method")))
	w.str("http_route", route)
	w.uint("http_status", uintOf(first(attrs, "http.response.status_code", "http.status_code"), 65535))
	if masked {
		w.str("url_path", urlPath)
	} else {
		w.str("url_path", MaskPathByRoute(RedactValue(urlPath), route))
	}
	w.str("db_system", dbSystem)
	w.str("db_statement", sliceUTF16(statement, dbStatementMax))
	w.str("peer", peerOf(attrs))
	w.str("exception_type", getStr(exAttrs, "exception.type"))
	w.str("exception_message", getStr(exAttrs, "exception.message"))
	w.strMap("attributes", io.attributes)
	w.strMap("resource", stringMap(resource))
	w.key("events")
	w.b = AppendJSONString(w.b, Stringify(eventsOrEmpty(events)))
	w.str("db_statement_full", io.dbStatementFull)
	w.uint("db_param_count", uint64(io.dbParamCount))
	return w.line(), nil
}

func eventsOrEmpty(events []any) []any {
	if events == nil {
		return []any{}
	}
	return events
}

// maskEvents: events of a sender that did not mask: every attribute by the key rule and the value rule.
func maskEvents(events []any) []any {
	out := make([]any, len(events))
	for i, e := range events {
		eo, ok := e.(*Object)
		if !ok || eo == nil {
			out[i] = e
			continue
		}
		av, has := eo.Get("attributes")
		attrs, isObj := av.(*Object)
		if !has || !truthy(av) || !isObj {
			out[i] = e
			continue
		}
		masked := newObject(attrs.Len())
		attrs.Each(func(key string, value any) {
			switch v := value.(type) {
			case string:
				masked.Set(key, maskAttributeText(key, v, ""))
			case []any:
				list := make([]any, len(v))
				for j, item := range v {
					if s, ok := item.(string); ok {
						list[j] = maskAttributeText(key, s, "")
					} else {
						list[j] = item
					}
				}
				masked.Set(key, list)
			default:
				if IsSensitiveKey(key) {
					masked.Set(key, REDACTED)
				} else {
					masked.Set(key, value)
				}
			}
		})
		copy := eo.Clone()
		copy.Set("attributes", masked)
		out[i] = copy
	}
	return out
}

// utf16Len: a string's length in UTF-16 code units (JavaScript's .length).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// sliceUTF16: s.slice(0, n) in UTF-16 units.
func sliceUTF16(s string, n int) string {
	if len(s) <= n {
		return s
	}
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}
