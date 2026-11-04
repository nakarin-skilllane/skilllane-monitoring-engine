package main

// Ordered JSON: a parser whose objects keep key order and a serialiser that
// writes what JavaScript's JSON.stringify writes (same key order, same number
// and string formatting), so rows, `events`, `error.cause` and stringified
// attribute values come out byte for byte as the Node engine's.
//
// Values: nil (JSON null), string, float64, bool, []any, *Object.

import (
	"errors"
	"math"
	"strconv"
	"unicode/utf8"
)

// Object is a JSON object in insertion order. JavaScript orders integer-like
// keys first (ascending), then the rest in insertion order; Entries does the same.
type Object struct {
	keys   []string
	vals   []any
	hasIdx bool
}

func newObject(n int) *Object {
	return &Object{keys: make([]string, 0, n), vals: make([]any, 0, n)}
}

func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

func (o *Object) index(key string) int {
	if o == nil {
		return -1
	}
	for i, k := range o.keys {
		if k == key {
			return i
		}
	}
	return -1
}

// Get: the value and whether the key exists (a JSON null exists, with nil).
func (o *Object) Get(key string) (any, bool) {
	i := o.index(key)
	if i < 0 {
		return nil, false
	}
	return o.vals[i], true
}

func (o *Object) Has(key string) bool { return o.index(key) >= 0 }

// Set replaces an existing key in place or appends (JSON.parse's duplicate-key rule).
func (o *Object) Set(key string, v any) {
	if i := o.index(key); i >= 0 {
		o.vals[i] = v
		return
	}
	o.keys = append(o.keys, key)
	o.vals = append(o.vals, v)
	if !o.hasIdx && isArrayIndex(key) {
		o.hasIdx = true
	}
}

func (o *Object) Delete(key string) {
	i := o.index(key)
	if i < 0 {
		return
	}
	o.keys = append(o.keys[:i], o.keys[i+1:]...)
	o.vals = append(o.vals[:i], o.vals[i+1:]...)
}

// Clone: a shallow copy (the `{ ...r }` of mappers.ts).
func (o *Object) Clone() *Object {
	c := &Object{keys: make([]string, len(o.keys)), vals: make([]any, len(o.vals)), hasIdx: o.hasIdx}
	copy(c.keys, o.keys)
	copy(c.vals, o.vals)
	return c
}

// Order: indices in JavaScript property order.
func (o *Object) Order() []int {
	n := len(o.keys)
	idx := make([]int, n)
	if !o.hasIdx {
		for i := range idx {
			idx[i] = i
		}
		return idx
	}
	// integer keys ascending, then the rest in insertion order
	type ik struct {
		n uint64
		i int
	}
	var ints []ik
	rest := idx[:0]
	for i, k := range o.keys {
		if isArrayIndex(k) {
			n, _ := strconv.ParseUint(k, 10, 64)
			ints = append(ints, ik{n, i})
		} else {
			rest = append(rest, i)
		}
	}
	// insertion sort: integer keys are few
	for a := 1; a < len(ints); a++ {
		for b := a; b > 0 && ints[b-1].n > ints[b].n; b-- {
			ints[b-1], ints[b] = ints[b], ints[b-1]
		}
	}
	out := make([]int, 0, n)
	for _, e := range ints {
		out = append(out, e.i)
	}
	out = append(out, rest...)
	return out
}

// Each calls fn for every entry in JavaScript order.
func (o *Object) Each(fn func(key string, v any)) {
	if o == nil {
		return
	}
	if !o.hasIdx {
		for i, k := range o.keys {
			fn(k, o.vals[i])
		}
		return
	}
	for _, i := range o.Order() {
		fn(o.keys[i], o.vals[i])
	}
}

// isArrayIndex: a canonical numeric string below 2^32-1 ("0", "42"; not "01", "-1").
func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 {
		return false
	}
	if k[0] == '0' {
		return len(k) == 1
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + uint64(c-'0')
	}
	return n < 4294967295
}

// ---------- parser ----------

var errJSON = errors.New("invalid JSON")

const maxDepth = 512

