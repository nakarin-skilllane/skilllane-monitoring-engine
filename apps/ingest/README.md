# ingest — the ingest role of skilllane-monitoring, in Rust

One process that does what the engine does with `ENGINE_ROLE=ingest`: takes telemetry envelopes over
HTTP and from one queue (Kafka or RabbitMQ; BullMQ jobs reach it over HTTP through `apps/bullmq-bridge`),
masks and maps them exactly as `apps/engine/src/ingest/` does, and inserts the rows into ClickHouse. The
engine keeps everything else (`ENGINE_ROLE=api`: query API, auth, reports, schema, cold storage). Design:
`docs/superpowers/specs/2026-11-05-ingest-rust-design.md`; deploy and rollback: `deploy/DEPLOY.md`.

It reads the engine's env names, so the same `.env` serves both processes. It never applies the schema: at
start it waits for ClickHouse to answer `/ping` and for table `logs` to exist (the engine creates it),
retrying every 2 s for as long as it takes (one log line a minute), and only then starts the consumer.
HTTP (ingest and health) is up from the first second.

## Build and run

```sh
# from the repo root; no toolchain needed on the host. The build stage runs every test (the SDK mask
# cases included) and fails the build when one fails. First build ≈ 10 min (librdkafka + OpenSSL are
# compiled from source and linked statically); seconds afterwards while Cargo.toml / Cargo.lock are unchanged.
docker build -t skilllane-monitoring-ingest apps/ingest

docker run --rm -p 5100:5100 --env-file .env skilllane-monitoring-ingest
```

Runtime image: `gcr.io/distroless/cc-debian12:nonroot`, one stripped binary, `USER nonroot`, no shell
(so no `HEALTHCHECK` in the Dockerfile: compose probes `GET /api/health`). `deploy/Dockerfile.ingest`
is the production copy of `apps/ingest/Dockerfile`.

Build and test on a Mac without Docker's image cache:

```sh
docker run --rm -v "$PWD/apps/ingest:/src" -v ingest-cargo:/usr/local/cargo/registry -v ingest-target:/src/target \
  -w /src rust:1-bookworm sh -c 'apt-get update -qq && apt-get install -y -qq cmake libssl-dev pkg-config >/dev/null && cargo test --release'
```

`tests/rabbitmq_it.rs` runs only with `RABBITMQ_IT=1` against a live broker (see its header).

## Env

Same names and defaults as the engine (`apps/engine/src/config.ts`, `SPEC.md` §config). Booleans: anything
but `false` / `0` / `no` / `off` is true. Numbers must be positive, else the default applies.

| name | default | |
|---|---|---|
| `ENGINE_PORT` (else `PORT`) | `5100` | HTTP port |
| `CLICKHOUSE_URL` | `http://localhost:8123` | |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `skilllane_monitoring` / `skilllane_monitoring` | basic auth (the writer user) |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | |
| `LOG_EXPORT` | auto | `kafka` \| `rabbitmq` \| `bullmq` \| `http` \| `otlp` \| `stdout`; unset or not a mode = resolved like the SDK (`LOG_KAFKA_BROKERS` → kafka, `LOG_RABBITMQ_URL` → rabbitmq, `LOG_BULLMQ_REDIS_URL` → bullmq, `LOG_HTTP_URL` → http, `OTEL_EXPORTER_ENDPOINT` → otlp, else stdout); a value that is not a mode is logged once. Only kafka and rabbitmq start a consumer here |
| `ENGINE_INGEST_HTTP` | `true` | `false` → `POST /api/ingest/*` answers 404 |
| `ENGINE_INGEST_TOKEN` | empty | bearer token(s), comma-separated to rotate; empty = open (a warning at start) |
| `ENGINE_INGEST_MAX_BYTES` | `2000000` | largest request body, raw and after gzip (413) |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | requests written at once; more answer 503 |
| `ENGINE_FLUSH_ROWS` / `ENGINE_FLUSH_MS` | `5000` / `1000` | insert when this many rows wait, or this long after the first buffered row; high-water = 4 × rows |
| `ENGINE_INSERT_INFLIGHT` | `1` | inserts in flight per table (1 = the engine's behaviour; the benchmark's ceiling) |
| `ENGINE_ASYNC_INSERT` | `false` | `async_insert=1&wait_for_async_insert=1` on every insert: ClickHouse merges the batches of every ingest into one part per flush of its own, answers once on disk |
| `CLICKHOUSE_INSERT_FORMAT` | `jsoneachrow` | `rowbinary` = the rows as RowBinary with the column list (`src/rowbinary.rs`); no JSON parsing on the server. `bench/load/verify.mjs` proves both identical |
| `ENGINE_CONCURRENCY` | `50` | RabbitMQ prefetch; Kafka: inserts waiting at once over the partition tasks |
| `ENGINE_CONSUMER_GROUP` | `skilllane-monitoring-engine` | Kafka group |
| `ENGINE_KAFKA_PARTITIONS` | `3` | partitions of a topic this process has to create |
| `LOG_TOPIC_LOGS` / `LOG_TOPIC_SPANS` | `skilllane-monitoring.logs` / `.spans` | Kafka topics / RabbitMQ queues |
| `LOG_KAFKA_BROKERS` | empty | comma-separated |
| `LOG_KAFKA_CLIENT_ID` | `skilllane-monitoring-engine` | |
| `LOG_KAFKA_SSL` | `false` | TLS to the brokers |
| `LOG_KAFKA_SASL_MECHANISM` / `_USERNAME` / `_PASSWORD` | unset | `plain` \| `scram-sha-256` \| `scram-sha-512`; anything else = no SASL |
| `LOG_RABBITMQ_URL` | unset | `amqp://…` |
| `LOG_RABBITMQ_EXCHANGE` | `skilllane-monitoring.telemetry` | durable direct exchange |
| `TZ` | `UTC` in the image | the mappers' `Date.parse` of offset-less text assumes UTC like the engine's container |

