# skilllane-monitoring engine: engineering spec

Version 1 · 17 Oct 2026. Audience: the agents building the POC, then the team reviewing it.
Source of truth for the wire format: `skilllane-monitoring/packages/monitoring/src/contract/index.ts` (entry point `skilllane-monitoring/contract`). For storage: `clickhouse/schema.sql`.
Change either only with a reason, and record the change in §12.

## 1. Goal and POC rules

Show end to end: a NestJS app installs `skilllane-monitoring`, sets a few env vars, and its logs
and traces go through **the customer's own queue (Kafka, RabbitMQ or BullMQ, their choice)**
into ClickHouse through the **skilllane-monitoring engine**. The engine also serves a query API for the
monitoring frontend (Next.js, built only after the HTML design is approved) and the database
offers read-only SQL for AI.

Our job is publish and subscribe only. We never run or manage the customer's queue.

POC rules:
- Speed first. **No unit tests, no test files** (phase 2). Code must build and the demo must run for all three transports.
- Do not modify anything in `../skilllane-monitoring-handoff/` (copy from it instead).
- TypeScript everywhere. Nest apps are compiled with `tsc` (decorator metadata); never run them with tsx/esbuild.
- Keep files small and readable; comments in English; user-facing docs (README) in Thai.

## 2. Layout

```
skilllane-monitoring-engine/
  SPEC.md  README.md(TH)  package.json  pnpm-workspace.yaml  tsconfig.json  .env.example
  docker-compose.yml        infra only: clickhouse, kafka, rabbitmq, redis-telemetry, redis-app
  clickhouse/schema.sql     tables + materialized views (engine applies on boot; docker initdb too)
  clickhouse/users.sql      read-only user skilllane_monitoring_reader (docker initdb)
  ../skilllane-monitoring/  skilllane-monitoring (SDK, with the wire contract at `skilllane-monitoring/contract`), a separate repo, installed from npm
  apps/engine/              @skilllane/monitoring-engine: NestJS. ingest (subscribe → ClickHouse) + query API
  apps/demo-api/            @skilllane/monitoring-demo-api: NestJS sample app (school-core-api-like) + traffic generator
  scripts/                  demo.sh, chaos helpers
  docs/                     DATA-DICTIONARY.md (for people and AI)
  design/monitoring-ui/     HTML design mockups (separate track, see design/monitoring-ui/BRIEF.md)
```

## 3. Decisions

- **Engine in TypeScript/NestJS.** Load from SIZING.md: about 600 log lines/s average,
  2–3k/s peak, about 150 spans/s. Node with batched inserts (thousands of rows per insert)
  handles that with wide headroom; the limit is ClickHouse insert batching, not the language.
  Scale out by adding engine instances to the consumer group.
- **No OTel Collector.** The SDK publishes; the engine subscribes. The OTel SDK still runs inside the app to make spans.
- **An app without a queue posts to the engine** (`LOG_EXPORT=http`, or just `LOG_HTTP_URL`): the same envelope over
  HTTP, answered once the rows are in ClickHouse. A configured queue always wins. Trade-off: while the engine is down
  the items wait only in the app's memory (the publisher bounds), and the engine must be up to take live load.
- **Wire format: our JSON envelope**, not OTLP protobuf. Simplest across three transports,
  readable on the queue, easy for other languages later.
- **At-least-once.** The engine acks or commits only after ClickHouse accepted the rows.
  A redelivery can duplicate rows; acceptable for the POC.