type parser struct {
	b     []byte
	i     int
	depth int
}

// ParseJSON parses a whole document (JSON.parse).
func ParseJSON(b []byte) (any, error) {
	p := parser{b: b}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.b) {
		return nil, errJSON
	}
	return v, nil
}

func (p *parser) ws() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value() (any, error) {
	if p.i >= len(p.b) {
		return nil, errJSON
	}
	switch c := p.b[p.i]; c {
	case '{':
		return p.object()
	case '[':
		return p.array()
	case '"':
		return p.str()
	case 't':
		if p.lit("true") {
			return true, nil
		}
	case 'f':
		if p.lit("false") {
			return false, nil
		}
	case 'n':
		if p.lit("null") {
			return nil, nil
		}
	default:
		if c == '-' || (c >= '0' && c <= '9') {
			return p.number()
		}
	}
	return nil, errJSON
}

func (p *parser) lit(s string) bool {
	if len(p.b)-p.i >= len(s) && string(p.b[p.i:p.i+len(s)]) == s {
		p.i += len(s)
		return true
	}
	return false
}

func (p *parser) number() (any, error) {
	start := p.i
	b := p.b
	if b[p.i] == '-' {
		p.i++
	}
	if p.i >= len(b) {
		return nil, errJSON
	}
	if b[p.i] == '0' {
		p.i++
	} else if b[p.i] >= '1' && b[p.i] <= '9' {
		for p.i < len(b) && b[p.i] >= '0' && b[p.i] <= '9' {
			p.i++
		}
	} else {
		return nil, errJSON
	}
	if p.i < len(b) && b[p.i] == '.' {
		p.i++
		d := p.i
		for p.i < len(b) && b[p.i] >= '0' && b[p.i] <= '9' {
			p.i++
		}
		if p.i == d {
			return nil, errJSON
		}
	}
	if p.i < len(b) && (b[p.i] == 'e' || b[p.i] == 'E') {
		p.i++
		if p.i < len(b) && (b[p.i] == '+' || b[p.i] == '-') {
			p.i++
		}
		d := p.i
		for p.i < len(b) && b[p.i] >= '0' && b[p.i] <= '9' {
			p.i++
		}
		if p.i == d {
			return nil, errJSON
		}
	}
	f, err := strconv.ParseFloat(string(b[start:p.i]), 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f, nil // ±Inf / 0 like JavaScript
		}
		return nil, errJSON
	}
	return f, nil
}

func (p *parser) str() (string, error) {
	b := p.b
	p.i++ // opening quote
	start := p.i
	// fast path: no escapes
	for p.i < len(b) {
		c := b[p.i]
		if c == '"' {
			s := string(b[start:p.i])
			p.i++
			return s, nil
		}
		if c == '\\' {
			break
		}
		if c < 0x20 {
			return "", errJSON
		}
		p.i++
	}
	if p.i >= len(b) {
		return "", errJSON
	}
	out := make([]byte, 0, p.i-start+16)
	out = append(out, b[start:p.i]...)
	for p.i < len(b) {
		c := b[p.i]
		switch {
		case c == '"':
			p.i++
			return string(out), nil
		case c == '\\':
			p.i++
			if p.i >= len(b) {
				return "", errJSON
			}
			e := b[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				out = append(out, e)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				r, ok := p.hex4()
				if !ok {
					return "", errJSON
				}
				if r >= 0xd800 && r < 0xdc00 && p.i+1 < len(b) && b[p.i] == '\\' && b[p.i+1] == 'u' {
					save := p.i
					p.i += 2
					if r2, ok := p.hex4(); ok && r2 >= 0xdc00 && r2 < 0xe000 {
						r = 0x10000 + (r-0xd800)<<10 + (r2 - 0xdc00)
					} else {
						p.i = save
					}
				}
				out = utf8.AppendRune(out, r)
			default:
				return "", errJSON
			}
		case c < 0x20:
			return "", errJSON
		default:
			out = append(out, c)
			p.i++
		}
	}
	return "", errJSON
}

