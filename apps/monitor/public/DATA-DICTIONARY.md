# Data dictionary: skilllane-monitoring telemetry (ClickHouse)

เอกสารนี้อธิบายข้อมูลทุกตารางในฐานข้อมูล `skilllane_monitoring` สำหรับคนและสำหรับ AI: แต่ละ column คืออะไร มาจาก field ไหนของ log (ECS)
มี SQL พร้อมใช้ 10 แบบ และวิธีต่อ AI assistant แบบอ่านอย่างเดียว

ที่มาของข้อมูล: แอปที่ติดตั้ง `skilllane-monitoring` เขียน log (ECS แบบ flat) และ span (OpenTelemetry) ส่งเข้า queue ของลูกค้า
(Kafka, RabbitMQ หรือ BullMQ) จากนั้น skilllane-monitoring engine อ่านจาก queue แล้ว insert ลงตาราง `skilllane_monitoring.logs` และ `skilllane_monitoring.spans`
ส่วน `skilllane_monitoring.trace_index` และ `skilllane_monitoring.route_stats_1m` ถูกเติมอัตโนมัติด้วย materialized view จาก `skilllane_monitoring.spans`
นิยามตารางจริงอยู่ที่ `clickhouse/schema.sql` ส่วน mapping จาก log ไป column อยู่ที่ `SPEC.md` หัวข้อ 7

## 1. กติกาที่ใช้กับทุกตาราง

- **เวลาเก็บเป็น UTC เสมอ** (`DateTime64(..., 'UTC')`) ถ้าจะแสดงเวลาไทยให้ใช้ `toTimeZone(timestamp, 'Asia/Bangkok')`
- **ต้องกรอง `env` และช่วงเวลาทุกครั้ง** ฐานข้อมูลเดียวเก็บทุก env (`dev`, `staging`, `prod` …) ตารางเรียงตาม `(env, ชั่วโมง, service, …)`
  การใส่ `env = '...' AND timestamp >= ...` ทำให้อ่านแค่ส่วนที่ต้องใช้ ถ้าไม่ใส่จะต้องอ่านทั้งตาราง
- **ค่าที่ไม่มี**: string เป็น `''`, ตัวเลขเป็น `0`, array เป็น `[]` มีเฉพาะ `duration_ms` ที่เป็น `NULL` เมื่อไม่รู้ค่า
  ดังนั้นให้เขียน `user_id != ''` แทน `user_id IS NOT NULL`
- `service` คือชื่อแอปโดยไม่มี role (เช่น `school-core-api`) ส่วน `role` คือหน้าที่ของ process นั้น (`api`, `worker`, `persister` …)
  แอปเดียวกันที่รันหลาย role จึงแยกดูได้
- `SELECT *` บนตาราง `logs` จะ **ไม่มี** `error_fingerprint` (เป็น MATERIALIZED column) ถ้าต้องการต้องระบุชื่อ column เอง
- ระยะเวลาเก็บ (TTL): `logs` เก็บ prod/production 90 วัน, staging/uat 30 วัน, อื่นๆ 7 วัน; `spans` เก็บ 14 / 7 / 3 วัน;
  `trace_index` เก็บ 14 วัน; `route_stats_1m` เก็บ 90 วันทุก env

## 2. `skilllane_monitoring.logs`: หนึ่งแถวต่อหนึ่งบรรทัด log

ORDER BY `(env, toStartOfHour(timestamp), service, level, timestamp)`, PARTITION รายวัน
มี skip index สำหรับ `trace_id`, `user_id`, `error_fingerprint` (bloom filter) และสำหรับ `lower(message)`, `lower(error_message)` (ngram)