`LOG_BULLMQ_*` are read but unused here (the bridge consumes BullMQ). `ENGINE_CORS_ORIGIN` is not needed
(no browser client talks to ingest).

## HTTP

`POST /api/ingest/logs` and `/api/ingest/spans` — the engine's `HttpIngestController`, answer for answer:

| status | when |
|---|---|
| 413 | body over `ENGINE_INGEST_MAX_BYTES`, raw or once gzip (`Content-Encoding: gzip`) is undone |
| 404 | `ENGINE_INGEST_HTTP=false` |
| 401 | `ENGINE_INGEST_TOKEN` set and no / wrong `Authorization: Bearer <token>` (SHA-256 digests compared in constant time; one warning a minute at most; the token is never logged) |
| 400 | unknown stream, body not a v1 envelope, bad gzip, or the envelope's `stream` differs from the path |
| 503 + `Retry-After: 2` | `ENGINE_INGEST_MAX_INFLIGHT` requests in flight, the table's buffer at its high-water mark, or the insert failed (`not written: …`) — the SDK keeps the items and retries |
| 202 `{"items": n}` | the rows are in ClickHouse (same meaning as an ack on a queue) |

Error bodies are Nest's `{"statusCode", "message", "error"}`.

`GET /api/health` → `{"ok", "clickhouse", "role": "ingest", "transport", "pending"}`, the engine's shape:
`clickhouse` = `/ping` answered within 800 ms (`ok` is the same here: no schema step); `transport` = the
resolved `LOG_EXPORT` mode; `pending` = the consumer's backlog (Kafka lag, RabbitMQ ready + unacked) plus
the rows buffered in the writer, `null` without a consumer (incl. bullmq) or when the broker did not answer
within 700 ms. It answers within 1 s even while the broker hangs; concurrent health calls share one broker
read.

## Consumers

Common semantics (`src/consumer.rs`): a message is acked / committed only after its rows are in ClickHouse;
an insert failure is retried / requeued, never dropped; a message that is not a v1 envelope is counted and
skipped, never retried; while a table's buffer is full the consumer waits (backpressure). The consumer is
started after ClickHouse is ready, retried with backoff (1 s doubling to 30 s) while the queue is unreachable.

