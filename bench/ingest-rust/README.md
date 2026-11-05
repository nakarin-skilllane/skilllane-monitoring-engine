# ingest-rust — benchmark prototype of the ingest hot path

A stand-alone Rust port of what `apps/engine/src/ingest/` does on its hot path (HTTP + Kafka →
mask → map → ClickHouse), so the Node engine and the Go / Rust / C# prototypes can be benchmarked
on identical work. The brief is `bench/BRIEF.md`.

> **Not built on this host: disk full.** Docker on the authoring Mac went read-only mid-task and
> there is no Rust toolchain on it, so the image size, build time, the mask-coverage line and the
> ClickHouse row counts below are *to be filled in* from the first Linux build. `Cargo.lock` was
> generated (dependency resolution succeeded, incl. the rdkafka `cmake-build` / `libz-static`
> features) before Docker stopped; the sources had a careful desk review but have not been
> compiled. Expect to fix at most small compile errors.

## Build and run

```sh
# from the repo root, no toolchain needed on the host (the build stage runs the mask test and
# fails the build if a required case fails)
docker build -t bench-ingest-rust bench/ingest-rust

docker run --rm -p 5100:5100 \
  -e CLICKHOUSE_URL=http://host.docker.internal:8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring -e CLICKHOUSE_PASSWORD=skilllane_monitoring \
  -e CLICKHOUSE_DATABASE=skilllane_monitoring \
  bench-ingest-rust
```

Image: `rust:1-bookworm` build stage (`cmake`, `libssl-dev`, `pkg-config`; librdkafka is built
from source and linked statically, zlib too) → `gcr.io/distroless/cc-debian12:nonroot` runtime
with one stripped binary. **Image size: 49.7 MB** (`docker images`, linux/amd64, built on 10.101.62.52).
Build time: about 10 min for the first build on the server (rdkafka + cmake-build dominate; 32 cores), seconds when the dependency layer is cached.

### Env

| name | default | |
|---|---|---|
| `PORT` | `5100` | HTTP port |
| `CLICKHOUSE_URL` | `http://localhost:8123` | |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | basic auth |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | |
| `LOG_KAFKA_BROKERS` | empty | empty = no consumer |
| `BENCH_CONSUMER_GROUP` | `bench-rust` | Kafka consumer group (the runner uses a fresh one per run) |
| `LOG_TOPIC_LOGS` / `LOG_TOPIC_SPANS` | `skilllane-monitoring.logs` / `.spans` | |
| `ENGINE_FLUSH_MS` | `1000` | flush after this long with rows waiting |
| `ENGINE_FLUSH_ROWS` | `5000` | flush when this many rows wait; high-water = 4 × |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | more concurrent HTTP requests → 503 |

### HTTP

- `POST /api/ingest/logs` and `/api/ingest/spans`: body = one envelope JSON, optional
  `Content-Encoding: gzip`, max 2,000,000 bytes (413 over, raw or inflated). **202** only after
  the rows are inserted; **503** + `Retry-After: 2` when the writer is at its high-water mark,
  too many requests are in flight, or the insert failed; **400** when the body is not a v1
  envelope or `stream` mismatches the path.
- `GET /api/health` → `{"ok":true}`.

### Kafka

`StreamConsumer` on both topics, `enable.auto.commit=false`, `auto.offset.reset=earliest`.
Messages are gzip-compressed JSON envelopes (plain JSON is accepted too). Each loop takes the
message it waited for plus whatever was already fetched (≤ 256), writes them in one go, retries a
failed insert with backoff until it succeeds, then stores the offsets and commits. A message that
is not an envelope is counted and skipped, never retried. While the writer is full the consumer
simply waits in `enqueue` (backpressure).

### Writer

Per table: rows are serialised to JSONEachRow lines on the request task, buffered under a mutex,
one insert in flight per table (a flush asked for during an insert runs right after it), flush at
`ENGINE_FLUSH_ROWS` or `ENGINE_FLUSH_MS` after the first buffered row, every enqueue resolves once
its rows are in ClickHouse. Insert = `POST <CLICKHOUSE_URL>/?query=INSERT INTO <db>.<table> FORMAT
JSONEachRow&date_time_input_format=best_effort`, basic auth, body gzipped (`flate2`, fast level),
`reqwest` with rustls, 60 s timeout.

