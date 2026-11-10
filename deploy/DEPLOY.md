# Deploy skilllane-monitoring-engine

## 1. Clone

```sh
umask 022                     # container อ่านไฟล์ของ repo ได้แม้เครื่องตั้ง umask เข้มงวด (007, 027) · ใช้ก่อน git pull ด้วย
mkdir -p ~/skilllane-monitoring-deploy && cd ~/skilllane-monitoring-deploy
git clone --branch main https://github.com/nakarin-skilllane/skilllane-monitoring-engine.git
cd skilllane-monitoring-engine
```

## 2. `.env`

`.env` ไฟล์เดียวที่ root ใช้ทั้ง dev และ deploy · `deploy/.env` เป็น link ไปที่ไฟล์นี้

```sh
cp .env.example .env && chmod 600 .env
ln -s ../.env deploy/.env     # compose ใน deploy/ อ่าน .env ไฟล์เดียวกัน
openssl rand -hex 24          # ใช้สร้างค่าสุ่มให้รหัสแต่ละตัว
nano .env
```

`.env.example` มีค่าของ dev ใส่ไว้ ตอน deploy ต้อง: เปลี่ยนรหัสด้านล่างเป็นค่าสุ่ม และลบค่า queue ของ dev (`LOG_KAFKA_BROKERS`, `LOG_RABBITMQ_URL`, `LOG_BULLMQ_REDIS_URL`) ถ้าจะรับทาง HTTP อย่างเดียว · `CLICKHOUSE_URL`, `ENGINE_PORT` และตัวแปรของ SDK เป็นของ dev compose ตั้งให้ container เอง

**บังคับ** = ต้องใส่ก่อน start ครั้งแรก · ช่องที่ไม่บังคับปล่อยค่า default ได้

### ตั้งครั้งแรก (บังคับ)

| ตัวแปร | คืออะไร | หมายเหตุ |
|---|---|---|
| `IMAGE_TAG` | tag ของ image ที่ build (ใช้ git sha) | เปลี่ยนทุกครั้งที่ build ใหม่ (ข้อ 3) |
| `CLICKHOUSE_PASSWORD` | รหัส user เขียนของ ClickHouse (engine ใช้) | ค่าสุ่ม |
| `CLICKHOUSE_READER_PASSWORD` | รหัส user อ่านอย่างเดียว (query API, AI) | ค่าสุ่ม · **ถูกสร้างตอน start ครั้งแรกเท่านั้น** เปลี่ยนใน `.env` ทีหลังไม่มีผล |
| `SKILLLANE_MONITORING_ADMIN_PASSWORD` | รหัสเข้าหน้า monitor ของ user admin | เปลี่ยนได้ทุกเมื่อ แล้ว restart engine |
| `SKILLLANE_MONITORING_AUTH_SECRET` | key เซ็น session ของ monitor | ค่าสุ่ม · เปลี่ยนแล้วทุกคนหลุด login |
| `ENGINE_INGEST_TOKEN` | bearer token ที่แอปใช้ส่ง log ทาง HTTP | ค่าสุ่ม · ใส่หลายค่าคั่น `,` เพื่อ rotate |

### ค่าที่มี default (แก้เมื่อจำเป็น)