- **Kafka** (`src/kafka.rs`, rdkafka with a statically linked librdkafka): group `ENGINE_CONSUMER_GROUP`
  on both topics (created with `ENGINE_KAFKA_PARTITIONS` partitions when missing), `auto.offset.reset=earliest`;
  one task per assigned partition writes its batches in order (like the engine's `partitionsConsumedConcurrently`),
  at most `ENGINE_CONCURRENCY` inserts waiting over all of them, the offset stored after each batch's insert and
  committed by librdkafka every second (and once more at stop); a failed insert is retried with backoff
  (0.5 s → 15 s) until it succeeds or the process stops (then nothing is committed and the batch comes again).
  Messages are gzip JSON envelopes (plain JSON accepted). `lag` = `<topic>[<partition>]=<high watermark −
  committed>` for every partition (no commit yet = from the low watermark, like the engine): one committed-offsets
  round trip, the watermarks from librdkafka's fetch cache (a broker query only for a partition not fetched here).
- **RabbitMQ** (`src/rabbitmq.rs`, lapin): the engine's exchange / queue / bind, `prefetch =
  ENGINE_CONCURRENCY`, ack / nack + requeue after 1 s / nack without requeue, reconnect with backoff.
- **BullMQ**: not consumed by this process; `apps/bullmq-bridge` runs the bullmq Worker and posts each
  job's envelope to `/api/ingest/<stream>`. With `LOG_EXPORT=bullmq` this process logs that once, reports
  `transport: "bullmq"` in health and needs HTTP ingest on.

## Writer

`src/writer.rs`, the engine's `ClickhouseWriter`: rows serialised to JSONEachRow lines on the request
task, buffered per table, `ENGINE_INSERT_INFLIGHT` inserts in flight per table, flush at `ENGINE_FLUSH_ROWS`
or `ENGINE_FLUSH_MS` after the first buffered row, every enqueue resolves once its rows are in ClickHouse
(rejects when the insert failed, so the caller retries / requeues), backpressure at 4 × flush rows, an
error log at most every 5 s. Insert = `POST <CLICKHOUSE_URL>/?query=INSERT INTO <db>.<table> FORMAT
JSONEachRow&date_time_input_format=best_effort`, basic auth, gzip body, reqwest + rustls, 60 s timeout.

## Logs, stats, shutdown

Everything goes to stdout, one line per event with a UTC time: `2026-11-05T10:00:00.123Z   LOG [Ingest] …`.
At start: `skilllane-monitoring ingest listening on :5100 role=ingest transport=kafka http-ingest=on (token)`
(`http-ingest=on` / `off`; `(ignored LOG_EXPORT=…)` when the value was not a mode), and the engine's
warning when HTTP ingest takes no token.

Every 30 s the engine's stats line: `logs <r> rows/s (last insert <ms> ms, buffered <n>) · spans … · insert
failures <n> (+<d>) · bad envelopes <n>, bad items <n> (+<d>) · messages <n> · lag <lag> · first bad: <err>`
(`lag` when the consumer answered within 2 s; `first bad` when bad input arrived since the last line).

SIGTERM / SIGINT: stop accepting HTTP → stop the consumer and flush the writer (the batch in progress is
inserted and committed / acked) → close the writer → final stats line → exit 0.

## Rows

`src/mappers.rs` + `src/spanio.rs` + `src/mask/` port the engine's `mappers.ts` / `span-io.ts` and the SDK's
mask rules; `tests/mask_cases.rs` runs the SDK's mask cases (`testdata/mask-cases.json`) and prints the
coverage line. `ingest map <envelopes.jsonl> <logs.out> <spans.out>` writes the mapped rows without
ClickHouse for a column-by-column diff against the Node mappers (`bench/load/verify.mjs`,
`scripts/compare.py`).

## Layout

```
Cargo.toml / Cargo.lock      tokio, axum 0.8, serde_json (preserve_order), flate2, reqwest (rustls), regex,
                             rdkafka 0.37 (cmake-build, libz-static, ssl-vendored), lapin, redis, sha2, subtle
Dockerfile / .dockerignore   build context = this crate only
src/config.rs                every env the engine's ingest reads
src/consumer.rs              the Consumer trait (start / stop / lag / pending)
src/kafka.rs  src/rabbitmq.rs   the queue consumers
src/http.rs                  POST /api/ingest/{stream}, GET /api/health
src/ingest.rs                parse + map + write (shared by HTTP and the consumers)
src/writer.rs                ClickHouse writer + ping / readiness wait
src/stats.rs                 counters, the 30 s line, the log line
src/main.rs                  wiring, start, shutdown, `map` subcommand
src/mappers.rs src/spanio.rs src/mask/ src/js.rs   envelope → rows, bit-for-bit with Node
tests/                       mask_cases.rs (SDK mask cases), rabbitmq_it.rs (live broker, opt-in)
scripts/                     compare.py, post-fixture.py (verification helpers)
```
