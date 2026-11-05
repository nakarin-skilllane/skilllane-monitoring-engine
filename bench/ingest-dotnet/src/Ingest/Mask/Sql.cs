// Port of skilllane-monitoring/contract/mask/sql.js: maskSql (literals of secret columns, every literal of
// a statement that names a secret, then the value rule in SQL mode). sqlPlaceholders / dbParametersJson
// (bind values) are not ported: span I/O columns stay out of the prototypes.
using System.Text;
using System.Text.RegularExpressions;

namespace Ingest.Mask;

public static partial class Sql
{
    private enum Kind { Id, Str, Number, Ph, Op, Punct }

    private sealed class Token
    {
        public Kind Kind;
        public string Text = "";
        public string? Upper;
        public int Start;
        public int End;
    }

    private sealed class Slot
    {
        public string? Column;
        public bool Structural;
    }

    private sealed class Context
    {
        public List<Token> Tokens = new();
        public int[] Parent = [];
        public int[] Match = [];
        public Token? T(int i) => i >= 0 && i < Tokens.Count ? Tokens[i] : null;
        public int ParentOf(int i) => i >= 0 && i < Parent.Length ? Parent[i] : -1;
        public int MatchOf(int i) => i >= 0 && i < Match.Length ? Match[i] : -1;
    }

    private static readonly string[] Operators = ["<>", "!=", "<=", ">=", "=", "<", ">"];
    private static readonly HashSet<string> CompareWords = ["LIKE", "ILIKE"];
    private const int ScanMax = 200_000;
    private static readonly HashSet<string> NotColumns =
    [
        "AND", "OR", "NOT", "WHERE", "SET", "ON", "WHEN", "THEN", "ELSE", "SELECT", "NEXT", "FIRST", "LIMIT", "OFFSET", "CASE",
        "END", "NULL", "IS", "DISTINCT", "VALUES", "FROM", "AS",
    ];
    private static readonly HashSet<string> Structural = ["LIMIT", "OFFSET", "FETCH", "FIRST", "NEXT", "TOP", "ROWS", "SKIP", "PERCENT"];
    private static readonly HashSet<string> NotFunctions =
    [
        "IN", "VALUES", "AS", "AND", "OR", "NOT", "WHERE", "ON", "SET", "SELECT", "FROM", "JOIN", "EXISTS", "ANY", "ALL", "SOME",
        "USING", "INTO", "THEN", "ELSE", "WHEN", "CASE", "RETURNING", "BY", "OVER", "TABLE", "WITH", "UNION", "HAVING", "LIMIT",
        "OFFSET", "IS", "LIKE", "ILIKE", "BETWEEN", "DISTINCT", "ESCAPE", "INSERT", "UPDATE", "DELETE", "MERGE", "CALL", "EXEC",
        "EXECUTE", "BEGIN", "END", "RETURN", "DO", "IF",
    ];
    private static readonly HashSet<string> SelectEnd = ["FROM", "WHERE", "UNION", "GROUP", "ORDER", "HAVING", "RETURNING", "ON", "LIMIT"];
    private static readonly HashSet<string> BetweenStop = ["AND", "OR", "WHERE", "ON", "WHEN", "SET"];

    [GeneratedRegex(@"^:(\.\.\.)?([A-Za-z0-9_$#]+)")]
    private static partial Regex NamedPlaceholder();
    [GeneratedRegex(@"^\$([0-9]+)")]
    private static partial Regex DollarPlaceholder();
    [GeneratedRegex(@"^@[A-Za-z0-9_]+")]
    private static partial Regex AtPlaceholder();
    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_$#]*")]
    private static partial Regex Identifier();
    [GeneratedRegex(@"^[0-9]+(\.[0-9]+)?")]
    private static partial Regex Number();

    private static bool IsNotColumn(string? upper) => upper != null && NotColumns.Contains(upper);

    private static void PushName(List<Token> tokens, string name, bool bare, int start, int end)
    {
        var last = tokens.Count > 0 ? tokens[^1] : null;
        var beforeDot = tokens.Count > 1 ? tokens[^2] : null;
        var from = start;
        if (last is { Kind: Kind.Punct, Text: "." } && beforeDot is { Kind: Kind.Id })
        {
            from = beforeDot.Start;
            tokens.RemoveRange(tokens.Count - 2, 2);
        }
        tokens.Add(new Token { Kind = Kind.Id, Text = name, Upper = bare ? name.ToUpperInvariant() : null, Start = from, End = end });
    }

    private static string Slice(string sql, int i, int len) => sql.Substring(i, Math.Min(len, sql.Length - i));