### Stats

Every 30 s on stdout, same shape as the engine: `logs <rows/s> rows/s (last insert <ms> ms,
buffered <n>) · spans … · insert failures … · bad envelopes …, bad items … · messages …`.

## What is ported

- `mappers.ts` 1:1: `str` / `uint` / `float` / `stringArray` / `stringMap` / `first` / `pathOf`
  (WHATWG `url` crate for `new URL().pathname`) / `resourceColumns`, `maskLogRecord`, every
  `logs` column, every `spans` column except the I/O ones, `maskEvents`, `peerOf`, `urlPathOf`,
  `splitSpanAttributes`'s `attributes` half (the I/O keys, `db.query.parameter.*`,
  `db.operation.parameter.*`, `http.request.header.*`, `http.response.header.*`,
  `db.query.text` / `db.statement` leave the map; `maskAttributeText` on the rest).
- JS semantics needed for bit-for-bit rows (`src/js.rs`): `String(number)` (ES Number::toString
  via ryu shortest digits), `JSON.stringify` (JS key order: integer-like keys first; JS number
  format), `Number()`, `parseInt()`, `Date.parse()` for ISO 8601 text, `toISOString()`,
  `nanosToDateTime64`, `isoToNanos`.
- Mask rules (`src/mask/`), ported from the SDK's JavaScript:
  - required: `redactValue`, `redactText`, `isSensitiveKey`, `maskSql` (the whole tokenizer /
    column analysis), `maskPathByRoute`
  - optional, ported: `maskJsonText` (incl. the loose scanner for non-JSON / cut text), `maskUrl`,
    `maskQuery`, `maskHeaderJson`, `maskHeaderValue` (cookie / set-cookie), `isSensitiveHeader`,
    `maskStatement`, `maskIdentifier` (`maskRedisKey`), `isThaiNationalId`, `maskNumber`
  - optional, skipped: `redisCommand` (nothing in the mappers uses it); also not ported, no case
    covers them: `maskMarkup`, `maskCsv`, `dbParametersJson` / `sqlPlaceholders`, `maskObject`
    (bodies and bind values are span I/O, which the prototypes leave out).
  - **RE2 note:** `EMAIL_RUN`, `THAI_ID` and `PAIR` (lookbehind + a backreference) are hand
    scanners in `src/mask/value.rs` with the regex's semantics (maximal runs; digit groups with
    optional dashes not preceded / followed by a digit; quoted-or-bare name + operator, scanning
    from `lastIndex` like `exec`).
- `error.cause`: the optional `maskJsonText` rule is ported, so `error.cause` is masked exactly as
  the engine does (JSON parse → `maskParsed` → `JSON.stringify`; the loose scanner otherwise).

### Mask coverage line

Printed by `cargo test --release -- --nocapture` (the Dockerfile runs it). Expected:

```
mask: required 5/5 · optional 28/31 (skipped: redisCommand)
mask cases: required 56/56, optional 28/31
```

`mask: required 5/5 · optional 28/31 (skipped: redisCommand)` — from the first Linux build (2026-11-05). The test reads `MASK_CASES` (a path), else
`../fixture/mask-cases.json`, else `testdata/mask-cases.json` (a copy of the fixture file, so the
Docker build context stays the crate alone).

## What is left out / not identical to Node

- Span I/O columns (`url_query`, `req_*`, `res_*`, `msg_*`, `db_params`, `db_param_count`,
  `has_query`) are not in the insert; ClickHouse defaults them. `db_statement_full` *is* written
  (the statement when it is longer than 2,000 UTF-16 units).
- `Date.parse`: only ISO 8601 forms (date, date-time, `Z` / `±hh:mm`; no offset = UTC — the
  container runs with `TZ=UTC`). V8's legacy formats ("Nov 5 2026") parse in Node and fall back to
  `sentAt` here.
- `JSON.parse` differences of serde_json: lone surrogate escapes (`"\ud800"`) are an error here
  (Node keeps them), numbers beyond f64 range are an error (Node gives ±Infinity), nesting deeper
  than 128 is an error. None occur in the fixture.
