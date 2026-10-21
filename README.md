# skilllane-monitoring engine

POC นี้แสดงว่า NestJS app ของลูกค้าแค่ติดตั้ง `skilllane-monitoring` แล้วตั้ง env ไม่กี่ตัว
log และ trace ทั้งหมดก็จะวิ่งผ่าน **queue ของลูกค้าเอง** (Kafka, RabbitMQ หรือ BullMQ แล้วแต่ลูกค้าเลือก)
ไปถึง **skilllane-monitoring engine** ซึ่งเขียนลง ClickHouse และเปิด query API ให้ monitoring frontend กับ AI อ่าน

หน้าที่ของเรามีแค่ **publish** (SDK ฝั่ง app) และ **subscribe** (engine) เท่านั้น เราไม่ได้รันหรือดูแล queue ของลูกค้า

- สเปกและสัญญาระหว่างส่วนต่าง ๆ: [`SPEC.md`](SPEC.md) (wire format อยู่ที่ [`skilllane-monitoring/packages/monitoring/src/contract/index.ts`](../skilllane-monitoring/packages/monitoring/src/contract/index.ts) ใช้ผ่าน `skilllane-monitoring/contract`, ตารางอยู่ที่ [`clickhouse/schema.sql`](clickhouse/schema.sql))
- แผนภาพ architecture: [`../skilllane-monitoring-diagram-clickhouse.html`](../skilllane-monitoring-diagram-clickhouse.html)
- หน้าจอ monitor (**skilllane monitor**, Next.js `:3300`): [`apps/monitor/`](apps/monitor/README.md) วิธีรันอยู่หัวข้อ 3 ด้านล่าง
- ดีไซน์ที่ approve แล้ว (HTML mockup, ต้นฉบับของ layout และข้อความภาษาไทย): [`design/monitoring-ui/`](design/monitoring-ui/index.html) (`BRIEF.md`, `DESIGN.md`, หนึ่งไฟล์ต่อหน้าจอ)
- ความหมายของทุกตารางและทุก column (สำหรับคนและ AI): [`docs/DATA-DICTIONARY.md`](docs/DATA-DICTIONARY.md)

## 1. ข้อมูลไหลอย่างไร

```
 NestJS app ของลูกค้า                queue ของลูกค้า                          skilllane-monitoring engine      ClickHouse
┌──────────────────────────────┐   ┌──────────────────────────────────┐   ┌────────────────────────────┐   ┌──────────────────────────┐
│ business code                │   │ Kafka topics                     │   │ ingest                     │   │ skilllane_monitoring     │
│  new Logger() / OTel         │──▶│   skilllane-monitoring.logs      │──▶│  consumer ตาม LOG_EXPORT   │──▶│   .logs                  │
│ skilllane-monitoring (SDK)  │   │   skilllane-monitoring.spans     │   │  map → batch insert        │   │   .spans                 │
│  stdout (ECS JSON) เสมอ      │   │ RabbitMQ exchange                │   │  ack/commit หลัง insert     │   │   .trace_index (MV)      │
│  + publisher ต่อ stream       │   │   skilllane-monitoring.telemetry │   │                            │   │   .route_stats_1m (MV)   │
│                              │   │ BullMQ queues                    │   │ query API  /api/*          │◀──│                          │
│                              │   │   (same names as Kafka)          │   │                            │   │                          │
└──────────────────────────────┘   └──────────────────────────────────┘   └──────────────┬─────────────┘   └─────────────┬────────────┘
                                                                                         │                               │ SQL read-only
                                                                          skilllane monitor (Next.js,      AI (mcp-clickhouse,
                                                                          apps/monitor :3300)              user skilllane_monitoring_reader)
```

1. **App + `skilllane-monitoring`**: SDK เขียน log เป็น ECS JSON หนึ่งบรรทัดต่อหนึ่ง record ลง stdout เสมอ (มี `event.code`, hint ภาษาอังกฤษ, `error.fix`, `log.origin.*` บอกว่าต้องแก้ที่ไหน)
   และสร้าง span ด้วย OpenTelemetry ใน process เดียวกัน (ไม่มี OTel Collector)
2. **Publisher**: SDK รวม log และ span เป็น envelope JSON `{ v: 1, stream: 'logs'|'spans', resource, sentAt, items }`
   แล้วส่งเข้า queue ที่ `LOG_EXPORT` เลือก เป็น batch (ตามเวลา จำนวน และขนาด) ไม่ block และไม่ throw ใส่ app ถ้า queue ล่ม จะเก็บไว้ใน memory แบบมีเพดาน แล้วส่งต่อเมื่อกลับมา
3. **Engine ingest**: subscribe queue เดียวกัน (อ่าน `LOG_EXPORT` จาก `.env` ชุดเดียวกับ SDK) แปลงเป็นแถวแล้ว insert ClickHouse เป็น batch
   และ ack/commit **หลัง** ClickHouse รับแถวแล้วเท่านั้น (at-least-once)
4. **ClickHouse**: `logs`, `spans` และ materialized view 2 ตัวที่สรุป trace (`trace_index`) และตัวเลข RED ต่อ route ต่อนาที (`route_stats_1m`)
5. **Query API** (`/api/*` ของ engine): ให้ monitoring frontend อ่าน และ **AI** อ่าน SQL ตรงด้วย user read-only `skilllane_monitoring_reader`

Engine ไม่ส่ง telemetry ของตัวเองเข้า queue (จะวนกลับเข้า ingest) มันเขียนแค่ stdout
ส่วน client ของ SDK เองที่ใช้ส่งเข้า queue ก็ไม่ถูกนับเป็น dependency ของ app และไม่สร้าง span

## 2. ต่อ NestJS app ของลูกค้า

ไม่ต้องแก้ code ใน `main.ts` หรือ business code แค่เพิ่ม package และโหลด register ก่อนทุกอย่าง:

```sh
pnpm add skilllane-monitoring
NODE_OPTIONS="--require skilllane-monitoring/register" node dist/main.js
```

แล้วตั้ง env (SDK และ engine อ่านชื่อเดียวกัน ดู [`.env.example`](.env.example) และ SPEC.md หัวข้อ 5):

| ทุก transport | ค่าตัวอย่าง | ความหมาย |
|---|---|---|
| `OTEL_SERVICE_NAME` | `school-core-api` | ชื่อ service (ไม่ใส่ role) |
| `APP_ROLE` | `api` · `worker` | role ของ process นี้ |
| `OTEL_ENV` | `prod` · `staging` · `dev` | env (column `env` แยกข้อมูลแต่ละ env ใน ClickHouse ชุดเดียว) |
| `SERVICE_VERSION` | `31.4.0` | ไม่ใส่ก็ได้ อ่านจาก package.json ควรตั้งทุกครั้งที่ deploy เพราะ "NEW since deploy" ใน API คำนวณจาก version ในข้อมูล |
| `LOG_EXPORT` | `kafka` · `rabbitmq` · `bullmq` | queue ที่ลูกค้าเลือก ต้องตรงกับ engine (ว่างไว้ = ตัวแรกที่ตั้ง connection ไว้) |
| `LOG_TOPIC_LOGS` / `LOG_TOPIC_SPANS` | `skilllane-monitoring.logs` / `skilllane-monitoring.spans` | ชื่อ topic หรือ queue |

