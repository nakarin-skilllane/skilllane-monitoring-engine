// bench/ingest-dotnet: the ingest hot path of apps/engine as a stand-alone ASP.NET Core (Kestrel) service.
// POST /api/ingest/{logs|spans} (one envelope, optional gzip) → rows → ClickHouse; 202 once inserted.
// Optional Kafka consumer (LOG_KAFKA_BROKERS). `Ingest map-fixture <envelopes.jsonl> <logs.out> <spans.out>`
// maps a fixture file to rows without a server (used to diff against bench/fixture/expected-*.jsonl).
using System.Buffers;
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Ingest;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

const int MaxBodyBytes = 2_000_000;
const string RetryAfterSeconds = "2";

static string Env(string name, string fallback) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;
static int EnvInt(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) && v > 0 ? v : fallback;

if (args.Length >= 4 && args[0] == "map-fixture")
{
    return await Fixture.MapAsync(args[1], args[2], args[3]);
}

var port = EnvInt("PORT", 5100);
var options = new WriterOptions(
    ClickhouseUrl: Env("CLICKHOUSE_URL", "http://localhost:8123"),
    User: Env("CLICKHOUSE_USER", "default"),
    Password: Environment.GetEnvironmentVariable("CLICKHOUSE_PASSWORD") ?? "",
    Database: Env("CLICKHOUSE_DATABASE", "skilllane_monitoring"),
    FlushRows: EnvInt("ENGINE_FLUSH_ROWS", 5000),
    FlushMs: EnvInt("ENGINE_FLUSH_MS", 1000));
var maxInflight = EnvInt("ENGINE_INGEST_MAX_INFLIGHT", 64);
var brokers = Environment.GetEnvironmentVariable("LOG_KAFKA_BROKERS") ?? "";
var consumerGroup = Env("BENCH_CONSUMER_GROUP", "bench-dotnet");

var http = new HttpClient(new SocketsHttpHandler
{
    PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    MaxConnectionsPerServer = 16,
    AutomaticDecompression = DecompressionMethods.None,
})
{ Timeout = TimeSpan.FromSeconds(60) };
var stats = new IngestStats();
var writer = new ClickhouseWriter(options, http, stats);
var handler = new EnvelopeHandler(writer, stats);
var inflight = 0;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = null; // enforced below on the inflated body (2,000,000 bytes → 413)
    k.Listen(IPAddress.Any, port, l => l.Protocols = HttpProtocols.Http1);
});
var app = builder.Build();

var healthJson = JsonSerializer.Serialize(new HealthResponse(true), AppJsonContext.Default.HealthResponse);
app.MapGet("/api/health", (HttpContext ctx) =>
{
    ctx.Response.ContentType = "application/json";
    return ctx.Response.WriteAsync(healthJson);
});

app.MapPost("/api/ingest/{stream}", async (HttpContext ctx) =>
{
    var stream = ctx.Request.RouteValues["stream"] as string ?? "";
    var response = ctx.Response;
    response.ContentType = "application/json";

    // the body parser: gzip undone, 2,000,000 bytes max (413)
    byte[]? buffer = null;
    int length;
    try
    {
        var (bytes, n, tooLarge) = await ReadBodyAsync(ctx.Request);
        buffer = bytes;
        length = n;
        if (tooLarge)
        {
            await Error(response, 413, "request entity too large");
            return;
        }
    }
    catch (Exception e) when (e is InvalidDataException or IOException)
    {
        await Error(response, 400, "bad body: " + e.Message);
        return;
    }
    try
    {
        if (stream != "logs" && stream != "spans")
        {
            await Error(response, 400, $"unknown stream {stream}");
            return;
        }
        if (Volatile.Read(ref inflight) >= maxInflight || writer.Saturated(stream))
        {
            response.Headers.RetryAfter = RetryAfterSeconds;
            await Error(response, 503, "ingest is busy, retry later");
            return;
        }
        Envelope envelope;
        try { envelope = handler.Parse(new ReadOnlyMemory<byte>(buffer, 0, length), "http"); }
        catch (BadEnvelopeException e)
        {
            await Error(response, 400, e.Message);
            return;
        }
        if (envelope.Stream != stream)
        {
            await Error(response, 400, $"envelope stream {envelope.Stream} posted to /{stream}");
            return;
        }
        Interlocked.Increment(ref inflight);
        try
        {
            await handler.WriteAsync([envelope]);
        }
        catch (Exception e)
        {
            response.Headers.RetryAfter = RetryAfterSeconds;
            await Error(response, 503, "not written: " + e.Message);
            return;
        }
        finally
        {
            Interlocked.Decrement(ref inflight);
        }
        response.StatusCode = 202;
        await response.WriteAsync(JsonSerializer.Serialize(new ItemsResponse(envelope.Items.Count), AppJsonContext.Default.ItemsResponse));
    }
    finally
    {
        if (buffer != null) ArrayPool<byte>.Shared.Return(buffer);
    }
});

