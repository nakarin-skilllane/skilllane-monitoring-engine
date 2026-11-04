package main

// Port of skilllane-monitoring/contract mask/sql.js: maskSql (the statement
// rule). dbParametersJson (bind values) is not ported: the span I/O columns
// stay out of this prototype.

import (
	"strings"
	"unicode/utf8"
)

type tokKind uint8

const (
	tokId tokKind = iota
	tokString
	tokNumber
	tokPh
	tokOp
	tokPunct
)

type sqlToken struct {
	kind  tokKind
	text  string
	upper string // bare identifiers only
	bare  bool
	start int
	end   int
}

const sqlScanMax = 200_000

var sqlOperators = []string{"<>", "!=", "<=", ">=", "=", "<", ">"}

var notColumns = toSet("AND", "OR", "NOT", "WHERE", "SET", "ON", "WHEN", "THEN", "ELSE", "SELECT", "NEXT", "FIRST",
	"LIMIT", "OFFSET", "CASE", "END", "NULL", "IS", "DISTINCT", "VALUES", "FROM", "AS")

var structuralWords = toSet("LIMIT", "OFFSET", "FETCH", "FIRST", "NEXT", "TOP", "ROWS", "SKIP", "PERCENT")

var notFunctions = toSet("IN", "VALUES", "AS", "AND", "OR", "NOT", "WHERE", "ON", "SET", "SELECT", "FROM", "JOIN",
	"EXISTS", "ANY", "ALL", "SOME", "USING", "INTO", "THEN", "ELSE", "WHEN", "CASE", "RETURNING", "BY", "OVER", "TABLE",
	"WITH", "UNION", "HAVING", "LIMIT", "OFFSET", "IS", "LIKE", "ILIKE", "BETWEEN", "DISTINCT", "ESCAPE", "INSERT",
	"UPDATE", "DELETE", "MERGE", "CALL", "EXEC", "EXECUTE", "BEGIN", "END", "RETURN", "DO", "IF")

var selectEnd = toSet("FROM", "WHERE", "UNION", "GROUP", "ORDER", "HAVING", "RETURNING", "ON", "LIMIT")

func isNotColumn(t *sqlToken) bool {
	if t == nil || !t.bare {
		return false
	}
	_, ok := notColumns[t.upper]
	return ok
}

func pushName(tokens []sqlToken, name string, bare bool, start, end int) []sqlToken {
	n := len(tokens)
	from := start
	if n >= 2 && tokens[n-1].kind == tokPunct && tokens[n-1].text == "." && tokens[n-2].kind == tokId {
		from = tokens[n-2].start
		tokens = tokens[:n-2]
	}
	t := sqlToken{kind: tokId, text: name, bare: bare, start: from, end: end}
	if bare {
		t.upper = strings.ToUpper(name)
	}
	return append(tokens, t)
}

func isIdStart(c byte) bool { return isLower(c) || isUpper(c) || c == '_' }
func isIdByte(c byte) bool  { return isAlnum(c) || c == '_' || c == '$' || c == '#' }