| Transport | env ที่ต้องมี | ตัวเลือกเพิ่ม |
|---|---|---|
| Kafka | `LOG_EXPORT=kafka` `LOG_KAFKA_BROKERS=broker1:9092,broker2:9092` | `LOG_KAFKA_CLIENT_ID`, `LOG_KAFKA_SSL=true`, `LOG_KAFKA_SASL_MECHANISM=plain\|scram-sha-256\|scram-sha-512`, `LOG_KAFKA_SASL_USERNAME`, `LOG_KAFKA_SASL_PASSWORD` |
| RabbitMQ | `LOG_EXPORT=rabbitmq` `LOG_RABBITMQ_URL=amqp://user:pass@host:5672/vhost` | `LOG_RABBITMQ_EXCHANGE` (default `skilllane-monitoring.telemetry`) |
| BullMQ | `LOG_EXPORT=bullmq` `LOG_BULLMQ_REDIS_URL=redis://host:6379/0` | `LOG_BULLMQ_PREFIX` (default `bull`) ควรเป็น Redis แยกจาก Redis ที่ app ใช้งานเอง |

ปรับการส่ง batch ได้ด้วย `LOG_EXPORT_BATCH_MS` (1000), `LOG_EXPORT_BATCH_SIZE` (500), `LOG_EXPORT_MAX_QUEUE` (10000, เต็มแล้วทิ้งตัวเก่าสุด),
`LOG_EXPORT_MAX_BYTES` (800000 ต่อ message) และ `LOG_EXPORT_SHUTDOWN_MS` (3000, เวลา flush ตอนปิดหรือ crash)

สิ่งที่ได้อัตโนมัติ (รายละเอียดใน [`skilllane-monitoring/packages/monitoring/README.md`](../skilllane-monitoring/packages/monitoring/README.md)):
- Nest logger ทั้ง app ใช้ format เดียว, `http.request` หนึ่งบรรทัดต่อ request, `request-id` header = trace id
- `@nestjs/cqrs` ทุก command/query เป็น `usecase`, TypeORM ชื่อ column ใน error กลายเป็น `Entity.property`
- BullMQ, kafkajs, amqplib, ioredis: job lines (`job.started|finished|retry|failed`), `dependency.up` (`reason: connected`) หนึ่งบรรทัดตอนต่อได้ครั้งแรกของแต่ละ process
  (dependency ที่ปกติดีจึงเห็นใน `/api/dependencies` ด้วย) และ `dependency.down|still_down|up` (`reason: recovered`) เมื่อล่มแล้วกลับมา (reconnect ที่ไม่ได้ล่มไม่เขียนอะไร)
- level ของบรรทัด error ตาม status ที่ตอบจริง: error ที่ pattern บอกว่าเป็นความผิดของผู้เรียก (warn) แต่ทำให้ request ตอบ 5xx จะเป็น `error`
  (เช่น ORA-12899 ที่ตอบ 500) ส่วนที่ตอบ 4xx (404, 400, 401) ยังเป็น `warn` บรรทัดนอก request (job, consumer) ใช้กติกาเดิม
- trace ข้าม service ผ่าน HTTP (W3C `traceparent`) และผ่าน BullMQ job data
- `app.started`, `app.shutdown`, uncaught exception และ unhandled rejection พร้อมรายการงานที่ค้างอยู่ตอนนั้น
- request / response ทุกตัวแบบ Network tab ของ browser (หัวข้อถัดไป)

### เก็บ request / response ทุกตัวแบบ Network tab (ตัดสินใจ 18 ต.ค.)

SDK เก็บทุกอย่างที่ request หนึ่งทำ ทุก env และทุก app โดยไม่ต้องแก้ code ของ app (ลง span ของ OpenTelemetry):
- **HTTP ขาเข้าและเรียกออก** (http/https, axios, gaxios, AWS SDK, fetch/undici): query string, header และ body ของ request และ response
  (ถอด gzip / deflate / br ให้อ่านได้) ขนาดจริงเป็น byte ที่ส่งจริง
- **SQL พร้อมค่า bind**: `skilllane.monitoring.db.parameters` = `[{ key, type, value, column? }]` ตามลำดับ bind (`key` = ชื่อของ `:name` หรือ `1`, `2` …,
  `type` = string, number, bigint, boolean, null, date, buffer, object) จาก oracledb (`enhancedDatabaseReporting`), TypeORM (`collectParameters`) และ pg
- **Redis**: คำสั่งพร้อม argument ครบ
- **Queue**: payload และ header ของ message ใน Kafka, RabbitMQ และ BullMQ ทั้งฝั่งส่ง (span `send` / `publish`) และฝั่ง job / consumer

**Mask ก่อนออกจาก process เสมอ** ไม่อ่อนกว่ากติกาเดิมของ school-core-api กติกามีชุดเดียวใน `skilllane-monitoring/packages/monitoring/src/contract/mask`
ที่ SDK, engine และ `seed-demo.js` ใช้ร่วมกัน (รายละเอียดใน SPEC §3):
- **ตาม key**: key, ชื่อ param, ชื่อ column ของ bind, ชื่อ header, field ของ hash, ส่วนของ key ใน Redis หรือชื่อ label ที่ตัวพิมพ์เล็ก**มีคำว่า**
  `password`, `confirmpassword`, `token`, `secret`, `authorization`, `cookie`, `session`, `passwd`, `pwd`, `apikey`, `credential`, `privatekey`
  หรือมี**คำ** (แยกที่ camelCase, `_ - . :`) `pass`, `pw`, `pin`, `otp`, `cvv`, `passcode`, `sid`, `sess`, `sig`, `signature`, `auth`, `oauth`, `jwt`, `refresh`
  หรือจบด้วย `key` ที่มี `api` / `access` / `secret` / `private` / `client` นำหน้า (`x-access-key`, `privateKey`) → `[REDACTED]` ลงไปทุกชั้นของ object และ array
  ยกเว้นชื่อที่มีหลายคำและคำสุดท้ายเป็น metadata (`type`, `at`, `date`, `changed`, `expires`, `timeout`, `length`, `count`, `name` …)
  เช่น `tokenType`, `PASSWORD_CHANGED_AT`, `sessionTimeout` ยังอ่านได้; ใน query string ยังรวม `code` (OAuth), `key` และ `ticket`
- header `authorization`, `proxy-authorization` ปิดทั้งค่า; `cookie` / `set-cookie` เก็บชื่อ cookie และ attribute ไว้ (`sid=[REDACTED]; Path=/; HttpOnly`)
- **ตามค่า**: string ทุกตัวที่เก็บ (body, ค่า header, ค่า query, ค่า bind, payload, attribute อื่นของ span) ผ่าน `redactValue`: JWT, `Bearer` / `Basic`,
  ค่าหลัง `Authorization:` ทุก scheme, รหัสผ่านใน URL (`redis://:[REDACTED]@host`), คู่ `ชื่อ=ค่า` / `"ชื่อ": "ค่า"` ที่ชื่อเข้ากติกา key
  (เช่น `confirmPassword=…`), string ที่เป็น JSON (mask แบบ JSON), email, เลขบัตรประชาชนไทย (ตรวจ checksum)