| Column | Type | ความหมาย | มาจาก (ECS / resource) |
|---|---|---|---|
| `timestamp` | DateTime64(3, UTC) | เวลาที่เขียน log | `@timestamp` |
| `env` | LowCardinality(String) | สภาพแวดล้อม เช่น `prod` | resource `deployment.environment.name` (สำรอง: `service.environment`; ไม่มีเลยเป็น `unknown`) |
| `service` | LowCardinality(String) | ชื่อแอป (ไม่มี role) | resource `service.name` |
| `role` | LowCardinality(String) | หน้าที่ของ process: `api`, `worker`, `persister` … | resource `app.role` (env `APP_ROLE`) |
| `version` | LowCardinality(String) | version ของแอปที่ deploy (`SERVICE_VERSION`) ใช้หา deploy และ error ที่ "NEW since deploy" (ดู SQL ข้อ 9 และ `/api/meta`) | resource `service.version` |
| `host` | LowCardinality(String) | ชื่อเครื่องหรือ pod | resource `host.name` |
| `level` | LowCardinality(String) | `debug` · `info` · `warn` · `error` · `fatal` บรรทัด error ใน HTTP request ที่ pattern บอกว่าเป็น `warn` (เช่น ORA-12899, 404, 400) จะได้ level ตาม status ที่ตอบจริง: 5xx → `error`, นอกนั้น → `warn` | `log.level` |
| `logger` | LowCardinality(String) | ชื่อ logger หรือ class เช่น `ImportQuestionBankHandler`, `HttpRequest` | `log.logger` |
| `event_code` | LowCardinality(String) | ชนิดเหตุการณ์ (ดูหัวข้อ 7) เช่น `http.request`, `job.failed` | `event.code` |
| `event_module` | LowCardinality(String) | ระบบงานเบื้องหลังที่เกี่ยว: `bullmq` · `kafka` · `rabbitmq` · `cron` · `task` | `event.module` |
| `message` | String | ข้อความของบรรทัด | `message` |
| `trace_id` | String | trace ของ request หรือ job (32 hex) ใช้ join กับ `spans` และตรงกับ header `request-id` | `trace.id` |
| `span_id` | String | span ที่ active ตอนเขียน log | `span.id` |
| `correlation_id` | String | id สำหรับเชื่อม log ข้าม process | `labels.correlation_id` |
| `user_id` | String | ผู้ใช้ที่ทำ request นี้ | `user.id` |
| `user_roles` | Array(String) | role ของผู้ใช้ เช่น `['teacher']` | `user.roles` |
| `organization_id` | String | องค์กรหรือโรงเรียน เช่น `s_118` | `organization.id` |
| `http_method` | LowCardinality(String) | method ของ HTTP | `http.request.method` |
| `http_route` | LowCardinality(String) | route pattern เช่น `/classes/:id/students` | `http.route` |
| `url_path` | String | path จริง (ไม่มี query string) เช่น `/classes/1180/students` | `url.path` |
| `url_domain` | LowCardinality(String) | domain ปลายทาง (กรณีเรียกออก) | `url.domain` |
| `http_status` | UInt16 | HTTP status code | `http.response.status_code` |
| `duration_ms` | Nullable(Float64) | ระยะเวลา (ms) ของ request, job หรือ outage | `duration_ms` |
| `error_type` | LowCardinality(String) | ชนิดของ error เช่น `QueryFailedError`, `TypeError` | `error.type` |
| `error_code` | LowCardinality(String) | code ของ error เช่น `ORA-12899`, `ECONNREFUSED`, `HTTP_404` | `error.code` |
| `error_message` | String | ข้อความ error ตัวจริง | `error.message` |
| `error_hint` | LowCardinality(String) | หัวข้อที่อ่านเข้าใจ คงที่ต่อชนิด error เช่น "Value too long for column" | `error.hint` |
| `error_hint_detail` | String | คำอธิบายทั่วไปของ error ชนิดนี้ | `error.hint_detail` |
| `error_fix` | String | วิธีแก้ของ **เคสนี้** พร้อมค่าจริง เช่น "QuestionBankEntity.title got 312 (max 255) …" | `error.fix` |
| `error_stack` | String | stack trace | `error.stack_trace` |
| `error_cause` | String | ข้อมูลต้นเหตุ (JSON string) เช่น `{"errorNum":12899}` | `error.cause` |
| `error_category` | LowCardinality(String) | หมวดของ error (ดูหัวข้อ 6) | `labels.error_category` |
| `error_target` | String | สิ่งที่ error ชี้ถึง: column, entity, field หรือ host เช่น `QuestionBankEntity.title`, `10.0.3.21:6379` | `labels.error_target` |
| `origin_function` | LowCardinality(String) | function ในโค้ดแอปที่ error เกิด เช่น `ImportQuestionBankHandler.execute` | `log.origin.function` |
| `origin_file` | LowCardinality(String) | ไฟล์ที่ต้องเปิดแก้ | `log.origin.file.name` |
| `usecase` | LowCardinality(String) | use case (CQRS command/query) ที่ error หลุดออกมา เช่น `ImportQuestionBankCommand` | `labels.usecase` |
| `failed_step` | LowCardinality(String) | การเรียกออกที่ล้มก่อนเกิด error เช่น `oracle INSERT QUESTION_BANK` | `labels.failed_step` |
| `db_statement` | String | SQL ที่เกี่ยวข้อง | `db.statement` |
| `dependency_type` | LowCardinality(String) | ชนิดของระบบที่เรียกใช้: `redis` · `http` · `kafka` · `rabbitmq` … | `dependency.type` |
| `dependency_name` | LowCardinality(String) | ชื่อที่แอปตั้งให้ dependency เช่น `cache`, `ThaID` | `dependency.name` |
| `dependency_host` / `dependency_port` | String / UInt16 | ที่อยู่ของ dependency | `dependency.host` / `dependency.port` |
| `job_queue` | LowCardinality(String) | queue, topic หรือ `cron` เช่น `report`, `school.events.score` | `job.queue` |
| `job_type` | LowCardinality(String) | ชนิดงาน เช่น `report:generate`, `AttendanceSyncService.sync` | `job.type` |
| `job_id` | String | id ของ job หรือ message | `job.id` |
| `job_attempt` / `job_max_attempts` | UInt16 | ครั้งที่ทำ / จำนวนครั้งสูงสุด (0 = ไม่รู้) | `job.attempt` / `job.max_attempts` |
| `job_final` | UInt8 | 1 = ล้มครั้งสุดท้าย ไม่ retry อีก | `job.final` |
| `job_inflight` | Array(String) | งานที่ค้างอยู่ตอน process ปิดหรือ crash | `job.inflight` |
| `reason` | LowCardinality(String) | เหตุผลสั้นๆ เช่น `missing_user_header`, `client_closed`; บน `dependency.up`: `connected` (ต่อได้ครั้งแรกของ process ไม่มี `duration_ms`) หรือ `recovered` (กลับมาหลังล่ม มี `duration_ms`; ข้อมูลเก่าก่อน 18 ต.ค. เป็น `''`) | `reason` |
| `labels` | Map(String, String) | labels อื่นที่เหลือ | `labels.*` (ยกเว้นตัวที่แยกเป็น column แล้ว) |
| `fields` | Map(String, String) | field อื่นทั้งหมด ค่าที่ไม่ใช่ string เก็บเป็น JSON เช่น `fields['dependency.affects'] = '["cache"]'`, `fields['rows'] = '120'` | key อื่นๆ ของ record |
| `error_fingerprint` | UInt64 (MATERIALIZED) | id ของ **error group** (0 = ไม่ใช่บรรทัด error) ดูหัวข้อ 6 | คำนวณใน ClickHouse |
| `ingested_at` | DateTime64(3, UTC) | เวลาที่ engine insert | default `now64(3)` |

