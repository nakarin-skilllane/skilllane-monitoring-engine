// ClickHouse writer (clickhouse-writer.ts): rows buffered per table, one insert in flight per table
// (a Channel<Batch> per table, read by one loop), flushed at ENGINE_FLUSH_ROWS rows or ENGINE_FLUSH_MS
// after the first buffered row. Every enqueue gets a task that completes once its rows are in ClickHouse
// and faults when the insert failed. Backpressure: 4 × flushRows rows waiting = saturated (HTTP answers
// 503, the Kafka consumer waits). Insert = POST /?query=INSERT INTO db.table FORMAT JSONEachRow, gzip body.
using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Channels;

namespace Ingest;

public sealed record WriterOptions(string ClickhouseUrl, string User, string Password, string Database, int FlushRows, int FlushMs);

public sealed class ClickhouseWriter
{
    private sealed class Batch
    {
        public List<string> Rows = new();
        public List<TaskCompletionSource> Waiters = new();
    }

    private sealed class Table
    {
        public required string Name;
        public readonly Channel<Batch> Channel = System.Threading.Channels.Channel.CreateUnbounded<Batch>(new UnboundedChannelOptions { SingleReader = true });
        public readonly object Lock = new();
        public Batch Open = new();
        public int Waiting; // rows in the open batch and in sealed batches not yet inserted
        public CancellationTokenSource? Timer;
        public TaskCompletionSource Drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task? Loop;
    }

    private readonly WriterOptions _options;
    private readonly HttpClient _http;
    private readonly IngestStats _stats;
    private readonly Dictionary<string, Table> _tables;
    private readonly int _highWater;
    private readonly string _auth;
    private volatile bool _closed;
    private long _lastErrorLog;

    public ClickhouseWriter(WriterOptions options, HttpClient http, IngestStats stats)
    {
        _options = options;
        _http = http;
        _stats = stats;
        _highWater = options.FlushRows * 4;
        _auth = Convert.ToBase64String(Encoding.UTF8.GetBytes(options.User + ":" + options.Password));
        _tables = new Dictionary<string, Table>
        {
            ["logs"] = new Table { Name = "logs" },
            ["spans"] = new Table { Name = "spans" },
        };
        foreach (var table in _tables.Values) table.Loop = Task.Run(() => LoopAsync(table));
    }

    public int Buffered(string table) { lock (_tables[table].Lock) return _tables[table].Waiting; }

    /// <summary>At the backpressure mark: an enqueue now would wait (HTTP ingest answers 503 instead).</summary>
    public bool Saturated(string table) => _closed || Buffered(table) >= _highWater;

    public async Task WaitForRoomAsync(string table, CancellationToken ct)
    {
        var t = _tables[table];
        while (true)
        {
            Task drained;
            lock (t.Lock)
            {
                if (_closed) throw new InvalidOperationException("ClickhouseWriter is closed");
                if (t.Waiting < _highWater) return;
                drained = t.Drained.Task;
            }
            await drained.WaitAsync(ct);
        }
    }

    /// <summary>Completes once `rows` are in ClickHouse; faults when their insert failed.</summary>
    public Task EnqueueAsync(string table, List<string> rows)
    {
        if (rows.Count == 0) return Task.CompletedTask;
        if (_closed) return Task.FromException(new InvalidOperationException("ClickhouseWriter is closed"));
        var t = _tables[table];
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (t.Lock)
        {
            t.Open.Rows.AddRange(rows);
            t.Open.Waiters.Add(done);
            t.Waiting += rows.Count;
            if (t.Open.Rows.Count >= _options.FlushRows) SealLocked(t);
            else if (t.Timer == null)
            {
                var cts = new CancellationTokenSource();
                t.Timer = cts;
                _ = Task.Delay(_options.FlushMs, cts.Token).ContinueWith(_ =>
                {
                    lock (t.Lock)
                    {
                        if (t.Timer != cts) return;
                        t.Timer = null;
                        SealLocked(t);
                    }
                }, TaskContinuationOptions.OnlyOnRanToCompletion);
            }
        }
        return done.Task;
    }