func sqlTokenize(sql string) []sqlToken {
	tokens := make([]sqlToken, 0, 64)
	n := len(sql)
	if n > sqlScanMax {
		n = sqlScanMax
	}
	i := 0
	for i < n {
		c := sql[i]
		switch {
		case c == ' ' || c == '\n' || c == '\r' || c == '\t':
			i++
		case c == '-' && i+1 < n && sql[i+1] == '-':
			end := strings.IndexByte(sql[i:], '\n')
			if end == -1 {
				i = n
			} else {
				i = i + end + 1
			}
		case c == '/' && i+1 < n && sql[i+1] == '*':
			end := strings.Index(sql[i+2:], "*/")
			if end == -1 {
				i = n
			} else {
				i = i + 2 + end + 2
			}
		case c == '\'':
			j := i + 1
			for j < n {
				if sql[j] == '\'' {
					if j+1 < len(sql) && sql[j+1] == '\'' {
						j += 2
					} else {
						break
					}
				} else {
					j++
				}
			}
			end := j + 1
			if end > n {
				end = n
			}
			tokens = append(tokens, sqlToken{kind: tokString, start: i, end: end})
			i = j + 1
		case c == '"' || c == '`':
			end := strings.IndexByte(sql[i+1:], c)
			var name string
			var next int
			if end == -1 {
				name = sql[i+1 : n]
				next = n
			} else {
				name = sql[i+1 : i+1+end]
				next = i + 1 + end + 1
			}
			tokens = pushName(tokens, name, false, i, next)
			i = next
		case c == ':':
			if i+1 < n && (sql[i+1] == ':' || sql[i+1] == '=') {
				tokens = append(tokens, sqlToken{kind: tokOp, text: sql[i : i+2], start: i, end: i + 2})
				i += 2
				continue
			}
			// ^:(\.\.\.)?([A-Za-z0-9_$#]+) within 130 characters
			limit := min(i+130, len(sql))
			j := i + 1
			if strings.HasPrefix(sql[j:limit], "...") {
				j += 3
			}
			k := j
			for k < limit && isIdByte(sql[k]) {
				k++
			}
			if k > j {
				tokens = append(tokens, sqlToken{kind: tokPh, text: ":" + sql[j:k], start: i, end: k})
				i = k
			} else {
				tokens = append(tokens, sqlToken{kind: tokPunct, text: ":", start: i, end: i + 1})
				i++
			}
		case c == '?':
			tokens = append(tokens, sqlToken{kind: tokPh, text: "?", start: i, end: i + 1})
			i++
		case c == '$' && i+1 < len(sql) && isDigit(sql[i+1]):
			limit := min(i+12, len(sql))
			k := i + 1
			for k < limit && isDigit(sql[k]) {
				k++
			}
			tokens = append(tokens, sqlToken{kind: tokPh, text: sql[i:k], start: i, end: k})
			i = k
		case c == '@' && i+1 < len(sql) && isIdStart(sql[i+1]):
			limit := min(i+130, len(sql))
			k := i + 1
			for k < limit && (isAlnum(sql[k]) || sql[k] == '_') {
				k++
			}
			tokens = append(tokens, sqlToken{kind: tokPh, text: sql[i:k], start: i, end: k})
			i = k
		case isIdStart(c):
			limit := min(i+130, len(sql))
			k := i + 1
			for k < limit && isIdByte(sql[k]) {
				k++
			}
			tokens = pushName(tokens, sql[i:k], true, i, k)
			i = k
		case isDigit(c):
			limit := min(i+40, len(sql))
			k := i
			for k < limit && isDigit(sql[k]) {
				k++
			}
			if k+1 < limit && sql[k] == '.' && isDigit(sql[k+1]) {
				k++
				for k < limit && isDigit(sql[k]) {
					k++
				}
			}
			tokens = append(tokens, sqlToken{kind: tokNumber, text: sql[i:k], start: i, end: k})
			i = k
		default:
			matched := false
			for _, op := range sqlOperators {
				if strings.HasPrefix(sql[i:], op) {
					tokens = append(tokens, sqlToken{kind: tokOp, text: op, start: i, end: i + len(op)})
					i += len(op)
					matched = true
					break
				}
			}
			if !matched {
				size := 1
				if c >= 0x80 {
					_, size = utf8.DecodeRuneInString(sql[i:])
				}
				tokens = append(tokens, sqlToken{kind: tokPunct, text: sql[i : i+size], start: i, end: i + size})
				i += size
			}
		}
	}
	return tokens
}

type sqlContext struct {
	tokens []sqlToken
	parent []int
	match  []int
}

func sqlContextOf(tokens []sqlToken) *sqlContext {
	n := len(tokens)
	parent := make([]int, n)
	match := make([]int, n)
	var stack []int
	for i := 0; i < n; i++ {
		parent[i] = -1
		match[i] = -1
		if len(stack) > 0 {
			parent[i] = stack[len(stack)-1]
		}
		t := &tokens[i]
		if t.kind != tokPunct {
			continue
		}
		if t.text == "(" {
			stack = append(stack, i)
		} else if t.text == ")" {
			if len(stack) > 0 {
				open := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				match[open] = i
				match[i] = open
			}
		}
	}
	for _, open := range stack {
		match[open] = n - 1
	}
	return &sqlContext{tokens: tokens, parent: parent, match: match}
}

func (c *sqlContext) tok(i int) *sqlToken {
	if i < 0 || i >= len(c.tokens) {
		return nil
	}
	return &c.tokens[i]
}

func isWord(t *sqlToken, word string) bool {
	return t != nil && t.kind == tokId && t.bare && t.upper == word
}

func isPunct(t *sqlToken, text string) bool {
	return t != nil && t.kind == tokPunct && t.text == text
}

func isCompareOp(t *sqlToken) bool {
	return t != nil && t.kind == tokOp && t.text != "::" && t.text != ":="
}

func (c *sqlContext) columnBefore(index int) (string, bool) {
	left := c.tok(index - 1)
	if left != nil && left.kind == tokId {
		if isNotColumn(left) {
			return "", false
		}
		return left.text, true
	}
	if isPunct(left, "]") {
		if t := c.tok(index - 2); t != nil && t.kind == tokId && isPunct(c.tok(index-3), "[") {
			return t.text, true
		}
	}
	if !isPunct(left, ")") {
		return "", false
	}
	open := c.match[index-1]
	if open < 0 {
		return "", false
	}
	for j := open + 1; j < index-1 && j < open+64; j++ {
		t := c.tok(j)
		if t.kind == tokId && !isNotColumn(t) && !isPunct(c.tok(j+1), "(") {
			return t.text, true
		}
	}
	return "", false
}