## 3. `skilllane_monitoring.spans`: หนึ่งแถวต่อหนึ่ง span ที่จบแล้ว

ORDER BY `(env, toStartOfHour(timestamp), service, is_entry, name, timestamp)` มี bloom filter บน `trace_id`

| Column | Type | ความหมาย | มาจาก (OTel span) |
|---|---|---|---|
| `timestamp` | DateTime64(6, UTC) | เวลาเริ่มของ span (ละเอียดระดับ µs) | `startTimeUnixNano` |
| `duration_ns` | UInt64 | ระยะเวลา (nanosecond) หารด้วย 1e6 จะได้ ms | `endTimeUnixNano - startTimeUnixNano` |
| `env`, `service`, `role`, `version`, `host` | | เหมือนใน `logs` | resource |
| `trace_id` / `span_id` / `parent_span_id` | String | id ของ trace / span / span แม่ (`''` = root) | `traceId` / `spanId` / `parentSpanId` |
| `is_entry` | UInt8 | 1 = span แรกของ service นี้ใน trace (ไม่มีแม่ หรือแม่อยู่อีก process) เช่น request ที่เข้ามา, job ที่เริ่มทำ | คำนวณจาก `parentSpanId` / `parentIsRemote` |
| `name` | LowCardinality(String) | ชื่อ span เช่น `POST /question-bank/import`, `oracle SELECT STUDENT`, `report report:generate` | `name` |
| `kind` | LowCardinality(String) | `SERVER` · `CLIENT` · `INTERNAL` · `PRODUCER` · `CONSUMER` | `kind` |
| `status_code` | LowCardinality(String) | `OK` · `ERROR` · `UNSET` (HTTP 4xx ฝั่ง server เป็น `UNSET`) | `status.code` |
| `status_message` | String | ข้อความของ status | `status.message` |
| `scope_name` | LowCardinality(String) | instrumentation ที่สร้าง span เช่น `@opentelemetry/instrumentation-http` | `scope.name` |
| `http_method`, `http_route`, `http_status`, `url_path` | | ข้อมูล HTTP (`url_path` ไม่มี query string) | attr `http.request.method`, `http.route`, `http.response.status_code`, `url.path` (+ ชื่อแบบเก่า) |
| `db_system` / `db_statement` | | ฐานข้อมูลและคำสั่ง (ไม่เกิน 2000 ตัวอักษร) | attr `db.system.name` / `db.query.text` |
| `peer` | LowCardinality(String) | ปลายทางที่เรียก `host:port` เช่น `10.0.3.21:6379` | attr `server.address` (+ `server.port`) |
| `exception_type` / `exception_message` | | exception แรกที่ span บันทึกไว้ | event `exception` |
| `attributes` | Map(String, String) | attributes ทั้งหมดของ span | `attributes` |
| `resource` | Map(String, String) | resource ทั้งหมดของ process | resource |
| `events` | String | span events เป็น JSON array | `events` |
| `ingested_at` | DateTime64(3, UTC) | เวลาที่ engine insert | default |

## 4. `skilllane_monitoring.trace_index`: trace id → ช่วงเวลา (เติมโดย `trace_index_mv`)