- JSON ที่ไม่ถูกต้อง (มี BOM, UTF-16, quote เดี่ยว, comment) หรือถูกตัด ใช้การอ่านแบบทนทาน และถ้าอ่านโครงสร้างไม่ออกจะปิดทุกคู่ `"ชื่อ": ค่า` ที่ชื่อเข้าข่ายซ้ำอีกรอบ (fail closed);
  XML ดูทั้งชื่อ tag และ `name=` / `key=`, CSV ดูหัวคอลัมน์, multipart อ่าน `name*=` และ part ที่ไม่มีชื่อถูกปิด
- **SQL**: ค่า bind ถูก mask ตามชื่อ หรือตาม column ที่อ่านได้จาก statement (`col = :1`, `IN`, `BETWEEN`, ฟังก์ชันที่ครอบ เช่น `crypt($1, …)` / `SHA2(?, 256)`,
  `INSERT … VALUES` / `INSERT … SELECT`, `AS alias`) และถ้า statement มีชื่อที่เป็นความลับ (เช่น `CALL change_password(?, ?)`) แต่อ่าน column ไม่ได้
  ค่านั้นถูกปิดด้วย พร้อม flag `masked: 'unresolved'`; ค่าที่เขียนตรงใน SQL ใต้ column ที่เป็นความลับก็ถูกปิด
- **Redis**: key ที่ขึ้นต้นด้วยส่วนที่เป็นความลับเก็บแค่ส่วนหน้า (`session:[REDACTED]`, `password_reset:[REDACTED]`), ค่าใต้ key / field ที่เข้าข่าย,
  รหัสผ่านของ AUTH / MIGRATE / CONFIG SET และ argument ของ EVAL ที่แตะ key ความลับ; คำสั่งถูก quote แบบ redis-cli จึงเห็นขอบของแต่ละ argument
- **log**: ข้อความ, error, hint, fix, `user.id`, `job.id`, `dependency.*`, `url.path` (ส่วนที่ตรงกับ route param ที่เป็นความลับ เช่น `/reset-password/:token`)
  และ label ทุกตัวตามชื่อ (`logger.log('x', { newPassword })` ได้ label `newPassword: [REDACTED]`)
- body ที่ถูกตัดยัง mask ส่วนที่เก็บไว้ครบ ค่าที่อยู่เลยจุดตัดไม่ถูกเก็บเลย
- **ยังไม่ mask** เบอร์โทรและข้อมูลส่วนบุคคลอื่นนอกจาก email และเลขบัตรประชาชน (ไม่อยู่ในรายการที่ตกลงไว้; รอเจ้าของ product ตัดสิน วิธีเพิ่มอยู่ใน SPEC §3)

ขนาด: body, payload และค่าแต่ละตัวเก็บแค่ `LOG_BODY_MAX_BYTES` แรก พร้อมขนาดจริงและ flag `truncated`;
`multipart/form-data` เก็บแค่ชื่อ field และไฟล์ (ชื่อ, ชนิด, ขนาด ไม่เก็บเนื้อไฟล์); binary, stream (SSE) และ route ที่ตั้งให้ข้ามเก็บแค่ขนาด

| env (SDK) | default | ความหมาย |
|---|---|---|
| `LOG_CAPTURE` | `all` | `off` = ไม่เก็บ header, body, bind และ payload (ค่าที่ app เขียนลง span เองยังถูก mask) |
| `LOG_BODY_MAX_BYTES` | `65536` | byte แรกที่เก็บของแต่ละ body / payload |
| `LOG_CAPTURE_SKIP_ROUTES` | ว่าง | prefix คั่นด้วย comma ของ path ขาเข้า หรือ path / URL ขาออก ที่ไม่อ่าน body (เก็บแค่ header และขนาด) เช่น `/health,https://s3.` |
| `LOG_EXPORT_MAX_QUEUE_BYTES` | `67108864` (64 MB) | เพดาน heap ของสิ่งที่รอส่งใน memory ต่อ stream ตอน queue ล่ม (span ที่มี body ใหญ่ขึ้น เพดานจำนวนอย่างเดียวไม่พอ); รายการที่มีภาษาไทยนับ 2 byte ต่อตัวอักษรตามที่ V8 เก็บจริง มี 2 stream (logs, spans) |

ที่เก็บ: engine ย้ายค่าเหล่านี้ออกจาก `attributes` ลง column ของ `skilllane_monitoring.spans` (`url_query`, `req_headers`, `res_headers`, `req_body`, `res_body`,
`*_body_size`, `*_body_truncated`, `db_params`, `db_statement_full`, `msg_body`, `msg_headers`, `msg_body_size`, `msg_body_truncated` และจำนวน header / bind;
ZSTD(3), TTL เดียวกับ span) query เดิมที่อ่าน `attributes` จึงไม่ช้าลง `/api/traces/:traceId` ได้แค่ขนาด (`io`) ค่าเต็มอ่านทีละ span ที่
`/api/traces/:traceId/spans/:spanId` (หัวข้อ 4) และดูได้ใน Network view ของหน้า trace (หัวข้อ 3)
ชื่อ attribute ของ instrumentation อื่น (`db.query.parameter.*`, `db.operation.parameter.*`, `http.request.header.*`, hook เดิมของ school-core-api)
engine ก็รับและ mask ด้วยกติกาเดียวกัน SDK ใส่ `skilllane.monitoring.mask` (เวอร์ชันของกติกา) ใน resource ของ envelope ทุกอัน; ของที่ส่งมาโดยไม่มีค่านี้
(SDK ภาษาอื่น หรือ skilllane-monitoring รุ่นเก่า) engine จะ mask ทุกอย่างเองก่อนเก็บ ทั้ง body, header, query, URL, attribute อื่น, event และข้อความ error
statement ของ SQL / Redis เก็บใน `db_statement` (+ `db_statement_full`) อย่างเดียว ไม่ซ้ำใน `attributes` แล้ว

ยังไม่เก็บ: bind ของ TypeORM `query(sql, params)` (instrumentation ไม่ส่งมา), payload ของ Kafka `eachBatch`, bind ของ mysql / mysql2

