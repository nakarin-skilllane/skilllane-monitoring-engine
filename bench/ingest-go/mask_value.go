package main

// Port of skilllane-monitoring/contract mask/value.js: the value rule
// (redactValue / redactText), JSON masking (maskJsonText, maskJsonValue) and
// the helpers they share. EMAIL_RUN, THAI_ID and PAIR use lookbehind in the
// SDK; here they are hand scanners (Go's RE2 has no lookaround). Everything
// scans bytes: every delimiter the rules look at is ASCII, so UTF-8 text
// behaves as UTF-16 text does in the SDK.

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	emailRe        = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	emailBoundedRe = regexp.MustCompile(`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}`)
	jwtRe          = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	bearerRe       = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
	bearerHintRe   = regexp.MustCompile(`(?i)bearer|basic`)
	userinfoRe     = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)([^\s:@/?#\[\]]*)(?::([^\s@/?#]*))?@`)
	urlQueryRe     = regexp.MustCompile(`((?:https?://[^\s?#"']+)|(?:/[\w\-./%~]*))\?[^\s#"']*`)
	placeholderRe  = regexp.MustCompile(`^(?::(?:\.\.\.)?[A-Za-z0-9_$#]+|\?|\$\d+|@[A-Za-z0-9_]+)$`)
	thirteenRe     = regexp.MustCompile(`^\d{13}$`)
)

const (
	emailRunMax     = 1024
	maskMaxDepth    = 32
	quotedRedacted  = `"` + REDACTED + `"`
	bomUTF8         = "\xEF\xBB\xBF"
	redactedEllipse = "[…]"
)

type maskMode struct {
	sql  bool
	json bool
}

// IsThaiNationalId: 13 digits, not starting with 0, mod-11 checksum.
func IsThaiNationalId(digits string) bool {
	if len(digits) != 13 || digits[0] == '0' {
		return false
	}
	sum := 0
	for i := 0; i < 13; i++ {
		if !isDigit(digits[i]) {
			return false
		}
		if i < 12 {
			sum += int(digits[i]-'0') * (13 - i)
		}
	}
	return (11-(sum%11))%10 == int(digits[12]-'0')
}

func StripQuery(path string) string {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		return path[:i]
	}
	return path
}

func isEmailRunByte(c byte) bool {
	return isAlnum(c) || c == '.' || c == '_' || c == '%' || c == '+' || c == '-' || c == '@'
}

// redactEmails: every maximal run of email characters that holds an '@' has its
// addresses replaced (EMAIL, or EMAIL_BOUNDED when the run is longer than 1,024).
func redactEmails(text string) string {
	var out []byte
	last := 0
	n := len(text)
	for i := 0; i < n; {
		if !isEmailRunByte(text[i]) {
			i++
			continue
		}
		j := i + 1
		hasAt := text[i] == '@'
		for j < n && isEmailRunByte(text[j]) {
			if text[j] == '@' {
				hasAt = true
			}
			j++
		}
		if hasAt {
			run := text[i:j]
			re := emailRe
			if len(run) > emailRunMax {
				re = emailBoundedRe
			}
			masked := re.ReplaceAllLiteralString(run, REDACTED)
			if masked != run {
				if out == nil {
					out = make([]byte, 0, n)
				}
				out = append(out, text[last:i]...)
				out = append(out, masked...)
				last = j
			}
		}
		i = j
	}
	if out == nil {
		return text
	}
	return string(append(out, text[last:]...))
}

func lineEnd(text string, from int) int {
	for i := from; i < len(text); i++ {
		if c := text[i]; c == '\n' || c == '\r' {
			return i
		}
	}
	return len(text)
}

func quoteEnd(text string, start int, q byte) int {
	for i := start + 1; i < len(text); i++ {
		c := text[i]
		if c == '\\' {
			i++
		} else if c == q {
			return i
		}
	}
	return -1
}

