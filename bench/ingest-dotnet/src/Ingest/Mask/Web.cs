// Port of skilllane-monitoring/contract/mask/web.js: query strings, URLs, cookies, header values,
// markup, maskPathByRoute, maskEndpoint. maskCsv is not ported (not used by the mappers).
using System.Text;
using System.Text.RegularExpressions;

namespace Ingest.Mask;

public static partial class Web
{
    private const string Redacted = Keys.Redacted;
    private const string JsSpace = @"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

    [GeneratedRegex(@"^(?:[a-z][a-z0-9+.-]*://|/)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UrlIsh();
    [GeneratedRegex(@"^(?::([A-Za-z0-9_$]+)\??|\{([A-Za-z0-9_$]+)\})$")]
    private static partial Regex RouteParam();
    [GeneratedRegex(@"^([^" + JsSpace + @":@/]*):([^" + JsSpace + @"@/]+)@")]
    private static partial Regex EndpointUserinfo();
    [GeneratedRegex(@",[" + JsSpace + @"]*(?=[^;,=" + JsSpace + @"]+=)")]
    private static partial Regex SetCookieSplit();
    [GeneratedRegex(@"<([A-Za-z_][A-Za-z0-9_:.-]*)([" + JsSpace + @"][^<>]*)?>((?:[^<]|<!\[CDATA\[[\s\S]*?\]\]>)*)</\1>")]
    private static partial Regex XmlElement();
    [GeneratedRegex(@"<([A-Za-z_][A-Za-z0-9_:.-]*)([" + JsSpace + @"][^<>]*?)(/?)>")]
    private static partial Regex StartTag();
    [GeneratedRegex(@"(?:^|[" + JsSpace + @"])(?:name|key|id|field|param|property)[" + JsSpace + @"]*=[" + JsSpace + @"]*([""'])([^""']*)\1", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex NameAttribute();
    [GeneratedRegex(@"([" + JsSpace + @"](?:value|content)[" + JsSpace + @"]*=[" + JsSpace + @"]*)([""'])[^""']*\2", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ValueAttribute();

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    /// <summary>decodeURIComponent(text.replace(/\+/g, ' ')), the text itself when it throws.</summary>
    private static string DecodeComponent(string text)
    {
        var plus = text.Replace('+', ' ');
        if (!plus.Contains('%')) return plus;
        try
        {
            var bytes = new List<byte>(plus.Length);
            var sb = new StringBuilder(plus.Length);
            void Flush() { if (bytes.Count > 0) { sb.Append(StrictUtf8.GetString(bytes.ToArray())); bytes.Clear(); } }
            for (var i = 0; i < plus.Length; i++)
            {
                var c = plus[i];
                if (c == '%')
                {
                    if (i + 2 >= plus.Length || !IsHex(plus[i + 1]) || !IsHex(plus[i + 2])) throw new FormatException("URI malformed");
                    bytes.Add((byte)((Hex(plus[i + 1]) << 4) | Hex(plus[i + 2])));
                    i += 2;
                }
                else { Flush(); sb.Append(c); }
            }
            Flush();
            return sb.ToString();
        }
        catch (Exception e) when (e is FormatException or DecoderFallbackException or ArgumentException)
        {
            return text;
        }
    }

    private static bool IsHex(char c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    private static int Hex(char c) => c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;

    /// <summary>encodeURIComponent, with %5BREDACTED%5D put back as [REDACTED].</summary>
    private static string EncodeComponent(string text)
    {
        var sb = new StringBuilder(text.Length + 16);
        Span<byte> buf = stackalloc byte[4];
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".IndexOf(c) >= 0)
            {
                sb.Append(c);
                continue;
            }
            Rune rune;
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) { rune = new Rune(c, text[i + 1]); i++; }
            else if (char.IsSurrogate(c)) rune = Rune.ReplacementChar;
            else rune = new Rune(c);
            var n = rune.EncodeToUtf8(buf);
            for (var k = 0; k < n; k++) sb.Append('%').Append(buf[k].ToString("X2"));
        }
        return sb.ToString().Replace("%5BREDACTED%5D", Redacted, StringComparison.Ordinal);
    }

    public static string MaskQuery(string query)
    {
        if (string.IsNullOrEmpty(query)) return query;
        var pairs = query.Split('&');
        for (var i = 0; i < pairs.Length; i++)
        {
            var pair = pairs[i];
            if (pair.Length == 0) continue;
            var index = pair.IndexOf('=');
            var rawName = index == -1 ? pair : pair.Substring(0, index);
            var name = DecodeComponent(rawName);
            if (Keys.IsSensitiveQueryName(name)) { pairs[i] = rawName + "=" + Redacted; continue; }
            if (index == -1)
            {
                var masked = Value.RedactValue(name);
                pairs[i] = masked == name ? pair : EncodeComponent(masked);
                continue;
            }
            var value = DecodeComponent(pair.Substring(index + 1));
            var maskedValue = Value.RedactValue(value);
            pairs[i] = maskedValue == value ? pair : rawName + "=" + EncodeComponent(maskedValue);
        }
        return string.Join('&', pairs);
    }

    public static string MaskUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return url;
        var hash = url.IndexOf('#');
        var queryAt = url.IndexOf('?');
        var query = queryAt != -1 && (hash == -1 || queryAt < hash) ? queryAt : -1;
        var pathEnd = query != -1 ? query : hash != -1 ? hash : url.Length;
        var @out = Value.RedactValue(url.Substring(0, pathEnd));
        if (query != -1) @out += "?" + MaskQuery(url.Substring(query + 1, (hash == -1 ? url.Length : hash) - (query + 1)));
        if (hash != -1)
        {
            var fragment = url.Substring(hash + 1);
            @out += "#" + (fragment.Contains('=') ? MaskQuery(fragment) : Value.RedactValue(fragment));
        }
        return @out;
    }

    public static string MaskCookie(string value)
    {
        var parts = value.Split(';');
        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            var index = part.IndexOf('=');
            if (index == -1) parts[i] = part.Trim().Length > 0 ? (part.StartsWith(' ') ? " " : "") + Redacted : part;
            else parts[i] = part.Substring(0, index) + "=" + Redacted;
        }
        return string.Join(';', parts);
    }

    public static string MaskSetCookie(string value)
    {
        var cookies = SetCookieSplit().Split(value);
        for (var i = 0; i < cookies.Length; i++)
        {
            var cookie = cookies[i];
            var semicolon = cookie.IndexOf(';');
            var first = semicolon == -1 ? cookie : cookie.Substring(0, semicolon);
            var attributes = semicolon == -1 ? "" : cookie.Substring(semicolon);
            var index = first.IndexOf('=');
            var name = index == -1 ? "" : first.Substring(0, index);
            cookies[i] = (name.Length > 0 ? name + "=" : "") + Redacted + Value.RedactValue(attributes);
        }
        return string.Join(", ", cookies);
    }

    public static string MaskHeaderValue(string name, string value)
    {
        var lower = name.ToLowerInvariant();
        if (lower == "set-cookie") return MaskSetCookie(value);
        if (lower == "cookie") return MaskCookie(value);
        if (Keys.IsSensitiveHeader(name)) return Redacted;
        if (UrlIsh().IsMatch(value) && (value.Contains('?') || value.Contains('#'))) return MaskUrl(value);
        return Value.RedactValue(value);
    }

    /// <summary>maskHeaders on a parsed header object: string or string[] values, duplicates merged after lower-casing.</summary>
    public static JsObject MaskHeaders(JsObject headers, bool lowerCase = true)
    {
        var @out = new JsObject();
        foreach (var (name, value) in headers.Entries())
        {
            if (Js.IsNullish(value)) continue;
            var key = lowerCase ? name.ToLowerInvariant() : name;
            List<object?> values = value is List<object?> list ? list : [value];
            var masked = new List<object?>();
            foreach (var item in values) masked.Add(MaskHeaderValue(key, Js.Str(item)));
            var before = @out.Get(key);
            List<object?> all;
            if (before is Undefined) all = masked;
            else
            {
                all = before is List<object?> b ? new List<object?>(b) : [before];
                all.AddRange(masked);
            }
            @out.Set(key, all.Count == 1 ? all[0] : all);
        }
        return @out;
    }

    private static bool NamedSecret(string? attrs)
    {
        if (string.IsNullOrEmpty(attrs)) return false;
        var name = NameAttribute().Match(attrs);
        return name.Success && Keys.IsSensitiveKey(name.Groups[2].Value);
    }

    public static string MaskMarkup(string text)
    {
        if (!text.Contains('<')) return text;
        var elements = XmlElement().Replace(text, m =>
        {
            var tag = m.Groups[1].Value;
            var attrs = m.Groups[2].Success ? m.Groups[2].Value : "";
            return Keys.IsSensitiveKey(tag) || NamedSecret(attrs) ? "<" + tag + attrs + ">" + Redacted + "</" + tag + ">" : m.Value;
        });
        return StartTag().Replace(elements, m =>
        {
            var tag = m.Groups[1].Value;
            var attrs = m.Groups[2].Value;
            var close = m.Groups[3].Value;
            return NamedSecret(attrs) ? "<" + tag + ValueAttribute().Replace(attrs, "$1$2" + Redacted + "$2") + close + ">" : m.Value;
        });
    }

    public static string MaskPathByRoute(string path, string? route)
    {
        if (string.IsNullOrEmpty(route) || string.IsNullOrEmpty(path) || !route.Contains('/')) return path;
        var routeParts = route.Split('/');
        var any = false;
        foreach (var part in routeParts) if (RouteParam().IsMatch(part)) { any = true; break; }
        if (!any) return path;
        var query = path.IndexOfAny(['?', '#']);
        var pathname = query == -1 ? path : path.Substring(0, query);
        var rest = query == -1 ? "" : path.Substring(query);
        var parts = pathname.Split('/');
        var changed = false;
        for (var i = 0; i < Math.Min(parts.Length, routeParts.Length); i++)
        {
            var param = RouteParam().Match(routeParts[i]);
            if (!param.Success) continue;
            var name = param.Groups[1].Success ? param.Groups[1].Value : param.Groups[2].Value;
            if (name.Length > 0 && parts[i].Length > 0 && parts[i] != Redacted && Keys.IsSensitiveKey(name))
            {
                parts[i] = Redacted;
                changed = true;
            }
        }
        return changed ? string.Join('/', parts) + rest : path;
    }

    public static string MaskEndpoint(string text) => EndpointUserinfo().Replace(Value.RedactValue(text), m =>
        m.Groups[2].Value == Redacted ? m.Value : m.Groups[1].Value + ":" + Redacted + "@", 1);
}