ใช้หาเวลาของ trace ก่อนค้น `spans` หรือ `logs` ทำให้ไม่ต้องอ่านทุก partition เป็น AggregatingMergeTree
แถวของ trace เดียวกันอาจยังไม่ถูกรวมกัน **ต้องใช้ aggregate ตอนอ่านเสมอ**:
`SELECT min(start_ts), max(end_ts), sum(span_count), sum(error_count), groupUniqArrayArray(services) FROM skilllane_monitoring.trace_index WHERE trace_id = '...'`

| Column | ความหมาย |
|---|---|
| `trace_id`, `day`, `env` | key (ORDER BY `(trace_id, day, env)` ค้นด้วย trace id ได้เร็ว) |
| `start_ts` / `end_ts` | เวลาเริ่มของ span แรก / เวลาจบของ span สุดท้าย (UTC, µs) |
| `span_count` / `error_count` | จำนวน span / จำนวน span ที่ `status_code = 'ERROR'` |
| `services` | service ที่อยู่ใน trace นี้ |

## 5. `skilllane_monitoring.route_stats_1m`: ตัวเลข RED ต่อ route ต่อนาที (เติมโดย `route_stats_1m_mv`)

คำนวณจาก entry span (`is_entry = 1`) ใช้แทน metrics: requests, errors, duration
เป็น AggregatingMergeTree อ่านด้วย `sum()` เสมอ และอ่าน percentile ด้วย `quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q)` ซึ่งได้ `[p50, p95, p99]`

| Column | ความหมาย |
|---|---|
| `minute` | นาที (UTC) |
| `env`, `service`, `role`, `kind` | เหมือนใน spans (`SERVER` = HTTP request, `CONSUMER` = job หรือ message, `INTERNAL` = cron) |
| `route` | `METHOD /route` เมื่อมี `http_route` นอกนั้นเป็นชื่อ span เช่น `report report:generate`, `cron AttendanceSyncService.sync` |
| `requests` | จำนวนครั้ง |
| `errors` | จำนวนที่ `status_code = 'ERROR'` หรือ HTTP ≥ 500 (**4xx ไม่นับเป็น error** ถ้าต้องการ 4xx ให้นับจาก `logs` ดู SQL ข้อ 10) |
| `duration_sum_ms` / `duration_max_ms` | ผลรวม / ค่าสูงสุดของระยะเวลา (ms) ค่าเฉลี่ย = `sum(duration_sum_ms) / sum(requests)` |
| `duration_q` | สถานะ t-digest สำหรับ p50 / p95 / p99 |

## 6. Error: field, หมวด และ error group

บรรทัด error ที่อ่านง่ายประกอบด้วย:
- **หัวข้อ** = `error_hint` (ถ้าไม่มีใช้ชื่อ event หรือ `message`)
- **รายละเอียดเคสนี้** = `error_fix` (ถ้าไม่มีใช้ `error_hint_detail`)
- **error จริง** = `error_type [error_code] error_message`
- **ต้องแก้ที่ไหน** = `origin_function` + `origin_file`, สิ่งที่โดน = `error_target`, ขั้นที่ล้ม = `failed_step`, use case = `usecase`
- ตามต่อด้วย `trace_id` และ `user_id`

`error_category`:

| ค่า | ป้ายที่แสดง | ความหมาย |
|---|---|---|
| `bug` | ต้องแก้โค้ด | โค้ดผิด เช่น อ่านค่าจาก undefined |
| `input` | ข้อมูลที่ส่งมาผิด | client ส่งข้อมูลผิด เช่น validation 400, หาไม่เจอ 404 |
| `data` | ข้อมูลในระบบขัดกัน | ข้อมูลไม่เข้ากับ schema หรือ constraint เช่น ค่ายาวเกิน column, deadlock |
| `dependency` | ระบบที่เรียกใช้มีปัญหา | DB, Redis, API ภายนอก ล่ม ช้า หรือจำกัด rate |
| `config` | ตั้งค่าผิด | key, secret หรือ URL ผิดหรือหมดอายุ |

**Error group (`error_fingerprint`)**: บรรทัดที่ไม่ใช่ `http.request` และมี `error_type` หรือ `error_hint` หรือ level เป็น `error`/`fatal`
จะได้ fingerprint = `cityHash64(env, service, error_type, error_code, error_hint, origin_function, …)`
ถ้าไม่มีทั้ง type และ hint จะใช้ `logger:message` แทน error ชนิดเดียวกันจากจุดเดียวกันจึงรวมเป็นกลุ่มเดียว
แม้ค่าใน `error_fix` จะต่างกัน (เช่น ความยาวจริง 312 กับ 288) ส่วน `level` ไม่อยู่ใน fingerprint เช่น job ที่ retry (`warn`) กับ job ที่ล้มจริง (`error`) อยู่กลุ่มเดียวกัน
UInt64 ใหญ่เกินตัวเลขของ JavaScript **ส่งต่อหรือแสดงผลให้ใช้ `toString(error_fingerprint)`**