func containerEnd(text string, start int) int {
	depth := 0
	for i := start; i < len(text); i++ {
		c := text[i]
		if c == '"' {
			end := quoteEnd(text, i, '"')
			if end == -1 {
				return len(text)
			}
			i = end
		} else if c == '{' || c == '[' {
			depth++
		} else if c == '}' || c == ']' {
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return len(text)
}

func bareStop(c byte, json bool) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' || c == '"' || c == '\'' || c == '&' || c == ';' ||
		(json && (c == '}' || c == ']'))
}

func isWordByte(c byte) bool { return isAlnum(c) || c == '_' }

// schemeOf: `^([A-Za-z][\w.+-]*)[ \t]+\S` → the scheme word, or "" when it does not match.
func schemeOf(rest string) string {
	n := len(rest)
	if n == 0 || !(isLower(rest[0]) || isUpper(rest[0])) {
		return ""
	}
	i := 1
	for i < n && (isWordByte(rest[i]) || rest[i] == '.' || rest[i] == '+' || rest[i] == '-') {
		i++
	}
	j := i
	for j < n && (rest[j] == ' ' || rest[j] == '\t') {
		j++
	}
	if j == i || j >= n || isJSSpace(rest[j]) {
		return ""
	}
	return rest[:i]
}

func isJSSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

func startsNumeric(v string) bool {
	i := 0
	if i < len(v) && (v[i] == '-' || v[i] == '+') {
		i++
	}
	if i < len(v) && v[i] == '.' {
		i++
	}
	return i < len(v) && isDigit(v[i])
}

// maskedValue: the value after a sensitive `name =` at p → (end, replacement, has).
func maskedValue(text string, p int, name string, mode maskMode) (int, string, bool) {
	n := len(text)
	if p >= n {
		return p, "", false
	}
	c := text[p]
	if c == '"' || c == '\'' {
		closeAt := quoteEnd(text, p, c)
		if closeAt == -1 {
			if mode.json {
				return n, string(c) + REDACTED, true
			}
			return lineEnd(text, p), string(c) + REDACTED, true
		}
		if text[p+1:closeAt] == REDACTED {
			return closeAt + 1, "", false
		}
		return closeAt + 1, string(c) + REDACTED + string(c), true
	}
	if c == '\\' && p+1 < n && (text[p+1] == '"' || text[p+1] == '\'') {
		quote := text[p : p+2]
		closeAt := strings.Index(text[p+2:], quote)
		if closeAt == -1 {
			return lineEnd(text, p), quote + REDACTED, true
		}
		closeAt += p + 2
		return closeAt + 2, quote + REDACTED + quote, true
	}
	lower := strings.ToLower(name)
	if !mode.json && !mode.sql && (strings.HasSuffix(lower, "authorization") || lower == "cookie" || lower == "set-cookie") {
		end := lineEnd(text, p)
		rest := text[p:end]
		masked := REDACTED
		if scheme := schemeOf(rest); scheme != "" {
			masked = scheme + " " + REDACTED
		}
		if masked == rest {
			return end, "", false
		}
		return end, masked, true
	}
	if mode.json && (c == '{' || c == '[') {
		return containerEnd(text, p), quotedRedacted, true
	}
	end := p
	for end < n && !bareStop(text[end], mode.json) {
		end++
	}
	if end == p {
		return p, "", false
	}
	value := text[p:end]
	if value == REDACTED {
		return end, "", false
	}
	if mode.sql && (placeholderRe.MatchString(value) || !startsNumeric(value)) {
		return end, "", false
	}
	return end, REDACTED, true
}

func isPairNameByte(c byte) bool { return isAlnum(c) || c == '_' || c == '.' || c == '-' }

// matchPairOp: `[ \t]*(===|=>|:=|==|[:=])[ \t]*` at k → end of the match.
func matchPairOp(text string, k int) (int, bool) {
	n := len(text)
	for k < n && (text[k] == ' ' || text[k] == '\t') {
		k++
	}
	if k >= n {
		return 0, false
	}
	switch {
	case strings.HasPrefix(text[k:], "==="):
		k += 3
	case strings.HasPrefix(text[k:], "=>"), strings.HasPrefix(text[k:], ":="), strings.HasPrefix(text[k:], "=="):
		k += 2
	case text[k] == ':' || text[k] == '=':
		k++
	default:
		return 0, false
	}
	for k < n && (text[k] == ' ' || text[k] == '\t') {
		k++
	}
	return k, true
}

// matchPair: the PAIR regex at position i → (name, end of match, matched).
//
//	(?:(\\?["'])([A-Za-z0-9_.-]{1,64})\1|(?<![A-Za-z0-9_.\-\\])([A-Za-z0-9_.-]{1,64}))[ \t]*(===|=>|:=|==|[:=])[ \t]*
func matchPair(text string, i int) (string, int, bool) {
	n := len(text)
	c := text[i]
	if c == '\\' || c == '"' || c == '\'' {
		q := i
		if c == '\\' {
			if i+1 < n && (text[i+1] == '"' || text[i+1] == '\'') {
				q = i + 1
			} else {
				return "", 0, false
			}
		}
		j := q + 1
		for j < n && isPairNameByte(text[j]) {
			j++
		}
		if j == q+1 || j-(q+1) > 64 {
			return "", 0, false
		}
		g1 := text[i : q+1]
		if !strings.HasPrefix(text[j:], g1) {
			return "", 0, false
		}
		end, ok := matchPairOp(text, j+len(g1))
		if !ok {
			return "", 0, false
		}
		return text[q+1 : j], end, true
	}
	if !isPairNameByte(c) {
		return "", 0, false
	}
	if i > 0 && (isPairNameByte(text[i-1]) || text[i-1] == '\\') {
		return "", 0, false
	}
	j := i
	for j < n && isPairNameByte(text[j]) {
		j++
	}
	if j-i > 64 {
		return "", 0, false
	}
	end, ok := matchPairOp(text, j)
	if !ok {
		return "", 0, false
	}
	return text[i:j], end, true
}

func redactPairs(text string, mode maskMode) string {
	var out []byte
	last := 0
	n := len(text)
	pos := 0 // the regex's lastIndex
	for pos < n {
		// find the next match at or after pos
		var name string
		var matchAt, end int
		found := false
		for k := pos; k < n; k++ {
			if nm, e, ok := matchPair(text, k); ok {
				name, matchAt, end, found = nm, k, e, true
				break
			}
		}
		if !found {
			break
		}
		var sensitive bool
		if matchAt > 0 && (text[matchAt-1] == '?' || text[matchAt-1] == '&' || text[matchAt-1] == '#') {
			sensitive = IsSensitiveQueryName(name)
		} else {
			sensitive = IsSensitiveKey(name)
		}
		pos = end
		if !sensitive {
			continue
		}
		vEnd, masked, has := maskedValue(text, end, name, mode)
		if !has {
			continue
		}
		if out == nil {
			out = make([]byte, 0, n+16)
		}
		out = append(out, text[last:end]...)
		out = append(out, masked...)
		last = vEnd
		if pos < vEnd {
			pos = vEnd
		}
	}
	if out == nil {
		return text
	}
	return string(append(out, text[last:]...))
}

func redactUserinfo(text string) string {
	locs := userinfoRe.FindAllStringSubmatchIndex(text, -1)
	if locs == nil {
		return text
	}
	var out []byte
	last := 0
	for _, m := range locs {
		match := text[m[0]:m[1]]
		scheme := text[m[2]:m[3]]
		user := text[m[4]:m[5]]
		var repl string
		if m[6] >= 0 {
			password := text[m[6]:m[7]]
			if password != "" {
				repl = scheme + user + ":" + REDACTED + "@"
			} else {
				repl = match
			}
		} else if user != "" && user != REDACTED {
			repl = scheme + REDACTED + "@"
		} else {
			repl = match
		}
		out = append(out, text[last:m[0]]...)
		out = append(out, repl...)
		last = m[1]
	}
	return string(append(out, text[last:]...))
}

func hasDigits5(text string) bool {
	run := 0
	for i := 0; i < len(text); i++ {
		if isDigit(text[i]) {
			run++
			if run == 5 {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// matchThaiId: `(?<!\d)(\d)-?(\d{4})-?(\d{5})-?(\d{2})-?(\d)(?!\d)` at i → (digits, end, ok).
func matchThaiId(text string, i int) (string, int, bool) {
	n := len(text)
	if i > 0 && isDigit(text[i-1]) {
		return "", 0, false
	}
	var digits [13]byte
	d := 0
	p := i
	for _, group := range [5]int{1, 4, 5, 2, 1} {
		for k := 0; k < group; k++ {
			if p >= n || !isDigit(text[p]) {
				return "", 0, false
			}
			digits[d] = text[p]
			d++
			p++
		}
		if d < 13 && p < n && text[p] == '-' {
			p++
		}
	}
	if p < n && isDigit(text[p]) {
		return "", 0, false
	}
	return string(digits[:]), p, true
}

func redactThaiIds(text string) string {
	var out []byte
	last := 0
	n := len(text)
	for i := 0; i < n; {
		if !isDigit(text[i]) {
			i++
			continue
		}
		digits, end, ok := matchThaiId(text, i)
		if !ok {
			i++
			continue
		}
		if IsThaiNationalId(digits) {
			if out == nil {
				out = make([]byte, 0, n)
			}
			out = append(out, text[last:i]...)
			out = append(out, REDACTED...)
			last = end
		}
		i = end
	}
	if out == nil {
		return text
	}
	return string(append(out, text[last:]...))
}

type maskState struct{ changed bool }

// maskJsonInText: a whole JSON document as text → masked JSON, when it parses.
func maskJsonInText(text string) (string, bool) {
	first := 0
	for first < len(text) && text[first] <= 32 {
		first++
	}
	if first >= len(text) {
		return "", false
	}
	open := text[first]
	if open != '{' && open != '[' {
		return "", false
	}
	last := len(text) - 1
	for last > first && text[last] <= 32 {
		last--
	}
	want := byte('}')
	if open == '[' {
		want = ']'
	}
	if text[last] != want {
		return "", false
	}
	parsed, err := ParseJSON([]byte(text))
	if err != nil {
		return "", false
	}
	st := &maskState{}
	masked := maskParsed(parsed, 0, st)
	if st.changed {
		return Stringify(masked), true
	}
	return text, true
}

func redactValueMode(text string, sql bool) string {
	if text == "" {
		return text
	}
	if !sql {
		if j, ok := maskJsonInText(text); ok {
			return j
		}
	}
	out := text
	if strings.Contains(out, "eyJ") {
		out = jwtRe.ReplaceAllLiteralString(out, REDACTED)
	}
	if bearerHintRe.MatchString(out) {
		out = bearerRe.ReplaceAllString(out, "${1} "+REDACTED)
	}
	if strings.Contains(out, "@") && strings.Contains(out, "://") {
		out = redactUserinfo(out)
	}
	if strings.ContainsAny(out, "=:") {
		out = redactPairs(out, maskMode{sql: sql})
	}
	if strings.Contains(out, "@") {
		out = redactEmails(out)
	}
	if hasDigits5(out) {
		out = redactThaiIds(out)
	}
	return out
}

// RedactValue: secrets and personal data in free text → [REDACTED] (the value rule).
func RedactValue(text string) string { return redactValueMode(text, false) }

// RedactText: the value rule after cutting query strings off URLs and paths.
func RedactText(text string) string {
	if strings.Contains(text, "?") {
		text = urlQueryRe.ReplaceAllString(text, "${1}")
	}
	return RedactValue(text)
}

// MaskNumber: a Thai national id as a JSON number → [REDACTED]; anything else as is.
func MaskNumber(value any) any {
	f, ok := value.(float64)
	if ok && f == float64(int64(f)) && f >= 1e12 && f < 1e13 && IsThaiNationalId(strconv.FormatInt(int64(f), 10)) {
		return REDACTED
	}
	return value
}

func maskKey(key string) string {
	if strings.Contains(key, "@") || hasDigits5(key) {
		return RedactValue(key)
	}
	return key
}

func renameKeys(record *Object, renamed map[string]string) *Object {
	out := newObject(record.Len())
	for i, key := range record.keys {
		name := key
		if r, ok := renamed[key]; ok {
			name = r
			for n := 2; out.Has(name); n++ {
				name = r + "#" + strconv.Itoa(n)
			}
		}
		out.Set(name, record.vals[i])
	}
	return out
}

func maskParsed(value any, depth int, st *maskState) any {
	switch v := value.(type) {
	case string:
		masked := RedactValue(v)
		if masked != v {
			st.changed = true
		}
		return masked
	case float64:
		masked := MaskNumber(v)
		if masked != any(v) {
			st.changed = true
		}
		return masked
	case nil, bool:
		return value
	case []any:
		if depth >= maskMaxDepth {
			st.changed = true
			return redactedEllipse
		}
		for i := range v {
			v[i] = maskParsed(v[i], depth+1, st)
		}
		return v
	case *Object:
		if depth >= maskMaxDepth {
			st.changed = true
			return redactedEllipse
		}
		var renamed map[string]string
		for i, key := range v.keys {
			if IsSensitiveKey(key) {
				if s, ok := v.vals[i].(string); !ok || s != REDACTED {
					v.vals[i] = REDACTED
					st.changed = true
				}
			} else {
				v.vals[i] = maskParsed(v.vals[i], depth+1, st)
			}
			if name := maskKey(key); name != key {
				if renamed == nil {
					renamed = map[string]string{}
				}
				renamed[key] = name
			}
		}
		if renamed == nil {
			return v
		}
		st.changed = true
		return renameKeys(v, renamed)
	}
	return value
}

// MaskJsonValue masks a parsed JSON value in place (sensitive keys, strings, Thai ids).
func MaskJsonValue(value any) any {
	return maskParsed(value, 0, &maskState{})
}

func trimJSONStart(text string) string {
	start := 0
	for start < len(text) {
		if text[start] <= 32 {
			start++
		} else if strings.HasPrefix(text[start:], bomUTF8) {
			start += 3
		} else {
			break
		}
	}
	return text[start:]
}

// MaskJsonText: a JSON document (complete) or a cut one → masked text. What
// does not parse goes through the loose tokenizer.
func MaskJsonText(text string, complete bool) string {
	body := trimJSONStart(text)
	if complete {
		parsed, err := ParseJSON([]byte(body))
		if err != nil {
			return maskJsonLoose(body)
		}
		return Stringify(maskParsed(parsed, 0, &maskState{}))
	}
	return maskJsonLoose(body)
}

// ---------- loose JSON (cut or invalid documents) ----------

func bareEnd(text string, start int) int {
	end := start
	n := len(text)
	for end < n {
		c := text[end]
		if c == ',' || c == '}' || c == ']' || c == ':' || c == '{' || c == '[' || c == '"' || c == '\'' ||
			c == ' ' || c == '\n' || c == '\r' || c == '\t' || strings.HasPrefix(text[end:], bomUTF8) ||
			(c == '/' && end+1 < n && (text[end+1] == '*' || text[end+1] == '/')) {
			break
		}
		end++
	}
	if end == start {
		return start + 1
	}
	return end
}

func nextChar(text string, from int) byte {
	for i := from; i < len(text); i++ {
		if text[i] > 32 && !strings.HasPrefix(text[i:], bomUTF8) {
			return text[i]
		}
	}
	return 0
}

func tokenText(token string, quote byte, whole bool) (string, bool) {
	var inner string
	if whole {
		inner = token[1 : len(token)-1]
	} else {
		inner = token[1:]
	}
	if quote != '"' || !whole || !strings.Contains(inner, "\\") {
		return inner, true
	}
	v, err := ParseJSON([]byte(token))
	if err != nil {
		return "", false
	}
	s, _ := v.(string)
	return s, true
}

func maskStringToken(token string, quote byte, whole bool) string {
	value, ok := tokenText(token, quote, whole)
	if !ok {
		return RedactValue(token)
	}
	masked := RedactValue(value)
	if masked == value {
		return token
	}
	if !whole {
		return string(quote) + masked
	}
	if quote == '"' {
		return Stringify(masked)
	}
	return "'" + strings.ReplaceAll(masked, "'", "\\'") + "'"
}

type looseFrame struct {
	object    bool
	phase     byte // 'k' key, 'c' colon, 'v' value, 'a' after
	sensitive bool
}

func maskJsonLoose(text string) string {
	out := make([]byte, 0, len(text)+16)
	var stack []*looseFrame
	n := len(text)
	lost := false
	top := func() *looseFrame {
		if len(stack) == 0 {
			return nil
		}
		return stack[len(stack)-1]
	}
	valueDone := func(f *looseFrame) {
		if f != nil {
			f.phase = 'a'
		}
	}
	i := 0
	for i < n {
		c := text[i]
		frame := top()
		phase := byte('v')
		if frame != nil {
			phase = frame.phase
		}
		sensitive := frame != nil && frame.object && frame.sensitive && (phase == 'v' || phase == 'c')
		switch {
		case c == ' ' || c == '\n' || c == '\r' || c == '\t':
			i++
		case strings.HasPrefix(text[i:], bomUTF8):
			i += 3
		case c == '/' && i+1 < n && (text[i+1] == '*' || text[i+1] == '/'):
			if text[i+1] == '*' {
				end := strings.Index(text[i+2:], "*/")
				if end == -1 {
					i = n
				} else {
					i = i + 2 + end + 2
				}
			} else {
				i = lineEnd(text, i)
			}
		case c == '{' || c == '[':
			if phase != 'v' {
				lost = true
			}
			if sensitive {
				out = append(out, quotedRedacted...)
				valueDone(frame)
				i = containerEnd(text, i)
			} else {
				out = append(out, c)
				f := &looseFrame{object: c == '{', phase: 'v'}
				if f.object {
					f.phase = 'k'
				}
				stack = append(stack, f)
				i++
			}
		case c == '}' || c == ']':
			out = append(out, c)
			if frame == nil || frame.object != (c == '}') || (frame.object && phase != 'a' && phase != 'k') {
				lost = true
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			valueDone(top())
			i++
		case c == ',':
			out = append(out, c)
			if frame != nil {
				if phase != 'a' {
					lost = true
				}
				if frame.object {
					frame.phase = 'k'
				} else {
					frame.phase = 'v'
				}
				frame.sensitive = false
			}
			i++
		case c == ':':
			out = append(out, c)
			if frame != nil && frame.phase == 'c' {
				frame.phase = 'v'
			} else {
				lost = true
			}
			i++
		case c == '"' || c == '\'':
			end := quoteEnd(text, i, c)
			whole := end != -1
			var token string
			if whole {
				token = text[i : end+1]
			} else {
				token = text[i:]
			}
			keyAfterValue := phase == 'a' && whole && nextChar(text, end+1) == ':'
			if frame != nil && frame.object && (phase == 'k' || keyAfterValue) {
				if keyAfterValue {
					lost = true
				}
				key, ok := tokenText(token, c, whole)
				if !ok {
					key = token
				}
				frame.sensitive = IsSensitiveKey(key)
				frame.phase = 'c'
				if name := maskKey(key); name == key {
					out = append(out, token...)
				} else {
					out = AppendJSONString(out, name)
				}
			} else {
				if phase != 'v' {
					lost = true
				}
				if sensitive {
					out = append(out, quotedRedacted...)
				} else {
					out = append(out, maskStringToken(token, c, whole)...)
				}
				valueDone(frame)
			}
			if whole {
				i = end + 1
			} else {
				i = n
			}
		default:
			end := bareEnd(text, i)
			token := text[i:end]
			if frame != nil && frame.object && phase == 'k' && nextChar(text, end) == ':' {
				frame.sensitive = IsSensitiveKey(token)
				frame.phase = 'c'
				out = append(out, token...)
			} else {
				if phase != 'v' {
					lost = true
				}
				if sensitive || (thirteenRe.MatchString(token) && IsThaiNationalId(token)) {
					out = append(out, quotedRedacted...)
				} else {
					out = append(out, token...)
				}
				valueDone(frame)
			}
			i = end
		}
	}
	masked := string(out)
	if lost {
		return redactPairs(masked, maskMode{json: true})
	}
	return masked
}

// ---------- utf-8 cut ----------

// TruncateUTF8 cuts text to maxBytes whole characters (the SDK's truncateUtf8).
func TruncateUTF8(text string, maxBytes int) (string, bool) {
	if len(text) <= maxBytes {
		return text, false
	}
	cut := text[:maxBytes]
	// drop a cut-off trailing sequence (what Buffer.toString turned into U+FFFD)
	for k := len(cut) - 1; k >= 0 && k >= len(cut)-3; k-- {
		c := cut[k]
		if c < 0x80 {
			break
		}
		if c >= 0xc0 { // a leading byte: whole only when its sequence fits
			need := 2
			if c >= 0xf0 {
				need = 4
			} else if c >= 0xe0 {
				need = 3
			}
			if len(cut)-k < need {
				cut = cut[:k]
			}
			break
		}
	}
	for strings.HasSuffix(cut, "�") {
		cut = cut[:len(cut)-3]
	}
	return cut, true
}