    private static List<Token> Tokenize(string sql)
    {
        var tokens = new List<Token>();
        var n = Math.Min(sql.Length, ScanMax);
        var i = 0;
        while (i < n)
        {
            var c = sql[i];
            var next = i + 1 < sql.Length ? sql[i + 1] : '\0';
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
            else if (c == '-' && next == '-')
            {
                var end = sql.IndexOf('\n', i);
                i = end == -1 ? n : end + 1;
            }
            else if (c == '/' && next == '*')
            {
                var end = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = end == -1 ? n : end + 2;
            }
            else if (c == '\'')
            {
                var j = i + 1;
                while (j < n)
                {
                    if (sql[j] == '\'')
                    {
                        if (j + 1 < sql.Length && sql[j + 1] == '\'') j += 2;
                        else break;
                    }
                    else j++;
                }
                tokens.Add(new Token { Kind = Kind.Str, Text = "", Start = i, End = Math.Min(j + 1, n) });
                i = j + 1;
            }
            else if (c == '"' || c == '`')
            {
                var end = sql.IndexOf(c, i + 1);
                var name = sql.Substring(i + 1, (end == -1 ? n : end) - (i + 1));
                var after = end == -1 ? n : end + 1;
                PushName(tokens, name, false, i, after);
                i = after;
            }
            else if (c == ':')
            {
                if (next == ':' || next == '=')
                {
                    tokens.Add(new Token { Kind = Kind.Op, Text = sql.Substring(i, 2), Start = i, End = i + 2 });
                    i += 2;
                    continue;
                }
                var m = NamedPlaceholder().Match(Slice(sql, i, 130));
                if (m.Success)
                {
                    tokens.Add(new Token { Kind = Kind.Ph, Text = ":" + m.Groups[2].Value, Start = i, End = i + m.Length });
                    i += m.Length;
                }
                else
                {
                    tokens.Add(new Token { Kind = Kind.Punct, Text = ":", Start = i, End = i + 1 });
                    i++;
                }
            }
            else if (c == '?')
            {
                tokens.Add(new Token { Kind = Kind.Ph, Text = "?", Start = i, End = i + 1 });
                i++;
            }
            else if (c == '$' && next >= '0' && next <= '9')
            {
                var m = DollarPlaceholder().Match(Slice(sql, i, 12));
                tokens.Add(new Token { Kind = Kind.Ph, Text = m.Value, Start = i, End = i + m.Length });
                i += m.Length;
            }
            else if (c == '@' && (next == '_' || (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z')))
            {
                var m = AtPlaceholder().Match(Slice(sql, i, 130));
                tokens.Add(new Token { Kind = Kind.Ph, Text = m.Value, Start = i, End = i + m.Length });
                i += m.Length;
            }
            else if (c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))
            {
                var m = Identifier().Match(Slice(sql, i, 130));
                PushName(tokens, m.Value, true, i, i + m.Length);
                i += m.Length;
            }
            else if (c >= '0' && c <= '9')
            {
                var m = Number().Match(Slice(sql, i, 40));
                tokens.Add(new Token { Kind = Kind.Number, Text = m.Value, Start = i, End = i + m.Length });
                i += m.Length;
            }
            else
            {
                string? op = null;
                foreach (var candidate in Operators)
                {
                    if (string.CompareOrdinal(sql, i, candidate, 0, candidate.Length) == 0 && i + candidate.Length <= sql.Length) { op = candidate; break; }
                }
                if (op != null)
                {
                    tokens.Add(new Token { Kind = Kind.Op, Text = op, Start = i, End = i + op.Length });
                    i += op.Length;
                }
                else
                {
                    tokens.Add(new Token { Kind = Kind.Punct, Text = c.ToString(), Start = i, End = i + 1 });
                    i++;
                }
            }
        }
        return tokens;
    }

    private static Context BuildContext(List<Token> tokens)
    {
        var n = tokens.Count;
        var parent = new int[n];
        var match = new int[n];
        Array.Fill(parent, -1);
        Array.Fill(match, -1);
        var stack = new List<int>();
        for (var i = 0; i < n; i++)
        {
            var token = tokens[i];
            parent[i] = stack.Count > 0 ? stack[^1] : -1;
            if (token.Kind != Kind.Punct) continue;
            if (token.Text == "(") stack.Add(i);
            else if (token.Text == ")")
            {
                if (stack.Count > 0)
                {
                    var open = stack[^1];
                    stack.RemoveAt(stack.Count - 1);
                    match[open] = i;
                    match[i] = open;
                }
            }
        }
        foreach (var open in stack) match[open] = n - 1;
        return new Context { Tokens = tokens, Parent = parent, Match = match };
    }

    private static bool IsWord(Token? token, string word) => token is { Kind: Kind.Id } && token.Upper == word;
    private static bool IsPunct(Token? token, string text) => token is { Kind: Kind.Punct } && token.Text == text;
    private static bool IsCompareOp(Token? token) => token is { Kind: Kind.Op } && token.Text != "::" && token.Text != ":=";

    private static string? ColumnBefore(Context c, int index)
    {
        var left = c.T(index - 1);
        if (left is { Kind: Kind.Id }) return IsNotColumn(left.Upper) ? null : left.Text;
        if (IsPunct(left, "]") && c.T(index - 2) is { Kind: Kind.Id } && IsPunct(c.T(index - 3), "[")) return c.T(index - 2)!.Text;
        if (!IsPunct(left, ")")) return null;
        var open = c.MatchOf(index - 1);
        if (open < 0) return null;
        for (var j = open + 1; j < index - 1 && j < open + 64; j++)
        {
            var token = c.Tokens[j];
            if (token.Kind == Kind.Id && !IsNotColumn(token.Upper) && !IsPunct(c.T(j + 1), "(")) return token.Text;
        }
        return null;
    }

    private static int BetweenFor(Context c, int and)
    {
        var j = and - 1;
        for (var steps = 0; j >= 0 && steps < 16; steps++)
        {
            var token = c.Tokens[j];
            if (IsPunct(token, ")")) j = c.MatchOf(j) - 1;
            else if (IsWord(token, "BETWEEN")) return j;
            else if (token.Kind == Kind.Id && token.Upper != null && BetweenStop.Contains(token.Upper)) return -1;
            else if (IsPunct(token, ",") || IsPunct(token, "(")) return -1;
            else j--;
        }
        return -1;
    }

    private static string? TupleColumn(Context c, int rightOpen, int start)
    {
        var item = 0;
        for (var j = rightOpen + 1; j < start; j++) if (IsPunct(c.Tokens[j], ",") && c.Parent[j] == rightOpen) item++;
        var leftOpen = c.MatchOf(rightOpen - 2);
        if (leftOpen < 0) return null;
        var names = new List<string>();
        for (var j = leftOpen + 1; j < rightOpen - 2; j++)
        {
            if (c.Parent[j] == leftOpen && c.Tokens[j].Kind == Kind.Id) names.Add(c.Tokens[j].Text);
        }
        return item < names.Count ? names[item] : null;
    }

    /// <summary>The column a value token belongs to: "" = structural (LIMIT 10), null = unknown.</summary>
    private static string? ColumnAround(Context c, int start, int end)
    {
        var prev = c.T(start - 1);
        var next = c.T(end + 1);
        if (IsCompareOp(prev))
        {
            var column = ColumnBefore(c, start - 1);
            if (!string.IsNullOrEmpty(column)) return column;
        }
        else if (prev != null && prev.Upper != null && CompareWords.Contains(prev.Upper))
        {
            return ColumnBefore(c, IsWord(c.T(start - 2), "NOT") ? start - 2 : start - 1);
        }
        else if (IsWord(prev, "BETWEEN"))
        {
            return ColumnBefore(c, IsWord(c.T(start - 2), "NOT") ? start - 2 : start - 1);
        }
        else if (IsWord(prev, "AND"))
        {
            var between = BetweenFor(c, start - 1);
            if (between != -1) return ColumnBefore(c, IsWord(c.T(between - 1), "NOT") ? between - 1 : between);
        }
        else if (prev is { Kind: Kind.Id } && prev.Upper != null && Structural.Contains(prev.Upper))
        {
            return "";
        }
        if (IsCompareOp(next))
        {
            var after = c.T(end + 2);
            if (after is { Kind: Kind.Id } && !IsNotColumn(after.Upper))
            {
                if (!IsPunct(c.T(end + 3), "(")) return after.Text;
                var close = c.MatchOf(end + 3);
                for (var j = end + 4; j < close && j < end + 64; j++)
                {
                    if (c.Tokens[j].Kind == Kind.Id && !IsPunct(c.T(j + 1), "(")) return c.Tokens[j].Text;
                }
            }
        }
        if (IsWord(next, "AS") && c.T(end + 2) is { Kind: Kind.Id } alias) return alias.Text;
        if (IsPunct(prev, "(") || IsPunct(prev, ","))
        {
            var open = c.ParentOf(start);
            if (open >= 0)
            {
                var before = c.T(open - 1);
                if (IsWord(before, "IN")) return ColumnBefore(c, IsWord(c.T(open - 2), "NOT") ? open - 2 : open - 1);
                if (IsCompareOp(before) && IsPunct(c.T(open - 2), ")")) return TupleColumn(c, open, start);
            }
        }
        return null;
    }

    private static string? SlotColumn(Context c, int index, bool walkOut)
    {
        var start = index;
        var end = index;
        for (var hop = 0; hop < 8; hop++)
        {
            var column = ColumnAround(c, start, end);
            if (column != null || !walkOut) return column;
            var open = c.ParentOf(start);
            if (open < 1) return null;
            var fn = c.Tokens[open - 1];
            if (fn.Kind != Kind.Id || (fn.Upper != null && NotFunctions.Contains(fn.Upper))) return null;
            start = open - 1;
            end = c.MatchOf(open);
        }
        return null;
    }

    private static bool IsValueToken(Token token) => token.Kind is Kind.Ph or Kind.Str or Kind.Number;

    private static List<string> ColumnList(Context c, int open)
    {
        var columns = new List<string>();
        var close = c.MatchOf(open);
        for (var j = open + 1; j < close; j++) if (c.Parent[j] == open && c.Tokens[j].Kind == Kind.Id) columns.Add(c.Tokens[j].Text);
        return columns;
    }

    private static void AssignItems(Context c, Dictionary<int, Slot> slots, int from, int to, int level, List<string> columns)
    {
        var item = 0;
        for (var j = from; j < to && j < c.Tokens.Count; j++)
        {
            var token = c.Tokens[j];
            if (IsPunct(token, ",") && c.Parent[j] == level) { item++; continue; }
            if (slots.TryGetValue(j, out var slot) && slot.Column == null && !slot.Structural && item < columns.Count && columns[item].Length > 0)
                slot.Column = columns[item];
        }
    }

    private static void InsertColumns(Context c, Dictionary<int, Slot> slots)
    {
        var t = c.Tokens;
        for (var i = 0; i < t.Count; i++)
        {
            var open = -1;
            if (IsWord(t[i], "INSERT") && IsPunct(c.T(i + 1), "(")) open = i + 1;
            else if (IsWord(t[i], "INTO") && c.T(i + 1) is { Kind: Kind.Id } && IsPunct(c.T(i + 2), "(")) open = i + 2;
            if (open == -1) continue;
            var columns = ColumnList(c, open);
            if (columns.Count == 0) continue;
            var k = c.MatchOf(open) + 1;
            if (IsWord(c.T(k), "VALUES"))
            {
                k++;
                while (IsPunct(c.T(k), "("))
                {
                    var close = c.MatchOf(k);
                    AssignItems(c, slots, k + 1, close, k, columns);
                    if (IsPunct(c.T(close + 1), ",") && IsPunct(c.T(close + 2), "(")) k = close + 2;
                    else break;
                }
            }
            else if (IsWord(c.T(k), "SELECT"))
            {
                var level = c.ParentOf(k);
                var end = k + 1;
                while (end < t.Count)
                {
                    var token = t[end];
                    if (c.Parent[end] == level && ((token.Upper != null && SelectEnd.Contains(token.Upper)) || IsPunct(token, ";"))) break;
                    if (level != -1 && end >= c.MatchOf(level)) break;
                    end++;
                }
                AssignItems(c, slots, k + 1, end, level, columns);
            }
        }
    }

    private sealed class Analysis
    {
        public Context Ctx = new();
        public List<KeyValuePair<int, Slot>> Slots = new();
        public bool Sensitive;
    }

    private static Analysis Analyse(string sql)
    {
        var ctx = BuildContext(Tokenize(sql));
        var slots = new Dictionary<int, Slot>();
        var order = new List<int>();
        var sensitive = false;
        for (var index = 0; index < ctx.Tokens.Count; index++)
        {
            var token = ctx.Tokens[index];
            if (token.Kind == Kind.Id && !sensitive && Keys.IsSensitiveKey(token.Text)) sensitive = true;
            if (!IsValueToken(token)) continue;
            var column = SlotColumn(ctx, index, token.Kind != Kind.Number);
            slots[index] = column == "" ? new Slot { Structural = true } : !string.IsNullOrEmpty(column) ? new Slot { Column = column } : new Slot();
            order.Add(index);
        }
        InsertColumns(ctx, slots);
        var analysis = new Analysis { Ctx = ctx, Sensitive = sensitive };
        foreach (var index in order) analysis.Slots.Add(new(index, slots[index]));
        return analysis;
    }

    public static string MaskSql(string sql)
    {
        if (string.IsNullOrEmpty(sql)) return sql;
        var analysis = Analyse(sql);
        var tokens = analysis.Ctx.Tokens;
        var @out = new StringBuilder();
        var last = 0;
        foreach (var (index, slot) in analysis.Slots)
        {
            var token = tokens[index];
            if (token.Kind == Kind.Ph) continue;
            var secret = !string.IsNullOrEmpty(slot.Column)
                ? Keys.IsSensitiveKey(slot.Column)
                : token.Kind == Kind.Str && analysis.Sensitive && !slot.Structural;
            if (!secret || sql.AsSpan(token.Start, token.End - token.Start).SequenceEqual("'" + Keys.Redacted + "'")) continue;
            @out.Append(sql, last, token.Start - last).Append('\'').Append(Keys.Redacted).Append('\'');
            last = token.End;
        }
        return Value.RedactValue(last > 0 ? @out.Append(sql, last, sql.Length - last).ToString() : sql, sql: true);
    }
}