## 7. `event_code` ที่ใช้บ่อย

| event_code | level ปกติ | ความหมาย |
|---|---|---|
| `http.request` | info / warn (4xx) / error (5xx) | request หนึ่งครั้งจบ: method, route, status, duration |
| `app.log` | ตามที่เขียน | log ทั่วไปจาก `new Logger()` รวมถึง error ที่แอปเขียนเอง |
| `auth.rejected` | warn | ปฏิเสธการยืนยันตัวตน (`reason`) |
| `http.outbound_failed` | warn | เรียก API ภายนอกไม่สำเร็จ (`dependency_*`, `url_domain`) |
| `dependency.down` / `dependency.still_down` / `dependency.up` | error / warn / info | dependency ล่ม / ยังล่ม (ทุก 30 วินาที) / `up`: `reason = 'connected'` ต่อได้ครั้งแรกของ process (หนึ่งบรรทัดต่อ dependency, ไม่เขียนซ้ำตอน reconnect) หรือ `reason = 'recovered'` กลับมาหลังล่ม (`duration_ms` = เวลาที่ล่ม) |
| `job.started` / `job.finished` | info | เริ่ม / จบงาน (`duration_ms`) |
| `job.retry` / `job.failed` | warn / error | ล้มแต่จะ retry / ล้มครั้งสุดท้าย (`job_final = 1`) |
| `job.stalled` / `job.redelivered` / `message.dead_lettered` | error / warn / error | worker หาย / message ถูกส่งซ้ำ / message ย้ายไป DLQ |
| `consumer.rebalancing` / `consumer.joined` / `consumer.crashed` | warn / info / error | เหตุการณ์ของ Kafka consumer group |
| `app.started` / `app.shutdown` / `app.boot_failed` / `app.uncaught_exception` / `app.unhandled_rejection` | info / info / fatal / fatal / fatal | วงจรชีวิตของ process |

## 8. SQL พร้อมใช้ 10 แบบ

ทุกข้อรันได้ด้วย user `skilllane_monitoring_reader` (ทดสอบกับข้อมูล seed ของ env `prod` แล้ว) ให้เปลี่ยนค่าในเครื่องหมาย `'...'` ตามต้องการ

**1. log ทั้งหมดของ trace เดียว** (ใช้ `trace_index` หาช่วงเวลาก่อน)

```sql
WITH (SELECT (min(start_ts), max(end_ts)) FROM skilllane_monitoring.trace_index
      WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736') AS b
SELECT toTimeZone(timestamp, 'Asia/Bangkok') AS time_ict, service, role, level, event_code, logger,
       message, error_hint, error_message, http_method, http_route, http_status, duration_ms
FROM skilllane_monitoring.logs
WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'
  AND timestamp BETWEEN b.1 - INTERVAL 5 SECOND AND b.2 + INTERVAL 1 MINUTE
ORDER BY timestamp
```

**2. สิ่งที่ผู้ใช้คนหนึ่งทำในช่วงเวลาหนึ่ง**

```sql
SELECT toTimeZone(timestamp, 'Asia/Bangkok') AS time_ict, service, role, level, event_code,
       http_method, url_path, http_status, duration_ms, error_hint, message, trace_id
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND user_id = 'u_1029'
  AND timestamp >= now() - INTERVAL 2 HOUR AND timestamp < now()
  -- ถ้าเป็นช่วงเวลาไทย: timestamp >= toDateTime64('2026-10-17 13:00:00', 3, 'Asia/Bangkok')
ORDER BY timestamp
LIMIT 500
```

**3. error group ที่เกิดบ่อยที่สุด (24 ชั่วโมง)**

```sql
SELECT toString(error_fingerprint) AS fingerprint,
       any(error_hint) AS hint, any(error_type) AS type, any(error_code) AS code,
       any(error_category) AS category, any(origin_function) AS origin, any(error_target) AS target,
       count() AS occurrences, uniqExactIf(user_id, user_id != '') AS users,
       min(timestamp) AS first_seen, max(timestamp) AS last_seen,
       anyIf(trace_id, trace_id != '') AS sample_trace_id
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND timestamp >= now() - INTERVAL 24 HOUR AND error_fingerprint != 0
GROUP BY error_fingerprint
ORDER BY occurrences DESC
LIMIT 20
```

**4. route ที่ช้าที่สุด (p95, ชั่วโมงล่าสุด)**

```sql
SELECT service, role, route,
       sum(requests) AS total_requests,
       round(quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q)[2]) AS p95_ms,
       round(sum(duration_sum_ms) / total_requests) AS avg_ms,
       round(max(duration_max_ms)) AS max_ms
FROM skilllane_monitoring.route_stats_1m
WHERE env = 'prod' AND kind = 'SERVER' AND minute >= now() - INTERVAL 1 HOUR
GROUP BY service, role, route
HAVING total_requests >= 20
ORDER BY p95_ms DESC
LIMIT 10
```

