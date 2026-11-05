# bench/ingest-dotnet — the ingest hot path in C# (.NET 10)

A stand-alone port of `apps/engine/src/ingest/` (HTTP + Kafka → mask → map → ClickHouse) written to
`bench/BRIEF.md`, so the Node engine and the Go / Rust / C# prototypes can be benchmarked on identical work.

## Build and run

```sh
# from the repo root; no .NET on the host needed (build stage = mcr.microsoft.com/dotnet/sdk:10.0)
docker build -t bench-ingest-dotnet bench/ingest-dotnet

docker run --rm -p 5100:5100 \
  -e CLICKHOUSE_URL=http://host.docker.internal:8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring -e CLICKHOUSE_PASSWORD=skilllane_monitoring \
  -e CLICKHOUSE_DATABASE=skilllane_monitoring \
  bench-ingest-dotnet

curl -s localhost:5100/api/health                       # {"ok":true}
curl -s -X POST localhost:5100/api/ingest/logs -H 'content-type: application/json' --data-binary @envelope.json   # 202 {"items":n}
```

The build stage runs the mask test (`dotnet test`, xunit) and fails the image build when a `required`
case of `mask-cases.json` does not match the SDK bit for bit. The test prints

```
mask: required 5/5 · optional 10/11 (skipped: redisCommand)
mask cases: required 56/56 · optional 28/31
```

Runtime image: `mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled` (17.6 MB) + a **self-contained,
trimmed** publish (`PublishTrimmed`, `TrimMode=partial`, `InvariantGlobalization`, server GC) — the default,
chosen because it leaves `Confluent.Kafka` (P/Invoke into librdkafka) untouched by the trimmer.
`--build-arg PUBLISH_MODE=aot` publishes a **Native AOT** binary on the same base instead (`clang` is installed in
the build stage for the link); the code is AOT-clean (no reflection, source-generated JSON and regexes, slim
Kestrel builder), but AOT + librdkafka was not exercised, so it is the option, not the default.

> **Not built on this host: disk full.** Docker on the authoring Mac went read-only (host disk full) before the first
> image build finished, so the image size, the `dotnet test` run and the ClickHouse row counts in *Numbers* were not
> measured here; the image is built and verified on a Linux server. Everything below that depends on a build is
> marked *unverified*.

### Env

| variable | default | |
| --- | --- | --- |
| `PORT` | `5100` | Kestrel, HTTP/1.1 |
| `CLICKHOUSE_URL` | `http://localhost:8123` | |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | basic auth |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | |
| `ENGINE_FLUSH_ROWS` | `5000` | rows that trigger an insert |
| `ENGINE_FLUSH_MS` | `1000` | ms after the first buffered row |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | more concurrent requests → 503 |
| `LOG_KAFKA_BROKERS` | empty | empty = no consumer |
| `BENCH_CONSUMER_GROUP` | `bench-dotnet` | Kafka consumer group |

### HTTP

`POST /api/ingest/logs` and `/api/ingest/spans`, body = one envelope (`{ v: 1, stream, resource, sentAt, items }`),
optional `Content-Encoding: gzip`, max 2,000,000 bytes after inflating (413). **202** only after the rows are in
ClickHouse (`{"items":n}`); **503** + `Retry-After: 2` while the writer is at its high-water mark, more than
`ENGINE_INGEST_MAX_INFLIGHT` requests are being written, or the insert failed; **400** when the body is not a v1
envelope or `stream` mismatches the path. `GET /api/health` → `{"ok":true}`.

### Kafka

`Confluent.Kafka` consumer on `skilllane-monitoring.logs` + `skilllane-monitoring.spans`, `EnableAutoCommit=false`,
`AutoOffsetReset=Earliest`. Messages are read in batches (≤ 500 messages / 4 MB), parsed (a non-envelope is counted
and skipped, never retried), mapped and enqueued; the offsets are committed only after the insert resolved. An insert
failure is retried with backoff inside the batch. While the writer is saturated the consumer waits instead of polling.
Kafka-level gzip is undone by librdkafka; an application-level gzip value (`1f 8b`) is inflated too.

### Writer

One `Channel<Batch>` per table read by one loop, so inserts are serialised per table. `EnqueueAsync` appends the rows
to the open batch and returns a task that completes when the insert that carried them succeeded (faults when it
failed). The open batch is sealed at `ENGINE_FLUSH_ROWS` rows or `ENGINE_FLUSH_MS` after its first row; everything
sealed while an insert was running goes into the next insert as one batch (as the Node writer does). High-water =
4 × flushRows rows waiting → `Saturated` (HTTP 503 / Kafka waits). Insert = `POST <CLICKHOUSE_URL>/?query=INSERT INTO
<db>.<table> FORMAT JSONEachRow&date_time_input_format=best_effort`, basic auth, one JSON object per line, gzip body.