| ตัวแปร | default | คืออะไร / ใส่เมื่อไหร่ |
|---|---|---|
| `INGEST` | `rust` | ใครรับ telemetry (compose profile, ข้อ 4–5): `rust` = process `ingest` (Rust) ที่ :5100 และ engine เป็น `ENGINE_ROLE=api` · `node` = engine รับเอง (`ENGINE_ROLE=all`) ใช้ rollback |
| `BIND_ADDRESS` | `127.0.0.1` | IP ที่ monitor (:3300) และ ingest (:5100; engine เมื่อ `INGEST=node`) รับ · `127.0.0.1` = เข้าได้จากเครื่องนี้เท่านั้น (HTTP ไม่เข้ารหัส อย่าเปิดออก network โดยไม่มี proxy ที่ทำ HTTPS) |
| `INGEST_IMAGE`, `ENGINE_IMAGE`, `MONITOR_IMAGE`, `BULLMQ_BRIDGE_IMAGE` | build บนเครื่อง | ใส่เมื่อดึง image จาก registry แทนการ build |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | ชื่อ database · ตั้งก่อน start ครั้งแรก |
| `CLICKHOUSE_USER`, `CLICKHOUSE_READER_USER` | `skilllane_monitoring`, `skilllane_monitoring_reader` | ชื่อ user เขียน / อ่าน · ตั้งก่อน start ครั้งแรก |
| `SKILLLANE_MONITORING_ADMIN_USERNAME` | `admin` | ชื่อ login ของ admin |
| `SKILLLANE_MONITORING_SESSION_HOURS` | `8` | อายุ session ของหน้า monitor (ชั่วโมง) |
| `ENGINE_INGEST_HTTP` | `true` | รับ log ทาง HTTP (`POST http://localhost:5100/api/ingest/<stream>`) · `false` เมื่อใช้ queue อย่างเดียว |
| `ENGINE_INGEST_MAX_BYTES` | `2000000` | ขนาด request สูงสุดต่อครั้ง |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | request ที่เขียนพร้อมกันได้ เกินนี้ตอบ 503 |
| `ENGINE_ROLE` | (compose ตั้งเอง) | ค่าใน `.env` ไม่มีผลกับ deploy: profile `rust` ตั้ง engine เป็น `api`, profile `node` ตั้งเป็น `all` |
| `ENGINE_APPLY_SCHEMA` | `true` | สร้าง/อัปเดตตารางทุกครั้งที่ engine start (ingest ไม่สร้างตาราง รอ engine) |
| `ENGINE_CONSUMER_GROUP` | `skilllane-monitoring-engine` | consumer group ของ Kafka |
| `ENGINE_CONCURRENCY` | `50` | จำนวน message ที่ประมวลผลพร้อมกัน |
| `ENGINE_FLUSH_MS`, `ENGINE_FLUSH_ROWS` | `1000`, `5000` | เขียน ClickHouse ทุกกี่ ms หรือครบกี่แถว |
| `ENGINE_INSERT_INFLIGHT` | `1` | (ingest Rust เท่านั้น) insert ที่ซ้อนกันได้ต่อตาราง · `1` = ทีละก้อนเหมือน engine · `.env.example` ตั้ง `2` |
| `ENGINE_ASYNC_INSERT` | `false` | (ingest Rust เท่านั้น) ใช้ async insert ของ ClickHouse (`async_insert=1`, `wait_for_async_insert=1`): server รวม batch จากทุก ingest เป็น part เดียวต่อรอบ flush ของมันเอง ตอบเมื่อลงดิสก์แล้ว (ack/commit เหมือนเดิม) |
| `CLICKHOUSE_INSERT_FORMAT` | `jsoneachrow` | (ingest Rust เท่านั้น) `rowbinary` = ส่งแถวเป็น RowBinary แทน JSON (server ไม่ต้อง parse JSON) · เปลี่ยนหลังรัน `node bench/load/verify.mjs` ผ่านกับ ClickHouse รุ่นที่ใช้ |
| `ENGINE_QUERY_CACHE_MS` | `10000` | engine เก็บผลลัพธ์ของ query API ไว้ในหน่วยความจำนานเท่านี้ (ต่อ path + พารามิเตอร์ + สิทธิ์ของผู้เรียก) · `0` = ปิด |
| `ENGINE_CORS_ORIGIN` | `http://localhost:3300` | ใส่เมื่อหน้าเว็บอยู่ที่อื่น |
| `CLICKHOUSE_MEMORY_LIMIT` | `0` | `0` = ไม่จำกัด (ClickHouse จำกัดตัวเองที่ 90% ของ RAM เครื่อง) · ใส่ขนาด เช่น `6g` เมื่อมีงานอื่นบนเครื่องเดียวกัน |
| `INGEST_MEMORY_LIMIT`, `ENGINE_MEMORY_LIMIT`, `MONITOR_MEMORY_LIMIT` | `512m`, `1500m`, `1g` | เครื่อง 4 GB ใช้ `256m`, `1g`, `768m` |
| `BULLMQ_BRIDGE_MEMORY_LIMIT` | `256m` | service `bullmq-bridge` (profile `bullmq`, เฉพาะ `LOG_EXPORT=bullmq`) |
| `GOTENBERG_MEMORY_LIMIT` | `1g` | service `gotenberg` (Chromium) ที่แปลงรายงานเป็น PNG / PDF · engine เรียกผ่าน network ของ compose (`GOTENBERG_URL` ตั้งให้แล้ว) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | –, `anthropic/claude-sonnet-5.5` | ข้อความ AI ในรายงานประจำวัน · ไม่ใส่ key = ไม่มี AI รายงานยังครบ · เครื่องต้องออก `https://openrouter.ai` ได้ |
| `REPORT_ENVS`, `REPORT_CRON` | `prod`, `0 9 * * *` | env ที่สร้างรายงานประจำวันอัตโนมัติ และเวลาที่สร้าง (เวลาไทย) · ค่ากฎอื่น `REPORT_*` ดู `.env.example` |

