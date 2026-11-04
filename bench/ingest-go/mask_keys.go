package main

// Port of skilllane-monitoring/contract mask/keys.js: the key rule.

import (
	"strings"
	"sync"
)

const (
	REDACTED        = "[REDACTED]"
	MaskVersion     = 2
	MaskResourceKey = "skilllane.monitoring.mask"
)

var sensitiveKeys = []string{
	"password", "confirmpassword", "token", "secret", "authorization", "cookie", "session",
	"passwd", "pwd", "apikey", "api_key", "api-key", "credential", "privatekey", "private_key",
}

var sensitiveWords = toSet("pass", "pw", "pwd", "pin", "otp", "totp", "cvv", "cvc", "passcode", "passphrase",
	"sid", "sess", "sig", "signature", "auth", "authentication", "oauth", "jwt", "refresh", "creds")

var keyQualifiers = toSet("api", "access", "secret", "private", "client", "signing", "encryption", "master",
	"ssh", "hmac", "jwt", "license")

var metadataWords = toSet("type", "at", "date", "time", "ts", "changed", "updated", "created", "expires", "expiry",
	"expired", "exp", "ttl", "timeout", "interval", "period", "length", "min", "max", "policy", "required", "enabled",
	"count", "strength", "hint", "name", "consent", "format", "version")

var sensitiveHeaders = toSet("authorization", "proxy-authorization", "cookie", "set-cookie")

var sensitiveQueryNames = toSet("code", "key", "ticket")

func toSet(words ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(words))
	for _, w := range words {
		m[w] = struct{}{}
	}
	return m
}

func isLower(c byte) bool { return c >= 'a' && c <= 'z' }
func isUpper(c byte) bool { return c >= 'A' && c <= 'Z' }
func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isAlnum(c byte) bool { return isLower(c) || isUpper(c) || isDigit(c) }

// keyWords: camelCase / snake-case / kebab-case → lower-case words
// (`([a-z0-9])([A-Z])` and `([A-Z]+)([A-Z][a-z])` boundaries, split on anything else).
func keyWords(key string) []string {
	var words []string
	var cur []byte
	flush := func() {
		if len(cur) > 0 {
			words = append(words, string(cur))
			cur = cur[:0]
		}
	}
	n := len(key)
	for i := 0; i < n; i++ {
		c := key[i]
		if isUpper(c) {
			if i > 0 && (isLower(key[i-1]) || isDigit(key[i-1])) {
				flush()
			} else if i > 0 && isUpper(key[i-1]) && i+1 < n && isLower(key[i+1]) {
				flush()
			}
			cur = append(cur, c+('a'-'A'))
		} else if isLower(c) || isDigit(c) {
			cur = append(cur, c)
		} else {
			flush()
		}
	}
	flush()
	return words
}

func judge(key string) bool {
	words := keyWords(key)
	last := ""
	if len(words) > 0 {
		last = words[len(words)-1]
	}
	if len(words) > 1 {
		if _, ok := metadataWords[last]; ok {
			return false
		}
	}
	lower := strings.ToLower(key)
	for _, w := range sensitiveKeys {
		if strings.Contains(lower, w) {
			return true
		}
	}
	for _, w := range words {
		if _, ok := sensitiveWords[w]; ok {
			return true
		}
	}
	if last == "key" {
		for _, w := range words {
			if _, ok := keyQualifiers[w]; ok {
				return true
			}
		}
		return false
	}
	if len(words) == 1 && strings.HasSuffix(last, "key") {
		_, ok := keyQualifiers[last[:len(last)-3]]
		return ok
	}
	return false
}

const (
	verdictCacheMax = 10_000
	cacheKeyMax     = 64
)

var (
	verdictMu sync.RWMutex
	verdicts  = make(map[string]bool, 1024)
)

// IsSensitiveKey: the key rule (cached like the SDK).
func IsSensitiveKey(key string) bool {
	if key == "" {
		return false
	}
	verdictMu.RLock()
	v, ok := verdicts[key]
	verdictMu.RUnlock()
	if ok {
		return v
	}
	v = judge(key)
	if len(key) <= cacheKeyMax {
		verdictMu.Lock()
		if len(verdicts) >= verdictCacheMax {
			verdicts = make(map[string]bool, 1024)
		}
		verdicts[strings.Clone(key)] = v
		verdictMu.Unlock()
	}
	return v
}

func IsSensitiveQueryName(name string) bool {
	if name == "" {
		return false
	}
	if _, ok := sensitiveQueryNames[strings.ToLower(name)]; ok {
		return true
	}
	return IsSensitiveKey(name)
}

func IsSensitiveHeader(name string) bool {
	if name == "" {
		return false
	}
	if _, ok := sensitiveHeaders[strings.ToLower(name)]; ok {
		return true
	}
	return IsSensitiveKey(name)
}
