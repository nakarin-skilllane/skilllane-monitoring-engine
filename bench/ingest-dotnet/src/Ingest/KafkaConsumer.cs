// Kafka consumer (kafka.consumer.ts): both topics, EnableAutoCommit=false, offsets committed only after
// ClickHouse accepted the batch's rows; an insert failure is retried with backoff. A message that is not
// an envelope is skipped (counted), never retried. Waits (does not poll) while the writer is saturated.
using System.IO.Compression;
using Confluent.Kafka;

namespace Ingest;

public sealed class KafkaConsumer
{
    private const int BatchMessages = 500;
    private const int BatchBytes = 4 * 1024 * 1024;
    private readonly string _brokers;
    private readonly string _group;
    private readonly string[] _topics;
    private readonly EnvelopeHandler _handler;
    private readonly ClickhouseWriter _writer;
    private readonly CancellationTokenSource _stop = new();
    private Thread? _thread;

    public KafkaConsumer(string brokers, string group, string[] topics, EnvelopeHandler handler, ClickhouseWriter writer)
    {
        _brokers = brokers;
        _group = group;
        _topics = topics;
        _handler = handler;
        _writer = writer;
    }

    public void Start()
    {
        _thread = new Thread(Run) { Name = "kafka-consumer", IsBackground = true };
        _thread.Start();
        Console.WriteLine($"Consuming {string.Join(", ", _topics)} as group {_group} from {_brokers}");
    }

    public void Stop()
    {
        _stop.Cancel();
        _thread?.Join(TimeSpan.FromSeconds(30));
    }

    private void Run()
    {
        var config = new ConsumerConfig
        {
            BootstrapServers = _brokers,
            GroupId = _group,
            ClientId = "bench-dotnet",
            EnableAutoCommit = false,
            EnableAutoOffsetStore = false,
            AutoOffsetReset = AutoOffsetReset.Earliest,
            SessionTimeoutMs = 30_000,
            HeartbeatIntervalMs = 3_000,
            MaxPartitionFetchBytes = 2 * 1024 * 1024,
            FetchMaxBytes = 20 * 1024 * 1024,
            FetchWaitMaxMs = 1_000,
            AllowAutoCreateTopics = true,
        };
        using var consumer = new ConsumerBuilder<Ignore, byte[]>(config)
            .SetErrorHandler((_, e) => { if (e.IsFatal || e.IsBrokerError) Console.WriteLine($"[warn] kafka: {e.Reason}"); })
            .Build();
        consumer.Subscribe(_topics);
        var batch = new List<ConsumeResult<Ignore, byte[]>>();
        var bytes = 0;
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                ConsumeResult<Ignore, byte[]>? result;
                try { result = consumer.Consume(TimeSpan.FromMilliseconds(batch.Count == 0 ? 500 : 50)); }
                catch (ConsumeException e) { Console.WriteLine($"[warn] kafka consume: {e.Error.Reason}"); continue; }
                if (result != null && !result.IsPartitionEOF)
                {
                    batch.Add(result);
                    bytes += result.Message.Value?.Length ?? 0;
                }
                if (batch.Count == 0) continue;
                if (result != null && batch.Count < BatchMessages && bytes < BatchBytes) continue;
                Process(consumer, batch);
                batch.Clear();
                bytes = 0;
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            try { consumer.Close(); } catch { /* shutting down */ }
        }
    }

    private void Process(IConsumer<Ignore, byte[]> consumer, List<ConsumeResult<Ignore, byte[]>> batch)
    {
        var envelopes = new List<Envelope>(batch.Count);
        foreach (var message in batch)
        {
            var source = $"kafka {message.Topic}[{message.Partition.Value}]@{message.Offset.Value}";
            try
            {
                envelopes.Add(_handler.Parse(Unwrap(message.Message.Value), source));
            }
            catch (BadEnvelopeException) { /* counted, skipped */ }
            catch (Exception e) when (e is InvalidDataException or IOException)
            {
                // not gzip after all: counted as a bad envelope like any other non-envelope
                try { _handler.Parse(ReadOnlyMemory<byte>.Empty, source + " (" + e.Message + ")"); }
                catch (BadEnvelopeException) { }
            }
        }
        for (var attempt = 1; ; attempt++)
        {
            if (_stop.IsCancellationRequested) return;
            try
            {
                foreach (var table in new[] { "logs", "spans" }) _writer.WaitForRoomAsync(table, _stop.Token).GetAwaiter().GetResult();
                _handler.WriteAsync(envelopes).GetAwaiter().GetResult();
                break;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception e)
            {
                var delay = Math.Min(500 * (1 << Math.Min(attempt, 10)), 15_000);
                Console.WriteLine($"[warn] kafka insert failed (attempt {attempt}), retrying in {delay} ms: {e.Message}");
                Thread.Sleep(delay);
            }
        }
        var offsets = new Dictionary<TopicPartition, TopicPartitionOffset>();
        foreach (var message in batch) offsets[message.TopicPartition] = new TopicPartitionOffset(message.TopicPartition, new Offset(message.Offset.Value + 1));
        try { consumer.Commit(offsets.Values); }
        catch (KafkaException e) { Console.WriteLine($"[warn] kafka commit: {e.Error.Reason}"); }
    }

    /// <summary>A gzip-compressed value (application-level, 1f 8b) is inflated; Kafka-level compression is already undone by librdkafka.</summary>
    private static ReadOnlyMemory<byte> Unwrap(byte[]? value)
    {
        if (value == null) return ReadOnlyMemory<byte>.Empty;
        if (value.Length < 2 || value[0] != 0x1f || value[1] != 0x8b) return value;
        using var gzip = new GZipStream(new MemoryStream(value), CompressionMode.Decompress);
        using var @out = new MemoryStream(value.Length * 4);
        gzip.CopyTo(@out);
        return @out.ToArray();
    }
}
