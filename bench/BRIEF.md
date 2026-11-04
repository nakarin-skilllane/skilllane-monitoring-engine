# Ingest prototype brief (same for Go, Rust, C#)

You are writing `bench/ingest-<lang>/`: a stand-alone ingest service that does what `apps/engine/src/ingest/` does on its
hot path, so the four (Node engine + 3 prototypes) can be benchmarked on identical work. Read these before writing code:

- `apps/engine/src/ingest/mappers.ts` — the exact column mapping (port it 1:1, same helpers `str` / `uint` / `float` /
  `stringArray` / `stringMap` / `first` / `pathOf` / `resourceColumns`, same fallbacks)
- `apps/engine/src/ingest/envelope-handler.ts`, `http-ingest.controller.ts`, `clickhouse-writer.ts` — behaviour
- `clickhouse/schema.sql` — column names and types of `logs` and `spans`
- `bench/fixture/mask-cases.json` — the mask rules, with inputs and the SDK's outputs
- `bench/fixture/envelopes.jsonl` + `expected-*.jsonl` — end-to-end expectation
- SDK mask sources (JavaScript, read for the algorithm):
  `node_modules/.pnpm/skilllane-monitoring@*/node_modules/skilllane-monitoring/dist/contract/mask/{value,keys,sql,web}.js`

## Must do

1. **HTTP** `POST /api/ingest/logs` and `/api/ingest/spans`, body = one envelope JSON (`{ v: 1, stream, resource, sentAt,
   items }`), optional `Content-Encoding: gzip`, max body 2,000,000 bytes (413 over). Answer **202 only after the rows are
   inserted into ClickHouse**; **503** with `Retry-After: 2` while the writer is full or ClickHouse fails; **400** when the
   body is not a v1 envelope or `stream` mismatches the path. `GET /api/health` → `{"ok":true}`. Also honour
   `ENGINE_INGEST_MAX_INFLIGHT` (default 64): more concurrent requests → 503.
2. **Kafka** consumer (`LOG_KAFKA_BROKERS`, topics `skilllane-monitoring.logs` and `skilllane-monitoring.spans`, group
   `bench-<lang>`, messages are gzip-compressed JSON envelopes): parse → write → commit offsets only after the insert
   resolved. A message that is not an envelope is skipped (counted), never retried.
3. **Mask** when the envelope resource has no `skilllane.monitoring.mask` (or a value below the SDK's `MASK_VERSION`, read
   it from `mask-cases.json`'s source); items of a sender that masked are stored as they are. Required rules (must pass
   every `required` case in `mask-cases.json` bit for bit): `redactValue`, `redactText`, `isSensitiveKey`, `maskSql`,
   `maskPathByRoute`. Apply them exactly where `mappers.ts` applies them (`maskLogRecord`, labels, fields, `url.path`,
   `error.cause` via `maskJsonText` → for `error.cause` you may use the optional rule or fall back to `redactValue` of the
   JSON text; note which). `optional` rules: port if cheap, otherwise skip — your test must print
   `mask: required 5/5 · optional <passed>/<total> (skipped: a, b, c)`.
   **RE2 note:** the SDK's `EMAIL_RUN`, `THAI_ID` and `PAIR` regexes use lookbehind. Go `regexp` / Rust `regex` cannot;
   write those three as small hand scanners (C#: do the same so the work is comparable). The cases decide, not the regex.
4. **Map** every column of `logs` and `spans` as `mappers.ts` does. Spans: leave the I/O columns out of the insert
   (`req_*`, `res_*`, `msg_*`, `db_params`, `url_query`, `has_query` — ClickHouse defaults them) and put the remaining
   attributes in `attributes` (the engine's `splitSpanAttributes` removes the I/O keys first: `http.request.body`,
   `http.response.body`, `http.request.header.*`, `http.response.header.*`, `db.query.parameter.*`, `messaging.message.body`,
   `skilllane.*` capture keys — read `span-io.ts` for the list).
5. **Writer**: per table, buffer rows; flush when `ENGINE_FLUSH_ROWS` (5000) are waiting or `ENGINE_FLUSH_MS` (1000) passed;
   one insert in flight per table, the next batch waits; high-water = 4 × flushRows → the request answers 503 (HTTP) or
   the consumer pauses (Kafka). Insert = `POST <CLICKHOUSE_URL>/?query=INSERT INTO <db>.<table> FORMAT JSONEachRow`
   with `date_time_input_format=best_effort`, basic auth `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`, body = one JSON
   object per line, gzip the body. Same format as Node, so the comparison is about the language, not the protocol.
6. **Stats** line to stdout every 30 s: `logs <rows/s> rows/s (last insert <ms> ms, buffered <n>) · spans …`.
7. **Env**: `PORT` (5100), `CLICKHOUSE_URL` (http://localhost:8123), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
   `CLICKHOUSE_DATABASE` (skilllane_monitoring), `LOG_KAFKA_BROKERS` (empty = no consumer), `ENGINE_FLUSH_MS`,
   `ENGINE_FLUSH_ROWS`, `ENGINE_INGEST_MAX_INFLIGHT`.
8. **Dockerfile**: multi-stage; the build stage runs the mask test and fails the build if a required case fails; runtime
   image as small as the language allows (distroless / alpine / scratch). `docker build -t bench-ingest-<lang> bench/ingest-<lang>`
   must work from the repo root with no toolchain on the host. Print the image size in your README.
9. **README.md**: how to build, run, env, what is ported, what is skipped, lines of code (`wc -l` of sources).

## Must not

- No changes outside `bench/ingest-<lang>/`. Do not touch `apps/`, `bench/fixture/`, `bench/load/`.
- No secrets in the image. No network at test time except ClickHouse / Kafka given by env.
- Do not call Node or the SDK at runtime.

## Done when

- `docker build` succeeds (mask test green for every required case).
- Running the container with the repo's dev ClickHouse (`docker compose up -d clickhouse` at the repo root:
  http://localhost:8123, user/password `skilllane_monitoring`, database `skilllane_monitoring`; apply
  `clickhouse/schema.sql` first if the tables are missing) and posting every line of `bench/fixture/envelopes.jsonl` to
  `/api/ingest/<stream>` answers 202 for all 2,000 and the row counts in `logs` / `spans` for `env = 'bench'` equal the
  expected files' line counts. Use env `bench` only; delete your rows afterwards
  (`ALTER TABLE logs DELETE WHERE env = 'bench'`, same for spans).
- Report back: image size, LOC, mask coverage line, anything you could not make identical to Node and why.