- `String.prototype.slice` cuts by UTF-16 unit; `db_statement` is cut at 2,000 units but never
  inside a surrogate pair (Node could leave a lone surrogate).
- `mask_body_text` masks `<…>` bodies with the plain value rule (no `maskMarkup`); it is only
  reached through `maskHeaderJson` with a non-object header text.
- The HTTP error bodies are `{"statusCode":…,"message":…}` like Nest's, but not its exact text.

## Verifying the rows (beyond counts)

`ingest-rust map <envelopes.jsonl> <logs.out> <spans.out>` writes the mapped rows without
ClickHouse; `scripts/compare.py` diffs them against `bench/fixture/expected-*.jsonl` column by
column (ignoring key order inside maps):

```sh
docker run --rm -v "$PWD/bench/fixture:/f:ro" -v /tmp/out:/out --entrypoint /ingest-rust \
  bench-ingest-rust map /f/envelopes.jsonl /out/logs.jsonl /out/spans.jsonl
python3 bench/ingest-rust/scripts/compare.py /tmp/out/logs.jsonl bench/fixture/expected-logs.jsonl
python3 bench/ingest-rust/scripts/compare.py /tmp/out/spans.jsonl bench/fixture/expected-spans.jsonl --ignore db_param_count
```

End to end (env `bench-rust`, rows deleted afterwards):

```sh
cd <repo root> && docker compose up -d --wait clickhouse
docker compose exec -T clickhouse clickhouse-client --multiquery < clickhouse/schema.sql   # if tables are missing
python3 bench/ingest-rust/scripts/post-fixture.py bench/fixture/envelopes.jsonl --env bench-rust --gzip
# expect: posted 2000 envelopes … 202×2000
docker compose exec -T clickhouse clickhouse-client -q "SELECT count() FROM skilllane_monitoring.logs WHERE env='bench-rust'"    # 57078
docker compose exec -T clickhouse clickhouse-client -q "SELECT count() FROM skilllane_monitoring.spans WHERE env='bench-rust'"   # 8651
docker compose exec -T clickhouse clickhouse-client -q "ALTER TABLE skilllane_monitoring.logs DELETE WHERE env='bench-rust'"
docker compose exec -T clickhouse clickhouse-client -q "ALTER TABLE skilllane_monitoring.spans DELETE WHERE env='bench-rust'"
```

Verified counts: 2,000 × 202, **57,078 log rows and 8,651 span rows, every column equal to the Node mappers** (`bench/load/verify.mjs` on the server, 2026-11-05). One compile fix was needed after the desk review: `first()` in `mappers.rs` needed `.flatten()`.

## Lines of code

`wc -l` of the sources (`src/**/*.rs`): **4,012** — of which `src/mask/` 1,927 (value 859, sql
594, web 287, keys 112, io 41, redis 34, mod 24), `js.rs` 534 (JS number / date / stringify
semantics), `mappers.rs` 693, `writer.rs` 278, `main.rs` 147, `stats.rs` 126, `kafka.rs` 98,
`http.rs` 95, `ingest.rs` 80, `lib.rs` 10. Test harness `tests/mask_cases.rs` 112. Helper scripts
(Python, not part of the service) 188.

## Layout

```
Cargo.toml / Cargo.lock      tokio, axum 0.8, serde_json (preserve_order), flate2, reqwest (rustls),
                             regex, rdkafka 0.37 (cmake-build, libz-static), ryu, url
Dockerfile / .dockerignore   build context = this crate only
src/js.rs                    JS semantics helpers
src/mask/                    the SDK mask rules
src/mappers.rs               envelope → rows
src/ingest.rs                parse + map + write (shared by HTTP and Kafka)
src/writer.rs                ClickHouse writer
src/http.rs  src/kafka.rs    the two inputs
src/stats.rs                 counters + the 30 s line
src/main.rs                  env, wiring, `map` subcommand
tests/mask_cases.rs          the mask cases (prints the coverage line)
testdata/mask-cases.json     copy of bench/fixture/mask-cases.json
scripts/                     compare.py, post-fixture.py (verification helpers)
```