ต้นทุนที่วัดได้ (งานทั้งหมดทำตอน span จบ และดูข้อมูลไม่เกิน `LOG_BODY_MAX_BYTES` ต่อค่า ไม่ว่าของจริงจะใหญ่แค่ไหน):
- mask body หนึ่งตัว (Apple M4): JSON ขนาด login ~0.01 ms, 8 KB ~0.13 ms, 30 KB ~0.25 ms, body ที่ถูกตัดที่ 64 KB ~0.7 ms
- ต่อ request (วัดแบบ closed loop ก่อนรอบนี้): ขนาด login +0.06–0.14 ms CPU, 2 KB เข้า / 8 KB ออก +0.1–0.2 ms, 30 KB / 20 KB +0.8–1.1 ms,
  body สองฝั่งที่ถูกตัดทั้งคู่ +3–4 ms (3–8 ms ตอนเครื่องมีโหลด); บน handler เปล่าที่ concurrency 16 throughput ลดลง 65–80 %
  (handler จริงที่เรียก database สัดส่วนจะน้อยกว่ามาก) ปิดได้ด้วย `LOG_CAPTURE=off` หรือ `LOG_CAPTURE_SKIP_ROUTES`
- งานใหญ่ถูกจำกัดแล้ว: INSERT 10,000 bind ~3 ms (เดิม 5.5 วินาที), Redis SET 10 MB ~6 ms (เดิม ~0.25 วินาที), multipart 200,000 field ~25 ms (เดิม ~230 ms)
- engine แปลง span ละ 4.3 µs, พื้นที่ของ column ใหม่ราว 38 byte ต่อ span หลังบีบอัด (traffic ของ demo; ทั้งตาราง span ตอนนี้ราว 40 byte ต่อ span)

ฝั่ง engine ตั้ง `LOG_EXPORT` และ connection ชุดเดียวกัน แล้วรัน `node apps/engine/dist/main.js`
(`ENGINE_ROLE=ingest|api|all`, scale ได้ด้วยการเพิ่ม instance เข้า consumer group เดียวกัน)

## 3. Quick start (เครื่อง local)

**ต้องมี**: Node 20, pnpm 10, Docker Desktop และ port ว่างตามหัวข้อ 6

```sh
cd skilllane-monitoring-engine
cp .env.example .env           # ไม่บังคับ: ไม่มี .env ก็ใช้ค่าใน .env.example (demo.sh) และ default ของ engine
pnpm install
pnpm build                     # build ทั้ง workspace (contract, logging, engine, demo-api และ next build ของ monitor)
docker compose up -d --wait    # infra: clickhouse, kafka, rabbitmq, redis-telemetry, redis-app (project skilllane-monitoring-engine)
```

ตาราง ClickHouse ถูกสร้างตอน docker initdb และ engine รัน `clickhouse/schema.sql` ซ้ำทุกครั้งที่ boot (idempotent)

### เดโมครบวง (เลือก queue ได้ 3 แบบ)

```sh
scripts/demo.sh kafka    demo-kafka
scripts/demo.sh rabbitmq demo-rabbitmq
scripts/demo.sh bullmq   demo-bullmq
```

argument ตัวที่สองคือ env ของข้อมูล (default `dev`) สคริปต์จะ:
1. `docker compose up -d --wait`
2. build 4 package ที่ต้องใช้
3. รัน engine (`ENGINE_ROLE=all`, :5100) กับ `LOG_EXPORT` ตาม argument
4. รัน demo app 3 process: `school-core-api` role `api` (:5101), `school-core-api` role `worker`, `school-etl-api` role `api` (:5102)
5. รัน traffic generator 8 req/s ครบ 8 scenario (ORA-12899, NULL_READ, 404, 400, BullMQ retry จาก Google 429, route ช้า, 401)
6. พิมพ์ URL ที่ควรเปิดดู แล้วรอจนกด Ctrl-C ซึ่งจะหยุด traffic → demo apps (flush telemetry ก่อน) → รอ engine เขียน queue ที่เหลือจนหมด → engine

log ของทุก process อยู่ใน `.demo/<name>.log` ตัวเลือกเพิ่ม: `DEMO_DURATION=90` (หยุดเองหลัง 90 วินาที), `SKIP_BUILD=1`, `TRAFFIC_RPS=8`,
`LOG_PRETTY=false` (log ของ demo เป็น JSON), `DEMO_ENGINE_PORT=5100`, `DEMO_DRAIN_SECONDS=20`,
`SERVICE_VERSION=0.2.0-demo` (version ของ demo app ทั้ง 3 process, default `0.2.0-demo`; ลองรันรอบสองด้วย version อื่นใน env เดิมเพื่อดู deploy marker และ `isNew`)
และ `scripts/demo.sh stdout` สำหรับลอง app อย่างเดียวโดยไม่มี queue

ระหว่างเดโม ลองเปิด:
- `http://localhost:5100/api/overview?env=demo-kafka&from=now-15m`
- RabbitMQ UI `http://localhost:15673` (skilllane_monitoring / skilllane_monitoring)
- ClickHouse `http://localhost:8123/play` (skilllane_monitoring_reader / skilllane_monitoring_reader)

### Chaos: ทำให้ Redis ของ app ล่ม

เปิดอีก terminal ระหว่าง `demo.sh` รันอยู่:

```sh
scripts/chaos-redis.sh          # หยุด redis-app (:6391) 45 วินาที แล้วเปิดคืน (CHAOS_DOWN_SECONDS=45)
```

ตอน process เริ่ม app เขียน `dependency.up` (`reason: connected`) ของ Redis `redis` (cache) และ `queue` (BullMQ) อย่างละหนึ่งบรรทัด
ระหว่าง chaos จะเขียน `dependency.down` → `dependency.still_down` (ทุก 30 วินาที) → `dependency.up` (`reason: recovered`)
ระหว่างนั้น cache fallback ไป Oracle และ enqueue report ตอบ 503 ดูได้ที่ `/api/dependencies`
Redis ของ telemetry (:6390) และ broker ไม่ถูกแตะ

### ข้อมูลตัวอย่าง 24 ชั่วโมง (สำหรับดีไซน์และ API)

```sh
node apps/engine/scripts/seed-demo.js           # env prod: ประมาณ 60k request, 179k span, 75k log ย้อนหลัง 24 ชม. จนถึงตอนนี้ (~5 วินาที)
node apps/engine/scripts/seed-demo.js --reset   # ลบเฉพาะแถวที่ seed ใส่ (labels['seed']='1')
node apps/engine/scripts/seed-demo.js --env=staging
```

ข้อมูล seed อิงเวลาตอนรัน ถ้าผ่านไปนานแล้วช่วง "1 ชั่วโมงล่าสุด" จะว่าง ให้รันใหม่ (รันซ้ำได้ ผลเท่าเดิม)
`school-core-api` ใช้ version `31.3.2` จนถึง 08:00 น. เวลาไทย (UTC+7) ของช่วง 24 ชม. ที่ seed แล้วเป็น `31.4.0` หลังจากนั้น
(`/api/meta` จึงมี deploy `31.4.0` เวลา 08:00 น.) error NULL_READ เกิดเฉพาะใน `31.4.0` จึงได้ `isNew = true` ส่วน ORA-12899 เคยเกิดใน `31.3.2` จึงเป็น `false`

### หน้าจอ skilllane monitor (stack ที่รันค้างไว้)

