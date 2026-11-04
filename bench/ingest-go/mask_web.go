package main

// Port of skilllane-monitoring/contract mask/web.js (what the ingest path uses:
// maskQuery, maskUrl, maskHeaderValue, maskPathByRoute, maskEndpoint) and
// mask/redis.js maskRedisKey / maskIdentifier. maskMarkup, maskCsv, maskHeaders
// and redisCommand are not ported (span I/O and Redis commands are out of scope).

import (
	"net/url"
	"regexp"
	"strings"
)

// decodeComponent: decodeURIComponent after '+' → ' ', the text itself when it does not decode.
func decodeComponent(text string) string {
	text = strings.ReplaceAll(text, "+", " ")
	if !strings.Contains(text, "%") {
		return text
	}
	out, err := url.PathUnescape(text)
	if err != nil {
		return text
	}
	return out
}

func isUnreservedJS(c byte) bool {
	return isAlnum(c) || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')'
}

// encodeComponent: encodeURIComponent, keeping [REDACTED] readable.
func encodeComponent(text string) string {
	const upperHex = "0123456789ABCDEF"
	var out []byte
	for i := 0; i < len(text); i++ {
		c := text[i]
		if isUnreservedJS(c) {
			if out != nil {
				out = append(out, c)
			}
			continue
		}
		if out == nil {
			out = make([]byte, 0, len(text)*3)
			out = append(out, text[:i]...)
		}
		out = append(out, '%', upperHex[c>>4], upperHex[c&0xf])
	}
	if out == nil {
		return text
	}
	return strings.ReplaceAll(string(out), "%5BREDACTED%5D", REDACTED)
}

// MaskQuery masks a query string pair by pair (sensitive names, then the value rule).
func MaskQuery(query string) string {
	if query == "" {
		return query
	}
	pairs := strings.Split(query, "&")
	for i, pair := range pairs {
		if pair == "" {
			continue
		}
		index := strings.IndexByte(pair, '=')
		rawName := pair
		if index != -1 {
			rawName = pair[:index]
		}
		name := decodeComponent(rawName)
		if IsSensitiveQueryName(name) {
			pairs[i] = rawName + "=" + REDACTED
			continue
		}
		if index == -1 {
			if masked := RedactValue(name); masked != name {
				pairs[i] = encodeComponent(masked)
			}
			continue
		}
		value := decodeComponent(pair[index+1:])
		if masked := RedactValue(value); masked != value {
			pairs[i] = rawName + "=" + encodeComponent(masked)
		}
	}
	return strings.Join(pairs, "&")
}

// MaskUrl: the value rule on the path part, the query rule on the query (and a fragment).
func MaskUrl(u string) string {
	if u == "" {
		return u
	}
	hash := strings.IndexByte(u, '#')
	queryAt := strings.IndexByte(u, '?')
	query := -1
	if queryAt != -1 && (hash == -1 || queryAt < hash) {
		query = queryAt
	}
	pathEnd := len(u)
	if query != -1 {
		pathEnd = query
	} else if hash != -1 {
		pathEnd = hash
	}
	out := RedactValue(u[:pathEnd])
	if query != -1 {
		end := len(u)
		if hash != -1 {
			end = hash
		}
		out += "?" + MaskQuery(u[query+1:end])
	}
	if hash != -1 {
		fragment := u[hash+1:]
		if strings.Contains(fragment, "=") {
			out += "#" + MaskQuery(fragment)
		} else {
			out += "#" + RedactValue(fragment)
		}
	}
	return out
}

func maskCookie(value string) string {
	parts := strings.Split(value, ";")
	for i, part := range parts {
		index := strings.IndexByte(part, '=')
		if index == -1 {
			if strings.TrimSpace(part) != "" {
				if strings.HasPrefix(part, " ") {
					parts[i] = " " + REDACTED
				} else {
					parts[i] = REDACTED
				}
			}
			continue
		}
		parts[i] = part[:index] + "=" + REDACTED
	}
	return strings.Join(parts, ";")
}

// splitSetCookie: `value.split(/,\s*(?=[^;,=\s]+=)/)` as a scanner.
func splitSetCookie(value string) []string {
	var parts []string
	start := 0
	n := len(value)
	for i := 0; i < n; i++ {
		if value[i] != ',' {
			continue
		}
		j := i + 1
		for j < n && isJSSpace(value[j]) {
			j++
		}
		k := j
		for k < n && value[k] != ';' && value[k] != ',' && value[k] != '=' && !isJSSpace(value[k]) {
			k++
		}
		if k > j && k < n && value[k] == '=' {
			parts = append(parts, value[start:i])
			start = j
			i = j - 1
		}
	}
	return append(parts, value[start:])
}

