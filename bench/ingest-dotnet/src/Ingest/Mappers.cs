// Port of apps/engine/src/ingest/mappers.ts (and the attribute split of span-io.ts): envelope items →
// ClickHouse rows as JSONEachRow lines. Same helpers (str / uint / float / stringArray / stringMap /
// first / pathOf / resourceColumns), same fallbacks, same places where the mask rules apply.
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Ingest.Mask;

namespace Ingest;

public static partial class Mappers
{
    private const string Redacted = Keys.Redacted;
    public const int DbStatementMax = 2000;
    public const int FallbackMaxBytes = 262_144;

    [GeneratedRegex(@"^[a-z][a-z0-9+.-]*://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SchemeStart();
    [GeneratedRegex(@"^[a-z][a-z0-9+.-]*://[^/?#]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SchemeAuthority();
    [GeneratedRegex(@"^[0-9]{1,30}$")]
    private static partial Regex Nanos();
    [GeneratedRegex(@"^[0-9]+$")]
    private static partial Regex Digits();

    // ---------- small value helpers (mappers.ts) ----------

    public static string Str(object? value) => Js.Str(value);

    private static double ToNumber(object? value) => value switch
    {
        double d => d,
        null => 0,
        Undefined => double.NaN,
        bool b => b ? 1 : 0,
        string s => Js.ToNumber(s),
        List<object?> list => Js.ToNumber(string.Join(',', list.Select(v => Js.IsNullish(v) ? "" : Str(v)))),
        _ => double.NaN,
    };

    /// <summary>Non-negative integer clamped to `max` (UInt16 / UInt8 columns).</summary>
    public static long Uint(object? value, long max = 65535)
    {
        var n = value is double d ? d : Js.ParseInt(Str(value));
        if (!double.IsFinite(n) || n < 0) return 0;
        return (long)Math.Min(Math.Truncate(n), max);
    }

    public static double? Float(object? value)
    {
        if (Js.IsNullish(value) || value is "") return null;
        var n = value is double d ? d : ToNumber(value);
        return double.IsFinite(n) ? n : null;
    }

    public static List<string> StringArray(object? value)
    {
        if (Js.IsNullish(value) || value is "") return [];
        if (value is List<object?> list) return list.Where(v => !Js.IsNullish(v)).Select(Str).ToList();
        return [Str(value)];
    }

    /// <summary>Map(String, String): strings as is, anything else JSON-encoded.</summary>
    public static JsObject StringMap(object? value)
    {
        var @out = new JsObject();
        if (value is JsObject obj)
        {
            foreach (var (key, v) in obj.Entries()) if (v is not Undefined) @out.Set(key, Str(v));
        }
        else if (value is List<object?> list)
        {
            for (var i = 0; i < list.Count; i++) @out.Set(i.ToString(CultureInfo.InvariantCulture), Str(list[i]));
        }
        return @out;
    }

    public static object? First(params object?[] values)
    {
        foreach (var v in values) if (!Js.IsNullish(v) && v is not "") return v;
        return Undefined.Value;
    }

    /// <summary>Path of a URL or of a request target; never the query string or fragment.</summary>
    public static string PathOf(object? value)
    {
        var raw = Str(value);
        if (raw.Length == 0) return "";
        var path = raw;
        if (SchemeStart().IsMatch(raw))
        {
            try { path = new Uri(raw, UriKind.Absolute).AbsolutePath; }
            catch (UriFormatException) { path = SchemeAuthority().Replace(raw, "", 1); }
        }
        var cut = path.IndexOfAny(['?', '#']);
        return cut == -1 ? path : path.Substring(0, cut);
    }

    private static object? Prop(object? o, string key) => o is JsObject obj ? obj.Get(key) : Undefined.Value;

    // ---------- resource ----------

    public static bool MaskedBySender(JsObject resource)
    {
        var version = ToNumber(resource.Get(Keys.MaskResourceKey));
        return double.IsFinite(version) && version >= Keys.MaskVersion;
    }

    private static void WriteResourceColumns(RowWriter w, JsObject resource, JsObject? record)
    {
        var recordService = Str(Prop(record, "service.name"));
        var slash = recordService.IndexOf('/');
        var env = Str(First(resource.Get("deployment.environment.name"), Prop(record, "service.environment")));
        w.Str("env", env.Length > 0 ? env : "unknown");
        w.Str("service", Str(First(resource.Get("service.name"), slash >= 0 ? recordService.Substring(0, slash) : recordService)));
        w.Str("role", Str(First(resource.Get("app.role"), slash >= 0 ? recordService.Substring(slash + 1) : Undefined.Value)));
        w.Str("version", Str(First(resource.Get("service.version"), Prop(record, "service.version"))));
        w.Str("host", Str(First(resource.Get("host.name"), Prop(record, "host.name"))));
    }

    // ---------- time ----------

    /// <summary>nanosToDateTime64 of the contract: "YYYY-MM-DD HH:MM:SS.ffffff" (UTC).</summary>
    public static string NanosToDateTime64(Int128 nanos, int digits)
    {
        var ms = nanos / 1_000_000;
        var iso = Js.ToIsoString((double)ms);
        var fraction = (nanos % 1_000_000_000).ToString(CultureInfo.InvariantCulture).PadLeft(9, '0');
        fraction = fraction.Substring(0, Math.Min(digits, fraction.Length));
        return iso.Substring(0, 10) + " " + iso.Substring(11, 8) + (digits > 0 ? "." + fraction : "");
    }

    /// <summary>ISO text → DateTime64(3) text; falls back when the value does not parse.</summary>
    private static string LogTimestamp(object? value, string fallbackIso)
    {
        var iso = Str(value);
        var parsed = iso.Length > 0 && double.IsFinite(Js.DateParse(iso)) ? iso : fallbackIso;
        var ms = Js.DateParse(parsed);
        var nanos = (Int128)(double.IsFinite(ms) ? ms : 0) * 1_000_000;
        return NanosToDateTime64(nanos, 3);
    }

    private static int JobFinal(object? value) => value is true || value is 1.0 || value is "true" || value is "1" ? 1 : 0;

    // ---------- logs ----------

    private static readonly HashSet<string> LogColumnKeys =
    [
        "@timestamp", "service.name", "service.version", "service.environment", "host.name", "log.level", "log.logger",
        "event.code", "event.module", "message", "trace.id", "span.id", "user.id", "user.roles", "organization.id",
        "http.request.method", "http.route", "url.path", "url.domain", "http.response.status_code", "duration_ms",
        "error.type", "error.code", "error.message", "error.hint", "error.detail", "error.how_to_fix", "error.stack_trace",
        "error.cause", "log.origin.function", "log.origin.file.name", "db.statement", "dependency.type", "dependency.name",
        "dependency.host", "dependency.port", "job.queue", "job.type", "job.id", "job.attempt", "job.max_attempts",
        "job.final", "job.inflight", "reason", "labels",
    ];

    private static readonly string[] LabelColumns = ["error_category", "error_target", "usecase", "failed_step"];
    private static readonly string[] TextKeys = ["message", "error.message", "error.stack_trace", "error.hint", "error.detail", "error.how_to_fix", "reason"];

    /// <summary>A log record from a sender that did not mask it: the SDK's redactRecord rules, on a copy.</summary>
    private static JsObject MaskLogRecord(JsObject r)
    {
        var @out = r.ShallowCopy();
        void TextOf(string key, Func<string, string> mask) { if (@out.Get(key) is string s) @out.Set(key, mask(s)); }
        foreach (var key in TextKeys) TextOf(key, Value.RedactText);
        TextOf("db.statement", Sql.MaskSql);
        TextOf("user.id", s => Value.RedactValue(s));
        TextOf("url.domain", s => Value.RedactValue(s));
        TextOf("job.id", Redis.MaskIdentifier);
        TextOf("dependency.name", Web.MaskEndpoint);
        TextOf("dependency.host", Web.MaskEndpoint);
        if (@out.Get("url.path") is string urlPath)
        {
            var path = Value.StripQuery(urlPath);
            @out.Set("url.path", Web.MaskPathByRoute(Value.RedactValue(path), @out.Get("http.route") as string));
        }
        var cause = @out.Get("error.cause");
        if (cause is not Undefined) @out.Set("error.cause", Value.MaskJsonText(cause is string cs ? cs : Js.Stringify(cause)));
        return @out;
    }

    public static string MapLog(JsObject item, JsObject resource, string sentAt)
    {
        var masked = MaskedBySender(resource);
        var r = masked ? item : MaskLogRecord(item);
        var labels = StringMap(r.Get("labels"));
        // The key rule on every label, whoever sent it; the value rule for other senders.
        foreach (var (key, value) in labels.Entries().ToList())
            labels.Set(key, Keys.IsSensitiveKey(key) ? Redacted : masked ? (string)value! : Value.RedactText((string)value!));
        var labelColumns = new Dictionary<string, string>(4);
        foreach (var key in LabelColumns)
        {
            labelColumns[key] = labels.Get(key) is string s ? s : "";
            labels.Remove(key);
        }
        var fields = new JsObject();
        foreach (var (key, value) in r.Entries())
        {
            if (LogColumnKeys.Contains(key) || value is Undefined) continue;
            fields.Set(key, masked ? Str(value) : Keys.IsSensitiveKey(key) ? Redacted : Value.RedactValue(Str(value)));
        }
        var fallbackIso = double.IsFinite(Js.DateParse(sentAt)) ? sentAt : Js.ToIsoString(Math.Floor((DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds));
        var w = new RowWriter();
        w.Str("timestamp", LogTimestamp(r.Get("@timestamp"), fallbackIso));
        WriteResourceColumns(w, resource, r);
        w.Str("level", Str(r.Get("log.level")));
        w.Str("logger", Str(r.Get("log.logger")));
        w.Str("event_code", Str(r.Get("event.code")));
        w.Str("event_module", Str(r.Get("event.module")));
        w.Str("message", Str(r.Get("message")));
        w.Str("trace_id", Str(r.Get("trace.id")));
        w.Str("span_id", Str(r.Get("span.id")));
        w.Str("correlation_id", labels.Get("correlation_id") is string cid ? cid : "");
        w.Str("user_id", Str(r.Get("user.id")));
        w.Arr("user_roles", StringArray(r.Get("user.roles")));
        w.Str("organization_id", Str(r.Get("organization.id")));
        w.Str("http_method", Str(r.Get("http.request.method")));
        w.Str("http_route", Str(r.Get("http.route")));
        w.Str("url_path", Str(r.Get("url.path")));
        w.Str("url_domain", Str(r.Get("url.domain")));
        w.Int("http_status", Uint(r.Get("http.response.status_code")));
        w.NullableNum("duration_ms", Float(r.Get("duration_ms")));
        w.Str("error_type", Str(r.Get("error.type")));
        w.Str("error_code", Str(r.Get("error.code")));
        w.Str("error_message", Str(r.Get("error.message")));
        w.Str("error_hint", Str(r.Get("error.hint")));
        w.Str("error_detail", Str(r.Get("error.detail")));
        w.Str("error_how_to_fix", Str(r.Get("error.how_to_fix")));
        w.Str("error_stack", Str(r.Get("error.stack_trace")));
        w.Str("error_cause", Str(r.Get("error.cause")));
        w.Str("error_category", labelColumns["error_category"]);
        w.Str("error_target", labelColumns["error_target"]);
        w.Str("usecase", labelColumns["usecase"]);
        w.Str("failed_step", labelColumns["failed_step"]);
        w.Str("origin_function", Str(r.Get("log.origin.function")));
        w.Str("origin_file", Str(r.Get("log.origin.file.name")));
        w.Str("db_statement", Str(r.Get("db.statement")));
        w.Str("dependency_type", Str(r.Get("dependency.type")));
        w.Str("dependency_name", Str(r.Get("dependency.name")));
        w.Str("dependency_host", Str(r.Get("dependency.host")));
        w.Int("dependency_port", Uint(r.Get("dependency.port")));
        w.Str("job_queue", Str(r.Get("job.queue")));
        w.Str("job_type", Str(r.Get("job.type")));
        w.Str("job_id", Str(r.Get("job.id")));
        w.Int("job_attempt", Uint(r.Get("job.attempt")));
        w.Int("job_max_attempts", Uint(r.Get("job.max_attempts")));
        w.Int("job_final", JobFinal(r.Get("job.final")));
        w.Arr("job_inflight", StringArray(r.Get("job.inflight")));
        w.Str("reason", Str(r.Get("reason")));
        w.Map("labels", labels);
        w.Map("fields", fields);
        return w.Finish();
    }

    // ---------- spans ----------

    private static readonly HashSet<string> IoKeys =
    [
        "url.query", "http.request.headers", "http.response.headers", "http.request.body", "http.response.body",
        "http.request.body.size", "http.response.body.size", "http.request.body.truncated", "http.response.body.truncated",
        "skilllane.monitoring.db.parameters", "db.statement.parameters", "db.postgresql.values", "messaging.message.body",
        "messaging.message.body.size", "messaging.message.body.truncated", "messaging.message.headers",
    ];
    private const string QueryParameter = "db.query.parameter.";
    private const string OperationParameter = "db.operation.parameter.";
    private const string RequestHeader = "http.request.header.";
    private const string ResponseHeader = "http.response.header.";
    private static readonly HashSet<string> UrlAttributes = ["url.full", "http.url", "http.target"];
    private static readonly HashSet<string> IdAttributes = ["job.id", "messaging.message.id", "messaging.message.conversation_id", "messaging.kafka.message.key"];

    /// <summary>One attribute of a sender that did not mask: URLs by their query, ids by their segments, the rest by key and value.</summary>
    public static string MaskAttributeText(string key, string value, string? route = null)
    {
        if (UrlAttributes.Contains(key)) return key == "http.target" ? Web.MaskPathByRoute(Web.MaskUrl(value), route) : Web.MaskUrl(value);
        if (key == "url.path") return Web.MaskPathByRoute(Value.RedactValue(value), route);
        if (Keys.IsSensitiveKey(key)) return Redacted;
        if (IdAttributes.Contains(key)) return Redis.MaskIdentifier(value);
        return Value.RedactValue(value);
    }

    private static string PeerOf(JsObject attrs)
    {
        var host = Str(First(attrs.Get("server.address"), attrs.Get("net.peer.name")));
        if (host.Length == 0) return "";
        var port = Str(First(attrs.Get("server.port"), attrs.Get("net.peer.port")));
        return port.Length > 0 ? host + ":" + port : host;
    }

    private static string UrlPathOf(JsObject attrs)
    {
        var direct = attrs.Get("url.path");
        if (direct is not Undefined && direct is not "") return PathOf(direct);
        var target = attrs.Get("http.target");
        if (target is not Undefined && target is not "") return PathOf(target);
        return PathOf(First(attrs.Get("url.full"), attrs.Get("http.url")));
    }

    /// <summary>Binds in skilllane.monitoring.db.parameters, leaving out the SDK's last `{ key: '…' }` cut marker.</summary>
    private static int ParamCountOf(object? value)
    {
        if (value is not List<object?> list) return 0;
        var binds = list.Count(p => !(p is JsObject o && o.Get("key") is "…"));
        return Math.Min(binds, 65535);
    }

    /// <summary>The number of binds `db_params` would list (the JSON itself is an I/O column the prototypes leave out).</summary>
    private static int DbParamCount(JsObject io, int perKeyParams)
    {
        var sdkParams = Str(io.Get("skilllane.monitoring.db.parameters"));
        if (sdkParams.Length > 0)
        {
            try { return ParamCountOf(Js.Parse(sdkParams)); }
            catch (System.Text.Json.JsonException) { return 0; }
        }
        if (perKeyParams > 0) return Math.Min(perKeyParams, 65535);
        if (io.Get("db.statement.parameters") is not Undefined)
        {
            try
            {
                var parsed = Js.Parse(Str(io.Get("db.statement.parameters")));
                return parsed is List<object?> l ? Math.Min(l.Count, 65535) : parsed is JsObject o ? Math.Min(o.Count, 65535) : 0;
            }
            catch (System.Text.Json.JsonException) { return 0; }
        }
        if (io.Get("db.postgresql.values") is List<object?> values) return Math.Min(values.Count, 65535);
        return 0;
    }

    /// <summary>Events of a sender that did not mask: every attribute by the key rule and the value rule (exception text too).</summary>
    private static List<object?> MaskEvents(List<object?> events)
    {
        var @out = new List<object?>(events.Count);
        foreach (var e in events)
        {
            if (e is not JsObject ev || !Js.Truthy(ev.Get("attributes"))) { @out.Add(e); continue; }
            var attributes = new JsObject();
            foreach (var (key, value) in StringMapEntries(ev.Get("attributes")))
            {
                attributes.Set(key, value switch
                {
                    string s => MaskAttributeText(key, s),
                    List<object?> list => list.Select(v => v is string vs ? (object?)MaskAttributeText(key, vs) : v).ToList(),
                    _ => Keys.IsSensitiveKey(key) ? Redacted : value,
                });
            }
            var copy = ev.ShallowCopy();
            copy.Set("attributes", attributes);
            @out.Add(copy);
        }
        return @out;
    }

    /// <summary>Object.entries of a truthy value: an object's entries, an array's index entries, nothing for the rest.</summary>
    private static IEnumerable<KeyValuePair<string, object?>> StringMapEntries(object? value)
    {
        if (value is JsObject obj) return obj.Entries();
        if (value is List<object?> list) return list.Select((v, i) => new KeyValuePair<string, object?>(i.ToString(CultureInfo.InvariantCulture), v));
        if (value is string s) return s.Select((c, i) => new KeyValuePair<string, object?>(i.ToString(CultureInfo.InvariantCulture), c.ToString()));
        return [];
    }

    /// <summary>Throws when the item cannot become a row (missing ids or bad times).</summary>
    public static string MapSpan(JsObject item, JsObject resource)
    {
        if (!Js.Truthy(item.Get("traceId")) || !Js.Truthy(item.Get("spanId"))) throw new InvalidDataException("span item without traceId/spanId");
        var start = Str(item.Get("startTimeUnixNano"));
        var end = Str(item.Get("endTimeUnixNano"));
        if (end.Length == 0) end = start;
        if (!Nanos().IsMatch(start) || !Nanos().IsMatch(end))
            throw new InvalidDataException($"span {Str(item.Get("spanId"))}: start/end time is not a nanosecond decimal string");
        var attrs = item.Get("attributes") is JsObject a ? a : new JsObject();
        var masked = MaskedBySender(resource);
        var dbSystem = Str(First(attrs.Get("db.system.name"), attrs.Get("db.system")));
        var rawStatement = Str(First(attrs.Get("db.query.text"), attrs.Get("db.statement")));
        var statement = masked || rawStatement.Length == 0 ? rawStatement : Io.MaskStatement(rawStatement, dbSystem, FallbackMaxBytes);

        // splitSpanAttributes: the attributes map (I/O keys leave it), db_statement_full, db_param_count
        var route = attrs.Get("http.route") as string;
        var attributes = new JsObject();
        var io = new JsObject();
        var perKeyParams = 0;
        foreach (var (key, value) in attrs.Entries())
        {
            if (value is Undefined) continue;
            if (IoKeys.Contains(key)) { io.Set(key, value); continue; }
            if (key.StartsWith("db.", StringComparison.Ordinal))
            {
                if (key.StartsWith(QueryParameter, StringComparison.Ordinal) || key.StartsWith(OperationParameter, StringComparison.Ordinal)) { perKeyParams++; continue; }
                if (key == "db.query.text" || key == "db.statement") continue;
            }
            else if (key.StartsWith("http.", StringComparison.Ordinal))
            {
                if (key.StartsWith(RequestHeader, StringComparison.Ordinal) || key.StartsWith(ResponseHeader, StringComparison.Ordinal)) continue;
            }
            attributes.Set(key, masked ? Str(value) : MaskAttributeText(key, Str(value), route));
        }

        var eventsValue = item.Get("events");
        List<object?> rawEvents = Js.IsNullish(eventsValue) ? [] : eventsValue as List<object?> ?? throw new InvalidDataException("span events is not an array");
        var events = masked ? rawEvents : MaskEvents(rawEvents);
        JsObject? exception = null;
        foreach (var e in events) if (e is JsObject ev && ev.Get("name") is "exception") { exception = ev; break; }
        var exAttrs = exception?.Get("attributes") as JsObject;
        var parent = Str(item.Get("parentSpanId"));
        var httpRoute = Str(attrs.Get("http.route"));
        var urlPath = UrlPathOf(attrs);
        string Text(object? value) => masked ? Str(value) : Value.RedactValue(Str(value));

        var startNanos = Int128.Parse(start, CultureInfo.InvariantCulture);
        var endNanos = Int128.Parse(end, CultureInfo.InvariantCulture);
        var duration = endNanos - startNanos;
        if (duration < 0) duration = 0;
        var statusCode = Str(Prop(item.Get("status"), "code"));

        var w = new RowWriter();
        w.Str("timestamp", NanosToDateTime64(startNanos, 6));
        w.Num("duration_ns", (double)duration);
        WriteResourceColumns(w, resource, null);
        w.Str("trace_id", Str(item.Get("traceId")));
        w.Str("span_id", Str(item.Get("spanId")));
        w.Str("parent_span_id", parent);
        w.Int("is_entry", parent.Length == 0 || item.Get("parentIsRemote") is true ? 1 : 0);
        w.Str("name", Text(item.Get("name")));
        w.Str("kind", Str(item.Get("kind")));
        w.Str("status_code", statusCode.Length > 0 ? statusCode : "UNSET");
        w.Str("status_message", Text(Prop(item.Get("status"), "message")));
        w.Str("scope_name", Str(Prop(item.Get("scope"), "name")));
        w.Str("http_method", Str(First(attrs.Get("http.request.method"), attrs.Get("http.method"))));
        w.Str("http_route", httpRoute);
        w.Int("http_status", Uint(First(attrs.Get("http.response.status_code"), attrs.Get("http.status_code"))));
        w.Str("url_path", masked ? urlPath : Web.MaskPathByRoute(Value.RedactValue(urlPath), httpRoute));
        w.Str("db_system", dbSystem);
        w.Str("db_statement", statement.Length > DbStatementMax ? statement.Substring(0, DbStatementMax) : statement);
        w.Str("peer", PeerOf(attrs));
        w.Str("exception_type", Str(Prop(exAttrs, "exception.type")));
        w.Str("exception_message", Str(Prop(exAttrs, "exception.message")));
        w.Map("attributes", attributes);
        w.Map("resource", StringMap(resource));
        w.Str("events", Js.Stringify(events));
        w.Str("db_statement_full", statement.Length > DbStatementMax ? statement : "");
        w.Int("db_param_count", DbParamCount(io, perKeyParams));
        return w.Finish();
    }
}

/// <summary>One JSONEachRow line, written in column order.</summary>
public sealed class RowWriter
{
    private readonly StringBuilder _sb = new(1024);
    private bool _first = true;

    public RowWriter() { _sb.Append('{'); }

    private void Key(string key)
    {
        if (!_first) _sb.Append(',');
        _first = false;
        _sb.Append('"').Append(key).Append("\":");
    }

    public void Str(string key, string value) { Key(key); Js.WriteString(_sb, value); }
    public void Int(string key, long value) { Key(key); _sb.Append(value.ToString(CultureInfo.InvariantCulture)); }
    public void Num(string key, double value) { Key(key); _sb.Append(Js.NumberToString(value)); }
    public void NullableNum(string key, double? value) { Key(key); _sb.Append(value.HasValue ? Js.NumberToString(value.Value) : "null"); }

    public void Arr(string key, List<string> values)
    {
        Key(key);
        _sb.Append('[');
        for (var i = 0; i < values.Count; i++)
        {
            if (i > 0) _sb.Append(',');
            Js.WriteString(_sb, values[i]);
        }
        _sb.Append(']');
    }

    public void Map(string key, JsObject map)
    {
        Key(key);
        _sb.Append('{');
        var first = true;
        foreach (var (k, v) in map.Entries())
        {
            if (!first) _sb.Append(',');
            first = false;
            Js.WriteString(_sb, k);
            _sb.Append(':');
            Js.WriteString(_sb, (string)v!);
        }
        _sb.Append('}');
    }

    public string Finish() => _sb.Append('}').ToString();
}