`scripts/live.sh` รัน `demo.sh` (engine, demo app 2 ตัว, traffic 1 req/s ใน env `prod`) แบบ detach ไว้ข้างหลัง พร้อมหน้าจอ monitor
แบบ **production** (`next start`) เป็นค่าเริ่มต้น เหมือนตอนเดโม:

```sh
scripts/live.sh start     # infra ต้องขึ้นก่อน (docker compose up -d --wait); engine :5100, demo :5101 :5102, monitor :3300 (next start)
scripts/live.sh status    # pid ของ stack และ monitor, mode ของ monitor (start/dev), บอกถ้าแก้โค้ดหลัง build + /api/health
scripts/live.sh seed      # ข้อมูลตัวอย่าง 24 ชม. ใน env prod (รันใหม่เมื่อข้อมูลเก่า)
scripts/live.sh monitor   # restart เฉพาะ monitor (stack ต้องรันอยู่ ไม่งั้นบอก "stack is not running; use start")
scripts/live.sh stack     # restart เฉพาะ engine + demo app + traffic (SKIP_BUILD=1 ใช้ dist เดิม) monitor ไม่หยุด
scripts/live.sh stop      # หยุดทั้งหมด (drain queue ก่อน)
```

- `MONITOR_MODE=start` (default): ถ้า `apps/monitor/.next` ยังไม่มี หรือเก่ากว่าไฟล์ใดใน `apps/monitor` (app, components, lib, public,
  scripts, config) `start`, `restart` และ `monitor` จะรัน `pnpm --filter @skilllane/monitoring-monitor build` ให้ก่อน (log `.demo/monitor-build.log`)
  แล้วค่อย `next start` · แก้โค้ด monitor แล้วต้องการเห็นผล: `scripts/live.sh monitor`
- `MONITOR_MODE=dev scripts/live.sh monitor`: `next dev` (hot reload ตอนพัฒนา หน้าโหลดช้ากว่าและมี dev overlay)
- `ENGINE_URL` ของ browser (`/engine/*`) ถูกฝังตอน build: เปลี่ยน `ENGINE_URL` แล้วต้อง build monitor ใหม่
- live.sh ไม่ build หรือ start ทับ monitor ตัวอื่นที่ถือ port 3300 อยู่ · log อยู่ที่ `.demo/monitor.log` และ `.demo/live.out`

เปิด http://localhost:3300 (ไป `/overview`) ทุกหน้ารับ `env`, `from`, `to` ใน URL (เช่น `?env=prod&from=now-6h`) และลิงก์ข้ามหน้าเก็บค่าเหล่านี้ไว้

| หน้า | Route | ตัวอย่าง |
|---|---|---|
| ภาพรวม | `/overview` | `/overview?env=prod&from=now-1h` |
| Log (+ drawer ของบรรทัด) | `/logs` | `/logs?env=prod&level=error`, `/logs?fingerprint=<fp>`, `/logs?traceId=<id>`, `/logs?jobId=<id>` |
| Trace | `/traces` | `/traces?env=prod&status=error` |
| Trace detail | `/traces/<trace id>` | `/traces/<32 hex>?span=<span id>`, Network: `/traces/<32 hex>?view=network&span=<span id>&tab=query` |
| Error group | `/errors` | `/errors?env=prod&from=now-24h` |
| Error detail | `/errors/<fingerprint>` | `/errors/9965298347258757284` (ORA-12899), `/errors/13468126479503630223` (NULL_READ) |
| งานเบื้องหลัง | `/jobs` | `/jobs?env=prod#dependencies`, `/jobs?job=<id>.<attempt>` |
| เกี่ยวกับหน้าจอชุดนี้ | `/about` | ลิงก์จากโลโก้และเมนู "เอกสาร" |

ดีไซน์อยู่ที่ [`design/monitoring-ui/`](design/monitoring-ui/index.html) (`DESIGN.md` = token, component, readable error rule, Copy for AI)
ส่วน convention ของโค้ดและ component ที่ใช้ร่วมกันอยู่ใน [`apps/monitor/README.md`](apps/monitor/README.md)

### อ่าน Network view ของ trace (เหมือน DevTools)

เปิด trace แล้วกด **Network** ข้าง Waterfall (หรือใส่ `?view=network`):
- **ตาราง**: หนึ่งแถวต่อ span ที่มี I/O ตามลำดับที่เรียก: request ที่เข้ามา (`http-in`), HTTP ที่เรียกออก (`fetch`: ETL, Google Sheets, ThaID, S3 …),
  query ของ database (`db`), คำสั่ง Redis (`redis`) และ message ที่ส่งหรือรับจาก queue (`queue`, รวม job ของ BullMQ)
  column: ชื่อ (path หรือหัว statement), Method, Status, Type, Size (ส่ง / รับ, จำนวน bind ของ db), เวลา และแถบ waterfall บนแกนเวลาของ trace
  chip ด้านบนกรองตามชนิด แถวสุดท้ายรวมจำนวนและ byte · คีย์บอร์ด: ↑ ↓ Home End เลือกแถว (แผงที่เปิดอยู่เปลี่ยนตาม) Enter เปิด Esc ปิด
- **คลิกแถว** เปิดแผงรายละเอียด (กว้างตั้งแต่ 1280 px วางข้างตาราง แคบกว่านั้นเป็น sheet ทับหน้า):
  - HTTP: **Headers** (General = URL, method, status, remote address แล้ว Response headers, Request headers) · **Payload** (ตาราง query string + request body
    หรือ form) · **Preview** (JSON แบบพับได้) · **Response** (ตัวเดิม มีปุ่ม Pretty) · **Timing** และปุ่ม **Copy as cURL**
  - DB: **Query** = statement จัดบรรทัด, ตาราง bind (key, column, type, value) และ **FULL QUERY** ที่ใส่ค่าแล้วตาม dialect (Oracle `TO_TIMESTAMP(…)`,
    `NULL`, string ที่มี `'` ถูก escape) พร้อมปุ่มคัดลอกไปรันจริง ป้ายสีเหลืองนับค่า `[REDACTED]` ที่ต้องแทนด้วยค่าจริงก่อนรัน
    (วันเวลาเขียนเป็นเวลา UTC ตามที่ library เก็บ) · Redis: คำสั่งพร้อม argument
  - queue / job: **Message** = ระบบ, ปลายทาง, operation, job และ attempt, header และ payload
- ค่าที่ถูก mask แสดงเป็นป้าย `[REDACTED]` ทุกที่ (header, JSON, ข้อความ, SQL) body ที่ถูกตัดบอก "แสดง 64 KB แรก (ขนาดจริง …)"
  cURL ที่ได้ยังมี `[REDACTED]` (เช่น `authorization`) ต้องแทนเองก่อนรัน และบอกถ้าส่ง body ได้ไม่ครบ (ถูกตัด, multipart, binary)
- URL เก็บสถานะ: `?view=network&span=<span id>&tab=headers|payload|preview|response|timing|query|message` คัดลอกลิงก์ไปให้คนอื่นเปิดที่แท็บเดียวกันได้
- ทางเข้าอื่น: คลิก span ที่มี I/O ใน Waterfall เปิดแผงเดียวกัน, drawer ของ Log มี "ดู request/response" บนบรรทัด `http.request` และ "ดู message ของ job"
  บนบรรทัดของ job, drawer ของงานเบื้องหลังมี "ดู message"