func maskSetCookie(value string) string {
	cookies := splitSetCookie(value)
	for i, cookie := range cookies {
		semicolon := strings.IndexByte(cookie, ';')
		first, attributes := cookie, ""
		if semicolon != -1 {
			first, attributes = cookie[:semicolon], cookie[semicolon:]
		}
		name := ""
		if index := strings.IndexByte(first, '='); index != -1 {
			name = first[:index]
		}
		prefix := ""
		if name != "" {
			prefix = name + "="
		}
		cookies[i] = prefix + REDACTED + RedactValue(attributes)
	}
	return strings.Join(cookies, ", ")
}

var urlishRe = regexp.MustCompile(`(?i)^(?:[a-z][a-z0-9+.-]*://|/)`)

// MaskHeaderValue: one header by its name (cookies, sensitive headers, URLs, text).
func MaskHeaderValue(name, value string) string {
	lower := strings.ToLower(name)
	if lower == "set-cookie" {
		return maskSetCookie(value)
	}
	if lower == "cookie" {
		return maskCookie(value)
	}
	if IsSensitiveHeader(name) {
		return REDACTED
	}
	if urlishRe.MatchString(value) && (strings.Contains(value, "?") || strings.Contains(value, "#")) {
		return MaskUrl(value)
	}
	return RedactValue(value)
}

// routeParamName: `^(?::([A-Za-z0-9_$]+)\??|\{([A-Za-z0-9_$]+)\})$` → the parameter name.
func routeParamName(part string) (string, bool) {
	isNameByte := func(c byte) bool { return isAlnum(c) || c == '_' || c == '$' }
	if len(part) >= 2 && part[0] == ':' {
		name := part[1:]
		if strings.HasSuffix(name, "?") {
			name = name[:len(name)-1]
		}
		if name == "" {
			return "", false
		}
		for i := 0; i < len(name); i++ {
			if !isNameByte(name[i]) {
				return "", false
			}
		}
		return name, true
	}
	if len(part) >= 3 && part[0] == '{' && part[len(part)-1] == '}' {
		name := part[1 : len(part)-1]
		for i := 0; i < len(name); i++ {
			if !isNameByte(name[i]) {
				return "", false
			}
		}
		return name, true
	}
	return "", false
}

// MaskPathByRoute: path segments under a sensitive route parameter (`/reset/:token`) → [REDACTED].
func MaskPathByRoute(path, route string) string {
	if route == "" || path == "" || !strings.Contains(route, "/") {
		return path
	}
	routeParts := strings.Split(route, "/")
	any := false
	for _, part := range routeParts {
		if _, ok := routeParamName(part); ok {
			any = true
			break
		}
	}
	if !any {
		return path
	}
	query := strings.IndexAny(path, "?#")
	pathname, rest := path, ""
	if query != -1 {
		pathname, rest = path[:query], path[query:]
	}
	parts := strings.Split(pathname, "/")
	changed := false
	for i := 0; i < len(parts) && i < len(routeParts); i++ {
		name, ok := routeParamName(routeParts[i])
		if ok && parts[i] != "" && parts[i] != REDACTED && IsSensitiveKey(name) {
			parts[i] = REDACTED
			changed = true
		}
	}
	if !changed {
		return path
	}
	return strings.Join(parts, "/") + rest
}

var endpointUserinfoRe = regexp.MustCompile(`^([^\s:@/]*):([^\s@/]+)@`)

// MaskEndpoint: the value rule, plus `user:password@` without a scheme.
func MaskEndpoint(text string) string {
	out := RedactValue(text)
	m := endpointUserinfoRe.FindStringSubmatchIndex(out)
	if m == nil {
		return out
	}
	password := out[m[4]:m[5]]
	if password == REDACTED {
		return out
	}
	return out[m[2]:m[3]] + ":" + REDACTED + "@" + out[m[1]:]
}

// ---------- redis keys ----------

var redisSecretPrefixes = toSet("pwreset", "reset", "verify", "verification", "magic", "invite", "confirm", "csrf", "nonce")

func isRedisKeyLike(key string) bool {
	if key == "" {
		return false
	}
	for i := 0; i < len(key); i++ {
		switch key[i] {
		case ' ', '\t', '\n', '\r', '\f', '\v', '"', '\'', '{', '}', '[', ']':
			return false
		}
	}
	return true
}

func maskRedisKey(key string) string {
	if !strings.Contains(key, ":") || !isRedisKeyLike(key) {
		return key
	}
	segments := strings.Split(key, ":")
	for i := 0; i < len(segments)-1; i++ {
		segment := segments[i]
		if segment == "" {
			continue
		}
		_, prefix := redisSecretPrefixes[strings.ToLower(segment)]
		if IsSensitiveKey(segment) || prefix {
			rest := strings.Join(segments[i+1:], ":")
			if rest == REDACTED {
				return key
			}
			return strings.Join(segments[:i+1], ":") + ":" + REDACTED
		}
	}
	return key
}

// MaskIdentifier: a key-like id (`session:abc`) by its segments, then the value rule.
func MaskIdentifier(text string) string {
	return RedactValue(maskRedisKey(text))
}