A stats line goes to stdout every 30 s:
`logs <rows/s> rows/s (last insert <ms> ms, buffered <n>) · spans … · insert failures … · bad envelopes …, bad items … · messages …`.

## What is ported

- `mappers.ts` 1:1: `str` / `uint` / `float` / `stringArray` / `stringMap` / `first` / `pathOf` / `resourceColumns`,
  `logTimestamp`, `jobFinal`, `maskLogRecord`, `mapLog` (every `logs` column), `mapSpan` (every `spans` column except
  the I/O ones: `req_*`, `res_*`, `msg_*`, `db_params`, `url_query` are left to ClickHouse defaults; `db_statement_full`
  and `db_param_count` are written), `maskEvents`, `peerOf`, `urlPathOf`.
- `span-io.ts`: `splitSpanAttributes` (the I/O keys, `db.query.parameter.*`, `db.operation.parameter.*`,
  `http.request.header.*`, `http.response.header.*`, the statement itself leave `attributes`), `maskAttributeText`.
- `envelope-handler.ts` (parse → rows → writer, bad envelopes / bad items counted), `http-ingest.controller.ts`,
  `clickhouse-writer.ts`, `ingest.stats.ts`, the Kafka consumer.
- The mask rules of `skilllane-monitoring/contract/mask`, read from the SDK's JavaScript:
  - `keys.js`: `isSensitiveKey`, `isSensitiveQueryName`, `isSensitiveHeader`, `keyWords` (with the SDK's verdict cache)
  - `value.js`: `redactValue`, `redactText`, `isThaiNationalId`, `maskNumber`, `maskJsonText` (complete and loose),
    `maskJsonValue`, `maskObject`, `truncateUtf8`, `stripQuery`
  - `sql.js`: `maskSql` (the tokenizer, parenthesis context, column resolution, INSERT column lists)
  - `web.js`: `maskQuery`, `maskUrl`, `maskCookie`, `maskSetCookie`, `maskHeaderValue`, `maskHeaders`, `maskMarkup`,
    `maskPathByRoute`, `maskEndpoint`
  - `io.js`: `maskBodyText`, `maskHeaderJson`, `maskStatement`
  - `redis.js`: `maskRedisKey`, `maskIdentifier`
- JS semantics the rows depend on (`Js.cs`): a JSON value model with JS property order (array-index keys first),
  `JSON.stringify` escaping (`\u00xx` for controls, lone surrogates escaped, everything else raw), `String(number)`
  (ECMAScript Number::toString, so `502.5303149225797`, `1e+21`, `100`), `Number(string)`, `parseInt`, `Date.parse`,
  `toISOString`, the contract's `nanosToDateTime64` / `isoToNanos` / `durationNanos`.
- `error.cause` goes through the ported `maskJsonText` (the optional rule), exactly as `maskLogRecord` does.

### Lookbehind

The SDK's `EMAIL_RUN`, `THAI_ID` and `PAIR` patterns use lookbehind. .NET `Regex` supports it, but these three are
hand scanners here anyway (`Value.RedactEmails`, `Value.RedactThaiIds`, `Value.MatchPairAt` / `RedactPairs`) so the
work matches the Go and Rust prototypes, which cannot use lookbehind. The scanners reproduce the regex semantics
(maximal runs for `EMAIL_RUN`; a candidate at every digit not preceded by a digit for `THAI_ID`; the two PAIR
alternatives, the 64-char name cap, the `lastIndex` handling of `redactPairs`). The remaining patterns are
`[GeneratedRegex]` written with JS (ASCII) classes: `\b` → `(?<![A-Za-z0-9_])`, `\d` → `[0-9]`, `\w` → `[A-Za-z0-9_]`,
`\s` → the JS white-space set, so a Thai letter is never a word character.

## What is skipped

- `redisCommand` (the Redis statement rule): not used by the mappers → the only optional rule not ported.
- `sqlPlaceholders` / `dbParametersJson` (bind values), `maskCsv`: feed the span I/O columns, which the prototypes
  leave out. `db_param_count` counts the binds the engine would list, without the byte cap of `dbParametersJson`.
- Node-only behaviours that cannot be identical:
  - `pathOf` uses `System.Uri` where Node uses the WHATWG `URL`: non-ASCII path characters stay unescaped in .NET
    (WHATWG percent-encodes them). The fixture has none.
  - `Date.parse` is `DateTimeOffset.TryParse` (invariant): the ISO forms agree; V8's legacy date formats may not.
    A date-time without an offset is read as UTC (Node: the process time zone, UTC in the container).
  - `JSON.parse` is `System.Text.Json` (strict, like JS); it rejects a lone-surrogate escape (`"\ud800"`) that JS
    accepts, and caps nesting at 1024 (JS: the stack).
  - A span whose `attributes` is not an object is mapped as if it had none (Node would index a string's characters).
  - `new Date().toISOString()` fallback for an unparsable `sentAt` is the current time, as in Node (not reproducible).

## Verification

```sh
# 1. dev ClickHouse at the repo root (apply clickhouse/schema.sql if the tables are missing)
docker compose up -d --wait clickhouse

# 2. the image, mask test included
time docker build -t bench-ingest-dotnet bench/ingest-dotnet
docker image ls bench-ingest-dotnet

# 3. run it against the dev ClickHouse
docker run -d --name bench-dotnet -p 5100:5100 \
  -e CLICKHOUSE_URL=http://host.docker.internal:8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring -e CLICKHOUSE_PASSWORD=skilllane_monitoring \
  bench-ingest-dotnet

# 4. every fixture envelope, env rewritten to bench-dotnet (so the rows can be counted and deleted by env)
python3 bench/ingest-dotnet/tools/post-fixture.py bench/fixture/envelopes.jsonl http://localhost:5100 bench-dotnet 8 gzip
#    expected: posted 2000 envelopes ... statuses {202: 2000}

# 5. row counts must equal the expected files' line counts (57,078 logs, 8,651 spans)
Q() { curl -s -u skilllane_monitoring:skilllane_monitoring 'http://localhost:8123/' --data-binary "$1"; }
Q "SELECT count() FROM skilllane_monitoring.logs WHERE env = 'bench-dotnet'"
Q "SELECT count() FROM skilllane_monitoring.spans WHERE env = 'bench-dotnet'"
wc -l bench/fixture/expected-logs.jsonl bench/fixture/expected-spans.jsonl

# 6. clean up
Q "ALTER TABLE skilllane_monitoring.logs DELETE WHERE env = 'bench-dotnet'"
Q "ALTER TABLE skilllane_monitoring.spans DELETE WHERE env = 'bench-dotnet'"
docker rm -f bench-dotnet
```

Value-by-value check of the mapping (no ClickHouse needed; the fixture has env `bench`, so no rewrite):

```sh
docker run --rm -v "$PWD/bench/fixture:/fixture:ro" -v "$PWD/bench/ingest-dotnet:/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
  sh -c 'dotnet run --project src/Ingest -c Release -- map-fixture /fixture/envelopes.jsonl /tmp/logs.jsonl /tmp/spans.jsonl \
         && cp /tmp/logs.jsonl /tmp/spans.jsonl /src/'
python3 bench/ingest-dotnet/tools/compare-fixture.py bench/fixture/expected-logs.jsonl bench/ingest-dotnet/logs.jsonl
python3 bench/ingest-dotnet/tools/compare-fixture.py bench/fixture/expected-spans.jsonl bench/ingest-dotnet/spans.jsonl
```

`compare-fixture.py` ignores key order and prints the first differing rows and a per-column count; "identical" is
the goal (the expected files were written by the engine's own `mapLog` / `mapSpan`).

## Numbers

| | |
| --- | --- |
| Lines of code (`wc -l`) | **3,283** C# in `src/Ingest` (Js 403 · Mappers 496 · Program 250 · Writer 228 · Stats 104 · Envelope 102 · Kafka 143 · Mask: Value 649, Sql 458, Web 246, Keys 118, Io 52, Redis 34) + 127 test + 52 csproj + 45 Dockerfile + 106 tools |
| Mask coverage | `mask: required 5/5 · optional 10/11 (skipped: redisCommand)` — expected from the port (56 required + 28 optional cases; the 3 `redisCommand` cases are the skipped ones). *Unverified: `dotnet test` did not run on this host.* |
| Image size | *unverified* — expected ≈ 17.6 MB base + the trimmed self-contained app (typically 35–45 MB for Kestrel + System.Text.Json + Confluent.Kafka with its 15 MB librdkafka) |
| Build time | *unverified* (the first `dotnet restore` + build of the test project in the SDK container took 2 min 19 s on an overloaded host before the disk filled) |
| Rows (`env = 'bench-dotnet'`) | *unverified* — must be 57,078 logs / 8,651 spans, 2,000 × 202 |

The optional rule counts assume the `maskNumber` cases (string inputs: the SDK returns a non-number unchanged) and
the `maskHeaderJson` case (no byte cap: `int.MaxValue`) are read the way `generate.mjs` produced them.