func (c *sqlContext) betweenFor(and int) int {
	j := and - 1
	for steps := 0; j >= 0 && steps < 16; steps++ {
		t := c.tok(j)
		if isPunct(t, ")") {
			j = c.match[j] - 1
		} else if isWord(t, "BETWEEN") {
			return j
		} else if t.kind == tokId && t.bare && (t.upper == "AND" || t.upper == "OR" || t.upper == "WHERE" || t.upper == "ON" || t.upper == "WHEN" || t.upper == "SET") {
			return -1
		} else if isPunct(t, ",") || isPunct(t, "(") {
			return -1
		} else {
			j--
		}
	}
	return -1
}

func (c *sqlContext) tupleColumn(rightOpen, start int) (string, bool) {
	item := 0
	for j := rightOpen + 1; j < start; j++ {
		if isPunct(c.tok(j), ",") && c.parent[j] == rightOpen {
			item++
		}
	}
	if rightOpen-2 < 0 {
		return "", false
	}
	leftOpen := c.match[rightOpen-2]
	if leftOpen < 0 {
		return "", false
	}
	var names []string
	for j := leftOpen + 1; j < rightOpen-2; j++ {
		if c.parent[j] == leftOpen && c.tokens[j].kind == tokId {
			names = append(names, c.tokens[j].text)
		}
	}
	if item < len(names) {
		return names[item], true
	}
	return "", false
}

// columnAround: the column a value at tokens[start..end] belongs to.
// ok=false means unknown; ok=true with "" means a structural number (LIMIT 10).
func (c *sqlContext) columnAround(start, end int) (string, bool) {
	prev := c.tok(start - 1)
	next := c.tok(end + 1)
	if isCompareOp(prev) {
		if col, ok := c.columnBefore(start - 1); ok {
			return col, true
		}
	} else if prev != nil && prev.bare && (prev.upper == "LIKE" || prev.upper == "ILIKE") {
		if isWord(c.tok(start-2), "NOT") {
			return c.columnBefore(start - 2)
		}
		return c.columnBefore(start - 1)
	} else if isWord(prev, "BETWEEN") {
		if isWord(c.tok(start-2), "NOT") {
			return c.columnBefore(start - 2)
		}
		return c.columnBefore(start - 1)
	} else if isWord(prev, "AND") {
		if between := c.betweenFor(start - 1); between != -1 {
			if isWord(c.tok(between-1), "NOT") {
				return c.columnBefore(between - 1)
			}
			return c.columnBefore(between)
		}
	} else if prev != nil && prev.kind == tokId && prev.bare {
		if _, ok := structuralWords[prev.upper]; ok {
			return "", true
		}
	}
	if isCompareOp(next) {
		after := c.tok(end + 2)
		if after != nil && after.kind == tokId && !isNotColumn(after) {
			if !isPunct(c.tok(end+3), "(") {
				return after.text, true
			}
			closeAt := c.match[end+3]
			for j := end + 4; j < closeAt && j < end+64; j++ {
				if c.tokens[j].kind == tokId && !isPunct(c.tok(j+1), "(") {
					return c.tokens[j].text, true
				}
			}
		}
	}
	if isWord(next, "AS") {
		if t := c.tok(end + 2); t != nil && t.kind == tokId {
			return t.text, true
		}
	}
	if isPunct(prev, "(") || isPunct(prev, ",") {
		open := c.parent[start]
		if open >= 0 {
			before := c.tok(open - 1)
			if isWord(before, "IN") {
				if isWord(c.tok(open-2), "NOT") {
					return c.columnBefore(open - 2)
				}
				return c.columnBefore(open - 1)
			}
			if isCompareOp(before) && isPunct(c.tok(open-2), ")") {
				return c.tupleColumn(open, start)
			}
		}
	}
	return "", false
}

func (c *sqlContext) slotColumn(index int, walkOut bool) (string, bool) {
	start, end := index, index
	for hop := 0; hop < 8; hop++ {
		col, ok := c.columnAround(start, end)
		if ok || !walkOut {
			return col, ok
		}
		open := c.parent[start]
		if open < 1 {
			return "", false
		}
		fn := c.tok(open - 1)
		if fn.kind != tokId {
			return "", false
		}
		if fn.bare {
			if _, bad := notFunctions[fn.upper]; bad {
				return "", false
			}
		}
		start = open - 1
		end = c.match[open]
	}
	return "", false
}

