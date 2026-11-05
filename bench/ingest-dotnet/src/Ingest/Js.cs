// JavaScript semantics the port depends on: a JSON value model with JS key order, JSON.parse /
// JSON.stringify (JS string escaping, JS number formatting), String(number), Number(string),
// parseInt, Date.parse and Date#toISOString. Everything that must be bit-identical to Node lives here.
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Ingest;

/// <summary>JS `undefined`: a missing property.</summary>
public sealed class Undefined
{
    public static readonly Undefined Value = new();
    private Undefined() { }
}

/// <summary>A JSON object with JS property order (array-index keys first, ascending, then insertion order).</summary>
public sealed class JsObject
{
    private readonly List<string> _keys = new();
    private readonly List<object?> _values = new();
    private Dictionary<string, int>? _index;
    private bool _hasIndexKeys;

    public int Count => _keys.Count;

    public object? Get(string key)
    {
        var i = IndexOf(key);
        return i < 0 ? Undefined.Value : _values[i];
    }

    public bool Has(string key) => IndexOf(key) >= 0;

    public void Set(string key, object? value)
    {
        var i = IndexOf(key);
        if (i >= 0) { _values[i] = value; return; }
        if (_keys.Count >= 8) (_index ??= BuildIndex())[key] = _keys.Count;
        _keys.Add(key);
        _values.Add(value);
        if (!_hasIndexKeys && IsArrayIndex(key)) _hasIndexKeys = true;
    }

    public void Remove(string key)
    {
        var i = IndexOf(key);
        if (i < 0) return;
        _keys.RemoveAt(i);
        _values.RemoveAt(i);
        _index = null;
    }

    private int IndexOf(string key)
    {
        if (_index != null) return _index.TryGetValue(key, out var i) ? i : -1;
        for (var i = 0; i < _keys.Count; i++) if (string.Equals(_keys[i], key, StringComparison.Ordinal)) return i;
        return -1;
    }

    private Dictionary<string, int> BuildIndex()
    {
        var d = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < _keys.Count; i++) d[_keys[i]] = i;
        return d;
    }

    /// <summary>Entries in JS order (Object.keys / Object.entries / JSON.stringify).</summary>
    public IEnumerable<KeyValuePair<string, object?>> Entries()
    {
        if (!_hasIndexKeys)
        {
            for (var i = 0; i < _keys.Count; i++) yield return new(_keys[i], _values[i]);
            yield break;
        }
        var indexed = new List<(uint n, int i)>();
        for (var i = 0; i < _keys.Count; i++) if (IsArrayIndex(_keys[i])) indexed.Add((uint.Parse(_keys[i], CultureInfo.InvariantCulture), i));
        indexed.Sort((a, b) => a.n.CompareTo(b.n));
        foreach (var (_, i) in indexed) yield return new(_keys[i], _values[i]);
        for (var i = 0; i < _keys.Count; i++) if (!IsArrayIndex(_keys[i])) yield return new(_keys[i], _values[i]);
    }

    public List<string> KeyList() => Entries().Select(e => e.Key).ToList();

    public JsObject ShallowCopy()
    {
        var copy = new JsObject();
        foreach (var (k, v) in Entries()) copy.Set(k, v);
        return copy;
    }

    private static bool IsArrayIndex(string key)
    {
        if (key.Length == 0 || key.Length > 10) return false;
        if (key.Length > 1 && key[0] == '0') return false;
        foreach (var c in key) if (c < '0' || c > '9') return false;
        return ulong.Parse(key, CultureInfo.InvariantCulture) < 4294967295UL;
    }
}

public static class Js
{
    private static readonly JsonDocumentOptions ParseOptions = new() { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 1024 };

    // ---------- JSON.parse ----------

    /// <summary>JSON.parse: throws JsonException like JS throws SyntaxError.</summary>
    public static object? Parse(string text)
    {
        using var doc = JsonDocument.Parse(text, ParseOptions);
        return ToTree(doc.RootElement);
    }

