# Deploy skilllane-monitoring-engine

## 1. Clone

```sh
mkdir -p ~/skilllane-monitoring-deploy && cd ~/skilllane-monitoring-deploy
git clone --branch main https://github.com/nakarin-skilllane/skilllane-monitoring-engine.git
cd skilllane-monitoring-engine/deploy
```

## 2. `.env`

```sh
cp .env.example .env && chmod 600 .env
openssl rand -hex 24          # ใช้สร้างค่าสุ่มให้รหัสแต่ละตัว
nano .env
```

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
| `BIND_ADDRESS` | `127.0.0.1` | IP ที่ monitor (:3300) และ engine (:5100) รับ · `127.0.0.1` = เข้าได้จากเครื่องนี้เท่านั้น (HTTP ไม่เข้ารหัส อย่าเปิดออก network โดยไม่มี proxy ที่ทำ HTTPS) |
| `ENGINE_IMAGE`, `MONITOR_IMAGE` | build บนเครื่อง | ใส่เมื่อดึง image จาก registry แทนการ build |
| `CLICKHOUSE_DATABASE` | `skilllane_monitoring` | ชื่อ database · ตั้งก่อน start ครั้งแรก |
| `CLICKHOUSE_USER`, `CLICKHOUSE_READER_USER` | `skilllane_monitoring`, `skilllane_monitoring_reader` | ชื่อ user เขียน / อ่าน · ตั้งก่อน start ครั้งแรก |
| `SKILLLANE_MONITORING_ADMIN_USERNAME` | `admin` | ชื่อ login ของ admin |
| `SKILLLANE_MONITORING_SESSION_HOURS` | `8` | อายุ session ของหน้า monitor (ชั่วโมง) |
| `ENGINE_INGEST_HTTP` | `true` | รับ log ทาง HTTP (`POST http://localhost:5100/api/ingest/<stream>`) · `false` เมื่อใช้ queue อย่างเดียว |
| `ENGINE_INGEST_MAX_BYTES` | `2000000` | ขนาด request สูงสุดต่อครั้ง |
| `ENGINE_INGEST_MAX_INFLIGHT` | `64` | request ที่เขียนพร้อมกันได้ เกินนี้ตอบ 503 |
| `ENGINE_ROLE` | `all` | `ingest` / `api` / `all` · เครื่องเดียวใช้ `all` |
| `ENGINE_APPLY_SCHEMA` | `true` | สร้าง/อัปเดตตารางทุกครั้งที่ engine start |
| `ENGINE_CONSUMER_GROUP` | `skilllane-monitoring-engine` | consumer group ของ Kafka |
| `ENGINE_CONCURRENCY` | `50` | จำนวน message ที่ประมวลผลพร้อมกัน |
| `ENGINE_FLUSH_MS`, `ENGINE_FLUSH_ROWS` | `1000`, `5000` | เขียน ClickHouse ทุกกี่ ms หรือครบกี่แถว |
| `ENGINE_CORS_ORIGIN` | `http://localhost:3300` | ใส่เมื่อหน้าเว็บอยู่ที่อื่น |
| `CLICKHOUSE_MEMORY_LIMIT`, `ENGINE_MEMORY_LIMIT`, `MONITOR_MEMORY_LIMIT` | `6g`, `1500m`, `1g` | สำหรับ VM 12 GB · VM 4 GB ใช้ `2g`, `1g`, `768m` |

### Queue ของแอป (ใส่เมื่อให้ engine อ่าน queue แทน HTTP)

ว่างทั้งหมด = รับทาง HTTP อย่างเดียว · ค่าต้องตรงกับที่แอปตั้งใน SDK · queue ต้องเข้าถึงได้จากเครื่องนี้ (ควรมี TLS + auth)

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

## 3. Build

รันจาก root ของ repo · tag ต้องตรงกับ `IMAGE_TAG` ใน `.env`

```sh
cd ~/skilllane-monitoring-deploy/skilllane-monitoring-engine
TAG=$(git rev-parse --short HEAD)
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$TAG/" deploy/.env          # Mac: sed -i ''

docker build -f deploy/Dockerfile.engine  -t skilllane-monitoring-engine:$TAG  .
docker build -f deploy/Dockerfile.monitor -t skilllane-monitoring-monitor:$TAG .
```

## 4. Run และตรวจ

```sh
cd deploy
docker compose up -d --no-build
docker compose ps                                   # ทุกตัว healthy
curl http://localhost:5100/api/health               # {"ok":true,"clickhouse":true,...}
```

เปิด `http://localhost:3300` แล้ว login ด้วย `SKILLLANE_MONITORING_ADMIN_USERNAME` / `SKILLLANE_MONITORING_ADMIN_PASSWORD`
แอปที่ส่งทาง HTTP ตั้ง `LOG_HTTP_URL=http://localhost:5100` และ `LOG_HTTP_TOKEN=<ENGINE_INGEST_TOKEN>`