### Queue ของแอป (ใส่เมื่อให้ ingest อ่าน queue แทน HTTP)

ว่างทั้งหมด = รับทาง HTTP อย่างเดียว (`.env.example` มี queue ของ dev ใส่ไว้ ต้องลบหรือเปลี่ยน) · ค่าต้องตรงกับที่แอปตั้งใน SDK · queue ต้องเข้าถึงได้จากเครื่องนี้ (ควรมี TLS + auth)

| ตัวแปร | คืออะไร |
|---|---|
| `LOG_EXPORT` | `kafka` / `rabbitmq` / `bullmq` |
| `LOG_KAFKA_BROKERS` | `host1:9092,host2:9092` |
| `LOG_KAFKA_CLIENT_ID`, `LOG_KAFKA_SSL` | client id, `true` เมื่อใช้ TLS |
| `LOG_KAFKA_SASL_MECHANISM`, `LOG_KAFKA_SASL_USERNAME`, `LOG_KAFKA_SASL_PASSWORD` | `plain` / `scram-sha-256` / `scram-sha-512` + user/pass |
| `LOG_RABBITMQ_URL`, `LOG_RABBITMQ_EXCHANGE` | `amqp(s)://user:pass@host:5672/vhost`, exchange (default `skilllane-monitoring.telemetry`) |
| `LOG_BULLMQ_REDIS_URL`, `LOG_BULLMQ_PREFIX` | `redis(s)://host:6379/0`, prefix (default `bull`) |
| `LOG_TOPIC_LOGS`, `LOG_TOPIC_SPANS` | ชื่อ topic/queue (default `skilllane-monitoring.logs` / `.spans`) |

### S3 เก็บ log เก่า (ไม่บังคับ)

ใส่ = engine ย้าย logs/spans ที่เก่ากว่า `CLICKHOUSE_COLD_AFTER_DAYS` จากดิสก์ไป bucket ทุกชั่วโมง (ยังดูได้ใน monitor)
ว่าง = ทุกอย่างอยู่บนดิสก์ · bucket ไม่มีหรือ S3 ล่ม ระบบยังทำงาน แค่ไม่ย้าย · **ไม่ใช่ backup**

| ตัวแปร | คืออะไร |
|---|---|
| `CLICKHOUSE_S3_URL` | URL ของ S3 ไม่ใส่ bucket ไม่ลงท้าย `/` · AWS: `https://s3.<region>.amazonaws.com` · MinIO: `http://<host>:9000` · ว่าง = ปิด |
| `CLICKHOUSE_S3_BUCKET` | ชื่อ bucket (default `skilllane-monitoring`) · **ต้องสร้างไว้ก่อน** ระบบไม่สร้างให้ · ไฟล์อยู่ใต้ `<bucket>/clickhouse/` |
| `CLICKHOUSE_S3_ACCESS_KEY_ID`, `CLICKHOUSE_S3_SECRET_ACCESS_KEY` | key ที่อ่าน/เขียน/ลบได้ใน bucket นั้น |
| `CLICKHOUSE_S3_REGION` | region ของ bucket |
| `CLICKHOUSE_COLD_AFTER_DAYS` | ย้ายเมื่ออายุเกินกี่วัน (default `14`) |

เปิดใช้แล้วอย่าลบค่า S3 ออก: query ที่แตะข้อมูลที่ย้ายไปแล้วจะ error

### รายงานประจำวันใน Slack (ไม่บังคับ)