    public static object? ToTree(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.String: return el.GetString();
            case JsonValueKind.Number: return NumberOf(el);
            case JsonValueKind.True: return true;
            case JsonValueKind.False: return false;
            case JsonValueKind.Null: return null;
            case JsonValueKind.Array:
                {
                    var list = new List<object?>(el.GetArrayLength());
                    foreach (var item in el.EnumerateArray()) list.Add(ToTree(item));
                    return list;
                }
            case JsonValueKind.Object:
                {
                    var obj = new JsObject();
                    foreach (var p in el.EnumerateObject()) obj.Set(p.Name, ToTree(p.Value));
                    return obj;
                }
            default: return Undefined.Value;
        }
    }

    private static double NumberOf(JsonElement el)
    {
        if (el.TryGetDouble(out var d)) return d;
        return double.TryParse(el.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture, out d) ? d : double.NaN;
    }

    // ---------- JSON.stringify ----------

    public static string Stringify(object? value)
    {
        var sb = new StringBuilder();
        Write(sb, value);
        return sb.ToString();
    }

    public static void Write(StringBuilder sb, object? value)
    {
        switch (value)
        {
            case null: sb.Append("null"); break;
            case Undefined: sb.Append("null"); break; // only reachable inside arrays: JSON.stringify writes null there
            case string s: WriteString(sb, s); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case double d: sb.Append(double.IsFinite(d) ? NumberToString(d) : "null"); break;
            case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
            case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); break;
            case List<object?> list:
                sb.Append('[');
                for (var i = 0; i < list.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, list[i]);
                }
                sb.Append(']');
                break;
            case JsObject obj:
                {
                    sb.Append('{');
                    var first = true;
                    foreach (var (k, v) in obj.Entries())
                    {
                        if (v is Undefined) continue;
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, k);
                        sb.Append(':');
                        Write(sb, v);
                    }
                    sb.Append('}');
                    break;
                }
            case Dictionary<string, string> map:
                {
                    sb.Append('{');
                    var first = true;
                    foreach (var (k, v) in map)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, k);
                        sb.Append(':');
                        WriteString(sb, v);
                    }
                    sb.Append('}');
                    break;
                }
            case List<string> strings:
                sb.Append('[');
                for (var i = 0; i < strings.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    WriteString(sb, strings[i]);
                }
                sb.Append(']');
                break;
            default: throw new InvalidOperationException($"cannot stringify {value.GetType().Name}");
        }
    }

    /// <summary>QuoteJSONString: escapes ", \, controls (\b \f \n \r \t, else \u00xx) and lone surrogates.</summary>
    public static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        var start = 0;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            string? esc = null;
            if (c == '"') esc = "\\\"";
            else if (c == '\\') esc = "\\\\";
            else if (c < 0x20)
            {
                esc = c switch
                {
                    '\b' => "\\b",
                    '\f' => "\\f",
                    '\n' => "\\n",
                    '\r' => "\\r",
                    '\t' => "\\t",
                    _ => "\\u00" + ((int)c).ToString("x2", CultureInfo.InvariantCulture),
                };
            }
            else if (char.IsSurrogate(c))
            {
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { i++; continue; }
                esc = "\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture);
            }
            if (esc == null) continue;
            sb.Append(s, start, i - start).Append(esc);
            start = i + 1;
        }
        sb.Append(s, start, s.Length - start).Append('"');
    }

    // ---------- String(number) ----------

    /// <summary>Number::toString(10) of ECMAScript (6.1.6.1.20).</summary>
    public static string NumberToString(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (d == 0) return "0";
        if (double.IsPositiveInfinity(d)) return "Infinity";
        if (double.IsNegativeInfinity(d)) return "-Infinity";
        var negative = d < 0;
        var r = Math.Abs(d).ToString("R", CultureInfo.InvariantCulture);
        string digits;
        int n;
        var e = r.IndexOf('E');
        if (e >= 0)
        {
            var mantissa = r.Substring(0, e);
            var exp = int.Parse(r.AsSpan(e + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            var dot = mantissa.IndexOf('.');
            var intDigits = dot < 0 ? mantissa.Length : dot;
            digits = mantissa.Replace(".", "");
            n = intDigits + exp;
        }
        else
        {
            var dot = r.IndexOf('.');
            var intPart = dot < 0 ? r : r.Substring(0, dot);
            var frac = dot < 0 ? "" : r.Substring(dot + 1);
            if (intPart == "0")
            {
                var z = 0;
                while (z < frac.Length && frac[z] == '0') z++;
                digits = frac.Substring(z);
                n = -z;
            }
            else
            {
                digits = intPart + frac;
                n = intPart.Length;
            }
        }
        digits = digits.TrimEnd('0');
        var lead = 0;
        while (lead < digits.Length && digits[lead] == '0') { lead++; n--; }
        digits = digits.Substring(lead);
        var k = digits.Length;
        var sb = new StringBuilder(32);
        if (negative) sb.Append('-');
        if (k <= n && n <= 21) sb.Append(digits).Append('0', n - k);
        else if (0 < n && n <= 21) sb.Append(digits, 0, n).Append('.').Append(digits, n, k - n);
        else if (-6 < n && n <= 0) sb.Append("0.").Append('0', -n).Append(digits);
        else
        {
            var exp = n - 1;
            sb.Append(digits[0]);
            if (k > 1) sb.Append('.').Append(digits, 1, k - 1);
            sb.Append('e').Append(exp >= 0 ? '+' : '-').Append(Math.Abs(exp).ToString(CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    // ---------- Number(string), parseInt ----------

    private static readonly string WhiteSpace = new string(new[] { (char)9, (char)10, (char)11, (char)12, (char)13, (char)32, (char)0xa0, (char)0x1680, (char)0x2000, (char)0x2001, (char)0x2002, (char)0x2003, (char)0x2004, (char)0x2005, (char)0x2006, (char)0x2007, (char)0x2008, (char)0x2009, (char)0x200a, (char)0x2028, (char)0x2029, (char)0x202f, (char)0x205f, (char)0x3000, (char)0xfeff });

    public static bool IsJsWhiteSpace(char c) => WhiteSpace.IndexOf(c) >= 0;

    /// <summary>Number(text) of JS.</summary>
    public static double ToNumber(string text)
    {
        var s = text.AsSpan().Trim(WhiteSpace.AsSpan());
        if (s.Length == 0) return 0;
        if (s.Length > 2 && s[0] == '0' && (s[1] | 0x20) is 'x' or 'o' or 'b')
        {
            var radix = (s[1] | 0x20) switch { 'x' => 16, 'o' => 8, _ => 2 };
            double v = 0;
            foreach (var c in s[2..])
            {
                var digit = c >= '0' && c <= '9' ? c - '0' : (c | 0x20) >= 'a' && (c | 0x20) <= 'z' ? (c | 0x20) - 'a' + 10 : 99;
                if (digit >= radix) return double.NaN;
                v = v * radix + digit;
            }
            return v;
        }
        if (s is "Infinity" or "+Infinity") return double.PositiveInfinity;
        if (s == "-Infinity") return double.NegativeInfinity;
        foreach (var c in s)
        {
            if (!((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')) return double.NaN;
        }
        return double.TryParse(s, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent, CultureInfo.InvariantCulture, out var d) ? d : double.NaN;
    }

    /// <summary>parseInt(text, 10) of JS.</summary>
    public static double ParseInt(string text)
    {
        var i = 0;
        while (i < text.Length && IsJsWhiteSpace(text[i])) i++;
        var negative = false;
        if (i < text.Length && (text[i] == '+' || text[i] == '-')) { negative = text[i] == '-'; i++; }
        var start = i;
        while (i < text.Length && text[i] >= '0' && text[i] <= '9') i++;
        if (i == start) return double.NaN;
        var d = double.Parse(text.AsSpan(start, i - start), NumberStyles.None, CultureInfo.InvariantCulture);
        return negative ? -d : d;
    }

    // ---------- Date ----------

    /// <summary>Date.parse: milliseconds since the epoch, or NaN. A time without offset is read as UTC.</summary>
    public static double DateParse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return double.NaN;
        if (!DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AllowWhiteSpaces, out var dto)) return double.NaN;
        var ticks = dto.UtcTicks - DateTime.UnixEpoch.Ticks;
        return Math.Floor(ticks / 10000.0);
    }

    /// <summary>new Date(ms).toISOString(); throws (RangeError) outside ±8.64e15 ms.</summary>
    public static string ToIsoString(double ms)
    {
        if (double.IsNaN(ms) || Math.Abs(ms) > 8.64e15) throw new ArgumentOutOfRangeException(nameof(ms), "Invalid time value");
        var dt = DateTime.UnixEpoch.AddTicks((long)ms * 10000);
        return dt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    }

    // ---------- values ----------

    public static bool Truthy(object? v) => v switch
    {
        null => false,
        Undefined => false,
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        string s => s.Length > 0,
        _ => true,
    };

    public static bool IsNullish(object? v) => v is null or Undefined;

    /// <summary>str() of mappers.ts / text() of span-io.ts.</summary>
    public static string Str(object? value) => value switch
    {
        null => "",
        Undefined => "",
        string s => s,
        double d => NumberToString(d),
        bool b => b ? "true" : "false",
        _ => Stringify(value),
    };
}
