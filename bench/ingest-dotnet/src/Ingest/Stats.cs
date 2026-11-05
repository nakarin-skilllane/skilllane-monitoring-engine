// Ingest counters and the stats line printed every 30 s (ingest.stats.ts).
using System.Globalization;
using System.Threading;

namespace Ingest;

public sealed class Counter
{
    private long _value;
    public long Value => Interlocked.Read(ref _value);
    public void Increment() => Interlocked.Increment(ref _value);
    public void Add(long n) => Interlocked.Add(ref _value, n);
}

public sealed class TableCounters
{
    public readonly Counter Rows = new();
    public readonly Counter Inserts = new();
    public readonly Counter Failures = new();
    private long _lastInsertMs;
    public long LastInsertMs { get => Interlocked.Read(ref _lastInsertMs); set => Interlocked.Exchange(ref _lastInsertMs, value); }
}

public sealed class IngestStats
{
    public readonly TableCounters Logs = new();
    public readonly TableCounters Spans = new();
    public readonly Counter Messages = new();
    public readonly Counter BadEnvelopes = new();
    public readonly Counter BadItems = new();
    private string? _firstBadError;
    private int _loggedBad;
    private readonly object _lock = new();
    private DateTime _lastTickAt = DateTime.UtcNow;
    private long _lastLogs, _lastSpans, _lastFailures, _lastBad;

    public TableCounters Table(string table) => table == "logs" ? Logs : Spans;

    public void Inserted(string table, int rows, long ms)
    {
        var t = Table(table);
        t.Rows.Add(rows);
        t.Inserts.Increment();
        t.LastInsertMs = ms;
    }

    public void InsertFailed(string table) => Table(table).Failures.Increment();

    public void BadEnvelope(string source, string message)
    {
        BadEnvelopes.Increment();
        NoteBad($"bad envelope from {source}", message);
    }

    public void BadItem(string stream, string message)
    {
        BadItems.Increment();
        NoteBad($"bad {stream} item", message);
    }

    private void NoteBad(string what, string message)
    {
        lock (_lock)
        {
            _firstBadError ??= $"{what}: {message}";
            if (_loggedBad < 5)
            {
                _loggedBad++;
                Console.WriteLine($"[warn] {what} skipped: {message}{(_loggedBad == 5 ? " (further ones only counted)" : "")}");
            }
        }
    }

    /// <summary>One line for stdout; `lag` comes from the consumer when cheap to read.</summary>
    public string Line(int bufferedLogs, int bufferedSpans, string? lag = null)
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            var seconds = Math.Max((now - _lastTickAt).TotalSeconds, 0.001);
            var logs = Logs.Rows.Value;
            var spans = Spans.Rows.Value;
            string Rate(long current, long last) => ((current - last) / seconds).ToString("F1", CultureInfo.InvariantCulture);
            var failures = Logs.Failures.Value + Spans.Failures.Value;
            var bad = BadEnvelopes.Value + BadItems.Value;
            var parts = new List<string>
            {
                $"logs {Rate(logs, _lastLogs)} rows/s (last insert {Logs.LastInsertMs} ms, buffered {bufferedLogs})",
                $"spans {Rate(spans, _lastSpans)} rows/s (last insert {Spans.LastInsertMs} ms, buffered {bufferedSpans})",
                $"insert failures {failures} (+{failures - _lastFailures})",
                $"bad envelopes {BadEnvelopes.Value}, bad items {BadItems.Value} (+{bad - _lastBad})",
                $"messages {Messages.Value}",
            };
            if (lag != null) parts.Add($"lag {lag}");
            if (_firstBadError != null && bad > _lastBad) parts.Add($"first bad: {_firstBadError}");
            _lastTickAt = now;
            _lastLogs = logs;
            _lastSpans = spans;
            _lastFailures = failures;
            _lastBad = bad;
            return string.Join(" · ", parts);
        }
    }
}