- span ที่บันทึกก่อนเปิด capture (ข้อมูลเก่า, seed รุ่นก่อน) แสดงเท่าที่ trace มีพร้อมข้อความ "ไม่มี header และ body ที่เก็บไว้ของ span นี้"

### รัน engine อย่างเดียว (ดู API กับข้อมูลที่มีอยู่)

```sh
cd apps/engine && ENGINE_ROLE=api node dist/main.js     # :5100, ไม่ subscribe queue
```

## 4. Query API (engine, `http://localhost:5100`)

JSON แบบ camelCase, param ร่วม: `env` (ไม่ใส่ = ทุก env), `from` / `to` (ISO หรือ `now-15m`, `now-1h`, `now-6h`, `now-24h`, `now-7d`; default 1 ชั่วโมงล่าสุด), `service`, `role`
รายละเอียด shape อยู่ใน SPEC.md หัวข้อ 8 ทุก query ใช้ ClickHouse query parameter และ user `skilllane_monitoring_reader`

| Endpoint | ได้อะไร | ตัวอย่าง |
|---|---|---|
| `GET /api/health` | `{ ok, clickhouse, role, transport, pending }` (`pending` = message ที่ยังไม่ลง ClickHouse) ตอบภายใน 1 วินาทีแม้ broker ล่ม (ตอนนั้น `pending` เป็น `null`) | `curl 'localhost:5100/api/health'` |
| `GET /api/meta` | env และ service/role ที่มีข้อมูล + `releases` (ต่อ env/service และต่อ role: version ที่เห็นพร้อม `firstSeen`/`lastSeen`, `currentVersion`, `deployedAt` = ครั้งแรกที่ version ปัจจุบันโผล่, `previousVersion`) + `deploys` `[{ service, env, version, at, previousVersion }]` สำหรับ marker บนกราฟ (`env`, `service` กรองได้) | `curl 'localhost:5100/api/meta?env=prod'` |
| `GET /api/overview` | RED ต่อ service, series, top routes (`route` = `GET /me`, มี `method`/`path`), error groups (+ `spark`), dependencies, jobs; ทุก endpoint รับ `step` (`1m`, `15m`, `1h` …) และ bucket ของ series เริ่มที่ `from` (ปัดลงเป็นนาที) | `curl 'localhost:5100/api/overview?env=prod&from=now-1h'` |
| `GET /api/logs` | log explorer: `q` (ค้นแบบไม่สนตัวพิมพ์ใน `message`, `error_message`, `error_fix`, `error_hint`, `error_target`, `error_code` เช่น `q=QuestionBankEntity`), `level`, `event`, `traceId`, `userId`, `route` (`GET /me`, `/me` หรือ `report report:generate`), `category`, `fingerprint`, `limit`, `before` + histogram; บรรทัด error ได้ `httpStatus`/`requestDurationMs` จากบรรทัด `http.request` ของ trace เดียวกัน | `curl 'localhost:5100/api/logs?env=prod&from=now-24h&q=ora-12899&level=warn,error'` |
| `GET /api/traces` | entry span ของแต่ละ trace: `route`, `status=error\|ok`, `minMs`, `kind`, `traceId` (เต็มหรือต้น id ≥ 4 ตัว), `sort=durationMs`, `sample=spread` (error ก่อน แล้วช้าสุด แล้วกระจายทั้งช่วงเวลา), `limit` + `total`; แถว job มี `job` (queue, type, id, attempt, maxAttempts) | `curl 'localhost:5100/api/traces?env=prod&from=now-1h&sample=spread&limit=100'` |
| `GET /api/traces/:traceId` | waterfall ของ trace (span ทุกตัว + log ทุกบรรทัด) span ละ `io` = ขนาดของ I/O ที่เก็บไว้ (จำนวน header, byte ของ body, ถูกตัดไหม, จำนวน bind, byte ของ message) | `curl 'localhost:5100/api/traces/4bf92f3577b34da6a3ce929d0e0e4736?env=prod&from=now-24h'` |
| `GET /api/traces/:traceId/spans/:spanId` | span เดียวพร้อม I/O ที่เก็บไว้: `http` (method, url, route, status, remoteAddress, userAgent, query, requestHeaders, responseHeaders, requestBody, responseBody), `db` (statement เต็ม, dialect, params), `message` (system, destination, operation, headers, body), `timing`; id ที่ไม่มีได้ 404 JSON, id ผิดรูปได้ 400 | `curl 'localhost:5100/api/traces/<trace id>/spans/<span id>'` |
| `GET /api/errors` | error group (`category`, `level`, `sort=count\|lastSeen\|firstSeen`, `limit`, `sparkBuckets`) พร้อม `spark` 24 ช่องต่อ group `count` นับในช่วงเวลาที่เลือก ส่วน `firstSeen`/`lastSeen`/`firstSeenVersion` ดูจากข้อมูลทั้งหมดที่เก็บไว้ และ `isNew` = เจอครั้งแรกหลัง deploy version ปัจจุบันของ service นั้น และ service เคยมี version ก่อนหน้า (ไม่นับ category `dependency` และ `input`) | `curl 'localhost:5100/api/errors?env=prod&from=now-24h'` |
| `GET /api/errors/:fingerprint` | รายละเอียด group: `versions` (จำนวนต่อ version), series, routes, usecases, 20 บรรทัดล่าสุด, trace ids | `curl 'localhost:5100/api/errors/<fingerprint>?env=prod&from=now-24h'` (ดูด้านล่าง) |
| `GET /api/jobs` | สถิติ job ต่อ queue/type + ความล้มเหลวล่าสุด | `curl 'localhost:5100/api/jobs?env=prod&from=now-24h'` |
| `GET /api/dependencies` | สถานะ dependency (down/degraded/up; `degraded` = ช่วงนั้นมีแค่ `http.outbound_failed`) + เหตุการณ์ `dependency.*` | `curl 'localhost:5100/api/dependencies?env=prod&from=now-24h'` |
| `GET /api/topology` | แผนผังระบบ: node (clients, service, queue, dependency) และ edge พร้อม calls/min, error rate, p95 จาก span | `curl 'localhost:5100/api/topology?env=prod&from=now-24h'` |

`fingerprint` เป็น string (UInt64 เกิน number ของ JS) และ `errorRate` เป็นสัดส่วน (0.0042 = 0.42 %)
หยิบ fingerprint ของ group แรกมาเปิดรายละเอียด:

```sh
FP=$(curl -s 'localhost:5100/api/errors?env=prod&from=now-24h' | node -pe 'JSON.parse(require("fs").readFileSync(0)).groups[0].fingerprint')
curl "localhost:5100/api/errors/$FP?env=prod&from=now-24h"
```

## 5. ต่อ AI แบบอ่านอย่างเดียว