static Task Error(HttpResponse response, int status, string message)
{
    response.StatusCode = status;
    var sb = new StringBuilder("{\"statusCode\":").Append(status).Append(",\"message\":");
    Js.WriteString(sb, message);
    return response.WriteAsync(sb.Append('}').ToString());
}

/// <summary>The request body, inflated when Content-Encoding: gzip, in a pooled buffer; tooLarge over MaxBodyBytes.</summary>
static async Task<(byte[] Bytes, int Length, bool TooLarge)> ReadBodyAsync(HttpRequest request)
{
    var gzip = request.Headers.ContentEncoding.Any(v => v != null && v.Contains("gzip", StringComparison.OrdinalIgnoreCase));
    if (!gzip && request.ContentLength > MaxBodyBytes) return (ArrayPool<byte>.Shared.Rent(1), 0, true);
    Stream source = request.Body;
    if (gzip) source = new GZipStream(request.Body, CompressionMode.Decompress);
    var buffer = ArrayPool<byte>.Shared.Rent(gzip ? 256 * 1024 : (int)Math.Min(request.ContentLength ?? 64 * 1024, MaxBodyBytes) + 1);
    var length = 0;
    try
    {
        while (true)
        {
            if (length == buffer.Length)
            {
                if (length > MaxBodyBytes) return (buffer, length, true);
                var bigger = ArrayPool<byte>.Shared.Rent(Math.Min(buffer.Length * 2, MaxBodyBytes + 1));
                Buffer.BlockCopy(buffer, 0, bigger, 0, length);
                ArrayPool<byte>.Shared.Return(buffer);
                buffer = bigger;
            }
            var n = await source.ReadAsync(buffer.AsMemory(length));
            if (n == 0) break;
            length += n;
            if (length > MaxBodyBytes) return (buffer, length, true);
        }
        return (buffer, length, false);
    }
    finally
    {
        if (gzip) await source.DisposeAsync();
    }
}

KafkaConsumer? kafka = null;
if (brokers.Length > 0)
{
    kafka = new KafkaConsumer(brokers, consumerGroup, ["skilllane-monitoring.logs", "skilllane-monitoring.spans"], handler, writer);
    kafka.Start();
}

var statsTimer = new PeriodicTimer(TimeSpan.FromSeconds(30));
_ = Task.Run(async () =>
{
    while (await statsTimer.WaitForNextTickAsync())
        Console.WriteLine(stats.Line(writer.Buffered("logs"), writer.Buffered("spans")));
});

app.Lifetime.ApplicationStopping.Register(() =>
{
    kafka?.Stop();
    writer.CloseAsync().GetAwaiter().GetResult();
});

Console.WriteLine($"bench-ingest-dotnet listening on :{port} → {options.ClickhouseUrl} db {options.Database} (flush {options.FlushRows} rows / {options.FlushMs} ms, max inflight {maxInflight}{(brokers.Length > 0 ? $", kafka {brokers} group {consumerGroup}" : "")})");
await app.RunAsync();
return 0;

/// <summary>Dev / verification mode: maps every envelope of a .jsonl file to rows, one JSON line per row.</summary>
static class Fixture
{
    public static async Task<int> MapAsync(string envelopes, string logsOut, string spansOut)
    {
        var stats = new IngestStats();
        var handler = new EnvelopeHandler(null!, stats);
        await using var logs = new StreamWriter(logsOut, false, new UTF8Encoding(false), 1 << 20);
        await using var spans = new StreamWriter(spansOut, false, new UTF8Encoding(false), 1 << 20);
        var started = Stopwatch.GetTimestamp();
        var n = 0;
        var logRows = new List<string>();
        var spanRows = new List<string>();
        foreach (var line in File.ReadLines(envelopes))
        {
            if (line.Length == 0) continue;
            var envelope = handler.Parse(Encoding.UTF8.GetBytes(line), "fixture");
            handler.Map(envelope, logRows, spanRows);
            foreach (var row in logRows) await logs.WriteLineAsync(row);
            foreach (var row in spanRows) await spans.WriteLineAsync(row);
            logRows.Clear();
            spanRows.Clear();
            n++;
        }
        Console.WriteLine($"mapped {n} envelopes in {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F0} ms · bad envelopes {stats.BadEnvelopes.Value}, bad items {stats.BadItems.Value}");
        return 0;
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(ItemsResponse))]
internal partial class AppJsonContext : JsonSerializerContext;

internal sealed record HealthResponse(bool Ok);
internal sealed record ItemsResponse(int Items);