- **One ClickHouse for all envs.** The `env` column separates dev / staging / prod; TTL differs per env.
- **The engine never sends its own telemetry to the queue** (it would loop). It logs to stdout only.
- **Metrics are derived from spans** in ClickHouse (`route_stats_1m`), not exported separately.
- **Traces store everything a request did, masked** (product owner, 18 Oct 2026): request and response headers and bodies
  of incoming and outgoing HTTP, the query string, SQL with its bind values, queue message payloads and headers, in every env.
  Masking is never weaker than school-core-api's own. The rules exist once, in `skilllane-monitoring/packages/monitoring/src/contract/mask` (`skilllane-monitoring/contract`),
  used by the SDK (masks before anything leaves the app), the engine (masks what other senders did not) and `seed-demo.js`:
  - **key rule** (`isSensitiveKey`): an object key, form / query / bind parameter name, bind column, header name, hash or
    stream field, Redis key segment or log label whose lower case contains `password`, `confirmpassword`, `token`, `secret`,
    `authorization`, `cookie`, `session`, `passwd`, `pwd`, `apikey` / `api_key` / `api-key`, `credential` or `privatekey`;
    or that has one of the words (split at camelCase, `_ - . :` …) `pass`, `pw`, `pwd`, `pin`, `otp`, `totp`, `cvv`, `cvc`,
    `passcode`, `passphrase`, `sid`, `sess`, `sig`, `signature`, `auth`, `authentication`, `oauth`, `jwt`, `refresh`, `creds`;
    or whose last word is `key` with `api`, `access`, `secret`, `private`, `client`, `signing`, `encryption` … before it
    → `[REDACTED]` (nested objects and arrays too). **Not** when it has two or more words and the last is metadata
    (`type`, `at`, `date`, `time`, `changed`, `expires`, `ttl`, `timeout`, `length`, `min`, `max`, `policy`, `enabled`, `count`,
    `hint`, `name`, `consent`, `format`, `version` …): `tokenType`, `passwordChangedAt`, `PASSWORD_CHANGED_AT`,
    `sessionTimeout` stay readable (the value rule still applies). In a query string or form also `code`, `key`, `ticket`.
    Headers `authorization`, `proxy-authorization` always; `cookie` and `set-cookie` keep the cookie names and the
    Set-Cookie attributes, values masked (`sid=[REDACTED]; Path=/; HttpOnly`). A URL path segment under a sensitive route
    parameter (`/reset-password/:token`) is masked.
  - **value rule** (`redactValue`) on every captured string: JWT, Bearer / Basic credentials, the credential after
    `Authorization:` whatever its scheme (`Digest`, `AWS4-HMAC-SHA256`, `Token`), URL userinfo (`scheme://user:[REDACTED]@`),
    any `name = value` / `"name": "value"` / `name: "value"` pair whose name the key rule matches (a quoted value whole), a
    string that is itself JSON (masked as JSON), email, Thai national id (checksum), and a 13-digit number that is one.
  - **bodies**: JSON by key and value (a BOM, UTF-16, single quotes, comments, NDJSON and a body cut at the cap go through a
    tolerant scan that fails closed: where it cannot follow the structure every sensitive `"name": value` pair is masked once
    more), form-urlencoded per field, multipart per field (`name*=` too; a part without a readable name is masked), XML / HTML
    by tag or `name=` / `key=` attribute, CSV by its header row, other text by the value rule.
  - **SQL**: a bind is masked by its name, or by the column the statement gives it (`col op x`, `x op col`, `LIKE`, `BETWEEN`,
    `IN (…)`, `(a, b) = (x, y)`, `x AS alias`, a call around the value such as `crypt($1, …)` / `SHA2(?, 256)`, the column
    lists of `INSERT … VALUES (…), (…)`, `INSERT … SELECT`, `INSERT ALL`, MERGE's `INSERT (cols) VALUES`); literals in the
    statement the same way; **fail closed**: in a statement that names a secret (an identifier the key rule matches:
    `CALL change_password(?, ?)`) a bind whose column cannot be read is masked too and marked `masked: 'unresolved'`.
  - **Redis**: AUTH / HELLO / MIGRATE / CONFIG SET / ACL credentials, a key whose prefix segment is a secret keeps the prefix
    (`session:[REDACTED]`, `password_reset:[REDACTED]`, `reset:`, `verify:` …), values under a sensitive key, hash or stream
    field, EVAL arguments of a script that touches a sensitive key; ids built the same way (BullMQ job ids, Kafka message keys).
  - **logs**: the same rules on message, error text, hint and fix, `user.id`, `job.id`, `dependency.*`, `url.path` and on
    every label by its key (legacy metadata `{ newPassword }` becomes the label `newPassword: [REDACTED]`).
  The SDK masks and caps (`LOG_BODY_MAX_BYTES`, default 65536 per body; at most that much of a value is ever looked at) and
  writes `skilllane.monitoring.mask` = `MASK_VERSION` into the envelope resource; the engine stores those items as they are and masks every
  other sender's (no `skilllane.monitoring.mask`, or an older version) with the same rules. The marker is a promise of the sender, not a check.
  **Phone numbers and other personal data** beyond email and Thai national id (names, addresses, birth dates, Thai mobile
  numbers `0[689]xxxxxxxx`) are stored as they are: they are not in the agreed list. Open decision for the product owner; to
  mask phones, add the words `phone`, `mobile`, `tel` to the key rule and the value pattern `(?<!\d)0[689]\d{8}(?!\d)` in
  `skilllane-monitoring/packages/monitoring/src/contract/mask`, then rebuild and restart the SDK users and the engine.

## 4. Wire contract

- One message = one `Envelope` encoded as UTF-8 JSON: `{ v: 1, stream: 'logs'|'spans', resource, sentAt, items }`.
- `logs` items: the flat ECS record exactly as `skilllane-monitoring` writes to stdout (already redacted).
- `spans` items: `SpanItem`, an OTel `ReadableSpan` converted; times are nanosecond decimal strings.
- `resource`: `service.name` (without role), `service.version`, `deployment.environment.name`, `host.name`, `app.role`,
  and `skilllane.monitoring.mask` (the `MASK_VERSION` of the rules the items were masked with, §3; skilllane-monitoring sets it).
- One message stays under `LOG_EXPORT_MAX_BYTES` (default 800000); the publisher splits bigger batches, and a span item
  over it has its largest values cut (bodies, header / parameter JSON kept valid, statements, a stack) instead of being dropped.

| | Kafka | RabbitMQ | BullMQ |
|---|---|---|---|
| Destination | topics `skilllane-monitoring.logs`, `skilllane-monitoring.spans` | durable direct exchange `skilllane-monitoring.telemetry`; routing key = topic name; durable queue with the same name bound to it | queues `skilllane-monitoring.logs`, `skilllane-monitoring.spans` on the customer's Redis (prefix `bull`) |
| Message | value = JSON; key = `<service>/<role>`; headers `skilllane-monitoring-stream`, `skilllane-monitoring-v`; GZIP compression | body = JSON; persistent; contentType `application/json`; same headers; confirm channel | job name = stream; data = the envelope object; attempts 5, exponential backoff 1 s, removeOnComplete true, removeOnFail 1000 |
| Who creates it | the engine creates missing topics on boot (`ENGINE_KAFKA_PARTITIONS`, default 3); compose also allows auto-create | both sides assert the exchange, queues and bindings (idempotent) | implicit |
| Engine consumes | group `ENGINE_CONSUMER_GROUP` (default `skilllane-monitoring-engine`), `eachBatch`, commit after insert | prefetch `ENGINE_CONCURRENCY`; ack after insert; nack + requeue on insert failure; nack without requeue on invalid JSON | one Worker per queue, concurrency `ENGINE_CONCURRENCY`; the processor resolves after insert and throws on failure (BullMQ retries) |

The publisher must not trace or log-loop itself: every publish runs inside
`context.with(suppressTracing(ROOT_CONTEXT), …)` and its own clients must not feed spans or log lines back into the stream on every send.

## 5. Environment variables

SDK and engine read the same `.env`; `LOG_EXPORT` picks the queue for both.

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `LOG_EXPORT` | both | auto | `kafka` · `rabbitmq` · `bullmq` · `http` · `otlp` · `stdout`. Empty: the first configured of Kafka brokers, RabbitMQ URL, BullMQ Redis URL, `LOG_HTTP_URL`, OTEL endpoint; else stdout. stdout is always written by the SDK. The engine consumes only the queues; `http` there means no consumer |
| `LOG_KAFKA_BROKERS` | both | – | `host:port,host:port` |
| `LOG_KAFKA_CLIENT_ID` | both | `skilllane-monitoring-<service>` / `skilllane-monitoring-engine` | |
| `LOG_KAFKA_SSL` / `LOG_KAFKA_SASL_MECHANISM` / `LOG_KAFKA_SASL_USERNAME` / `LOG_KAFKA_SASL_PASSWORD` | both | off | customer Kafka auth (`plain`, `scram-sha-256`, `scram-sha-512`) |
| `LOG_RABBITMQ_URL` | both | – | `amqp://user:pass@host:5672/vhost` |
| `LOG_RABBITMQ_EXCHANGE` | both | `skilllane-monitoring.telemetry` | |
| `LOG_BULLMQ_REDIS_URL` | both | – | `redis://host:6379/0` |
| `LOG_BULLMQ_PREFIX` | both | `bull` | |
| `LOG_HTTP_URL` / `LOG_HTTP_TOKEN` | SDK | – | no queue: the engine's base URL; the token only when the engine sets `ENGINE_INGEST_TOKEN` (or as `https://<token>@host`) |
| `LOG_TOPIC_LOGS` / `LOG_TOPIC_SPANS` | both | `skilllane-monitoring.logs` / `skilllane-monitoring.spans` | topic or queue names |
| `LOG_EXPORT_BATCH_MS` / `LOG_EXPORT_BATCH_SIZE` / `LOG_EXPORT_MAX_QUEUE` / `LOG_EXPORT_MAX_BYTES` | SDK | 1000 / 500 / 10000 / 800000 | publisher batching; when the in-memory queue is full the oldest items are dropped |
| `LOG_EXPORT_SHUTDOWN_MS` | SDK | 3000 | flush time on shutdown and crash |
| `LOG_EXPORT_MAX_QUEUE_BYTES` | SDK | 67108864 | bound of the heap held by what waits in memory per stream (oldest dropped), next to the count bound: spans carry bodies. An item with any non-Latin-1 character (Thai) counts 2 bytes per character, as V8 stores it |
| `LOG_CAPTURE` | SDK | `all` | `off` = no headers, bodies, binds or payloads are captured (values an app writes itself are still masked) |
| `LOG_BODY_MAX_BYTES` | SDK | 65536 | first bytes kept of each body / payload (cut values flagged `truncated`, the real size kept) |
| `LOG_CAPTURE_SKIP_ROUTES` | SDK | – | comma-separated prefixes of an incoming path or an outgoing path / URL (`/health,https://s3.`) whose bodies are not read (headers + size only) |
| `OTEL_SERVICE_NAME`, `APP_ROLE`, `OTEL_ENV`, `SERVICE_VERSION` | SDK | package.json, –, NODE_ENV | resource of every envelope (unchanged from the handoff library) |
| `CLICKHOUSE_URL` | engine | `http://localhost:8123` | |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | engine | `skilllane_monitoring` / `skilllane_monitoring` | writer (ingest, schema) |
| `CLICKHOUSE_READER_USER` / `CLICKHOUSE_READER_PASSWORD` | engine | `skilllane_monitoring_reader` / `skilllane_monitoring_reader` | query API |
| `CLICKHOUSE_DATABASE` | engine | `skilllane_monitoring` | |
| `ENGINE_ROLE` | engine | `all` | `ingest` · `api` · `all` |
| `ENGINE_PORT` | engine | `5100` | HTTP (health + query API) |
| `ENGINE_APPLY_SCHEMA` | engine | `true` | run `clickhouse/schema.sql` on boot |
| `ENGINE_CONSUMER_GROUP` | engine | `skilllane-monitoring-engine` | Kafka group id |
| `ENGINE_KAFKA_PARTITIONS` | engine | `3` | partitions of topics the engine creates |
| `ENGINE_CONCURRENCY` | engine | `50` | RabbitMQ prefetch, BullMQ worker concurrency |
| `ENGINE_FLUSH_MS` / `ENGINE_FLUSH_ROWS` | engine | `1000` / `5000` | ClickHouse insert batching per table |
| `ENGINE_CORS_ORIGIN` | engine | `*` | for the Next.js frontend on :3300 |
| `ENGINE_INGEST_HTTP` | engine | `true` | `false` = `POST /api/ingest/*` answers 404 |
| `ENGINE_INGEST_TOKEN` | engine | – | optional bearer tokens, comma-separated (rotation); empty = no token asked (keep the port internal) |
| `ENGINE_INGEST_MAX_BYTES` | engine | `2000000` | largest ingest body after gzip is undone (413 above) |
| `ENGINE_INGEST_MAX_INFLIGHT` | engine | `64` | ingest requests written at once; more answer 503 + `Retry-After` |
| `SKILLLANE_MONITORING_ADMIN_USERNAME` / `SKILLLANE_MONITORING_ADMIN_PASSWORD` | engine | – | the admin login, taken exactly as set and checked on every login; unset = no admin login |
| `SKILLLANE_MONITORING_AUTH_SECRET` | engine | random per process | HS256 key of sessions (set it for more than one api engine, or sessions end at restart) |
| `SKILLLANE_MONITORING_SESSION_HOURS` | engine | `8` | session lifetime |
| `CLICKHOUSE_CONFIG_DATABASE` | engine | `<CLICKHOUSE_DATABASE>_config` | users and roles; the writer user reads and writes it, `skilllane_monitoring_reader` has no grant |

## 6. Ports and credentials (host side)

| What | Port | Notes |
|---|---|---|
| ClickHouse HTTP / native | 8123 / 19000 | admin+writer `skilllane_monitoring`/`skilllane_monitoring`, reader `skilllane_monitoring_reader`/`skilllane_monitoring_reader`, db `skilllane_monitoring` |
| Kafka (external listener) | 29092 | KRaft single node; auto-create topics on |
| RabbitMQ AMQP / management UI | 5673 / 15673 | `skilllane_monitoring`/`skilllane_monitoring`, vhost `/` |
| Redis for the BullMQ transport | 6390 | telemetry only |
| Redis of the demo app itself (cache, business jobs) | 6391 | stopped by the chaos script |
| engine | 5100 | `/api/*` |
| demo `school-core-api` / `school-etl-api` | 5101 / 5102 | |
| Next.js frontend (later) | 3300 | |

Compose project name `skilllane-monitoring-engine`. Busy on this machine, do not use: 5672, 6379, 6380, 9000, 9092, 19094, 3001, 8080, 1025, 8025.
Images: `clickhouse/clickhouse-server:25.8`, `apache/kafka:4.3.1`, `rabbitmq:4.1-management`, `redis:7.4-alpine` (pin; adjust only if a tag does not exist, and note it in §12).

## 7. ClickHouse

Database `skilllane_monitoring`; tables `logs`, `spans`, `trace_index` (+ MV), `route_stats_1m` (+ MV). See `clickhouse/schema.sql`.
Insert with `@clickhouse/client`, `format: 'JSONEachRow'`, setting `date_time_input_format: 'best_effort'`.
Logs `timestamp` = the ISO `@timestamp`. Spans `timestamp` = `nanosToDateTime64(startTimeUnixNano, 6)` from the contract.

**Log item → `skilllane_monitoring.logs` row.** Missing values: `''` for strings, `0` for numbers, `[]` for arrays, `null` for `duration_ms`.

| Column | From |
|---|---|
| timestamp | `@timestamp` |
| env, service, role, version, host | resource `deployment.environment.name` / `service.name` / `app.role` / `service.version` / `host.name`; fallbacks: record `service.environment`, the part of record `service.name` after `/`, record `service.version`, record `host.name`; env `unknown` if none |
| level, logger, event_code, event_module, message | `log.level`, `log.logger`, `event.code`, `event.module`, `message` |
| trace_id, span_id, correlation_id | `trace.id`, `span.id`, `labels.correlation_id` |
| user_id, user_roles, organization_id | `user.id`, `user.roles`, `organization.id` |
| http_method, http_route, url_path, url_domain, http_status, duration_ms | `http.request.method`, `http.route`, `url.path`, `url.domain`, `http.response.status_code`, `duration_ms` |
| error_type, error_code, error_message, error_hint, error_hint_detail, error_fix, error_stack, error_cause | `error.type`, `error.code`, `error.message`, `error.hint`, `error.hint_detail`, `error.fix`, `error.stack_trace`, `error.cause` (JSON string) |
| error_category, error_target, usecase, failed_step | `labels.error_category`, `labels.error_target`, `labels.usecase`, `labels.failed_step` (removed from `labels`) |
| origin_function, origin_file, db_statement | `log.origin.function`, `log.origin.file.name`, `db.statement` |
| dependency_type, dependency_name, dependency_host, dependency_port | `dependency.*` |
| job_queue, job_type, job_id, job_attempt, job_max_attempts, job_final, job_inflight | `job.*` (`job.final` true → 1) |
| reason | `reason` |
| labels | remaining `labels` |
| fields | every other key; strings as is, anything else `JSON.stringify` (e.g. `dependency.affects`, `dependency.attempt`, `signal`, `dlq`, `partitions`, `server.port`) |

**Span item → `skilllane_monitoring.spans` row.**

| Column | From |
|---|---|
| timestamp, duration_ns | `startTimeUnixNano`; `endTimeUnixNano - startTimeUnixNano` |
| env, service, role, version, host | resource (same as logs) |
| trace_id, span_id, parent_span_id | `traceId`, `spanId`, `parentSpanId` (`''` for a root) |
| is_entry | 1 when `parentSpanId` is empty or `parentIsRemote` is true |
| name, kind, status_code, status_message, scope_name | `name`, `kind`, `status.code`, `status.message`, `scope.name` |
| http_method | attr `http.request.method` ?? `http.method` |
| http_route | attr `http.route` |
| http_status | attr `http.response.status_code` ?? `http.status_code` |
| url_path | attr `url.path` ?? path of `http.target` ?? path of `url.full` / `http.url` (never the query string) |
| db_system, db_statement | attr `db.system.name` ?? `db.system`; `db.query.text` ?? `db.statement` (max 2000 chars) |
| peer | attr `server.address` ?? `net.peer.name` (+ `:port` when known) |
| exception_type, exception_message | first event named `exception`: `exception.type`, `exception.message` |
| attributes, resource | all attributes / resource as `Map(String, String)` (non-strings JSON-encoded), **except** the captured I/O attributes below (they go only to their columns, so queries that read the map never read bodies) and the statement (`db.query.text` / `db.statement`: it is `db_statement` / `db_statement_full`) |
| events | `JSON.stringify(events ?? [])` |

**Captured I/O → `skilllane_monitoring.spans` columns** (the monitor's Network view; `''` / `0` when not captured; same TTL as the row).
The SDK sets these attributes already masked and capped (§3) and says so in the envelope resource (`skilllane.monitoring.mask`). The other
names are fallbacks for other instrumentations (school-core-api's own hooks, oracledb `enhancedDatabaseReporting`, TypeORM
`collectParameters`, pg); the engine always masks those, with the same rules (`skilllane-monitoring/contract` src/mask, via
`apps/engine/src/ingest/mask.ts`). For a sender without `skilllane.monitoring.mask` (another SDK, an older skilllane-monitoring) the engine also masks
everything else: these columns, `url.full` / `http.url` / `http.target`, every other attribute (key and value rule), events,
status and exception text, `db_statement`, `url_path`, `name`; a body or JSON value over 256 KB is cut there and flagged.

| Column | From |
|---|---|
| url_query | attr `url.query`, without a leading `?` |
| req_headers / res_headers | attr `http.request.headers` / `http.response.headers`: JSON object string, lower-case names, value string or string[]; else the semconv per-header attrs `http.request.header.<name>` / `http.response.header.<name>` (`_` → `-`) |
| req_header_count / res_header_count | number of header names in those (UInt16), counted at ingest so `/api/traces/:id` never reads the JSON |
| req_body / res_body | attr `http.request.body` / `http.response.body`: masked text (JSON re-serialised compact, text as text, form-urlencoded masked per key, multipart = JSON summary `{fields, files:[{name, filename, type, size}], more?: {parts, bytes}}` (`more`: the parts after the first 1,000 / 64 KB of summary, only counted), binary = `''`) |
| req_body_size / res_body_size | attr `http.request.body.size` / `http.response.body.size` (original bytes); else the byte length of the body |
| req_body_truncated / res_body_truncated | attr `http.request.body.truncated` / `http.response.body.truncated`; else 1 for school-core-api's own cut (exactly 1003 characters ending `...`, no size or flag) |
| db_params | attr `skilllane.monitoring.db.parameters`: JSON array `[{key, type, value, column?, truncated?}]` in bind order (`key` = the name of a `:name` bind, else `"1"`, `"2"` …; `type` = string, number, bigint, boolean, null, date, buffer, object; `value` = its text: date ISO-8601, buffer hex, object JSON; `column` = the column the placeholder binds to when the statement says; `truncated` = the value was cut; `masked: 'unresolved'` = masked because the statement names a secret and the bind's column could not be read (§3); a last `{key: '…', type: 'null', value: '<n> more', truncated: true}` = the list was cut). Fallbacks: `db.query.parameter.<key>`, `db.operation.parameter.<key>` (a 0-based index becomes `"1"` …), `db.statement.parameters` (TypeORM JSON of named or positional params), `db.postgresql.values` (string[], `'null'` = NULL); type from the JS value (an ISO-8601 string → date, a JSON Buffer → buffer) |
| db_param_count | number of bind values (UInt16) |
| db_statement_full | the whole `db.query.text` ?? `db.statement` when it is longer than the 2000 characters `db_statement` keeps, else `''`. Redis: the full command with its arguments, masked by the SDK and quoted the way redis-cli reads it (an argument with spaces or quotes in `'…'` or `"…"`, a cut one followed by ` …`, `(<n> more)` for arguments past the cap) |
| msg_body / msg_headers | attr `messaging.message.body` (Kafka value, RabbitMQ content, BullMQ `job.data`) / `messaging.message.headers` (JSON object: Kafka headers, RabbitMQ `properties.headers`, BullMQ job name + opts), on consumer / job and producer spans |
| msg_body_size / msg_body_truncated | attr `messaging.message.body.size` (else its byte length) / `messaging.message.body.truncated` (else 1 when the size is larger than the text and the text is no longer whole JSON) |

## 8. Engine (`apps/engine`)

Modules: `ClickhouseModule` (clients, schema apply), `IngestModule` (when role is `ingest` or `all`), `QueryModule` (when role is `api` or `all`; `GET /api/health` always).

### Ingest

- Picks the transport with `resolveExportMode()` from the contract; `http` / `otlp` / `stdout` → no consumer (warn, or
  info when HTTP ingest is on).
- HTTP ingest (`ingest/http-ingest.controller.ts`, roles `ingest` / `all`, on unless `ENGINE_INGEST_HTTP=false`):
  `POST /api/ingest/logs|spans`, open by default (the app needs only the URL; a boot warning says to keep the port
  internal), a bearer token compared in constant time when `ENGINE_INGEST_TOKEN` is set, JSON body (gzip undone by the body parser,
  `ENGINE_INGEST_MAX_BYTES`), same `EnvelopeHandler` as the consumers. `202 {items}` once the rows are inserted;
  `503` + `Retry-After` while the writer is at its backpressure mark, `ENGINE_INGEST_MAX_INFLIGHT` requests are being
  written or the insert failed (the SDK keeps and retries); `400` for a non-envelope, an unknown stream or an envelope
  posted to the other stream's path, `413` too large (the SDK drops these); `401` bad token (token set); `404` ingest off.
  Runs next to a queue consumer when both are configured.
- A shared `ClickhouseWriter` buffers rows per table, flushes at `ENGINE_FLUSH_ROWS` or every `ENGINE_FLUSH_MS`,
  and gives every enqueue a promise that settles when its rows are inserted. Consumers ack/commit on that promise.
- Bad envelopes are logged (count + first error) and skipped; they never stop the consumer.
- Masking (§3, §7): items of a sender whose resource carries `skilllane.monitoring.mask` ≥ `MASK_VERSION` are stored as sent; any other
  sender's logs and spans are masked with the shared rules before the insert (labels by key always).
- Logs to stdout every 30 s: rows/s per table, last insert latency, queue lag if cheap to read.

### Users, roles, sessions (`apps/engine/src/auth`, roles `api` / `all`)

- Global `AuthGuard`: every route needs a session (cookie `skilllane_monitoring_session`, or `Authorization: Bearer`) except
  `@Public()`: `/api/health`, `/api/ingest/*`, `/api/auth/login|logout|set-password|invite/:token`. 401 = no or bad
  session.
- Permissions (`auth/permissions.ts`): view `overview`, `logs`, `traces` (incl. span detail), `errors`, `jobs` (incl.
  `/api/dependencies`), `topology`; manage `users`, `roles`. A role holds grants `{ permission, envs }` (`envs` empty =
  every env; manage permissions are always every env). A user gets the union of all their roles as (permission, env)
  pairs. `/api/meta` needs only a session and leaves out envs the user cannot read. A view permission limited to some
  envs needs `env` set to one of them (403 otherwise): such a user reads one env at a time; `/api/meta` then says
  `envsLimited: true` and the monitor drops "ทุก env".
- Admin = `SKILLLANE_MONITORING_ADMIN_USERNAME` / `SKILLLANE_MONITORING_ADMIN_PASSWORD` (no row; every permission; shown read-only in the user list).
  Roles `admin` (builtin, every permission, cannot change) and `viewer` (every view permission) are created once.
- Users: `POST /api/users` (username, name, roleIds) answers a set-password link token (72 h, one use, only its sha256
  stored); `PATCH /api/users/:id`, `POST …/ban|unban|reset-password`, `DELETE`. Roles: `GET|POST /api/roles`,
  `PATCH|DELETE /api/roles/:id` (409 with the users while in use, `?force=true` takes it off them),
  `GET /api/auth/permissions` (catalog for the form). Rules: nobody hands out, takes away or edits a role beyond their
  own grants, or acts on a user who holds more; nobody changes their own account there; passwords ≥ 12 characters,
  scrypt; 5 failed logins per username in 15 min → 429.
- Ban, reset, delete and a password change bump `token_version`: older sessions fail at once on this engine and within
  10 s (cache) on others. Storage: ReplacingMergeTree(updated_at) tables `users`, `roles` in the config database,
  read with FINAL, written by the writer user.

### Query API (`/api`, JSON, camelCase)

Common query params: `env` (omitted = all envs), `from`, `to` (ISO or `now-15m|now-1h|now-6h|now-24h|now-7d`; default `now-1h`..`now`),
`service`, `role`, `step` (series bucket: seconds or `1m|5m|15m|1h|1d`, whole minutes, ≤ 2000 buckets). Series step by range when
`step` is absent: ≤1 h → 1 m, ≤6 h → 5 m, ≤24 h → 15 m, ≤30 d → 1 h, else 6 h (always ≤ 2000 buckets, so echoing `range.stepSeconds` back as `step` is accepted). Series buckets start at `from` rounded down to the minute
(`t` = bucket start); with a step above 1 m a remainder under a minute (the seconds of `now-24h`) joins the last bucket, so
`from=now-24h&step=1h` gives 24 buckets; with 1 m the current partial minute is its own last bucket.
`route` params take `METHOD /path` (the form every response uses, e.g. `GET /me`), the old `/path`, or a job key `<queue> <type>`.
Every query uses ClickHouse query parameters (`{name:Type}`), never string concatenation of user input. Use the reader user.
`fingerprint` values are strings (UInt64 exceeds JS numbers).

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{ ok, clickhouse: boolean, role, transport, pending }`; answers within 1 s even while the broker is down (`pending: null` when it cannot be read in 700 ms) |
| `GET /api/meta` | params `env, service` (narrow `releases` / `deploys` only) → `{ envs: string[], services: [{ service, roles: string[], envs: string[] }], releases: Release[], deploys: [{ service, env, version, at, previousVersion }], now }` |
| `GET /api/overview` | `{ range:{from,to,stepSeconds}, services:[{service,role,kind,requests,errors,errorRate,p95Ms,rpm,spark:number[]}], series:[{t,requests,errors,p95Ms}], routes:[{service,role,kind,route,method,path,requests,errors,errorRate,avgMs,p50Ms,p95Ms,p99Ms,clientErrors,clientErrorRate}] (top 20; `route` = `METHOD /path` or the job key, `method`/`path` '' for jobs), errorGroups: ErrorGroup[] (top 8), errorGroupsSpark: ErrorSpark, dependencies: Dependency[], jobs: JobStat[] }` |
| `GET /api/logs` | params `q` (case-insensitive substring of `message`, `error_message`, `error_fix`, `error_hint`, `error_target`, `error_code`, the request as `METHOD /route` (`GET /classes/:id/students`) or `url_path`), `level (comma list), event (a code, a prefix like job.*, or a comma list of codes), traceId, userId, jobId, route, category, fingerprint (decimal UInt64), limit (≤500, default 100), before (ISO cursor)` → `{ rows: LogRow[], histogram:[{t,debug,info,warn,error,fatal}], levelCounts:{debug,info,warn,error,fatal,requestError}, nextBefore }` (`levelCounts` = the whole range with every filter except `level`; `requestError` = its error lines that are `http.request` lines); error rows get `httpStatus` / `requestDurationMs` (and `http.status` / `durationMs` when missing, except on outbound lines: `http.domain` set or `http.outbound_failed`) from the `http.request` line of the same trace + service + role |
| `GET /api/traces` | params `route, status (error|ok), minMs, kind, traceId (32 hex, or a prefix of ≥ 4 hex), sort (timestamp (default, newest first) | durationMs (slowest first)), sample (spread | comma list of errors, slow, spread), entries (top (default) | all), slowMs (threshold of totalSlow, default 2000), limit (≤500, default 200)` → `TraceList` (entry spans; `entries=top` leaves out downstream HTTP entries — SERVER entry spans with a parent span, i.e. a service called by another service, a hop of its caller's trace — unless `service`, `role` or `route` is given; `all` = every entry span) |
| `GET /api/traces/:traceId` | `{ traceId, env, start, durationMs, spanCount, errorCount, services, spans: SpanRow[], logs: LogRow[] }` (spans with `io`) |
| `GET /api/traces/:traceId/spans/:spanId` | param `env` → `SpanDetail`: one span with everything it captured (the Network panel). 404 JSON `{ statusCode, message, error }` for an unknown trace or span; 400 for an id that is not 32 / 16 hex |
| `GET /api/errors` | params `category, level (comma list; the group's most severe level), sort (count (default) | lastSeen | firstSeen, newest first), sparkBuckets (1–120, default 24), limit (≤500, default 100)` → `{ groups: ErrorGroup[], spark: ErrorSpark }` |
| `GET /api/errors/:fingerprint` | `{ group: ErrorGroup, spark: ErrorSpark, versions:[{version,count,firstSeen,lastSeen}] (all retained data, oldest first), series:[{t,count}], routes:[{route,count}], usecases:[{usecase,count}], recent: LogRow[] (20, with the request join of /api/logs), traceIds: string[] }` |
| `GET /api/jobs` | `{ stats: JobStat[], recentFailures: LogRow[], consumerEvents: LogRow[] }` |
| `GET /api/dependencies` | `{ dependencies: Dependency[], events: LogRow[] }` (dependency.* and http.outbound_failed lines) |
| `GET /api/topology` | params common (`service` / `role` keep the edges touching that service) → `Topology`: the system map from spans (+ watched dependencies from dependency.* lines) |

Shapes:
- `LogRow = { timestamp, env, service, role, version, level, logger, eventCode, eventModule, message, traceId, spanId, userId, organizationId, http:{method,route,path,status}|null, durationMs, httpStatus: number|null, requestDurationMs: number|null, error:{type,code,message,hint,hintDetail,fix,category,target,stack,originFunction,originFile}|null, usecase, failedStep, dependency:{type,name,host,port}|null, job:{queue,type,id,attempt,maxAttempts,final}|null, labels, fields }`
  (`http.route` stays the bare template next to `http.method`; `httpStatus` / `requestDurationMs` = the request the line was written in: an `http.request` line's own values, an error line's from the join, else null)
- `TraceList = { rows: TraceRow[], total, totalErrors, totalTraces, totalErrorTraces, totalSlow, slowMs, sample: ('errors'|'slow'|'spread')[] | null }` (`total` / `totalErrors` = entry spans in the range matching every filter: requests + every job / message attempt; `totalTraces` / `totalErrorTraces` = their distinct traces / distinct traces with an error entry; `totalSlow` = HTTP entries (kind SERVER) that are not errors and took ≥ `slowMs`)
- `TraceRow = { traceId, spanId, timestamp, service, role, name, kind, method, route, httpRoute, status, statusCode, isError, downstream, durationMs, spanCount, errorCount, services, job:{queue,type,id,attempt,maxAttempts,module}|null, sample: 'errors'|'slow'|'spread'|null }`
  (`downstream` = an HTTP entry called by another service; only listed with `entries=all` or a service / role / route filter)
  (`spanId` = the entry span; `route` = `METHOD /path` for HTTP, else the span name `<queue> <type>`; `httpRoute` = the bare template; `job` for non-HTTP entries from the span attributes `job.*` / `messaging.*`, else the job.* log lines of that span; `attempt` / `maxAttempts` 0 when unknown; `module` = `event.module` / `messaging.system` of the span, else of its job lines, '' when unknown).
  `sample`: `spread` = `errors,slow,spread`; parts run in that order on the `limit` budget: `errors` = error entries, at most half the limit when other parts follow (more → spread over time), plus the budget the later parts leave unused (e.g. `status=error`); `slow` = slowest of the rest, HTTP entries first (long jobs never take the slots of slow requests; jobs fill what HTTP entries leave), a fifth of the limit (or what `errors` leaves without `spread`); `spread` = the rest, evenly over min(left, series buckets) time buckets (one per bucket before any second, a stable pseudo-random pick). Rows come back sorted by `sort`.
- `ErrorSpark = { from, stepSeconds, buckets }`: `ErrorGroup.spark[i]` counts [from + i·step, from + (i+1)·step), every bucket exactly one step; `stepSeconds` = the range's whole minutes / `sparkBuckets` rounded up to whole minutes (at least 60), `buckets` = enough to cover the range, never more than `sparkBuckets`; the grid is laid back from `to`: the last bucket is the last step before `to` (to the second), `from` = to − buckets × step (not rounded to the minute); when the range is not a whole number of steps the first bucket starts before the range and holds less, and a remainder under a minute joins the first bucket instead of opening one (15 min → 15 × 60, 1 h → 20 × 180, 24 h → 24 × 3600, 35 min → 18 × 120 whose first bucket holds 1 min of data)
- `SpanRow = { traceId, spanId, parentSpanId, service, role, version, name, kind, startTime (ISO, µs), durationMs, statusCode, statusMessage, http:{method,route,status,path}|null, db:{system,statement}|null, peer, exception:{type,message}|null, attributes, events, io: SpanIo }`
  (`db.statement` = the first 2000 characters; `SpanDetail.db.statement` has all of it)
- `SpanIo = { hasQuery, reqHeaders, resHeaders, reqBytes, resBytes, reqTruncated, resTruncated, params, msgBytes }`: lengths only, from the size / count columns (never the JSON or bodies): header names, original body bytes, the SDK's cut, bind values, message body bytes; zeros when nothing was captured
- `SpanDetail = SpanRow & { http, db, message, timing }`, with:
  `http: { method, route, status, path, url, remoteAddress, userAgent, query: [k, v][], requestHeaders: [k, v][], responseHeaders: [k, v][], requestBody: Body, responseBody: Body } | null`
  (`url` = `scheme://host[:port]/path?query`, default ports left out: an outgoing call from `url.full`, an incoming request as the client addressed it (Host header, `x-forwarded-proto`) else `server.address` / `server.port`, the query from `url_query`; `remoteAddress` = the other end: the caller of an incoming request (`client.address` else `network.peer.*`), the server of an outgoing call (`network.peer.*` else `peer`); header pairs in the order sent, a repeated header one pair per value; method / status fall back to the attributes, so an S3 / rpc span shows its HTTP exchange);
  `Body = { text, size, truncated, contentType }` (`contentType` from its headers);
  `db: { system, name, operation, table, statement (whole), dialect: 'oracle'|'postgres'|'mysql'|'mssql'|'sqlite'|'other' (from db_system), params: [{key, type, value, column?, truncated?}] } | null`;
  `message: { system (messaging.system ?? event.module), destination (messaging.destination.name ?? job.queue), operation (messaging.operation.type ?? process / send by kind), id, headers: [k, v][], body: Body } | null` (CONSUMER / PRODUCER spans, or any with a message captured);
  `timing: { start, durationMs, offsetMs }` (`offsetMs` from the trace start)
- `ErrorGroup = { fingerprint, env, service, role, roles, level, errorType, errorCode, hint, hintDetail, category, target, fix, originFunction, originFile, count, users, firstSeen, lastSeen, firstSeenVersion, isNew, spark:number[], routes:string[], usecases:string[], sampleTraceId, sampleMessage, errorCount, warnCount, sparkError:number[], eventModule, dependencyType, httpStatus }` (`role` = the latest occurrence's, `roles` = every role with an occurrence in the range, sorted; `count`, `users`, routes (`METHOD /path`), `spark` … cover the range; `errorCount` / `warnCount` / `sparkError` split them by level (error + fatal vs warn: a job group's job.failed vs job.retry lines); `eventModule` / `dependencyType` of the latest occurrence; `httpStatus` = what the latest occurrence's request answered (the `http.request` line of its trace, same service + role), else the line's own non-outbound status, 0 when none; `firstSeen` / `lastSeen` / `firstSeenVersion` cover all retained data of the fingerprint; `isNew` = first seen at or after its service's `deployedAt` and that service ran an earlier version before, never for category `dependency` or `input`)
- `Release = { env, service, currentVersion, deployedAt, previousVersion, versions:[{version,firstSeen,lastSeen}], roles:[{ role, currentVersion, deployedAt, previousVersion, versions }] }` from the `version` of log lines over all retained data: current = the version with the latest line, `deployedAt` = first line of the current version, `previousVersion` = the version first seen last before it (`''` when none). A deploy = a version first seen after another version of the same service + env (the first version in the data is not one)
- `Dependency = { service, role, type, name, host, port, state:'down'|'degraded'|'up', since, lastEventAt, attempts, outboundFailures, lastRecoveredAt, lastOutageFrom, lastOutageMs, affects }` (one row per service + role + type + name + **host:port**, each from that target's own lines; state from the latest `dependency.down|still_down|up` line of the row; the last finished outage = the row's latest recovery line (`dependency.up`, reason not `connected`, with a duration) merged with every recovery of the same env + type + name + host:port whose down window (up − duration_ms) overlaps it, whatever process wrote it and whatever the service / role filter: `lastRecoveredAt` = the last of their up lines, `lastOutageFrom` = the earliest start, `lastOutageMs` = the union of their windows, so every row of one outage carries the same numbers; null without a recovery in the 7-day lookback; `degraded` = not down, the range has `http.outbound_failed` lines for it and no `dependency.down|still_down`, `since` = the first of them; the SDK writes one `dependency.up` with `reason: 'connected'` per watched dependency when a process first connects, so healthy dependencies are listed as `up` too)
- `JobStat = { module, queue, type, started, finished, retried, failed, p95Ms }` (from `job.*` lines)
- `Topology = { range:{from,to,minutes}, nodes: TopologyNode[], edges: TopologyEdge[] }`;
  `TopologyNode = { id, kind:'clients'|'service'|'queue'|'dependency', label, type, service, role, host, names:string[], requests, errors, errorRate, callsPerMin, p95Ms, state:'down'|'degraded'|'up'|null }`
  (ids `clients`, `service:<service>/<role>`, `queue:<name>`, `dependency:<type>:<name>`: one dependency node per type + name whatever host it was seen on (name = the SDK's dependency name for that host:port, BullMQ's own `bull:` commands going to its `queue` connection when one server has several, else the database system, rpc service or HTTP host), readable `label` (Oracle, Redis queue, AWS S3, Google Sheets, ThaID), `host` = its host:port list joined with `, ` (most calls first); service nodes carry RED of their entry spans (`route_stats_1m` minutes starting in [from, to)), a dependency the calls it receives, a queue the messages consumed, clients the requests sent, each with `p95Ms` over every span of those edges (a log-scale duration histogram per row, 32 buckets per doubling, merged in the engine, ±1.1 %), never the highest edge p95; `names` / `state` from dependency.* lines);
  `TopologyEdge = { id:'<source>-><target>', source, target, kind:'http'|'db'|'rpc'|'produce'|'consume'|'call', calls, errors, clientErrors, callsPerMin, errorRate, avgMs, p95Ms }`
  (clients → service: root SERVER entry spans; service → service: CLIENT spans whose peer answered with another service's entry span; service → queue: distinct parent spans of consumers' entry spans (a message retried 3 times counts once) or PRODUCER spans; queue → service: CONSUMER / INTERNAL entry spans (every attempt); service → dependency: other CLIENT / PRODUCER spans, plus watched dependencies with `calls: 0`; an edge's `p95Ms` is over all its spans, every host / peer merged the same way; `errors` = status ERROR or HTTP ≥ 500, `clientErrors` = HTTP 4xx: disjoint on clients → service edges, but the SDK sets ERROR on an outbound 4xx, so on CLIENT-span edges a 4xx is in both — never add them)

## 9. SDK changes (`skilllane-monitoring/packages/monitoring`)

Start from a copy of `../skilllane-monitoring-handoff/library/skilllane-monitoring`. Keep everything that works; add:
- `LOG_EXPORT` modes from the contract (`resolveExportMode`); the old "kafka not available" warning goes away.
- `src/transport/`: one `Transport` per queue (`kafka.ts`, `rabbitmq.ts`, `bullmq.ts`) with `connect / publish(stream, body, key) / close`,
  a `Publisher` per stream (batch by count, time and bytes; bounded queue dropping oldest; simple circuit breaker; never blocks or throws into the app),
  and a span exporter that converts `ReadableSpan` → `SpanItem`.
- Queue mode wiring in `registerTelemetry`: the record sink feeds the logs publisher; a span processor feeds the spans publisher;
  flush on shutdown/crash within `LOG_EXPORT_SHUTDOWN_MS`. No OTLP exporters in queue mode.
- Client libraries `kafkajs`, `amqplib`, `bullmq`, `ioredis` are dependencies of the SDK, loaded lazily (only the chosen one).
- Feedback safety: publish under `suppressTracing(ROOT_CONTEXT)`; give the SDK's own kafkajs client its own quiet `logCreator`;
  the SDK's own BullMQ queues and Redis/AMQP connections must not be reported as the app's dependencies or traced.
- README: the new modes and env vars.

## 10. Demo (`apps/demo-api`)

One NestJS codebase, run as three processes: `school-core-api` role `api` (:5101), `school-core-api` role `worker`, `school-etl-api` role `api` (:5102).
Picks behaviour from `DEMO_SERVICE=core|etl` and `APP_ROLE`. Loads `skilllane-monitoring/register` through `NODE_OPTIONS`; no logging code beyond `new Logger()`.
Scenarios (traffic generator weights in brackets):
1. `GET /question-bank/my` [35%]: 200; Redis cache get on the app Redis + a manual CLIENT span `oracle SELECT QUESTION_BANK` (db.system oracle).
2. `POST /question-bank/import` [15%]: CQRS `ImportQuestionBankCommand`; calls `school-etl-api POST /etl/parse-excel` over HTTP (axios), then a manual span `oracle INSERT QUESTION_BANK`; 25% fail with an ORA-12899 error (`errorNum: 12899`, message `ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)`) → 500 with hint + fix showing `QuestionBankEntity.title` (register fake TypeORM metadata via `registerTypeormSchema`).
3. `GET /classes/:id/report` [15%]: CQRS `GetClassReportQuery`; ids ending in 7 throw `TypeError: Cannot read properties of undefined (reading 'school')` → 500, NULL_READ hint naming the `school` relation of `ClassroomEntity`.
4. `GET /exams/:id` [10%]: 404 `NotFoundException` (EntityNotFound-like) for ids > 900 → warn.
5. `POST /exams/:id/submit` [8%]: 400 with a validation message array (`answers.0.choice must be one of A, B, C, D`) → warn with rejected fields.
6. `POST /reports/:id/generate` [7%]: enqueues BullMQ business job `report:generate` on the app Redis; the worker processes it; 30% of attempts fail with a Google-API-shaped 429 (`rateLimitExceeded`, gaxios shape) → `job.retry`, `job.failed` after 3 attempts.
7. `GET /classes/:id/students` [7%]: slow, 1.5–3 s.
8. `GET /me` [3%]: 401 when the demo user header is missing → `auth.rejected`.
9. `POST /auth/login` [3%]: email + password in, tokens and `Set-Cookie` out (Oracle SELECT APP_USER + INSERT USER_SESSION with binds); 15% answer 401 (`auth.rejected`).
10. `PUT /me/profile` [2%]: email, phone, Thai national id, optional password change (Oracle UPDATE APP_USER / STUDENT with binds).
11. `POST /question-bank/files` [2%]: multipart (an 8–40 KB PNG + fields), read as a stream; the route takes a raw binary upload too.
Every scenario sends query strings, `Authorization` / `Cookie` headers and JSON bodies the SDK captures and masks (§3); the core → ETL call carries a Bearer service token.
Users: header `x-demo-user` (e.g. `u_1029`), `x-demo-school` (`s_118`), `current-role` (`teacher`); a middleware sets `req.user`.
Traffic generator: default 8 req/s (`TRAFFIC_RPS`), 25 users, runs until Ctrl-C.
`scripts/demo.sh <kafka|rabbitmq|bullmq> [env]`: compose up, build, start engine + 3 demo processes + traffic; logs in `.demo/*.log`; Ctrl-C stops everything.
`scripts/chaos-redis.sh`: stop `redis-app` 45 s then start (dependency down → still down → up).

## 11. Design track

`design/monitoring-ui/BRIEF.md`. Static HTML only until approved. The screens consume the §8 API shapes.

## 12. Change log

Agents append one line per deviation from this spec: date, who, what, why.
- 2026-10-17 · foundation agent · engine reads two extra optional vars: `ENGINE_SCHEMA_FILE` (path of schema.sql; default: searched upward from the engine and cwd) and `ENGINE_ENV_FILE` (default: `./.env`, else `<repo root>/.env`; real env vars win). Engine controllers use no global prefix (each declares `api/...`). Why: robust schema apply and one shared `.env` for SDK and engine.
- 2026-10-17 · demo agent · `apps/demo-api` builds to `dist/src/main.js` (so `log.origin.file.name` reads `src/…ts`); demo env vars `DEMO_PORT`, `DEMO_ETL_URL`, `DEMO_REDIS_URL`, `DEMO_IMPORT_FAIL_RATE`, `DEMO_REPORT_FAIL_RATE`; scenario 4 throws a TypeORM-shaped `EntityNotFoundError` that the demo exception filter answers with a 404 (hint "Record not found", fix names `ExamEntity`); `demo.sh` also accepts `stdout` (no queue) and `DEMO_DURATION`, `SKIP_BUILD`, `DEMO_ENGINE_PORT`, and caller env beats `.env` beats `.env.example`. Why: clearer demo lines and automated runs.
- 2026-10-18 · query agent · §8 API conventions + additive fields: `errorRate` is a ratio (0.0042 = 0.42 %), times ISO UTC, empty strings `''`, nested objects `null` when empty; `from`/`to` also take any `now-<n>s|m|h|d|w`, max range 90 d; extra fields: LogRow `version, host, correlationId, userRoles, fingerprint, dbStatement, http.domain, error.cause, job.inflight`; SpanRow `version, host, isEntry, scope`; ErrorGroup `eventCode, logger, failedStep, jobQueue, jobType, dependencyName` (`firstSeen` looks back 14 d before `to`, `fix` is the latest occurrence's); traces rows `status` = HTTP status (0 for jobs) + `statusCode`, `isError`, params `kind`, `limit` ≤ 500 (default 200); overview services `kind`, routes `clientErrors`/`clientErrorRate` (4xx from `http.request` lines); JobStat `service, role, lastRunAt, lastFailedAt` (retried = retry + redelivered); `/api/jobs` adds `consumerEvents`; Dependency `lastOutageMs, affects`, state as of `to` (7 d lookback), `attempts` = failure lines in range, `events` include `http.outbound_failed`; `/api/errors` takes `limit`; `q` runs as UNION ALL of message / error_message branches. Why: the BRIEF screens need them; an OR across two ngram indexes prunes nothing on ClickHouse 25.8.
- 2026-10-18 · integration agent · `GET /api/health` adds `pending` (messages not yet in ClickHouse: Kafka lag, RabbitMQ ready + unacked, BullMQ wait/active/prioritized/delayed, plus rows buffered in the writer; `null` without ingest); `scripts/demo.sh` waits for `pending = 0` (up to `DEMO_DRAIN_SECONDS`, default 20) between stopping the apps and stopping the engine; SDK: a producer-only BullMQ queue marks its `queue` dependency up on the connection's `ready` event (it stayed `still_down` forever after an outage), and ioredis "Stream isn't writeable and enableOfflineQueue options is false" gets hint `Redis unavailable` (category dependency); root `README.md` (Thai). Why: the apps' last flush was left on the queue when the engine stopped first, and the chaos demo showed a stuck dependency and an unhinted top error group.
- 2026-10-18 · release agent · changes approved by the product owner + verifier fixes, A–F:
  **A** an `app.log` error line that its pattern downgrades to warn (ORA-12899, EntityNotFound, HTTP 4xx …) and that is written inside an HTTP request is held (`LogScope.held`, `skilllane-monitoring/packages/monitoring/src/logger/held-lines.ts`) and written when the response finishes, at `error` when the status sent is ≥ 500, else `warn`, with its original `@timestamp`, just before the `http.request` line; a response closed before finishing, a crash (`uncaughtException`, fatal `unhandledRejection`), SIGTERM/SIGINT and `flushTelemetry`/`shutdownTelemetry` write held lines as originally decided (warn). Lines outside a request (jobs, consumers) and lines after the response finished keep the old rule. The recommended approach was used: no simpler rule gives the same results, because the demo filter answers 404 for a non-HttpException (`EntityNotFoundError`) while ORA-12899 (also a warn pattern, also no status on the error) answers 500, so only the status actually sent tells them apart.
  **B** `DependencyMonitor` writes one `dependency.up` with `reason: 'connected'` (message `Dependency connected`, pretty title `<type> "<name>" connected`) on the first successful connect of each monitor, never on reconnects; the recovery line now carries `reason: 'recovered'` (a dependency that was down before its first connect gets only the recovered line). The BullMQ watch hooks `Queue.prototype.waitUntilReady` (the Queue constructor calls it), so a producer-only process watches its queues from boot, not from the first `add()`; the `queue` monitor takes host/port from the queue/worker `connection`; `watchRedis` marks a client that is already `ready` as connected. `isInternal()` also recognises a BullMQ queue built on the SDK's own connection (needed because the constructor now runs the hook before the SDK marks the queue). `/api/dependencies` `lastOutageMs` ignores `connected` lines.
  **C** "NEW since deploy" from the data (no CI events): `ReleasesService` (engine) reads `min/max(timestamp)` per env + service + role + version from `skilllane_monitoring.logs` over all retained data (cached 10 s); `/api/meta` gains `releases` and `deploys`; ErrorGroup gains `env`, `firstSeenVersion`, `isNew`, and `firstSeen` / `lastSeen` now cover all retained data (before: 14 d lookback / the range); `/api/errors/:fingerprint` gains `versions` and opens a group from all retained data when it has no line in the range. LogRow / SpanRow already carried `version`. `seed-demo.js`: the deploy is real clock 08:00 ICT (01:00 UTC) inside the seeded window (school-core-api 31.3.2 before, 31.4.0 after; NULL_READ only after it; ORA-01013 and ORA-00060 get at least one occurrence before it so only the deploy's own bug and the post-deploy incidents are new), `dependency.up` lines get `reason` (`connected` for the new pods' cache/queue, `recovered` after the outage). `scripts/demo.sh` exports `SERVICE_VERSION` (default `0.2.0-demo`; a caller's value wins).
  **D** `GET /api/health` bounds `ingest.pending()` at 700 ms and the ClickHouse ping at 800 ms (`pending: null` on timeout); concurrent polls share one broker read in flight.
  **E** `/api/logs` `q` adds a third disjoint UNION ALL branch over `error_fix`, `error_hint`, `error_target`, `error_code` (no skip index on those).
  **F** seeded prod 404 rows look like the live SDK lines: `error_type` EntityNotFoundError, `error_code` '' (the pattern key equals the type, which the SDK drops), hint `Record not found` + the live hint detail, logger = origin class, no `http_status` on the error line, TypeORM's multi-line criteria in the message.
  Also: the error-group and job-stat queries aliased `argMax(service, …)` / `argMax(role, …)` with the column names, so `service=` / `role=` filters failed with ILLEGAL_AGGREGATION on `/api/errors`, `/api/overview` and `/api/jobs`; the aliases are now `group_*` / `job_*`. Why: product-owner decisions A–C, verifier findings D–F; proven with `scripts/demo.sh` on Kafka, RabbitMQ and BullMQ (envs `dc-kafka`, `dc-rabbitmq`, `dc-bullmq`, each with a 15 s broker outage) and a re-seeded `prod`.
- 2026-10-18 · query agent (monitor screens) · DESIGN.md §9 "Still needed" 1–10 + NEW rule + system map, all in §8 above. Additive except where noted:
  `/api/traces` `sample` (`spread` = `errors,slow,spread`), `sort=durationMs`, `traceId` (exact or ≥ 4-hex prefix), response `total`, `totalErrors`, `sample`, rows `job`, `sample`, `httpRoute`;
  **rows `route` is now `METHOD /path`** (was the bare template, now in `httpRoute`; non-HTTP entries: the span name, the overview routes[] key) — no caller read it (scripts only print the URL, the frontend is not built yet);
  `/api/logs` `fingerprint`; `route` params everywhere take `METHOD /path`, `/path` or `<queue> <type>` (logs: job_queue + job_type);
  LogRow `httpStatus`, `requestDurationMs` + for error lines (fingerprint set) in `/api/logs` and `/api/errors/:fingerprint` `recent[]` `http.status` / `durationMs` filled from the `http.request` line of the same trace + service + role (one query bounded to the page's trace ids, envs and time span; a line whose own status differs, e.g. `http.outbound_failed` 401, keeps it);
  overview `routes[].method`, `routes[].path`, `errorGroupsSpark`; `/api/errors` `level`, `sort=count|lastSeen|firstSeen`, `sparkBuckets`, response `spark`, ErrorGroup `spark` (one `sumMap` in the group query); `/api/errors/:fingerprint` `spark`;
  common `step` param and **series buckets start at `from` rounded down to the minute** (were aligned to the epoch; same shape; a sub-minute remainder joins the last bucket when step > 1 m);
  Dependency `state: 'degraded'` + `outboundFailures`; ErrorGroup `isNew` never for category `dependency` / `input`;
  new `GET /api/topology` (separate endpoint, not an overview block, so overview stays cheap): nodes + edges with calls/min, error rate, avg/p95 from `spans` (entry spans, CLIENT/PRODUCER spans, one parent join for service → service and producer → queue) and `route_stats_1m`, dependency names/state from `logs`.
  The SDK's job span carries no `job.*` attributes (only seeded spans have `messaging.*`), so `job` falls back to the job.* lines of the same span (bounded like the request join).
  ClickHouse 25.8 does not substitute `{param}` inside `OVER (…)`; the spread pick computes its bucket in an inner subquery. Every endpoint < 150 ms for env=prod over 24 h. Why: the approved monitor screens (skilllane monitor) need them; verified against direct ClickHouse queries on a separate api-only engine (:5110).
- 2026-10-18 · query agent (review fixes) · `ErrorSpark`: `stepSeconds` = whole minutes of the range / `sparkBuckets` rounded **up** (was rounded to nearest), `buckets` never more than `sparkBuckets`, a sub-minute remainder joins the last bucket (1 h → 20 × 180 s, was 21; 24 h at `sparkBuckets=100` → 96 × 900 s, was 100 × 840 with a 54-min last bucket); default `step` for ranges over 30 d is 6 h (was 1 h = 2160 buckets for 90 d, which `step=1h` rejected); `route_stats_1m` reads take minutes starting before `to` (`minute < to`, was `<=`: one extra minute for a `to` on a minute boundary); topology produce edges count distinct consumer parents (job retries counted once), `clientErrors` documented as overlapping `errors` on CLIENT-span edges; `/api/traces` `sample` gives unused budget back to errors (`status=error&limit=100` → 100 rows, was 50), `slow` without `spread` takes what errors leave; the logs request join no longer writes the request's status / duration into an outbound line's `http.status` / `durationMs` (`http.domain` set or `http.outbound_failed`). Why: reviewer findings (false spike / sliver in sparks, 400 on an echoed step, route_stats vs spans totals, retries over-counted).
- 2026-10-18 · data agent (seed vs live) · `seed-demo.js` writes the error groups the live demo apps also produce with exactly the live SDK's fields, so seeded and live lines share one `error_fingerprint`: ORA-12899 `Error` + origin `ImportQuestionBankHandler.saveQuestions` (was `QueryFailedError` + `.execute`), NULL_READ hint detail / fix / file of the demo, not found `ExamsController.findOneOrFail` (logger `ExamsController`, failed step `oracle SELECT EXAM`), HTTP_400 `ExamsController.submit` ("Bad Request Exception", no `validation.messages`), Google 429 hint "Google rate limit hit", no origin / fix, `Queue:report` lines "Job failed (and will be retried)" without user; the cache Redis is dependency `redis` as the SDK names the app's own Redis (was `cache`): `AggregateError` "Redis \"redis\" unreachable" + `REDIS_OFFLINE` cache-read warns during the outage, like `scripts/chaos-redis.sh` live; seeded job spans carry the `job.*` attributes. Story unchanged: ORA-12899 in 31.3.2 + 31.4.0, NULL_READ only in 31.4.0 (isNew), outage / ThaID not new. `runJob` sets `event.module` + `job.*` on its span (one `setAttributes`), so `/api/traces` job info of live jobs comes from the span. `demo.sh`: `CORE_VERSION` / `ETL_VERSION` per demo process (default `0.2.0-demo`; `SERVICE_VERSION` overrides both); `live.sh` defaults them to the seed's 31.4.0 / 4.2.1 (was one `SERVICE_VERSION=31.4.0` for all, a false school-etl-api deploy). `/api/topology`: dependency nodes by type + name, not host (ids `dependency:<type>:<name>`, `host` lists every host:port, readable labels), so seeded and live Oracle / Redis `queue` are one node each; the monitor's map shows the first host + "+n". Why: reviewers found duplicate groups (live ORA-12899 shown NEW), a false deploy and duplicate dependency nodes between seeded and live data.
- 2026-10-18 · integration agent (monitor) · additive, to drop per-group / per-chip extra calls of the screens: `/api/logs` `levelCounts` (+ `requestError`), `event` as a comma list of codes, `jobId` filter; ErrorGroup `errorCount`, `warnCount`, `sparkError`, `eventModule`, `dependencyType`, `httpStatus` (one extra query on the sample traces' `http.request` lines); TraceRow `spanId`, `job.module`. Why: the Error list made one `/api/logs?fingerprint=` call per route / job group (up to 30) for the ERR / WRN split and the request status, the Log page two extra calls for chip counts and the 5xx split, and the Jobs drawer could only link one attempt's trace.
- 2026-10-18 · fix agent (shared + engine review findings) · `/api/topology`: the `p95Ms` of a queue / dependency / clients node and of an edge merged over several peers is now the p95 over all their spans (a 32-per-doubling duration histogram per SQL row, merged in the engine) — it was the highest edge / peer p95 (AWS S3 showed 2,954 ms, its p95 over 893 calls is ~184 ms; Oracle 2,573 ms vs ~1,956 ms). `/api/errors` + `/api/errors/:fingerprint` + overview `errorGroupsSpark`: **`ErrorSpark` is laid back from `to`** (every bucket exactly one step, `from` = to − buckets × step to the second) — it started at `from` rounded down to the minute, so the newest bucket held up to step + 59 s (a false spike on 15 min / 1 h views and a wrong "last minute" count). ErrorGroup `roles` (every role of the group in the range). `/api/traces`: param `entries=top|all` (default `top` leaves out downstream HTTP entries, e.g. POST /etl/parse-excel inside an import, unless a service / role / route filter is given), response `totalTraces`, `totalErrorTraces`, `totalSlow` (+ `slowMs` param, default 2000), rows `downstream`, and the `slow` sample part takes HTTP entries first (it ranked every kind by duration, so 3–11 s jobs filled every slot and slow requests vanished from the scatter). Additive except the `entries=top` default (rows and totals no longer count downstream hops) and the ErrorSpark grid. Monitor: `scripts/live.sh` defaults to `MONITOR_MODE=start` (production) and builds the monitor first when `.next` is missing or older than its sources; `apps/monitor/scripts/sync-design.mjs` applies `APP_PATCHES` to the 3D module until the design has them (compact map labels: a failing node keeps a one-line `name · error %` label). Why: review findings overview-2, errors-1, errors-11, traces-2, traces-3, shell-9.
- 2026-10-18 · engine agent (captured I/O) · product-owner decision: traces store request / response headers and bodies, query strings, SQL bind values and queue messages, masked (§3). `skilllane_monitoring.spans` gains `url_query, req_headers, res_headers, req_body, res_body, req_body_size, res_body_size, req_body_truncated, res_body_truncated, db_params, db_statement_full, msg_body, msg_headers, msg_body_size, msg_body_truncated, req_header_count, res_header_count, db_param_count` (one `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `schema.sql`, ZSTD(3), same layout as the CREATE); the ingest moves the I/O attributes out of `attributes` (§7) and masks only fallback inputs of other instrumentations; additions to the shared contract: `db_statement_full` (a statement over 2000 characters — e.g. a Redis command with its arguments — was kept whole only in `attributes`; topology reads `db_statement` and the map on every CLIENT span), `msg_body_truncated` (+ optional attr `messaging.message.body.truncated`), and the three count columns (counting JSON keys at query time read every header of the trace's granules: ~3 granules × 8192 rows). `/api/traces/:traceId` spans gain `io`; new `GET /api/traces/:traceId/spans/:spanId` → `SpanDetail`. Review leftovers: `/api/logs` `q` also matches `METHOD /route` and `url_path` (third UNION ALL branch); `/api/dependencies` (and overview / topology, which share it) one row per host:port (was per service + role + name with the latest host, so an outage of one host showed next to another host) with `lastRecoveredAt`, `lastOutageFrom` and `lastOutageMs` as the union over every process that reported the outage (the seeded 45 s Redis outage read 45.07 s on the api row and 45.03 s on the persister row, the monitor 45.0 / 45.1 / 45.2 s; now 45.3 s on both). `seed-demo.js`: every seeded HTTP (in and out, S3), Oracle and job span carries captured I/O masked with the SDK's rules (mirrored in the script), from its own random stream so the rest of the seed is unchanged; more realistic statements with binds; `--dry-run [--dump=<file>]` generates without ClickHouse. Checked: the API over the existing data on an api-only engine (:5130), the seed's demo-trace rows through ClickHouse `format()` + `toSpanDetail`; unchanged endpoints run byte-identical SQL, trace detail reads the same bytes, `/api/dependencies` reads less. Why: the Network view of the trace (DevTools-like) and review findings.
- 2026-10-18 · integration agent (captured I/O) · reconciled the SDK, engine and monitor parts of the capture contract: `skilllane.monitoring.db.parameters` entries keep the SDK's optional `column` / `truncated` through the engine (`SpanDetail.db.params`) to the monitor (bind table column, a cut list's `…` entry is not a bind value in the FULL QUERY); the SDK sets `messaging.message.body.truncated` with every captured message body (the engine's heuristic stays for other senders); the engine's fallback masking uses the SDK's linear email scan (the old pattern backtracked for seconds on a 64 KB value); `/api/topology` counts a consumer's parent link only when that parent is not a PRODUCER span with a destination (the new BullMQ `report publish` span, kafkajs `send`), which already makes its own produce edge — the service → queue edge counted every job twice; monitor: Copy as cURL leaves out `content-encoding` when it sends the stored (decoded) body, a size-only body says stream / not stored / binary by content type, `/jobs` has no auto refresh for a fixed past window and its outage length is the union of the processes' windows (45.3 s, like overview / errors / about). New SDK env vars in §5 (`LOG_CAPTURE`, `LOG_BODY_MAX_BYTES`, `LOG_CAPTURE_SKIP_ROUTES`, `LOG_EXPORT_MAX_QUEUE_BYTES`), demo scenarios 9–11 in §10. Proven on private processes (new SDK with `LOG_EXPORT=stdout` → the engine's `mapSpan` / `toSpanDetail` → a private build of the monitor against an api-only engine): no crafted secret in any stored column, the 400 KB body cut at 64 KB and flagged; the live stack restart that puts the new SDK and ingest on env=prod was not run in this step. Why: the user's decision of 18 Oct (Network view of the trace).
- 2026-10-18 · monitor agent (Network view review fixes) · the trace URL records the open panel: `?io=<spanId>` opens it in either view (nearest span with I/O above), removed when it closes (`?span=` only selects; links from the Logs and Jobs drawers carry both). Every Logs drawer line with a span links to the Network view; a line about a failure opens the failing I/O under its span (the INSERT behind ORA-12899, a job attempt's 429 call). A failed row shows its exception / status message in the panel head. The Response tab shows the stored text (Raw by default; Pretty re-indents without parsing, so 64-bit ids, `1.10`, key order and repeated keys stay), copy always copies the stored text, the Preview tree keeps numbers as written, `text/html` previews in a sandboxed frame that runs no script and loads nothing. Copy as cURL: `--globoff` for `[ ] { }` URLs (incl. `[REDACTED]` query values), `-I` for HEAD, no `traceparent` / `tracestate` / `baggage` (a replay starts its own trace), multipart as `--form-string` per stored field + `-F name=@<filename>` per file without the stored boundary, size-only bodies as `--data-binary @request-body.<ext>`. FULL QUERY: a date bind is its UTC instant converted to the session time zone when it runs (Oracle `FROM_TZ(…,'+00:00') AT TIME ZONE SESSIONTIMEZONE`, PostgreSQL `TIMESTAMPTZ`, MySQL `CONVERT_TZ`, SQL Server `DATETIMEOFFSET`), as drivers bind a JS Date (the live BIRTH_DATE bound as 2011-01-10 +07:00 was written as 2011-01-09); Oracle array binds (keys 1..n) match placeholders by position; values the SDK cut are flagged; Oracle strings over 4,000 bytes become `TO_CLOB` pieces. Footer totals count each exchange once (`request · response · message`, `–` when unknown). Why: Network view review (NW-1…NW-15).
- 2026-10-18 · fix agent (capture privacy + safety review) · **one set of masking rules** in `skilllane-monitoring/packages/monitoring/src/contract/mask` (key rule with words and metadata exceptions, value rule with any `name=value` pair, Authorization schemes, URL userinfo, JSON in strings; JSON / query / URL / header / cookie / markup / CSV / SQL / Redis masking), used by the SDK, the engine and `seed-demo.js` (were three drifting copies; the seed showed 96 unmasked `x-api-key` headers). SDK: BOM / UTF-16 / invalid JSON bodies fail closed; SQL binds resolved through calls, `INSERT … SELECT`, aliases, tuples, and masked `masked: 'unresolved'` in a statement that names a secret; Redis key prefixes, XADD / MIGRATE / EVAL, redis-cli quoting; log labels by key; `job.id` / Kafka keys / message ids, every other span attribute and every event by key and value; `url.path` under a sensitive route parameter. Engine: the resource marker `skilllane.monitoring.mask` (§4); senders without it are masked at ingest (§7, §8); the statement always leaves `attributes` (it was there twice for Redis: +49 % attribute bytes per live span). Safety: bind values typed, masked and serialised one at a time under the cap (a 10,000-bind INSERT took 5.5 s, now ~3 ms; also with `LOG_CAPTURE=off` on TypeORM spans); the Redis serializer looks at most `LOG_BODY_MAX_BYTES` (a 10 MB SET added ~0.25 s, now ~6 ms); multipart keeps 1,000 parts / 64 KB of summary then only counts (`more`); the key cache holds short flat keys only; `LOG_EXPORT_MAX_QUEUE_BYTES` counts two-byte strings ×2; an oversized span is cut, not dropped; an aborted upload's size is the bytes received (flagged truncated); a foreign body on a size-only side is removed; an uncaught exception exits only when the SDK's listener is the only one; tiny writes share one buffer. API: `SpanDetail.http.remoteAddress` / `url` bracket IPv6 hosts (`[::1]:5102`); `db.params[].masked`. The seeded rows still hold the old masking until the seed is re-run. Why: privacy and safety review findings P1–P13, SAFE-1–12, NW-9, NW-14.
- 2026-10-19 · nakarin + Claude · HTTP ingest for apps without a queue: contract adds export mode `http` (`ENVELOPE_TRANSPORTS`, `isEnvelopeTransport`, `INGEST_PATH`, `LOG_HTTP_URL` / `LOG_HTTP_TOKEN`; auto order kafka → rabbitmq → bullmq → http → otlp → stdout); engine adds `POST /api/ingest/:stream` (open by default, token optional) and `ENGINE_INGEST_*` (§5, §8); `ClickhouseWriter.saturated()`; the stats line runs with HTTP ingest only. The SDK side (`HttpTransport`, publisher drops a message the receiver rejects for good, breaker jitter) lives in pluton-monorepo `packages/skilllane-monitoring`; this repo's `skilllane-monitoring/packages/monitoring` copy is not updated. Why: deploy the engine per project and let an app without a queue use it with one URL.
- 2026-10-19 · nakarin + Claude · monitor sign-in and user management (§5, §8 "Users, roles, sessions"): engine `auth/` (AuthGuard on every route, users/roles in `<db>_config`, admin from `SKILLLANE_MONITORING_ADMIN_*`, set-password links, grants per env), query routes take a permission each, `/api/meta` filtered + `envsLimited`; monitor `/login`, `/set-password`, `/account`, `/admin/users`, `/admin/roles`, `proxy.ts` sends a request without the session cookie to `/login`, the server calls the engine with the user's session, the nav and env picker follow the permissions, a screen without its permission redirects to the first allowed one. No payload / identity permissions (decided: every view permission sees the captured data). Why: one stack per project, its own users.