ใส่ = หลังสร้างรายงานตาม `REPORT_CRON` engine ส่งรายงานล่าสุดของแต่ละ env ใน `REPORT_ENVS` เข้า channel
ครั้งเดียวต่อ env ต่อวัน: รูป infographic ภาพรวมกับรายละเอียด และลิงก์ไปหน้ารายงาน · รอ AI (ความเห็นอยู่ในรูป)
ได้ไม่เกิน `REPORT_SLACK_AI_WAIT_S` แล้วส่งเลย · แปลงรูปไม่ได้ก็ส่งลิงก์อย่างเดียวพร้อมบอกเหตุผล ·
ส่งแล้วจดใน `<config db>.report_notifications` restart จึงไม่ส่งซ้ำ
ว่าง = ไม่ส่ง

| ตัวแปร | คืออะไร |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) ของ Slack app ที่มี scope `chat:write` และ `files:write` |
| `SLACK_REPORT_CHANNEL` | channel ID (`C…`) ไม่ใช่ชื่อ channel · ต้อง invite bot เข้า channel ก่อน |
| `MONITOR_PUBLIC_URL` | URL ของหน้า monitor ที่คนอ่าน Slack เปิดได้ เช่น `http://10.101.62.52:3300` · ว่าง = ไม่ใส่ลิงก์ |
| `REPORT_SLACK_AI_WAIT_S` | รอความเห็น AI กี่วินาที (default `300`) · `0` = ไม่รอ |

ตั้ง Slack app ครั้งแรก:

1. https://api.slack.com/apps → Create New App → From a manifest → เลือก workspace แล้ววาง
   ```yaml
   display_information:
     name: Skilllane Monitoring
   features:
     bot_user:
       display_name: skilllane-monitoring
   oauth_config:
     scopes:
       bot: [chat:write, files:write]
   settings:
     token_rotation_enabled: false
   ```
2. Install App → Install to Workspace (ขึ้น Request to Install = รอ admin ของ workspace อนุมัติ)
3. OAuth & Permissions → คัดลอก Bot User OAuth Token ใส่ `SLACK_BOT_TOKEN`
4. ใน channel พิมพ์ `/invite @<ชื่อ bot>` แล้วคลิกชื่อ channel → ล่างสุดของ About คือ channel ID ใส่ `SLACK_REPORT_CHANNEL`
5. `docker compose up -d --no-build engine` (แค่ `restart` ไม่อ่าน `.env` ใหม่) · log engine ต้องมี
   `daily report of … , sent to Slack` · ครั้งแรกส่งรายงานล่าสุดภายในราว 30 วินาทีถึง 5 นาที (รอ AI)

ส่งไม่ได้ดูที่ log `[ReportSlack]`: `not_in_channel` = ยังไม่ invite bot · `channel_not_found` = ใช้ชื่อแทน ID ·
`missing_scope` = เพิ่ม scope แล้ว Reinstall to Workspace · `invalid_auth` = token ผิดหรือถูก revoke ·
เครื่องต้องออก `https://slack.com` และ `https://files.slack.com` ได้

## 3. Build

รันจาก root ของ repo · tag ต้องตรงกับ `IMAGE_TAG` ใน `.env`

```sh
cd ~/skilllane-monitoring-deploy/skilllane-monitoring-engine
TAG=$(git rev-parse --short HEAD)
sed -i.bak "s/^IMAGE_TAG=.*/IMAGE_TAG=$TAG/" .env && rm .env.bak   # ใช้ได้ทั้ง Mac และ Linux

docker build -f deploy/Dockerfile.ingest  -t skilllane-monitoring-ingest:$TAG  .   # Rust ingest (รัน cargo test ใน build, ครั้งแรก ~10 นาที)
docker build -f deploy/Dockerfile.bullmq-bridge -t skilllane-monitoring-bullmq-bridge:$TAG .   # เฉพาะเมื่อ LOG_EXPORT=bullmq
docker build -f deploy/Dockerfile.engine  -t skilllane-monitoring-engine:$TAG  .
docker build -f deploy/Dockerfile.monitor -t skilllane-monitoring-monitor:$TAG .
docker pull gotenberg/gotenberg:8.37.0-chromium     # export PNG / PDF ของรายงาน (~500 MB)
```

## 4. Run และตรวจ

`INGEST` ใน `.env` เลือกว่าใครรับ telemetry (= compose profile): `rust` (default) = process `ingest` (Rust, `apps/ingest`)
รับ HTTP + queue ที่ :5100 และ engine รัน `ENGINE_ROLE=api` โดยไม่เปิด port (monitor เรียกผ่าน network ของ compose) ·
`node` = engine รับเองเหมือนเดิม (`ENGINE_ROLE=all`, :5100) ดูข้อ 5 · `LOG_EXPORT=bullmq` กับ `rust` ต้องเพิ่ม profile `bullmq`
(service `bullmq-bridge` หยิบ job จาก Redis ส่งให้ ingest ทาง HTTP, health ที่ :5110 ใน compose network)