    private void SealLocked(Table t)
    {
        if (t.Timer != null) { t.Timer.Cancel(); t.Timer = null; }
        if (t.Open.Rows.Count == 0) return;
        var batch = t.Open;
        t.Open = new Batch();
        t.Channel.Writer.TryWrite(batch);
    }

    /// <summary>Starts an insert of everything buffered for `table`.</summary>
    public void Flush(string table) { var t = _tables[table]; lock (t.Lock) SealLocked(t); }

    /// <summary>Inserts every buffered row of every table; completes when nothing is left.</summary>
    public async Task FlushAllAsync()
    {
        while (true)
        {
            var pending = new List<Task>();
            foreach (var t in _tables.Values)
            {
                lock (t.Lock)
                {
                    SealLocked(t);
                    if (t.Waiting > 0) pending.Add(t.Drained.Task);
                }
            }
            if (pending.Count == 0) return;
            await Task.WhenAll(pending.Select(p => p.ContinueWith(_ => { })));
        }
    }

    /// <summary>Final flush on shutdown; later enqueues fault.</summary>
    public async Task CloseAsync()
    {
        await FlushAllAsync();
        _closed = true;
        foreach (var t in _tables.Values)
        {
            t.Channel.Writer.TryComplete();
            lock (t.Lock) t.Drained.TrySetResult();
        }
        await Task.WhenAll(_tables.Values.Select(t => t.Loop!));
    }

    private async Task LoopAsync(Table t)
    {
        var reader = t.Channel.Reader;
        while (await reader.WaitToReadAsync())
        {
            if (!reader.TryRead(out var batch)) continue;
            // Everything sealed meanwhile goes into this insert (Node: one insert of all that buffered during the last one).
            while (reader.TryRead(out var more))
            {
                batch.Rows.AddRange(more.Rows);
                batch.Waiters.AddRange(more.Waiters);
            }
            await InsertAsync(t, batch);
            lock (t.Lock)
            {
                t.Waiting -= batch.Rows.Count;
                var drained = t.Drained;
                t.Drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                drained.TrySetResult();
            }
        }
    }

    private async Task InsertAsync(Table t, Batch batch)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            await PostAsync(t.Name, batch.Rows);
            _stats.Inserted(t.Name, batch.Rows.Count, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            foreach (var w in batch.Waiters) w.TrySetResult();
        }
        catch (Exception e)
        {
            _stats.InsertFailed(t.Name);
            var error = new InvalidOperationException($"ClickHouse insert into {t.Name} failed: {e.Message}");
            var now = Environment.TickCount64;
            if (now - Interlocked.Read(ref _lastErrorLog) > 5000)
            {
                Interlocked.Exchange(ref _lastErrorLog, now);
                Console.WriteLine($"[error] Insert of {batch.Rows.Count} rows into {t.Name} failed: {e.Message}");
            }
            foreach (var w in batch.Waiters) w.TrySetException(error);
        }
    }

    private async Task PostAsync(string table, List<string> rows)
    {
        var body = new MemoryStream(rows.Count * 512);
        using (var gzip = new GZipStream(body, CompressionLevel.Optimal, leaveOpen: true))
        using (var text = new StreamWriter(gzip, new UTF8Encoding(false), 65536, leaveOpen: true))
        {
            foreach (var row in rows)
            {
                text.Write(row);
                text.Write('\n');
            }
        }
        body.Position = 0;
        var query = Uri.EscapeDataString($"INSERT INTO {_options.Database}.{table} FORMAT JSONEachRow");
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_options.ClickhouseUrl.TrimEnd('/')}/?query={query}&date_time_input_format=best_effort");
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", _auth);
        request.Content = new StreamContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        request.Content.Headers.ContentEncoding.Add("gzip");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"{(int)response.StatusCode} {detail.Trim()}");
        }
    }
}
