// Port of skilllane-monitoring/contract/mask/io.js: maskBodyText, maskHeaderJson, maskStatement.
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ingest.Mask;

public static partial class Io
{
    [GeneratedRegex("redis", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RedisSystem();

    private static char? FirstChar(string text)
    {
        foreach (var c in text) if (c > ' ' && c != '\ufeff') return c;
        return null;
    }

    public static string MaskBodyText(string value, int maxBytes)
    {
        var (text, truncated) = Value.TruncateUtf8(value, maxBytes);
        var first = FirstChar(text);
        var masked = first is '{' or '['
            ? Value.MaskJsonText(text, !truncated)
            : first == '<'
                ? Value.RedactValue(Web.MaskMarkup(text))
                : Value.RedactValue(text);
        return Value.TruncateUtf8(masked, maxBytes).Text;
    }

    public static string MaskHeaderJson(string text, bool lowerCase, int maxBytes)
    {
        try
        {
            if (Js.Parse(text) is JsObject parsed)
                return Value.TruncateUtf8(Js.Stringify(Web.MaskHeaders(parsed, lowerCase)), maxBytes).Text;
        }
        catch (JsonException)
        {
            // not JSON: masked as a body below
        }
        return Value.TruncateUtf8(MaskBodyText(text, maxBytes), maxBytes).Text;
    }

    public static string MaskStatement(string statement, string system, int maxBytes)
    {
        var (text, truncated) = Value.TruncateUtf8(statement, maxBytes);
        if (RedisSystem().IsMatch(system)) return Value.TruncateUtf8(Value.RedactValue(text), maxBytes).Text;
        var first = FirstChar(text);
        if (first is '{' or '[') return Value.TruncateUtf8(Value.MaskJsonText(text, !truncated), maxBytes).Text;
        return Value.TruncateUtf8(Sql.MaskSql(text), maxBytes).Text;
    }
}