```sh
cd deploy
. ./.env 2>/dev/null; INGEST=${INGEST:-rust}
docker compose --profile $INGEST up -d --no-build   # LOG_EXPORT=bullmq: docker compose --profile rust --profile bullmq up -d --no-build
docker compose --profile $INGEST ps                 # engine, monitor, clickhouse healthy · ingest ไม่มี healthcheck (image ไม่มี shell)
curl http://localhost:5100/api/health               # {"ok":true,"clickhouse":true,"role":"ingest","transport":...,"pending":...}
docker compose logs -f ingest                       # stats line ทุก 30 วินาที (rows/s ต่อตาราง, insert ล่าสุด, lag)
```

เปิด `http://localhost:3300` แล้ว login ด้วย `SKILLLANE_MONITORING_ADMIN_USERNAME` / `SKILLLANE_MONITORING_ADMIN_PASSWORD`
แอปที่ส่งทาง HTTP ตั้ง `LOG_HTTP_URL=http://localhost:5100` และ `LOG_HTTP_TOKEN=<ENGINE_INGEST_TOKEN>` (ไม่ต้องแก้ตอนสลับ profile)

ตอนรอบแรกหลังสลับมา `rust`: ดู `curl :5100/api/health` ว่า `ok: true` และ `pending` ไม่โตขึ้นเรื่อย ๆ, ดู stats line ใน
`docker compose logs ingest` ว่ามี rows/s และไม่มี `insert failed`, แล้วเทียบจำนวนแถวต่อ service ใน monitor กับช่วงก่อนสลับสัก 1 ชั่วโมง

## 5. Rollback (กลับไปให้ engine ingest เอง)

สลับด้วยตัวแปรเดียว: `INGEST=node` · image ไม่ต้อง build ใหม่ · SDK ของแอปไม่ต้องแก้ (port เดิม :5100) · ข้อมูลอยู่ที่ ClickHouse เหมือนเดิม
compose **ไม่หยุด** service ของ profile ที่ไม่ active แล้ว ต้อง `stop` เองก่อน ไม่งั้น `ingest` กับ `engine-all` แย่ง :5100 และ queue กัน

```sh
cd deploy
sed -i.bak 's/^INGEST=.*/INGEST=node/' .env && rm .env.bak
docker compose stop ingest engine                   # ของ profile rust (LOG_EXPORT=bullmq: stop bullmq-bridge ด้วย)
docker compose --profile node up -d --no-build      # engine-all: ENGINE_ROLE=all เปิด :5100 · monitor ยังใช้ http://engine:5100 (network alias)
docker compose --profile node ps
curl http://localhost:5100/api/health               # role "all"
```

กลับมาใช้ Rust: `INGEST=rust` ใน `.env`, `docker compose stop engine-all`, `docker compose --profile rust up -d --no-build`
(ดูทั้งสอง profile พร้อมกัน: `docker compose --profile rust --profile node ps -a` · ลบ container ที่หยุดแล้ว: `docker compose --profile rust --profile node rm -f`)

ถ้าใช้ `setup-vm.sh` หรือ script ที่สั่ง `docker compose up -d` เฉย ๆ ต้องใส่ `--profile $INGEST` ด้วย ไม่งั้นไม่มี engine ขึ้นเลย (monitor จะรอ)

### Reader user limits (ClickHouse)

`clickhouse-init/01-reader.sh` creates the read-only user with `max_execution_time 55`, `max_memory_usage 2 GB`,
`max_threads 8`, `max_concurrent_queries_for_user 16` at first start. A ClickHouse that already exists keeps its old
settings until this runs once (as the admin user):

```sh
docker compose exec clickhouse clickhouse-client --user skilllane_monitoring --password "$CLICKHOUSE_PASSWORD" -q \
  "ALTER USER skilllane_monitoring_reader SETTINGS readonly = 2, max_execution_time = 55, max_memory_usage = 2000000000, max_result_rows = 100000, max_threads = 8, max_concurrent_queries_for_user = 16"
```
