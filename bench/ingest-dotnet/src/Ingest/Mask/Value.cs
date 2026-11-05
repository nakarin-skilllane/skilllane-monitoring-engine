// Port of skilllane-monitoring/contract/mask/value.js: the value rule (redactValue / redactText),
// maskNumber, maskJsonText / maskJsonValue / maskObject, truncateUtf8.
// EMAIL_RUN, THAI_ID and PAIR of the SDK use lookbehind; here they are hand scanners (same for Go and
// Rust, so the work is comparable). The other patterns are [GeneratedRegex] with JS (ASCII) classes.
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ingest.Mask;

public static partial class Value
{
    private const string Redacted = Keys.Redacted;
    private const string QuotedRedacted = "\"" + Keys.Redacted + "\"";
    private const int EmailRunMax = 1_024;
    private const int MaxDepth = 32;
    // JS \s (non-unicode mode): WhiteSpace + LineTerminator
    private const string JsSpace = @"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

    [GeneratedRegex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")]
    private static partial Regex Email();
    [GeneratedRegex(@"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}")]
    private static partial Regex EmailBounded();
    [GeneratedRegex(@"(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")]
    private static partial Regex Jwt();
    [GeneratedRegex(@"(?<![A-Za-z0-9_])(Bearer|Basic)[" + JsSpace + @"]+[A-Za-z0-9._~+/=-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Bearer();
    [GeneratedRegex(@"bearer|basic", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BearerHint();
    [GeneratedRegex(@"(?<![A-Za-z0-9_])([a-z][a-z0-9+.-]*://)([^" + JsSpace + @":@/?#\[\]]*)(?::([^" + JsSpace + @"@/?#]*))?@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UserInfo();
    [GeneratedRegex(@"[0-9]{5}")]
    private static partial Regex Digits5();
    [GeneratedRegex(@"((?:https?://[^" + JsSpace + @"?#""']+)|(?:/[A-Za-z0-9_\-./%~]*))\?[^" + JsSpace + @"#""']*")]
    private static partial Regex UrlQuery();
    [GeneratedRegex(@"^(?::(?:\.\.\.)?[A-Za-z0-9_$#]+|\?|\$[0-9]+|@[A-Za-z0-9_]+)$")]
    private static partial Regex Placeholder();
    [GeneratedRegex(@"^([A-Za-z][A-Za-z0-9_.+-]*)[ \t]+[^" + JsSpace + "]")]
    private static partial Regex Scheme();
    [GeneratedRegex(@"^[-+]?\.?[0-9]")]
    private static partial Regex NumberStart();
    [GeneratedRegex(@"^[0-9]{13}$")]
    private static partial Regex Digits13();

    public readonly record struct Mode(bool Sql, bool Json);

    // ---------- Thai national id ----------

    public static bool IsThaiNationalId(string digits)
    {
        if (digits.Length != 13 || digits[0] == '0') return false;
        var sum = 0;
        for (var i = 0; i < 12; i++)
        {
            var c = digits[i];
            if (c < '0' || c > '9') return false;
            sum += (c - '0') * (13 - i);
        }
        if (digits[12] < '0' || digits[12] > '9') return false;
        return (11 - (sum % 11)) % 10 == digits[12] - '0';
    }

    public static string StripQuery(string path)
    {
        var index = path.IndexOf('?');
        return index == -1 ? path : path.Substring(0, index);
    }

    // ---------- emails: EMAIL_RUN = /(?<![A-Za-z0-9._%+@-])[A-Za-z0-9._%+@-]+/g as a scanner ----------

    private static bool IsEmailRunChar(char c) =>
        (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '.' || c == '_' || c == '%' || c == '+' || c == '@' || c == '-';

    private static string RedactEmails(string text)
    {
        StringBuilder? sb = null;
        var last = 0;
        var i = 0;
        while (i < text.Length)
        {
            if (!IsEmailRunChar(text[i])) { i++; continue; }
            var start = i;
            var hasAt = false;
            while (i < text.Length && IsEmailRunChar(text[i])) { if (text[i] == '@') hasAt = true; i++; }
            if (!hasAt) continue;
            var run = text.Substring(start, i - start);
            var masked = (run.Length > EmailRunMax ? EmailBounded() : Email()).Replace(run, Redacted);
            if (ReferenceEquals(masked, run) || masked == run) continue;
            sb ??= new StringBuilder(text.Length);
            sb.Append(text, last, start - last).Append(masked);
            last = i;
        }
        if (sb == null) return text;
        sb.Append(text, last, text.Length - last);
        return sb.ToString();
    }

    // ---------- Thai id: THAI_ID = /(?<!\d)(\d)-?(\d{4})-?(\d{5})-?(\d{2})-?(\d)(?!\d)/g as a scanner ----------

    private static bool IsDigit(char c) => c >= '0' && c <= '9';

    /// <summary>Tries the THAI_ID pattern at `p`; returns the match end (exclusive) or -1, and the 13 digits.</summary>
    private static int MatchThaiId(string text, int p, Span<char> digits)
    {
        if (p > 0 && IsDigit(text[p - 1])) return -1;
        var i = p;
        var d = 0;
        ReadOnlySpan<int> groups = [1, 4, 5, 2, 1];
        for (var g = 0; g < groups.Length; g++)
        {
            if (g > 0 && i < text.Length && text[i] == '-') i++;
            for (var k = 0; k < groups[g]; k++)
            {
                if (i >= text.Length || !IsDigit(text[i])) return -1;
                digits[d++] = text[i++];
            }
        }
        if (i < text.Length && IsDigit(text[i])) return -1;
        return i;
    }

    private static string RedactThaiIds(string text)
    {
        StringBuilder? sb = null;
        var last = 0;
        Span<char> digits = stackalloc char[13];
        var i = 0;
        while (i < text.Length)
        {
            if (!IsDigit(text[i])) { i++; continue; }
            var end = MatchThaiId(text, i, digits);
            if (end < 0) { i++; continue; }
            if (IsThaiNationalId(new string(digits)))
            {
                sb ??= new StringBuilder(text.Length);
                sb.Append(text, last, i - last).Append(Redacted);
                last = end;
            }
            i = end;
        }
        if (sb == null) return text;
        sb.Append(text, last, text.Length - last);
        return sb.ToString();
    }

    // ---------- key=value pairs: PAIR as a scanner ----------
    // PAIR = /(?:(\\?["'])([A-Za-z0-9_.-]{1,64})\1|(?<![A-Za-z0-9_.\-\\])([A-Za-z0-9_.-]{1,64}))[ \t]*(===|=>|:=|==|[:=])[ \t]*/g

    private static bool IsNameChar(char c) =>
        (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';

    private static bool IsNameLookbehind(char c) => IsNameChar(c) || c == '\\';

    /// <summary>The operator and the spaces around it from `i`; -1 when PAIR's tail does not match there.</summary>
    private static int MatchPairTail(string text, int i)
    {
        while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
        if (i >= text.Length) return -1;
        var rest = text.AsSpan(i);
        int op;
        if (rest.StartsWith("===")) op = 3;
        else if (rest.StartsWith("=>") || rest.StartsWith(":=") || rest.StartsWith("==")) op = 2;
        else if (rest[0] == ':' || rest[0] == '=') op = 1;
        else return -1;
        i += op;
        while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
        return i;
    }

    /// <summary>One PAIR match attempt at `p`: the name and the match end, or end -1.</summary>
    private static int MatchPairAt(string text, int p, out string name)
    {
        name = "";
        var c = text[p];
        if (c == '"' || c == '\'' || (c == '\\' && p + 1 < text.Length && (text[p + 1] == '"' || text[p + 1] == '\'')))
        {
            // alternative 1: (\\?["'])name\1
            var quoteLen = c == '\\' ? 2 : 1;
            var quote = text.AsSpan(p, quoteLen);
            var i = p + quoteLen;
            var start = i;
            while (i < text.Length && IsNameChar(text[i])) i++;
            var len = i - start;
            if (len < 1 || len > 64) return -1;
            if (!text.AsSpan(i).StartsWith(quote)) return -1;
            name = text.Substring(start, len);
            return MatchPairTail(text, i + quoteLen);
        }
        if (!IsNameChar(c)) return -1;
        if (p > 0 && IsNameLookbehind(text[p - 1])) return -1;
        var j = p;
        while (j < text.Length && IsNameChar(text[j])) j++;
        var n = j - p;
        if (n > 64) return -1;
        name = text.Substring(p, n);
        return MatchPairTail(text, j);
    }

    private static int LineEnd(string text, int from)
    {
        for (var i = from; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\n' || c == '\r') return i;
        }
        return text.Length;
    }

    private static int QuoteEnd(string text, int start, char quote)
    {
        for (var i = start + 1; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\\') i++;
            else if (c == quote) return i;
        }
        return -1;
    }

    private static int ContainerEnd(string text, int start)
    {
        var depth = 0;
        for (var i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '"')
            {
                var end = QuoteEnd(text, i, '"');
                if (end == -1) return text.Length;
                i = end;
            }
            else if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']')
            {
                depth--;
                if (depth == 0) return i + 1;
            }
        }
        return text.Length;
    }

    private static bool BareStop(char c, bool json) =>
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' || c == '"' || c == '\'' || c == '&' || c == ';' ||
        (json && (c == '}' || c == ']'));

    /// <summary>maskedValue: where the value under `name` ends and its masked text (null = leave it).</summary>
    private static (int End, string? Masked) MaskedValue(string text, int p, string name, Mode mode)
    {
        if (p >= text.Length) return (p, null);
        var c = text[p];
        if (c == '"' || c == '\'')
        {
            var close = QuoteEnd(text, p, c);
            if (close == -1) return (mode.Json ? text.Length : LineEnd(text, p), c + Redacted);
            return (close + 1, text.AsSpan(p + 1, close - p - 1).SequenceEqual(Redacted) ? null : c + Redacted + c);
        }
        if (c == '\\' && p + 1 < text.Length && (text[p + 1] == '"' || text[p + 1] == '\''))
        {
            var quote = text.Substring(p, 2);
            var close = text.IndexOf(quote, p + 2, StringComparison.Ordinal);
            if (close == -1) return (LineEnd(text, p), quote + Redacted);
            return (close + 2, quote + Redacted + quote);
        }
        var lower = name.ToLowerInvariant();
        if (!mode.Json && !mode.Sql && (lower.EndsWith("authorization", StringComparison.Ordinal) || lower == "cookie" || lower == "set-cookie"))
        {
            var end = LineEnd(text, p);
            var rest = text.Substring(p, end - p);
            var scheme = Scheme().Match(rest);
            var masked = scheme.Success ? scheme.Groups[1].Value + " " + Redacted : Redacted;
            return (end, masked == rest ? null : masked);
        }
        if (mode.Json && (c == '{' || c == '[')) return (ContainerEnd(text, p), QuotedRedacted);
        var e = p;
        while (e < text.Length && !BareStop(text[e], mode.Json)) e++;
        if (e == p) return (p, null);
        var value = text.Substring(p, e - p);
        if (value == Redacted) return (e, null);
        if (mode.Sql && (Placeholder().IsMatch(value) || !NumberStart().IsMatch(value))) return (e, null);
        return (e, Redacted);
    }

    public static string RedactPairs(string text, Mode mode)
    {
        StringBuilder? sb = null;
        var last = 0;
        var pos = 0;
        while (pos < text.Length)
        {
            var end = MatchPairAt(text, pos, out var name);
            if (end < 0) { pos++; continue; }
            var matchIndex = pos;
            pos = end; // lastIndex
            var before = matchIndex > 0 ? text[matchIndex - 1] : '\0';
            var sensitive = before == '?' || before == '&' || before == '#' ? Keys.IsSensitiveQueryName(name) : Keys.IsSensitiveKey(name);
            if (!sensitive) continue;
            var valueStart = end;
            var (valueEnd, masked) = MaskedValue(text, valueStart, name, mode);
            if (masked == null) continue;
            sb ??= new StringBuilder(text.Length);
            sb.Append(text, last, valueStart - last).Append(masked);
            last = valueEnd;
            if (pos < valueEnd) pos = valueEnd;
        }
        if (sb == null) return text;
        sb.Append(text, last, text.Length - last);
        return sb.ToString();
    }

    private static string RedactUserinfo(string text) => UserInfo().Replace(text, m =>
    {
        var scheme = m.Groups[1].Value;
        var user = m.Groups[2].Value;
        if (m.Groups[3].Success)
            return m.Groups[3].Length > 0 ? scheme + user + ":" + Redacted + "@" : m.Value;
        return user.Length > 0 && user != Redacted ? scheme + Redacted + "@" : m.Value;
    });

    /// <summary>Whole-text JSON (object / array): masked and re-serialised when anything changed.</summary>
    private static string? MaskJsonInText(string text)
    {
        var first = 0;
        while (first < text.Length && text[first] <= ' ') first++;
        if (first >= text.Length) return null;
        var open = text[first];
        if (open != '{' && open != '[') return null;
        var last = text.Length - 1;
        while (last > first && text[last] <= ' ') last--;
        if (text[last] != (open == '{' ? '}' : ']')) return null;
        object? parsed;
        try { parsed = Js.Parse(text); }
        catch (JsonException) { return null; }
        var state = new MaskState();
        var masked = MaskParsed(parsed, 0, state);
        return state.Changed ? Js.Stringify(masked) : text;
    }

    public static string RedactValue(string text, bool sql = false)
    {
        if (string.IsNullOrEmpty(text)) return text;
        if (!sql)
        {
            var json = MaskJsonInText(text);
            if (json != null) return json;
        }
        var @out = text;
        if (@out.Contains("eyJ", StringComparison.Ordinal)) @out = Jwt().Replace(@out, Redacted);
        if (BearerHint().IsMatch(@out)) @out = Bearer().Replace(@out, "$1 " + Redacted);
        if (@out.Contains('@') && @out.Contains("://", StringComparison.Ordinal)) @out = RedactUserinfo(@out);
        if (@out.Contains('=') || @out.Contains(':')) @out = RedactPairs(@out, new Mode(sql, false));
        if (@out.Contains('@')) @out = RedactEmails(@out);
        if (Digits5().IsMatch(@out)) @out = RedactThaiIds(@out);
        return @out;
    }

    public static string RedactText(string text) => RedactValue(text.Contains('?') ? UrlQuery().Replace(text, "$1") : text);

    /// <summary>maskNumber on a JS number: a 13-digit integer with a valid checksum → [REDACTED].</summary>
    public static object MaskNumber(double value)
    {
        if (value == Math.Floor(value) && !double.IsInfinity(value) && value >= 1e12 && value < 1e13 && IsThaiNationalId(Js.NumberToString(value))) return Redacted;
        return value;
    }

    private static string MaskKey(string key) => key.Contains('@') || Digits5().IsMatch(key) ? RedactValue(key) : key;

    private sealed class MaskState { public bool Changed; }

    private static JsObject RenameKeys(JsObject record, Dictionary<string, string> renamed)
    {
        var @out = new JsObject();
        foreach (var (key, value) in record.Entries())
        {
            var name = renamed.TryGetValue(key, out var r) ? r : key;
            for (var n = 2; renamed.ContainsKey(key) && @out.Has(name); n++) name = renamed[key] + "#" + n.ToString(CultureInfo.InvariantCulture);
            @out.Set(name, value);
        }
        return @out;
    }

    private static object? MaskParsed(object? value, int depth, MaskState state)
    {
        switch (value)
        {
            case string s:
                {
                    var masked = RedactValue(s);
                    if (!ReferenceEquals(masked, s) && masked != s) state.Changed = true;
                    return masked;
                }
            case double d:
                {
                    var masked = MaskNumber(d);
                    if (masked is string) state.Changed = true;
                    return masked;
                }
            case null or bool or Undefined: return value;
        }
        if (depth >= MaxDepth) { state.Changed = true; return "[…]"; }
        if (value is List<object?> list)
        {
            for (var i = 0; i < list.Count; i++) list[i] = MaskParsed(list[i], depth + 1, state);
            return list;
        }
        var record = (JsObject)value;
        Dictionary<string, string>? renamed = null;
        foreach (var key in record.KeyList())
        {
            if (Keys.IsSensitiveKey(key))
            {
                if (!(record.Get(key) is string rs && rs == Redacted)) { record.Set(key, Redacted); state.Changed = true; }
            }
            else record.Set(key, MaskParsed(record.Get(key), depth + 1, state));
            var name = MaskKey(key);
            if (name != key) (renamed ??= new Dictionary<string, string>(StringComparer.Ordinal))[key] = name;
        }
        if (renamed == null) return record;
        state.Changed = true;
        return RenameKeys(record, renamed);
    }

    public static object? MaskJsonValue(object? value) => MaskParsed(value, 0, new MaskState());

    public static string MaskJsonText(string text, bool complete = true)
    {
        var start = 0;
        while (start < text.Length && (text[start] <= ' ' || text[start] == '\ufeff')) start++;
        var body = start > 0 ? text.Substring(start) : text;
        if (complete)
        {
            object? parsed;
            try { parsed = Js.Parse(body); }
            catch (JsonException) { return MaskJsonLoose(body); }
            return Js.Stringify(MaskParsed(parsed, 0, new MaskState()));
        }
        return MaskJsonLoose(body);
    }

    // ---------- loose JSON (cut or invalid): a one-pass scanner ----------

    private static int BareEnd(string text, int start)
    {
        var end = start;
        while (end < text.Length)
        {
            var c = text[end];
            if (c == ',' || c == '}' || c == ']' || c == ':' || c == '{' || c == '[' || c == '"' || c == '\'' || c == ' ' ||
                c == '\n' || c == '\r' || c == '\t' || c == '\ufeff' ||
                (c == '/' && end + 1 < text.Length && (text[end + 1] == '*' || text[end + 1] == '/')))
                break;
            end++;
        }
        return end == start ? start + 1 : end;
    }

    private static char? NextChar(string text, int from)
    {
        for (var i = from; i < text.Length; i++)
        {
            var c = text[i];
            if (c > ' ' && c != '\ufeff') return c;
        }
        return null;
    }

    private static string? TokenText(string token, char quote, bool whole)
    {
        var inner = whole ? token.Substring(1, token.Length - 2) : token.Substring(1);
        if (quote != '"' || !whole || !inner.Contains('\\')) return inner;
        try { return Js.Parse(token) as string; }
        catch (JsonException) { return null; }
    }

    private static string MaskStringToken(string token, char quote, bool whole)
    {
        var value = TokenText(token, quote, whole);
        if (value == null) return RedactValue(token);
        var masked = RedactValue(value);
        if (masked == value) return token;
        if (!whole) return quote + masked;
        return quote == '"' ? Js.Stringify(masked) : "'" + masked.Replace("'", "\\'") + "'";
    }

    private sealed class Frame
    {
        public bool Object;
        public string Phase = "value"; // key | colon | value | after
        public bool Sensitive;
    }

    private static string MaskJsonLoose(string text)
    {
        var @out = new StringBuilder(text.Length);
        var stack = new List<Frame>();
        var n = text.Length;
        var lost = false;
        var i = 0;
        while (i < n)
        {
            var c = text[i];
            var frame = stack.Count > 0 ? stack[^1] : null;
            var phase = frame?.Phase ?? "value";
            var sensitive = frame != null && frame.Object && frame.Sensitive && (phase == "value" || phase == "colon");
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\ufeff')
            {
                i++;
            }
            else if (c == '/' && i + 1 < n && (text[i + 1] == '*' || text[i + 1] == '/'))
            {
                var block = text[i + 1] == '*';
                var end = block ? text.IndexOf("*/", i + 2, StringComparison.Ordinal) : LineEnd(text, i);
                i = end == -1 ? n : block ? end + 2 : end;
            }
            else if (c == '{' || c == '[')
            {
                if (phase != "value") lost = true;
                if (sensitive)
                {
                    @out.Append(QuotedRedacted);
                    if (frame != null) frame.Phase = "after";
                    i = ContainerEnd(text, i);
                }
                else
                {
                    @out.Append(c);
                    stack.Add(new Frame { Object = c == '{', Phase = c == '{' ? "key" : "value", Sensitive = false });
                    i++;
                }
            }
            else if (c == '}' || c == ']')
            {
                @out.Append(c);
                if (frame == null || frame.Object != (c == '}') || (frame.Object && phase != "after" && phase != "key")) lost = true;
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                if (stack.Count > 0) stack[^1].Phase = "after";
                i++;
            }
            else if (c == ',')
            {
                @out.Append(c);
                if (frame != null)
                {
                    if (phase != "after") lost = true;
                    frame.Phase = frame.Object ? "key" : "value";
                    frame.Sensitive = false;
                }
                i++;
            }
            else if (c == ':')
            {
                @out.Append(c);
                if (frame?.Phase == "colon") frame.Phase = "value";
                else lost = true;
                i++;
            }
            else if (c == '"' || c == '\'')
            {
                var end = QuoteEnd(text, i, c);
                var whole = end != -1;
                var token = whole ? text.Substring(i, end + 1 - i) : text.Substring(i);
                var keyAfterValue = phase == "after" && whole && NextChar(text, end + 1) == ':';
                if (frame != null && frame.Object && (phase == "key" || keyAfterValue))
                {
                    if (keyAfterValue) lost = true;
                    var key = TokenText(token, c, whole) ?? token;
                    frame.Sensitive = Keys.IsSensitiveKey(key);
                    frame.Phase = "colon";
                    var name = MaskKey(key);
                    @out.Append(name == key ? token : Js.Stringify(name));
                }
                else
                {
                    if (phase != "value") lost = true;
                    @out.Append(sensitive ? QuotedRedacted : MaskStringToken(token, c, whole));
                    if (frame != null) frame.Phase = "after";
                }
                i = whole ? end + 1 : n;
            }
            else
            {
                var end = BareEnd(text, i);
                var token = text.Substring(i, end - i);
                if (frame != null && frame.Object && phase == "key" && NextChar(text, end) == ':')
                {
                    frame.Sensitive = Keys.IsSensitiveKey(token);
                    frame.Phase = "colon";
                    @out.Append(token);
                }
                else
                {
                    if (phase != "value") lost = true;
                    @out.Append(sensitive || (Digits13().IsMatch(token) && MaskNumber(Js.ToNumber(token)) is string) ? QuotedRedacted : token);
                    if (frame != null) frame.Phase = "after";
                }
                i = end;
            }
        }
        var masked = @out.ToString();
        return lost ? RedactPairs(masked, new Mode(false, true)) : masked;
    }

    // ---------- maskObject (values of any shape) ----------

    public static object? MaskObject(object? value) => MaskInner(value, 0);

    private static object? MaskInner(object? value, int depth)
    {
        switch (value)
        {
            case string s: return RedactValue(s);
            case double d: return MaskNumber(d);
            case null or bool or Undefined: return value;
        }
        if (depth >= MaxDepth) return "[…]";
        if (value is List<object?> list)
        {
            var copy = new List<object?>(list.Count);
            foreach (var item in list) copy.Add(MaskInner(item, depth + 1));
            return copy;
        }
        var record = (JsObject)value;
        var @out = new JsObject();
        foreach (var (key, item) in record.Entries())
        {
            if (item is Undefined) continue;
            var name = MaskKey(key);
            for (var n = 2; name != key && @out.Has(name); n++) name = MaskKey(key) + "#" + n.ToString(CultureInfo.InvariantCulture);
            @out.Set(name, Keys.IsSensitiveKey(key) ? Redacted : MaskInner(item, depth + 1));
        }
        return @out;
    }

    // ---------- truncateUtf8 ----------

    private static readonly UTF8Encoding Utf8Lossy = new(false, false);

    public static int ByteLength(string text) => Utf8Lossy.GetByteCount(text);

    public static (string Text, bool Truncated) TruncateUtf8(string text, int maxBytes)
    {
        if ((long)text.Length * 3 <= maxBytes || ByteLength(text) <= maxBytes) return (text, false);
        var head = text.Length > maxBytes ? text.Substring(0, maxBytes) : text;
        var bytes = Utf8Lossy.GetBytes(head);
        var cut = Utf8Lossy.GetString(bytes, 0, Math.Min(maxBytes, bytes.Length)).TrimEnd('\ufffd');
        return (cut, true);
    }
}
