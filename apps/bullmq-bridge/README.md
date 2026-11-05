# @skilllane/monitoring-bullmq-bridge

The engine's BullMQ consumer as its own small Node process. It takes the jobs the
skilllane-monitoring SDK publishes to the BullMQ queues (`LOG_EXPORT=bullmq`) and
forwards each one to the ingest service (`apps/ingest`) over HTTP, where the
rows are written to ClickHouse. The ingest service itself consumes Kafka,
RabbitMQ and HTTP; it has no BullMQ consumer, so this bridge covers that
transport.

```
SDK --(BullMQ job: v1 envelope)--> Redis --> bullmq-bridge --POST /api/ingest/<stream>--> ingest --> ClickHouse
```

## What it does

- One BullMQ `Worker` per stream queue (`LOG_TOPIC_LOGS`, `LOG_TOPIC_SPANS`) on
  `LOG_BULLMQ_REDIS_URL` with prefix `LOG_BULLMQ_PREFIX`, `ENGINE_CONCURRENCY`
  jobs in flight per queue.
- The processor checks `job.data` is a v1 envelope (`parseEnvelope` from
  `skilllane-monitoring/contract`: `v === 1`, `stream` logs/spans, `resource`
  with `service.name`, `items` array) and posts it as JSON to
  `${INGEST_URL}/api/ingest/<stream>` (gzipped above 64 KB, keep-alive, 30 s
  per request, `Authorization: Bearer <token>` when `ENGINE_INGEST_TOKEN` is set).
- The ingest's answer means what an ack means on a queue:

  | ingest answers | job |
  |---|---|
  | 202 | completes (rows are in ClickHouse) |
  | 400 | fails for good (`UnrecoverableError`): the envelope can never be written; stays in the failed list |
  | 401 | fails, retried: the token does not match (logged once a minute) |
  | 503 (+ Retry-After), other 5xx, no answer | fails, retried with the publisher's `attempts` / `backoff` |

  A job that is not an envelope fails for good without a request.
  `Retry-After` is not waited on: the job is thrown back to BullMQ right away,
  exactly as the engine does when its insert fails.
- One stats line every 30 s:
  `bullmq: jobs <n> (+<since last>) · forwarded rows <n> · failed <n> · unrecoverable <n> · pending <queue>=<wait> wait/<active> active/<delayed> delayed/<failed> failed …`
- `GET /api/health` on `BRIDGE_PORT` → `{ ok, redis, ingest, pending }`,
  200 when ok, 503 otherwise, always within 1 s. `redis` = PING answered,
  `ingest` = the ingest's `/api/health` is ok, `pending` = wait + active +
  prioritized + delayed over both queues (null while Redis is unreadable).
- SIGTERM / SIGINT: workers close (active jobs finish their POST), queues
  close, Redis quits, exit 0.

## Environment

The names are the engine's, so the same env block serves both.

| Variable | Default | |
|---|---|---|
| `LOG_BULLMQ_REDIS_URL` | — | required, e.g. `redis://redis-telemetry:6379/0` |
| `LOG_BULLMQ_PREFIX` | `bull` | BullMQ key prefix |
| `LOG_TOPIC_LOGS` | `skilllane-monitoring.logs` | logs queue |
| `LOG_TOPIC_SPANS` | `skilllane-monitoring.spans` | spans queue |
| `ENGINE_CONCURRENCY` | `50` | jobs in flight per queue |
| `ENGINE_INGEST_TOKEN` | — | comma list; the first non-empty entry is sent as the bearer token |
| `INGEST_URL` | `http://ingest:5100` | the ingest service |
| `BRIDGE_PORT` | `5110` | `GET /api/health` |
| `ENGINE_ENV_FILE` | — | a `.env` to load first (else `./.env`, else the repo root's); the environment wins |

## How it maps to the engine's consumer

`apps/engine/src/ingest/consumers/bullmq.consumer.ts` is kept line for line
where it matters: the same Worker options (`autorun`, `concurrency`, `prefix`,
a shared ioredis connection with `maxRetriesPerRequest: null`), the same
throttled `error` / `failed` logging (one warning per 5 s, `UnrecoverableError`
not logged), the same `lag()` / `pending()` job counts, the same stop order.
What changes is the processor: where the engine calls
`EnvelopeHandler.write()` (map rows, enqueue into the ClickHouse writer, resolve
once inserted), the bridge POSTs the envelope and reads the status; the ingest
does the mapping and the insert. `BadEnvelopeError` → `UnrecoverableError` is
the same rule; a 400 from the ingest is treated the same way, since the ingest
runs the same parse.

Differences worth knowing:

- Per-job latency includes one HTTP round trip and the ingest's insert, so a
  job completes a little later than in the engine; the throughput ceiling is
  the ingest's `ENGINE_INGEST_MAX_INFLIGHT` (503 above it, which the bridge
  turns into a BullMQ retry).
- The health endpoint answers 503 when not ok (the engine's answers 200 with
  `ok: false`), so the container `HEALTHCHECK` reflects it.
- The bridge has no ClickHouse and no query API; it logs to stdout with a tiny
  logger instead of Nest's.

## Run

```sh
pnpm install
pnpm --filter @skilllane/monitoring-bullmq-bridge build
LOG_BULLMQ_REDIS_URL=redis://localhost:6390/0 INGEST_URL=http://localhost:5100 \
  pnpm --filter @skilllane/monitoring-bullmq-bridge start
```

Image (context = repo root): `docker build -f deploy/Dockerfile.bullmq-bridge .`

## Tests

```sh
pnpm --filter @skilllane/monitoring-bullmq-bridge test        # unit: fake ingest, envelope validation, health, config
docker compose up -d --wait redis-telemetry                    # at the repo root → redis://localhost:6390/0
pnpm --filter @skilllane/monitoring-bullmq-bridge test:it     # BULLMQ_IT=1: real Redis + fake ingest
```

The integration test publishes with `Queue.add` under its own prefix and
checks: an envelope job is forwarded and completes; a 503 leads to a retry
(`attempts: 2`) and then completion; a non-envelope job fails as unrecoverable
after one attempt. `BULLMQ_IT_REDIS_URL` points it at another Redis.
