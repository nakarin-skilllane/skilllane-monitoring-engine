// A v1 envelope (`{ v: 1, stream, resource, sentAt, items }`) as parseEnvelope of the contract reads it,
// and the message → rows step shared by HTTP and Kafka (envelope-handler.ts).
using System.Text.Json;

namespace Ingest;

/// <summary>Thrown for a message that is not a v1 envelope: skip it, never retry it.</summary>
public sealed class BadEnvelopeException(string message) : Exception(message);

public sealed class Envelope
{
    public required string Stream { get; init; }
    public required JsObject Resource { get; init; }
    public required string SentAt { get; init; }
    public required List<object?> Items { get; init; }
}

public static class EnvelopeParser
{
    private static readonly JsonDocumentOptions Options = new() { MaxDepth = 1024 };

    public static Envelope Parse(ReadOnlyMemory<byte> json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json, Options); }
        catch (JsonException e) { throw new BadEnvelopeException("Unexpected token: " + e.Message); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var version) || version != 1 ||
                !root.TryGetProperty("stream", out var stream) || stream.ValueKind != JsonValueKind.String ||
                (stream.GetString() is not ("logs" or "spans")) ||
                !root.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array ||
                !root.TryGetProperty("resource", out var resource) || resource.ValueKind != JsonValueKind.Object ||
                !resource.TryGetProperty("service.name", out var service) || service.ValueKind != JsonValueKind.String)
            {
                throw new BadEnvelopeException("Not an skilllane-monitoring-contract v1 envelope");
            }
            var sentAt = root.TryGetProperty("sentAt", out var s) ? Js.Str(Js.ToTree(s)) : "";
            return new Envelope
            {
                Stream = stream.GetString()!,
                Resource = (JsObject)Js.ToTree(resource)!,
                SentAt = sentAt,
                Items = (List<object?>)Js.ToTree(items)!,
            };
        }
    }
}

/// <summary>Envelope → rows → ClickhouseWriter; the returned task settles when the rows are inserted.</summary>
public sealed class EnvelopeHandler(ClickhouseWriter writer, IngestStats stats)
{
    public Envelope Parse(ReadOnlyMemory<byte> raw, string source)
    {
        stats.Messages.Increment();
        try { return EnvelopeParser.Parse(raw); }
        catch (BadEnvelopeException e)
        {
            stats.BadEnvelope(source, e.Message);
            throw;
        }
    }

    public void Map(Envelope envelope, List<string> logs, List<string> spans)
    {
        if (envelope.Stream == "logs")
        {
            foreach (var item in envelope.Items)
            {
                try
                {
                    if (item is not JsObject record) throw new InvalidDataException("log item is not an object");
                    logs.Add(Mappers.MapLog(record, envelope.Resource, envelope.SentAt));
                }
                catch (Exception e) when (e is not OutOfMemoryException) { stats.BadItem("logs", e.Message); }
            }
        }
        else
        {
            foreach (var item in envelope.Items)
            {
                try
                {
                    if (item is not JsObject record) throw new InvalidDataException("span item is not an object");
                    spans.Add(Mappers.MapSpan(record, envelope.Resource));
                }
                catch (Exception e) when (e is not OutOfMemoryException) { stats.BadItem("spans", e.Message); }
            }
        }
    }

    /// <summary>Writes the rows of several envelopes; completes once all of them are inserted.</summary>
    public async Task WriteAsync(IEnumerable<Envelope> envelopes)
    {
        var logs = new List<string>();
        var spans = new List<string>();
        foreach (var envelope in envelopes) Map(envelope, logs, spans);
        await Task.WhenAll(writer.EnqueueAsync("logs", logs), writer.EnqueueAsync("spans", spans));
    }
}