**5. error rate ต่อ route** (error = 5xx หรือ span ERROR; ตั้งชื่อ alias ไม่ให้ซ้ำกับชื่อ column)

```sql
SELECT service, role, route,
       sum(requests) AS total_requests, sum(errors) AS total_errors,
       round(100 * total_errors / total_requests, 2) AS error_rate_pct
FROM skilllane_monitoring.route_stats_1m
WHERE env = 'prod' AND minute >= now() - INTERVAL 1 HOUR
GROUP BY service, role, route
HAVING total_requests > 0
ORDER BY error_rate_pct DESC, total_errors DESC
LIMIT 20
```

**6. job ที่ล้ม (ไม่ retry แล้ว)**

```sql
SELECT toTimeZone(timestamp, 'Asia/Bangkok') AS time_ict, service, role, event_module AS module,
       job_queue, job_type, job_id, job_attempt, job_max_attempts, event_code,
       error_hint, error_message, duration_ms, trace_id
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND timestamp >= now() - INTERVAL 24 HOUR
  AND event_code IN ('job.failed', 'job.stalled', 'message.dead_lettered')
ORDER BY timestamp DESC
LIMIT 50
```

**7. ช่วงที่ dependency ล่ม** (หนึ่งแถวต่อการล่มที่กลับมาแล้ว ถ้าตอนนี้ยังล่มอยู่ จะเห็น `dependency.down` ล่าสุดที่ยังไม่มี `dependency.up` ตาม)

```sql
SELECT toTimeZone(timestamp - toIntervalMillisecond(toInt64(duration_ms)), 'Asia/Bangkok') AS down_since_ict,
       toTimeZone(timestamp, 'Asia/Bangkok') AS back_up_ict,
       round(duration_ms / 1000, 1) AS down_seconds,
       service, role, dependency_type, dependency_name,
       concat(dependency_host, ':', toString(dependency_port)) AS target,
       fields['dependency.affects'] AS affects
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND event_code = 'dependency.up' AND reason != 'connected'  -- connected = ต่อครั้งแรก ไม่ใช่การกลับมาจากล่ม
  AND timestamp >= now() - INTERVAL 7 DAY
ORDER BY timestamp DESC
```

**8. waterfall เต็มของ trace เดียว** (`start_ms` นับจากจุดเริ่มของ trace)

```sql
WITH (SELECT (min(start_ts), max(end_ts)) FROM skilllane_monitoring.trace_index
      WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736') AS b
SELECT round(dateDiff('microsecond', b.1, timestamp) / 1000, 1) AS start_ms,
       round(duration_ns / 1e6, 1) AS duration_ms,
       service, role, kind, name, status_code, peer,
       span_id, parent_span_id, exception_type, exception_message
FROM skilllane_monitoring.spans
WHERE trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'
  AND timestamp BETWEEN b.1 - INTERVAL 1 SECOND AND b.2 + INTERVAL 1 SECOND
ORDER BY timestamp
```

**9. error ใหม่หลัง deploy version หนึ่ง** (เจอใน `31.4.0` แต่ไม่เคยเจอใน version อื่นภายใน 7 วัน)
ผลอาจมี incident ที่บังเอิญเกิดหลัง deploy ด้วย (เช่น Redis ล่ม) ให้ดู `origin` ประกอบ
API ของ engine ใช้กติกาเดียวกันแต่ดูข้อมูลทั้งหมดที่เก็บไว้: `/api/errors` ให้ `isNew` = group เจอครั้งแรกหลัง `deployedAt` ของ version ปัจจุบันของ service
(เวลาของบรรทัดแรกที่มี version นั้น) และ service เคยมี version ก่อนหน้า; `/api/meta` ให้ `releases` และ `deploys`

```sql
SELECT toString(error_fingerprint) AS fingerprint,
       any(error_hint) AS hint, any(error_code) AS code, any(origin_function) AS origin,
       count() AS occurrences, min(timestamp) AS first_seen
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND service = 'school-core-api' AND error_fingerprint != 0
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY error_fingerprint
HAVING countIf(version = '31.4.0') > 0 AND countIf(version != '31.4.0') = 0
ORDER BY occurrences DESC
```

**10. 4xx เทียบกับ 5xx ต่อ route** (นับจากบรรทัด `http.request`)

```sql
SELECT service, role, concat(http_method, ' ', http_route) AS route,
       count() AS requests,
       countIf(http_status BETWEEN 400 AND 499) AS c4xx,
       countIf(http_status >= 500) AS c5xx,
       round(100 * c4xx / requests, 2) AS pct_4xx,
       round(100 * c5xx / requests, 2) AS pct_5xx
FROM skilllane_monitoring.logs
WHERE env = 'prod' AND event_code = 'http.request' AND timestamp >= now() - INTERVAL 1 HOUR
GROUP BY service, role, route
ORDER BY c5xx DESC, c4xx DESC
LIMIT 20
```

