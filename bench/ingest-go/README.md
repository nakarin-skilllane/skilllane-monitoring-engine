# bench/ingest-go — the engine's ingest hot path in Go

A stand-alone port of `apps/engine/src/ingest/` (HTTP + Kafka → mask → map → ClickHouse
`JSONEachRow`), written to `bench/BRIEF.md` so the Node engine and the three prototypes can be
benchmarked on identical work. Standard library only on the hot path (`net/http`, `compress/gzip`,
`regexp`); Kafka through `github.com/twmb/franz-go` v1.19.5 (the last line that builds with Go 1.23).

## Build and run

```sh
# from the repo root; no toolchain needed on the host
docker build -t bench-ingest-go bench/ingest-go      # runs go vet + the mask test; fails on a required case
docker run --rm -p 5100:5100 \
  -e CLICKHOUSE_URL=http://host.docker.internal:8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring -e CLICKHOUSE_PASSWORD=skilllane_monitoring \
  -e LOG_KAFKA_BROKERS=host.docker.internal:29093 \
  bench-ingest-go

# on the host (Go 1.23+)
cd bench/ingest-go && go test ./... && go build -o ingest . && CLICKHOUSE_USER=… CLICKHOUSE_PASSWORD=… ./ingest
```

Tests: `go test ./...` runs the mask cases (`testdata/mask-cases.json`, a copy of
`bench/fixture/mask-cases.json` so the Docker build context has it), maps every envelope of
`bench/fixture/envelopes.jsonl` and compares the rows byte for byte with `expected-*.jsonl`, and
drives the HTTP server end to end against a fake ClickHouse (202 / 400 / 413 / 503, gzip bodies, row
counts). The fixture tests skip when `../fixture` is not there (inside Docker).

`scripts/verify.sh [http://localhost:5100]` posts the fixture (env rewritten to `bench-go`) to a running
ingest and compares the ClickHouse row counts for `env = 'bench-go'`; `scripts/verify.sh --delete`
removes those rows afterwards.

## Env

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `5100` | HTTP ingest port |
| `CLICKHOUSE_URL` | `http://localhost:8123` | |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | empty | basic auth |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | |
| `LOG_KAFKA_BROKERS` | empty = no consumer | comma-separated |
| `BENCH_CONSUMER_GROUP` | `bench-go` | consumer group (the runner uses a fresh one per run) |
| `LOG_KAFKA_TOPIC_LOGS` / `LOG_KAFKA_TOPIC_SPANS` | `skilllane-monitoring.logs` / `.spans` | |
| `ENGINE_FLUSH_MS` | `1000` | flush after this long with rows waiting |
| `ENGINE_FLUSH_ROWS` | `5000` | flush at this many rows; high-water = 4× |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | more concurrent HTTP requests → 503 |

## What is ported

- **HTTP** `POST /api/ingest/logs|spans` (body = one v1 envelope, optional `Content-Encoding: gzip`,
  2,000,000 bytes after gzip → 413), `GET /api/health`. 202 only after the rows are inserted; 503 +
  `Retry-After: 2` while the writer is full, ClickHouse fails or `ENGINE_INGEST_MAX_INFLIGHT` requests are
  running; 400 for a non-envelope or a stream that does not match the path. Error bodies use Nest's
  `{statusCode, message, error}` shape.