func isValueToken(t *sqlToken) bool {
	return t.kind == tokPh || t.kind == tokString || t.kind == tokNumber
}

type sqlSlot struct {
	column     string
	hasColumn  bool
	structural bool
}

type sqlAnalysis struct {
	ctx       *sqlContext
	slotOrder []int
	slots     map[int]*sqlSlot
	sensitive bool
}

func (c *sqlContext) columnList(open int) []string {
	var columns []string
	closeAt := c.match[open]
	for j := open + 1; j < closeAt; j++ {
		if c.parent[j] == open && c.tokens[j].kind == tokId {
			columns = append(columns, c.tokens[j].text)
		}
	}
	return columns
}

func (a *sqlAnalysis) assignItems(from, to, level int, columns []string) {
	item := 0
	for j := from; j < to; j++ {
		t := a.ctx.tok(j)
		if t == nil {
			break
		}
		if isPunct(t, ",") && a.ctx.parent[j] == level {
			item++
			continue
		}
		if slot := a.slots[j]; slot != nil && !slot.hasColumn && !slot.structural && item < len(columns) && columns[item] != "" {
			slot.column = columns[item]
			slot.hasColumn = true
		}
	}
}

func (a *sqlAnalysis) insertColumns() {
	c := a.ctx
	t := c.tokens
	for i := 0; i < len(t); i++ {
		open := -1
		if isWord(&t[i], "INSERT") && isPunct(c.tok(i+1), "(") {
			open = i + 1
		} else if isWord(&t[i], "INTO") && c.tok(i+1) != nil && c.tok(i+1).kind == tokId && isPunct(c.tok(i+2), "(") {
			open = i + 2
		}
		if open == -1 {
			continue
		}
		columns := c.columnList(open)
		if len(columns) == 0 {
			continue
		}
		k := c.match[open] + 1
		if isWord(c.tok(k), "VALUES") {
			k++
			for isPunct(c.tok(k), "(") {
				closeAt := c.match[k]
				a.assignItems(k+1, closeAt, k, columns)
				if isPunct(c.tok(closeAt+1), ",") && isPunct(c.tok(closeAt+2), "(") {
					k = closeAt + 2
				} else {
					break
				}
			}
		} else if isWord(c.tok(k), "SELECT") {
			level := c.parent[k]
			end := k + 1
			for end < len(t) {
				tk := &t[end]
				if c.parent[end] == level {
					if _, stop := selectEnd[tk.upper]; (stop && tk.bare) || isPunct(tk, ";") {
						break
					}
				}
				if level != -1 && end >= c.match[level] {
					break
				}
				end++
			}
			a.assignItems(k+1, end, level, columns)
		}
	}
}

func sqlAnalyse(sql string) *sqlAnalysis {
	ctx := sqlContextOf(sqlTokenize(sql))
	a := &sqlAnalysis{ctx: ctx, slots: map[int]*sqlSlot{}}
	for index := range ctx.tokens {
		t := &ctx.tokens[index]
		if t.kind == tokId && !a.sensitive && IsSensitiveKey(t.text) {
			a.sensitive = true
		}
		if !isValueToken(t) {
			continue
		}
		col, ok := ctx.slotColumn(index, t.kind != tokNumber)
		slot := &sqlSlot{}
		if ok && col == "" {
			slot.structural = true
		} else if ok {
			slot.column = col
			slot.hasColumn = true
		}
		a.slots[index] = slot
		a.slotOrder = append(a.slotOrder, index)
	}
	a.insertColumns()
	return a
}

// MaskSql: string literals under a sensitive column (or any literal of a
// statement that names a secret) → '[REDACTED]', then the value rule in SQL mode.
func MaskSql(sql string) string {
	if sql == "" {
		return sql
	}
	a := sqlAnalyse(sql)
	tokens := a.ctx.tokens
	var out []byte
	last := 0
	for _, index := range a.slotOrder {
		slot := a.slots[index]
		t := &tokens[index]
		if t.kind == tokPh {
			continue
		}
		var secret bool
		if slot.hasColumn {
			secret = IsSensitiveKey(slot.column)
		} else {
			secret = t.kind == tokString && a.sensitive && !slot.structural
		}
		if !secret || sql[t.start:t.end] == "'"+REDACTED+"'" {
			continue
		}
		out = append(out, sql[last:t.start]...)
		out = append(out, '\'')
		out = append(out, REDACTED...)
		out = append(out, '\'')
		last = t.end
	}
	if out != nil {
		sql = string(append(out, sql[last:]...))
	}
	return redactValueMode(sql, true)
}