func (p *parser) hex4() (rune, bool) {
	if p.i+4 > len(p.b) {
		return 0, false
	}
	var r rune
	for k := 0; k < 4; k++ {
		c := p.b[p.i+k]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		r = r<<4 | rune(d)
	}
	p.i += 4
	return r, true
}

func (p *parser) array() (any, error) {
	p.depth++
	if p.depth > maxDepth {
		return nil, errJSON
	}
	p.i++
	out := make([]any, 0, 4)
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == ']' {
		p.i++
		p.depth--
		return out, nil
	}
	for {
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		p.ws()
		if p.i >= len(p.b) {
			return nil, errJSON
		}
		if p.b[p.i] == ',' {
			p.i++
			continue
		}
		if p.b[p.i] == ']' {
			p.i++
			p.depth--
			return out, nil
		}
		return nil, errJSON
	}
}

func (p *parser) object() (any, error) {
	p.depth++
	if p.depth > maxDepth {
		return nil, errJSON
	}
	p.i++
	o := newObject(8)
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == '}' {
		p.i++
		p.depth--
		return o, nil
	}
	for {
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != '"' {
			return nil, errJSON
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != ':' {
			return nil, errJSON
		}
		p.i++
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		o.Set(k, v)
		p.ws()
		if p.i >= len(p.b) {
			return nil, errJSON
		}
		if p.b[p.i] == ',' {
			p.i++
			continue
		}
		if p.b[p.i] == '}' {
			p.i++
			p.depth--
			return o, nil
		}
		return nil, errJSON
	}
}

// ---------- JSON.stringify ----------

const hexDigits = "0123456789abcdef"

// AppendJSONString appends s as a JSON string literal the way JSON.stringify does:
// only ", \ and control characters are escaped; no HTML or U+2028 escaping.
func AppendJSONString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		dst = append(dst, s[start:i]...)
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		}
		start = i + 1
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}

// AppendJSNumber appends f as JavaScript's Number::toString would print it.
func AppendJSNumber(dst []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(dst, "null"...)
	}
	if f == 0 {
		return append(dst, '0')
	}
	abs := math.Abs(f)
	if abs < 1e21 && abs >= 1e-6 {
		return strconv.AppendFloat(dst, f, 'f', -1, 64)
	}
	n := len(dst)
	dst = strconv.AppendFloat(dst, f, 'e', -1, 64)
	// Go writes e-07 / e+21; JavaScript e-7 / e+21
	b := dst[n:]
	if k := len(b) - 4; k >= 0 && b[k] == 'e' && (b[k+1] == '-' || b[k+1] == '+') && b[k+2] == '0' {
		b[k+2] = b[k+3]
		dst = dst[:len(dst)-1]
	}
	return dst
}

// JSNumberString is String(number).
func JSNumberString(f float64) string {
	return string(AppendJSNumber(nil, f))
}

// AppendJSON serialises v (JSON.stringify). An unknown Go type is written as null.
func AppendJSON(dst []byte, v any) []byte {
	switch x := v.(type) {
	case nil:
		return append(dst, "null"...)
	case string:
		return AppendJSONString(dst, x)
	case float64:
		return AppendJSNumber(dst, x)
	case bool:
		if x {
			return append(dst, "true"...)
		}
		return append(dst, "false"...)
	case []any:
		dst = append(dst, '[')
		for i, e := range x {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = AppendJSON(dst, e)
		}
		return append(dst, ']')
	case *Object:
		dst = append(dst, '{')
		first := true
		x.Each(func(k string, e any) {
			if !first {
				dst = append(dst, ',')
			}
			first = false
			dst = AppendJSONString(dst, k)
			dst = append(dst, ':')
			dst = AppendJSON(dst, e)
		})
		return append(dst, '}')
	case int:
		return strconv.AppendInt(dst, int64(x), 10)
	case int64:
		return strconv.AppendInt(dst, x, 10)
	case uint64:
		return strconv.AppendUint(dst, x, 10)
	}
	return append(dst, "null"...)
}

func Stringify(v any) string {
	return string(AppendJSON(nil, v))
}