ข้อควรระวังเมื่อเขียน SQL เอง:
- ใน `route_stats_1m` ห้ามตั้ง alias ชื่อเดียวกับ column แล้วนำไปใช้ใน aggregate อื่น เช่น `sum(requests) AS requests` คู่กับ `argMax(x, requests)` จะได้ error `ILLEGAL_AGGREGATION`
- ค้นข้อความให้เขียน `lower(message) LIKE '%คำค้น%'` หรือ `lower(error_message) LIKE '%คำค้น%'` **แยกกันทีละ column** จึงจะใช้ ngram index ได้
  ถ้า OR สอง column ใน WHERE เดียวกัน ClickHouse 25.8 จะใช้ index ไม่ได้ (API ของ engine จึงแยกเป็น UNION ALL)

## 9. ต่อ AI assistant แบบอ่านอย่างเดียว

ใช้ ClickHouse MCP server ทางการ ([`mcp-clickhouse`](https://github.com/ClickHouse/mcp-clickhouse)) กับ user `skilllane_monitoring_reader`
AI จะเรียกเครื่องมือ `list_databases`, `list_tables` และ `run_query` ได้ ต้องติดตั้ง [`uv`](https://docs.astral.sh/uv/) ก่อน
ให้ AI อ่านเอกสารนี้ประกอบด้วย (แนบไฟล์หรือใส่ใน project knowledge) เพื่อให้รู้ความหมายของแต่ละ column

Claude Desktop (`claude_desktop_config.json`) หรือ MCP client ที่ใช้ format เดียวกัน:

```json
{
  "mcpServers": {
    "skilllane-monitoring-clickhouse": {
      "command": "uv",
      "args": ["run", "--with", "mcp-clickhouse", "--python", "3.12", "mcp-clickhouse"],
      "env": {
        "CLICKHOUSE_HOST": "localhost",
        "CLICKHOUSE_PORT": "8123",
        "CLICKHOUSE_USER": "skilllane_monitoring_reader",
        "CLICKHOUSE_PASSWORD": "skilllane_monitoring_reader",
        "CLICKHOUSE_DATABASE": "skilllane_monitoring",
        "CLICKHOUSE_SECURE": "false",
        "CLICKHOUSE_VERIFY": "false",
        "CLICKHOUSE_CONNECT_TIMEOUT": "30",
        "CLICKHOUSE_SEND_RECEIVE_TIMEOUT": "60"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add skilllane-monitoring-clickhouse \
  -e CLICKHOUSE_HOST=localhost -e CLICKHOUSE_PORT=8123 \
  -e CLICKHOUSE_USER=skilllane_monitoring_reader -e CLICKHOUSE_PASSWORD=skilllane_monitoring_reader \
  -e CLICKHOUSE_DATABASE=skilllane_monitoring -e CLICKHOUSE_SECURE=false \
  -- uv run --with mcp-clickhouse --python 3.12 mcp-clickhouse
```

ถ้าเป็นเครื่องจริงหรือ production ให้ใช้ HTTPS (`CLICKHOUSE_SECURE=true`, port 8443), เปลี่ยนรหัสผ่าน และอย่าเปิด `CLICKHOUSE_ALLOW_WRITE_ACCESS`

**user `skilllane_monitoring_reader` ทำอะไรได้บ้าง** (`clickhouse/users.sql`):
- `GRANT SELECT ON skilllane_monitoring.*` เท่านั้น ถ้าลอง INSERT หรือ CREATE จะได้ `ACCESS_DENIED` (code 497)
- `readonly = 2`: อ่านได้อย่างเดียว แต่ client ยังส่ง query settings ได้ ที่ต้องเป็น 2 เพราะ mcp-clickhouse และ client หลายตัวส่ง settings มากับทุก query
  (mcp-clickhouse อ่านค่า `readonly` ของ user แล้วส่งค่าเดิมคือ `2` กลับมากับทุก query ซึ่งทดสอบแล้วว่าผ่าน
  ส่วน `readonly = 1` ห้ามเปลี่ยน setting ทุกตัว และถ้า client ส่ง `readonly=1` มากับ user นี้ จะได้ error `Cannot modify 'readonly' setting in readonly mode`)
- ขีดจำกัดตั้งต้น: `max_execution_time = 30` วินาที, `max_memory_usage = 2000000000` (2 GB), `max_result_rows = 100000`
  (ถ้าผลลัพธ์เกิน query จะ error ดังนั้นให้ AI ใส่ `LIMIT` เสมอ)
- **ข้อควรรู้**: เพราะ `readonly = 2` client จึงเพิ่มค่าเหล่านี้เองได้ (ทดสอบแล้ว: ส่ง `max_execution_time=300` ผ่าน)
  ถ้าต้องการบังคับเป็นเพดานจริง ให้เพิ่ม constraint `MAX` (ทดสอบ clause `SETTINGS … MAX …` กับ user ชั่วคราวที่สร้างด้วย `CREATE USER` แล้ว: ถ้าขอเกินจะได้ `SETTING_CONSTRAINT_VIOLATION`):

```sql
ALTER USER skilllane_monitoring_reader SETTINGS readonly = 2,
    max_execution_time = 30 MAX 60,
    max_memory_usage = 2000000000 MAX 4000000000,
    max_result_rows = 100000 MAX 100000;
```

คำแนะนำที่ควรใส่ใน prompt หรือ system prompt ของ AI:
1. กรอง `env` และช่วง `timestamp` (หรือ `minute`) ทุกครั้ง และใส่ `LIMIT`
2. เวลาเก็บเป็น UTC แปลงเป็นเวลาไทยด้วย `toTimeZone(x, 'Asia/Bangkok')`
3. ตัวเลข RED ให้ใช้ `route_stats_1m` (`sum` + `quantilesTDigestMerge`) อย่านับจาก `spans` ทั้งตาราง
4. หา trace ให้ใช้ `trace_index` หาช่วงเวลาก่อน แล้วค้น `spans` และ `logs` ด้วย `trace_id`
5. error group ให้ `GROUP BY error_fingerprint` และแสดงด้วย `toString(error_fingerprint)`
6. อ่าน `error_hint` → `error_fix` → `origin_function` / `origin_file` เพื่อตอบว่าเกิดอะไร ต้องแก้ที่ไหน

## 10. ข้อมูลเดียวกันผ่าน query API ของ engine

Monitoring frontend ไม่ได้ต่อ ClickHouse ตรง แต่อ่านผ่าน engine (`/api/*`, SPEC.md หัวข้อ 8) ซึ่งใช้ user `skilllane_monitoring_reader` และส่งค่าจากผู้ใช้เป็น query parameter เสมอ

| Endpoint | อ่านจาก |
|---|---|
| `/api/overview` | `route_stats_1m` (services, series, routes) + `logs` (error groups, dependencies, jobs, 4xx ต่อ route) |
| `/api/logs` | `logs` (rows + histogram ตาม level, cursor `before`); `q` ค้นใน `message`, `error_message`, `error_fix`, `error_hint`, `error_target`, `error_code` (UNION ALL 3 branch) |
| `/api/traces` | `spans` ที่ `is_entry = 1` + `trace_index` (span/error count, services) + `logs` บรรทัด `job.*` ของ span เดียวกัน (`job`) |
| `/api/traces/:traceId` | `trace_index` (ช่วงเวลา) → `spans` + `logs` |
| `/api/errors`, `/api/errors/:fingerprint` | `logs` ที่ `error_fingerprint != 0`: `count`/`users` ในช่วงเวลา, `firstSeen`/`lastSeen`/`firstSeenVersion` และ `versions` (detail) จากข้อมูลทั้งหมดที่เก็บไว้, `isNew` เทียบกับ `deployedAt` ของ service |
| `/api/meta` | `route_stats_1m` + `logs` 7 วัน (envs, services) และ `logs.version` ทั้งหมดที่เก็บไว้ → `releases` (ต่อ env/service/role: versions, `currentVersion`, `deployedAt`, `previousVersion`) และ `deploys` |
| `/api/jobs` | `logs` บรรทัด `job.*` (+ `consumer.*`) |
| `/api/dependencies` | `logs` บรรทัด `dependency.*` และ `http.outbound_failed` (สถานะดูจากบรรทัดล่าสุดถึงเวลา `to` ย้อนหลัง 7 วัน) |
| `/api/topology` | `spans` (entry span, CLIENT/PRODUCER span, join span แม่สำหรับ service → service และ producer → queue) + `route_stats_1m` (RED ของ service) + `logs` (ชื่อและสถานะ dependency) |

ทุกแถวของ `LogRow` และ `SpanRow` มี `version` ของ process ที่เขียน

รูปแบบข้อมูลที่ API คืน: field เป็น camelCase, เวลาเป็น ISO UTC, `errorRate` เป็นสัดส่วน (0.0042 = 0.42 %), `fingerprint` เป็น string,
string ที่ไม่มีค่าเป็น `''`, object ย่อย (`http`, `error`, `dependency`, `job`, `db`, `exception`) เป็น `null` เมื่อไม่มีข้อมูล

**ข้อมูลตัวอย่างสำหรับ demo**: `node apps/engine/scripts/seed-demo.js` ใส่ข้อมูล 24 ชั่วโมงล่าสุดของ env `prod` ตาม `design/monitoring-ui/BRIEF.md`
(trace A `4bf92f3577b34da6a3ce929d0e0e4736`, B `9a1c4e0b7d2f4c8e8b3a6f5d2e1c0b9a`, C `e7c3d2a1f09e885ca13e9b0a8d4f21b6`)
แถวที่มาจาก seed มี `labels['seed'] = '1'` (logs) หรือ `resource['seed'] = '1'` (spans) ส่วน `--reset` ลบเฉพาะแถวเหล่านี้