- **Kafka** consumer group on both topics, `ConsumeResetOffset AtStart` (the engine's `fromBeginning`),
  manual commits: one goroutine per assigned partition parses the batch, writes it, retries a failed
  insert with the engine's back-off (500 ms × 2ⁿ, max 15 s) until it succeeds or the partition is
  revoked, then commits the batch's offsets (`CommitRecords`). Non-envelopes are counted and skipped.
  A revoke waits for the running batch (rebalances are blocked while polling). The SDK's gzip is Kafka
  batch compression, which the client undoes; a value that is itself gzip (magic bytes) is also undone.
  Topics are auto-created by the broker (`AllowAutoTopicCreation`), not by an admin call.
- **Mask**: `mask_keys.go` (`isSensitiveKey` with the SDK's cache), `mask_value.go` (`redactValue`,
  `redactText`, `maskJsonText` complete + loose, `maskJsonValue`, `maskNumber`, `isThaiNationalId`,
  `truncateUtf8`), `mask_sql.go` (`maskSql` with the full tokenizer / column analysis), `mask_web.go`
  (`maskQuery`, `maskUrl`, `maskHeaderValue` + cookies, `isSensitiveHeader`, `maskPathByRoute`,
  `maskEndpoint`, `maskRedisKey`, `maskIdentifier`), `mask_io.go` (`maskStatement`). The three
  lookbehind regexes — `EMAIL_RUN`, `THAI_ID`, `PAIR` — are hand scanners (`redactEmails`,
  `matchThaiId`, `matchPair` / `redactPairs`), replicating the regex's per-position semantics
  including `lastIndex` handling. Everything else uses Go's RE2 `regexp` where the SDK uses a regex
  (`EMAIL`, `JWT`, `BEARER`, `USERINFO`, `URL_QUERY`: no lookaround, same leftmost-first semantics).
  Applied exactly where `mappers.ts` applies them; `error.cause` uses the ported `maskJsonText`
  (the optional rule), not the `redactValue` fallback.
- **Map**: `mappers.go` is `mappers.ts` 1:1 (`str` / `uint` / `float` / `stringArray` / `stringMap` /
  `first` / `pathOf` / `resourceColumns`, `maskLogRecord`, `maskEvents`, `peerOf`, `urlPathOf`, the
  `is_entry` / `status_code` / timestamp fallbacks). JSON is parsed into an **ordered** object model
  (`jsonx.go`) and serialised as `JSON.stringify` would (key order incl. JavaScript's integer-key
  ordering, number formatting, string escaping), so `events`, `error.cause`, stringified attribute
  values and the `labels` / `fields` / `attributes` / `resource` maps come out byte for byte as the
  engine's. `TestFixtureRows` proves it: 57,078 log rows and 8,651 span rows identical to
  `expected-*.jsonl`.
- **Spans**: the I/O keys (`http.request.body`, headers, `url.query`, bind values, `messaging.*`,
  `db.query.parameter.*`, …) leave `attributes`; `req_* / res_* / msg_* / db_params / url_query` are not
  inserted (ClickHouse defaults). `db_statement_full` and `db_param_count` are kept because the
  expected rows have them.
- **Writer**: per table, chunks of pre-encoded rows; flush at `ENGINE_FLUSH_ROWS` or `ENGINE_FLUSH_MS`
  after the first row; one insert in flight per table, the next batch waits (`again`); high-water
  4 × flushRows → `Saturated` (HTTP 503) / `Enqueue` blocks (Kafka pauses). Insert =
  `POST <url>/?query=INSERT INTO <db>.<table> FORMAT JSONEachRow&date_time_input_format=best_effort`,
  basic auth, gzip body (`gzip.DefaultCompression`, like zlib's default in the Node client), 60 s
  timeout. Rows are encoded in the request / partition goroutine; the writer only concatenates.
- **Stats** line every 30 s, same text as `ingest.stats.ts` (plus `lag <topic>=<n>` from the last fetch
  of every partition).

## What is skipped (and why)

- Span I/O columns and their rules: `maskBodyText`, `maskHeaderJson`, `maskHeaders`, `maskMarkup`
  (needs a back-reference `<\/\1>`: not RE2), `maskCsv`, `dbParametersJson` / bind re-masking,
  `redisCommand`. Per the brief the I/O columns are left out of the insert.
  `db_param_count` counts the binds without masking them (exact unless a bind list exceeds the SDK's
  256 KB cap, where the engine would count fewer).
- Mask coverage line (from `go test`):
  `mask: required 5/5 · optional 27/31 (skipped: maskHeaderJson, redisCommand)` — 56/56 required cases.
- Kafka lag in the stats line is from fetch high-watermarks, not an admin `fetchOffsets` call; topics
  are not created by the consumer.
- Bearer-token auth (`ENGINE_INGEST_TOKEN`) and `ENGINE_INGEST_HTTP=false`: not part of the hot path.

## Where Node and Go cannot be made identical

- A JSON text that is not valid UTF-8, or holds a lone surrogate escape (`"\ud800"`): Node keeps the
  lone surrogate and re-emits `\ud800`; Go stores U+FFFD. `\s` in the ported regexes is ASCII
  whitespace in Go, Unicode whitespace in JavaScript (`USERINFO`, `URL_QUERY`, `BEARER`).
- `Date.parse` accepts more loose formats than `parseDateJS` (ISO 8601, RFC 1123/850, ANSIC forms);
  an ISO time without a zone is read as UTC (Node: the process time zone, UTC in the engine's image).
- `pathOf` on a URL uses `net/url` (`EscapedPath`) rather than the WHATWG parser: identical for normal
  URLs, not for ones needing WHATWG normalisation (backslashes, `..` segments, non-ASCII hosts).
- `duration_ns` beyond 2^53 and years outside 0–9999 differ in formatting (never in practice).
- An array as a log item (`[...]`) is a bad item here; Node would map its indices into `fields`.
- `Number("0x10")` style strings in numeric columns parse in Node, not here (→ 0 / null).

## Numbers

- Lines of code (`wc -l`): **4,843** source (`*.go` without tests; the mask port is 2,265 of them:
  `mask_*.go`), 501 lines of tests. Go module: `github.com/twmb/franz-go` v1.19.5 and its three
  indirect dependencies; nothing else.
- Runtime image: `gcr.io/distroless/static:nonroot` + one static binary. The stripped linux/arm64 binary
  (`-trimpath -ldflags='-s -w'`, what the Dockerfile builds) is **9.0 MB** (9,044,152 bytes); the distroless static base
  is ~2 MB, so the image is about 11 MB. The `docker build` could not be completed on the machine the
  prototype was written on: the host disk filled up while the `golang:1.23-bookworm` layer was being
  extracted, the Docker VM went read-only and the engine hung (see the report). Image size and build
  time are therefore to be measured with `docker build -t bench-ingest-go bench/ingest-go`
  (`docker images bench-ingest-go`); the build stage ran through `go mod download` before the disk
  filled.
- Verification against the dev ClickHouse: the mapping and the HTTP path were verified end to end
  (`TestFixtureRows`: 57,078 / 8,651 rows byte-identical; `TestHTTPEndToEnd`: 2,000 envelopes → 2,000
  × 202, 57,078 log rows and 8,651 span rows inserted into a fake ClickHouse). The run against the real
  ClickHouse (`scripts/verify.sh`) answered 503 for every envelope because ClickHouse's filesystem had
  gone read-only together with the Docker VM (`Code: 1001 … filesystem error: in create_directories:
  Read-only file system`) — the 503 + `Retry-After` is the intended answer in that state. Re-run
  `scripts/verify.sh` once the Docker VM is back.