ให้ AI ต่อ ClickHouse ผ่าน MCP server ทางการ [`mcp-clickhouse`](https://github.com/ClickHouse/mcp-clickhouse) ด้วย user `skilllane_monitoring_reader`
(`GRANT SELECT ON skilllane_monitoring.*` เท่านั้น, `readonly = 2`, จำกัด 30 วินาที / 2 GB / 100k แถว) และแนบ [`docs/DATA-DICTIONARY.md`](docs/DATA-DICTIONARY.md) ให้ AI อ่านประกอบ
config ของ Claude Desktop / Claude Code, SQL ตัวอย่าง 10 แบบ และคำแนะนำสำหรับ system prompt อยู่ใน DATA-DICTIONARY.md หัวข้อ 8 และ 9 เช่น:

```bash
claude mcp add skilllane-monitoring-clickhouse \
  -e CLICKHOUSE_HOST=localhost -e CLICKHOUSE_PORT=8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring_reader -e CLICKHOUSE_PASSWORD=skilllane_monitoring_reader \
  -e CLICKHOUSE_DATABASE=skilllane_monitoring -e CLICKHOUSE_SECURE=false \
  -- uv run --with mcp-clickhouse --python 3.12 mcp-clickhouse
```

## 6. Port และ credential (ฝั่ง host)

| อะไร | Port | หมายเหตุ |
|---|---|---|
| ClickHouse HTTP / native | 8123 / 19000 | writer+admin `skilllane_monitoring` / `skilllane_monitoring`, reader `skilllane_monitoring_reader` / `skilllane_monitoring_reader`, database `skilllane_monitoring` |
| Kafka (external listener) | 29092 | KRaft node เดียว, auto-create topic เปิดอยู่, engine สร้าง topic 3 partition ตอน boot |
| RabbitMQ AMQP / management UI | 5673 / 15673 | `skilllane_monitoring` / `skilllane_monitoring`, vhost `/` |
| Redis ของ BullMQ transport (telemetry) | 6390 | ใช้ส่ง telemetry อย่างเดียว |
| Redis ของ demo app (cache, business job) | 6391 | ตัวที่ chaos script หยุด |
| skilllane-monitoring engine | 5100 | `/api/*` |
| demo `school-core-api` / `school-etl-api` | 5101 / 5102 | |
| skilllane monitor (Next.js) | 3300 | browser เรียก engine ผ่าน `/engine/*` ของ monitor (`ENGINE_URL`) |

Compose project ชื่อ `skilllane-monitoring-engine` ค่าทั้งหมดเป็นค่า local สำหรับ POC เท่านั้น ห้ามใช้ใน production

## 7. โครงสร้าง project

```
skilllane-monitoring-engine/
  README.md  SPEC.md  .env.example  docker-compose.yml  package.json  pnpm-workspace.yaml
  clickhouse/schema.sql        ตาราง + materialized view (docker initdb และ engine ตอน boot)
  clickhouse/users.sql         user read-only skilllane_monitoring_reader
  ../skilllane-monitoring/     skilllane-monitoring (SDK รวม contract ที่ `skilllane-monitoring/contract`) อยู่ repo แยก ติดตั้งจาก npm
  apps/engine/                 @skilllane/monitoring-engine: src/ingest/ (consumer 3 แบบ, mapper, ClickhouseWriter), src/query/ (API), scripts/seed-demo.js, scripts/publish-sample.js
  apps/demo-api/               @skilllane/monitoring-demo-api: NestJS app ตัวอย่าง (school-core-api / school-etl-api) + scripts/traffic.js
  apps/monitor/                @skilllane/monitoring-monitor: skilllane monitor (Next.js 16) อ่าน query API ของ engine
  scripts/demo.sh              เดโมครบวง
  scripts/live.sh              stack ที่รันค้างไว้ (engine + demo + traffic + monitor)
  scripts/chaos-redis.sh       ทำให้ Redis ของ app ล่ม 45 วินาที
  docs/DATA-DICTIONARY.md      ความหมายของตารางและ column, SQL ตัวอย่าง, การต่อ AI
  design/monitoring-ui/        ดีไซน์ที่ approve แล้วของ monitor (BRIEF.md, DESIGN.md, mockup หนึ่งไฟล์ต่อหน้าจอ)
```

## 8. สิ่งที่ทดสอบแล้วใน POC นี้

**รอบ capture (18 ต.ค., เก็บ request / response)**: build SDK, engine และ demo-api ผ่าน, `tsc` ของ monitor ผ่าน และ `next build` ของ monitor ผ่าน
(สำเนาใน scratch) แล้วทดสอบบน process ส่วนตัว: demo app 3 ตัวของ SDK ใหม่ (`LOG_EXPORT=stdout`, port 5191–5192, Redis db 7) รับ request ที่ตั้งใจใส่ข้อมูลลับ
(password ซ้อนใน array, `Authorization`, `Cookie`, `?token=` / `?access_token=`, email, เลขบัตรประชาชน, JWT ในข้อความ, body gzip, body 400 KB, upload binary และ multipart)
span ทุกตัวผ่าน `mapSpan` ของ engine ใหม่ (code เดียวกับ ingest): ไม่มีค่าลับหลุดใน column ใด, attribute ใด หรือ log ใดเลย (52 span, 76 log),
body 400 KB เก็บ 64 KB แรก `truncated = 1` พร้อมขนาดจริง, binary เก็บแค่ขนาด, multipart เก็บแค่สรุป, ไม่มี attribute ของ I/O ค้างใน `attributes`
หน้า Network (monitor ที่ build แล้ว, engine `ENGINE_ROLE=api` ส่วนตัว, headless Chrome) คลิก http-in, fetch, db, redis, job และ producer ได้ครบ, Copy as cURL ถูก,
FULL QUERY ของ Oracle INSERT / UPDATE / SELECT (วันที่, `NULL`, string ที่มี `'` และ `"`) ถูก, ลิงก์จาก drawer ของ Log และงานเบื้องหลังเปิดแผงที่แท็บถูก
console error 0 และ hydration warning 0 ทั้ง light, dark และ 400 px · endpoint เดิม (overview, traces, logs, errors, dependencies, topology) ของ engine ใหม่เร็วเท่าเดิม
(สลับวัดกับ engine เก่า) · **ยังไม่ได้**: restart stack จริง (`scripts/live.sh stack` แล้ว `scripts/live.sh monitor`) จึงยังไม่มี I/O ของ traffic จริงใน ClickHouse

**รอบล่าสุด (18 ต.ค., ข้อ A–F ใน SPEC.md หัวข้อ 12)**: `pnpm build` ทั้ง workspace ผ่าน และรัน `DEMO_DURATION=75 scripts/demo.sh <transport> <env>` ครบ 3 queue (env `dc-kafka`, `dc-rabbitmq`, `dc-bullmq`)
โดยหยุด broker ที่ใช้อยู่ประมาณ 15 วินาทีกลางรอบ ตรวจว่า: ORA-12899 จาก exception filter เป็น `error` (มี hint, fix `QuestionBankEntity.title`, usecase) และบรรทัด `http.request` ของ trace เดียวกันเป็น `error`/500,
NULL_READ เป็น `error`, 404 (`Record not found`) / 400 / `auth.rejected` เป็น `warn`, `dependency.up` `reason: connected` หนึ่งบรรทัดต่อ dependency ต่อ process (`redis` และ `queue` ของ api และ worker)
และ `/api/dependencies` แสดงเป็น `up` โดยไม่มี client ของ SDK เอง, `version` อยู่ใน LogRow/SpanRow และ `/api/meta`, `/api/health` ตอบประมาณ 0.7 วินาทีขณะ broker ล่ม (`pending: null`) และข้อมูลเดินต่อหลัง broker กลับมา,
`q=QuestionBankEntity` เจอบรรทัด ORA-12899 และ queue ว่างหลังจบรอบ ส่วน `prod` ที่ seed ใหม่: NULL_READ `isNew = true` (`firstSeenVersion` `31.4.0`), ORA-12899 `isNew = false`, deploy `31.4.0` เวลา 08:00 น.

**รอบก่อนหน้า (17 ต.ค.)**:

`pnpm build` ทั้ง workspace ผ่าน และรัน `scripts/demo.sh <transport> <env>` จริงครบทั้ง 3 queue (env `it-kafka`, `it-rabbitmq`, `it-bullmq`, ประมาณ 90–130 วินาทีต่อรอบ, รอบ BullMQ มี chaos script ด้วย)
แต่ละรอบตรวจว่า: engine health รายงาน transport ถูก, `skilllane_monitoring.logs` มีข้อมูลจากทั้ง 3 process, มี trace ที่มี span ทั้ง `school-core-api` และ `school-etl-api`,
แถว ORA-12899 มี hint `Value too long for column` + fix ที่ชี้ `QuestionBankEntity.title` + usecase `ImportQuestionBankCommand` + trace id,
NULL_READ ชี้ relation `school`, 404/400 เป็น warn, มี `auth.rejected`, job `report:generate` มี `job.retry`, มี span ของ worker,
`route_stats_1m` / `trace_index` ถูกเติม, API ทุก endpoint คืนข้อมูลของ env นั้น, หลังหยุดแล้ว queue ว่าง (Kafka lag 0 / RabbitMQ 0 message / BullMQ wait ว่าง) และจำนวนแถวไม่เพิ่มอีก,
และไม่มี telemetry ของ engine หรือ client ของ SDK เองปนเข้ามา (ไม่มี service อื่น, ไม่มี dependency หรือ span ที่ชี้ไป port ของ broker)

### ข้อจำกัดที่รู้แล้ว (ตั้งใจปล่อยไว้ใน POC)

- at-least-once: ถ้า insert สำเร็จแต่ ack/commit ไม่ทัน (เช่น engine ถูก kill) จะได้แถวซ้ำ
- consumer group ใหม่ของ Kafka อ่านจากต้น topic (`fromBeginning`) จึงอาจได้ข้อมูลเก่าที่ยังอยู่ใน retention 24 ชม.
- latency จาก app ถึง ClickHouse ประมาณ 1–3 วินาที (batch ของ SDK 1 วินาที + batch ของ engine 1 วินาที)
- บรรทัด error ที่รอ status (ข้อ A) ถูกเขียนตอน response จบ จึงอยู่ใน stdout หลังบรรทัดอื่นของ request เดียวกัน (`@timestamp` ยังเป็นเวลาเดิม) และถ้า process โดน `kill -9` ก่อน response จบ บรรทัดนั้นจะหาย
- "NEW since deploy" คำนวณจาก `version` ในข้อมูลเท่านั้น: incident ที่เกิดครั้งแรกหลัง deploy (เช่น Redis ล่ม) ก็ได้ `isNew = true` ด้วย และการ rollback กลับ version เก่าจะไม่ถูกนับเป็น deploy ใหม่
- ถ้า app เรียก `process.exit()` เอง ต้อง `await shutdownTelemetry()` ก่อน ไม่อย่างนั้น batch สุดท้ายจะไม่ถูกส่ง
- ตัวเลข 13 หลักที่ checksum ตรงกับเลขบัตรประชาชน (เช่น epoch ms บางค่า) ถูกปิด; ชื่อที่มีคำเข้าข่ายแต่ไม่ใช่ความลับ (เช่น `authProvider`, `tokenizer`) ก็ถูกปิด
- ค่าที่ไม่มีอะไรบอกว่าเป็นความลับ (ค่าใต้ key ชื่อธรรมดา เช่น `SET k <token>`, error code ที่เป็นข้อความอิสระ, path ที่ไม่มี route template) ไม่ถูกปิด
- ใน statement ที่มีชื่อความลับ (เช่น `CALL change_password(?, ?)`) ค่า bind ที่อ่าน column ไม่ได้ถูกปิดหมด รวมถึง id ธรรมดา (fail closed)
- `skilllane.monitoring.mask` ใน resource เป็นคำรับรองของผู้ส่ง ไม่ใช่การตรวจ: ผู้ส่งที่ใส่ค่านี้เองโดยไม่ได้ mask จะถูกเก็บตามที่ส่งมา
- ข้อมูล seed ใน ClickHouse ยัง mask ด้วยกติกาเดิมจนกว่าจะรัน `node apps/engine/scripts/seed-demo.js` ใหม่ (header `x-api-key` ของ 96 span ยังเห็นค่าอยู่)
- FULL QUERY เขียนวันเวลาเป็นเวลา UTC ของค่าที่เก็บ (session ของ database อาจใช้ time zone อื่น) และค่า `[REDACTED]` ต้องแทนเองก่อนรัน

## 9. ที่ตั้งใจเก็บไว้ทำ Phase 2

- **Test ทั้งหมด**: unit test, integration test อัตโนมัติ, load test (2–3k บรรทัด/วินาที) และแก้ test เดิมที่ copy มาจาก handoff ให้ตรงกับ SDK ใหม่ (รอ feedback จากการโชว์ก่อนแล้วเทสรวมทีเดียว)
- **Hardening**: แยก poison batch (แถวที่ ClickHouse ปฏิเสธตอนนี้ทำให้ batch retry ไม่จบ), dedupe ของ at-least-once, Kafka SSL/SASL กับ broker จริง,
  engine หลาย instance / rebalance, broker ที่ค้างแทนที่จะปฏิเสธ connection, TLS ของ ClickHouse, รหัสผ่านจริง และเพดาน `MAX` ของ user `skilllane_monitoring_reader`
- **Spill-to-disk** ใน SDK: ตอนนี้ถ้า queue ล่มนานเกิน `LOG_EXPORT_MAX_QUEUE` จะทิ้งตัวเก่าสุด (stdout ยังมีครบ)
- **ภาษาอื่น**: SDK สำหรับ Java / Go / Python ที่ส่ง envelope เดียวกัน (wire format เป็น JSON ธรรมดาเพื่อให้ทำได้ง่าย)
- อื่น ๆ: retention / TTL ตามสัญญาลูกค้า, alerting, auth ของ query API
