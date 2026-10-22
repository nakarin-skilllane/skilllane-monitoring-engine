# คู่มือ deploy skilllane-monitoring บน VM เครื่องเดียว

เอกสารนี้สำหรับคนที่ต้องเอา skilllane-monitoring engine + monitor ขึ้นเซิร์ฟเวอร์ หรือซ้อมบนเครื่องตัวเอง
ครอบคลุม: สิ่งที่ต้องเตรียม, ขั้นตอนทำมือทีละคำสั่ง, ทางลัดด้วยสคริปต์, การอัปเดต/rollback และวิธีแก้ปัญหาที่พบบ่อย
รายละเอียดของไฟล์แต่ละตัวใน `deploy/` อยู่ใน [README.md](README.md) (ภาษาอังกฤษ)

## 1. ภาพรวม

```
นักพัฒนา                         GitHub / npm                           VM (Ubuntu 24.04)
────────                         ────────────                           ─────────────────
git push ─────────────────────▶ skilllane-monitoring-engine ── git clone ─▶ ~/skilllane-monitoring-deploy/
pnpm publish (เมื่อแก้ SDK) ──▶ npm: skilllane-monitoring ──── pnpm install (ใน docker build)
                                                                            │
                                                                            ▼
                                                            docker build  → image engine + monitor
                                                            docker compose up
                                                              caddy :80/:443 ─▶ monitor :3300 ─▶ engine :5100 ─▶ clickhouse
```

หลักการ

- **build บนเครื่องที่รัน** ไม่มี registry: VM clone โค้ดจาก GitHub แล้ว build image เอง
- **engine ไม่ได้รัน queue** มันไปอ่าน queue ของแอป (Kafka / RabbitMQ / Redis) ตาม `LOG_*` ใน `.env`
  ถ้าไม่ตั้งค่า queue เลย engine จะรับ log ทาง HTTP (`POST /api/ingest/<stream>` พร้อม bearer token)
- **เปิดออกนอกเครื่องแค่ Caddy** (80/443) ClickHouse, engine, monitor คุยกันใน docker network เท่านั้น
- **ความลับอยู่ที่เดียว** คือ `deploy/.env` บน VM (ไม่อยู่ใน git)
- **SDK และ contract มาจาก npm** (`skilllane-monitoring`) engine ไม่พึ่ง repo อื่นตอน build

สิ่งที่รันบน VM

| container | image | หน้าที่ | พอร์ตออกนอก |
|---|---|---|---|
| `clickhouse` | `clickhouse/clickhouse-server:25.8` | เก็บ logs/spans; สร้าง user อ่านอย่างเดียวตอนเริ่มครั้งแรก | ไม่มี |
| `engine` | build จาก `deploy/Dockerfile.engine` | ingest (queue หรือ HTTP) → ClickHouse, query API, sign-in | ไม่มี |
| `monitor` | build จาก `deploy/Dockerfile.monitor` | หน้าเว็บ Next.js | ไม่มี |
| `caddy` | `caddy:2-alpine` | HTTPS (Let's Encrypt) → monitor.<DOMAIN>, engine.<DOMAIN> | 80, 443 |

## 2. สิ่งที่ต้องเตรียม

### 2.1 โค้ดต้องอยู่บน GitHub

VM clone branch `main` งานที่ยังไม่ commit จะไม่ถูก deploy
ถ้าแก้ SDK หรือ contract (repo `skilllane-monitoring`) ต้อง `pnpm publish` เวอร์ชันใหม่ขึ้น npm ก่อน
แล้วปรับ `"skilllane-monitoring": "^x.y.z"` ใน `apps/engine/package.json` และ `apps/demo-api/package.json`, `pnpm install`, commit, push

### 2.2 VM

- Ubuntu 24.04, RAM อย่างน้อย 4 GB (แนะนำ 12 GB), disk 50 GB ขึ้นไป, สถาปัตยกรรม arm64 หรือ amd64 ก็ได้
- Oracle Cloud Always Free: shape **VM.Standard.A1.Flex 2 OCPU / 12 GB**, image Canonical Ubuntu 24.04, boot volume 100 GB, public subnet + public IPv4, SSH key ของคุณ
- **Security list** ของ subnet (Networking → VCN → Subnets → security list → Ingress rules):
  เพิ่ม `0.0.0.0/0 TCP 80` และ `0.0.0.0/0 TCP 443` (ถ้าได้ จำกัด source ของ 22 ให้เป็น IP ของคุณ)

### 2.3 DNS

สร้าง A record 2 ตัวชี้ไป public IP ของ VM

```
monitor.<โดเมน>   A   <public ip>
engine.<โดเมน>    A   <public ip>
```

Caddy จะขอใบรับรองได้ก็ต่อเมื่อชื่อทั้งสอง resolve มาที่ VM แล้ว

### 2.4 ถ้า repo เป็น private

ตอน `git clone` บน VM จะถาม username/password ของ GitHub ให้ใช้ Personal Access Token (สิทธิ์อ่าน repo) แทน password
หรือสร้าง deploy key ไว้ใน `~/.ssh` ของ VM แล้ว clone ด้วย ssh URL

## 3. ขั้นตอนทำมือ (บน VM)

### ขั้น 0 เตรียมเครื่อง (ทำครั้งเดียว)

```sh
ssh -i ~/.ssh/<key> ubuntu@<public ip>

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo apt-get install -y git
exit                                  # ssh เข้าใหม่ให้ group docker มีผล
```

image Ubuntu ของ Oracle มี iptables ปิดทุกพอร์ตยกเว้น 22 ไว้ในเครื่อง (คนละชั้นกับ security list) ต้องเปิด 80/443

```sh
sudo iptables -I INPUT 5 -p tcp --dport 80  -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
sudo iptables -I INPUT 5 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### ขั้น 1 clone โค้ด

```sh
mkdir -p ~/skilllane-monitoring-deploy && cd ~/skilllane-monitoring-deploy
git clone --branch main https://github.com/nakarin-skilllane/skilllane-monitoring-engine.git
cd skilllane-monitoring-engine
git rev-parse --short HEAD            # จด sha ไว้เป็น tag ของ image เช่น c6e4cb1
```

### ขั้น 2 สร้างและแก้ `.env`

```sh
cd deploy
cp .env.example .env
chmod 600 .env
nano .env
```

แก้อย่างน้อย 7 บรรทัดนี้ (ค่าสุ่มใช้ `openssl rand -hex 24`)

```sh
DOMAIN=example.com                           # โดเมนจากข้อ 2.3 (ไม่ใส่ monitor./engine.)
IMAGE_TAG=c6e4cb1                            # sha จากขั้น 1

CLICKHOUSE_PASSWORD=<สุ่ม>
CLICKHOUSE_READER_PASSWORD=<สุ่ม>
SKILLLANE_MONITORING_ADMIN_PASSWORD=<รหัสเข้า monitor ของ user admin>
SKILLLANE_MONITORING_AUTH_SECRET=<สุ่ม>
ENGINE_INGEST_TOKEN=<สุ่ม ให้แอปใช้ตอนส่ง log ทาง HTTP>
```

ถ้ามี S3 bucket สำหรับเก็บ log เก่า ใส่ `CLICKHOUSE_S3_*` ด้วย (ไม่บังคับ ดูหัวข้อ 9)

ค่าอื่นปล่อย default ได้ บรรทัด `LOG_*` ของ queue ปล่อยว่าง = HTTP ingest อย่างเดียว
ถ้าจะให้ engine อ่าน queue ของแอป ให้ใส่เฉพาะชุดที่ใช้ เช่น `LOG_EXPORT=kafka` + `LOG_KAFKA_BROKERS=...` (ควรมี SSL/SASL เพราะวิ่งข้าม internet)
VM 4 GB ให้ตั้ง `CLICKHOUSE_MEMORY_LIMIT=2g`, `ENGINE_MEMORY_LIMIT=1g`, `MONITOR_MEMORY_LIMIT=768m`

### ขั้น 3 build image

รันจาก root ของ repo (context คือทั้ง repo มี `.dockerignore` คุมแล้ว) ชื่อและ tag ต้องตรงกับ `IMAGE_TAG` ใน `.env`

```sh
cd ~/skilllane-monitoring-deploy/skilllane-monitoring-engine

docker build -f deploy/Dockerfile.engine  -t skilllane-monitoring-engine:c6e4cb1  .
docker build -f deploy/Dockerfile.monitor -t skilllane-monitoring-monitor:c6e4cb1 .

docker images | grep skilllane-monitoring
```

ครั้งแรกบน 2 OCPU ใช้เวลา 5 ถึง 10 นาที (ขั้น `pnpm install` และ `next build`) รอบถัดไปเร็วขึ้นมากจาก cache

สิ่งที่ Dockerfile ทำ: stage `build` ติดตั้ง dependency จาก npm ตาม lockfile → compile → ตัด devDependencies;
stage สุดท้าย copy เฉพาะ `dist` + `node_modules` ที่จำเป็น รันด้วย user `node` และมี health check ในตัว

### ขั้น 4 รัน

```sh
cd deploy
docker compose up -d --no-build       # ใช้ image ที่เพิ่ง build

docker compose ps                     # รอจน clickhouse / engine / monitor เป็น healthy
docker compose logs -f engine caddy
```

ลำดับที่เกิด: ClickHouse ขึ้นและสร้าง user อ่านอย่างเดียว → engine ต่อ ClickHouse และ apply `clickhouse/schema.sql` เอง
→ monitor → Caddy ขอใบรับรองจาก Let's Encrypt (ใน log ต้องเห็น `certificate obtained successfully` ทั้ง 2 ชื่อ)

### ขั้น 5 ตรวจ

```sh
curl https://engine.<โดเมน>/api/health
# {"ok":true,"clickhouse":true,"role":"all","transport":"stdout","pending":null}
```

เปิดเบราว์เซอร์ `https://monitor.<โดเมน>` sign in ด้วย `admin` และ `SKILLLANE_MONITORING_ADMIN_PASSWORD`

ทดสอบส่ง log เข้าแบบที่แอปจะทำ

```sh
TOKEN=<ENGINE_INGEST_TOKEN>
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
curl -w ' HTTP %{http_code}\n' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"v\":1,\"stream\":\"logs\",\"resource\":{\"service.name\":\"demo-api\",\"app.role\":\"api\",\"deployment.environment.name\":\"dev\",\"service.version\":\"1.0.0\"},\"sentAt\":\"$NOW\",\"items\":[{\"@timestamp\":\"$NOW\",\"log.level\":\"info\",\"log.logger\":\"Demo\",\"event.code\":\"http.request\",\"message\":\"hello\"}]}" \
  https://engine.<โดเมน>/api/ingest/logs
# {"items":1} HTTP 202   ·   ไม่ใส่ token ต้องได้ 401
```

แล้วดูในหน้า Log ของ monitor (env `dev`)

### ขั้น 6 ต่อแอปเข้ามา

แอปที่ติดตั้ง `skilllane-monitoring` ตั้ง env แบบไม่ใช้ queue

```sh
LOG_HTTP_URL=https://engine.<โดเมน>
LOG_HTTP_TOKEN=<ENGINE_INGEST_TOKEN>
OTEL_SERVICE_NAME=<ชื่อ service>  APP_ROLE=api  OTEL_ENV=staging  SERVICE_VERSION=<เวอร์ชัน>
NODE_OPTIONS="--require skilllane-monitoring/register" node dist/main.js
```

หรือใช้ queue ของแอปตามปกติ โดยให้ `LOG_EXPORT` และ connection ตรงกับที่ตั้งใน `.env` ของ engine

## 4. ทางลัด: ใช้สคริปต์แทนขั้น 0 ถึง 4

`deploy/setup-vm.sh` ทำขั้น 0 ถึง 4 ให้ทั้งหมด (ติดตั้ง Docker, เปิด firewall, clone, สร้าง `.env` พร้อมค่าสุ่ม, build, up) และพิมพ์ URL, รหัส admin, ingest token ตอนจบ
รันซ้ำได้ = อัปเดต (pull, rebuild, restart เฉพาะที่เปลี่ยน)

จาก Mac คำสั่งเดียว (scp สคริปต์ขึ้นไปแล้วรัน)

```sh
DOMAIN=<โดเมน> deploy/push-to-vm.sh ubuntu@<public ip> -i ~/.ssh/<key>
```

หรือบน VM เอง

```sh
DOMAIN=<โดเมน> bash setup-vm.sh
```

## 5. อัปเดตและ rollback

### อัปเดตเป็น commit ใหม่

```sh
cd ~/skilllane-monitoring-deploy/skilllane-monitoring-engine
git pull --ff-only
NEW=$(git rev-parse --short HEAD)

docker build -f deploy/Dockerfile.engine  -t skilllane-monitoring-engine:$NEW  .
docker build -f deploy/Dockerfile.monitor -t skilllane-monitoring-monitor:$NEW .

cd deploy
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$NEW/" .env
docker compose up -d --no-build       # สร้างใหม่เฉพาะ container ที่ image เปลี่ยน
```

`.env`, ข้อมูลใน ClickHouse (volume `clickhouse-data`) และใบรับรอง (volume `caddy-data`) อยู่ครบข้ามการอัปเดต

### rollback

แก้ `IMAGE_TAG` ใน `.env` กลับเป็น sha เก่าที่ยังมี image อยู่ (`docker images`) แล้ว `docker compose up -d --no-build`

### เปลี่ยนค่าใน `.env`

แก้แล้ว `docker compose up -d --no-build` compose จะ restart เฉพาะ container ที่ env เปลี่ยน
หมุน `ENGINE_INGEST_TOKEN`: ใส่ `เก่า,ใหม่` คั่นด้วย comma → แอปเปลี่ยนไปใช้ตัวใหม่ → ค่อยลบตัวเก่า

### หยุด

```sh
docker compose down          # หยุด เก็บข้อมูลไว้
docker compose down -v       # หยุดและลบข้อมูล ClickHouse + ใบรับรอง (เริ่มใหม่หมด)
```

## 6. ซ้อมบน Mac ก่อนขึ้น VM

ทำขั้น 1 ถึง 5 เหมือนกันทุกอย่าง โดย

- **clone แยกโฟลเดอร์** (`~/skilllane-monitoring-deploy`) อย่าใช้โฟลเดอร์ที่พัฒนาอยู่ เพื่อพิสูจน์ว่าของบน GitHub ครบ และไม่ปน `.env`
- ข้ามขั้น 0 ทั้งหมด (Docker Desktop มีอยู่แล้ว ไม่มี iptables)
- `.env` ใส่ `DOMAIN=localhost` Caddy จะออกใบรับรองให้ `*.localhost` ด้วย CA ภายในของตัวเอง
- `sed -i` บน Mac ต้องเป็น `sed -i ''`
- curl ต้องเติม `-k --resolve engine.localhost:443:127.0.0.1` และใช้ `https://engine.localhost/...`
  เบราว์เซอร์เปิด `https://monitor.localhost` แล้วกดยอมรับ cert warning

เช็คก่อนเริ่ม

```sh
docker info >/dev/null && echo docker-ok
lsof -iTCP:80 -sTCP:LISTEN; lsof -iTCP:443 -sTCP:LISTEN     # ต้องว่าง
docker compose -p skilllane-monitoring ps                   # ต้องไม่มี stack ชื่อนี้ค้าง
```

compose ใช้ project name `skilllane-monitoring` ตายตัว ถ้ามี stack เก่าอยู่ให้ `docker compose down -v` ในโฟลเดอร์เดิมก่อน
dev stack ของ repo (`docker compose up` ที่ root: Kafka, RabbitMQ, ClickHouse :8123) เป็นคนละ project และคนละพอร์ต เปิดทิ้งไว้ได้

ซ้อมด้วยสคริปต์: `bash deploy/setup-vm.sh` (clone จาก GitHub) หรือใช้โค้ดในเครื่องที่ยังไม่ commit
`SOURCE=local LOCAL_ENGINE=$PWD WORKDIR=/tmp/skilllane-rehearsal bash deploy/setup-vm.sh` (ห้ามใช้โหมดนี้บน VM)

## 7. ปัญหาที่พบบ่อย

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| `docker compose up` บ่นว่า `CLICKHOUSE_PASSWORD` / `DOMAIN` ว่าง | ยังไม่ได้แก้ `.env` | แก้ตามขั้น 2 |
| `pull access denied for skilllane-monitoring-engine` | ไม่มี image ชื่อ/tag ตาม `IMAGE_TAG` | build ตามขั้น 3 ให้ tag ตรงกัน หรือใช้ `docker compose up -d --build` |
| Caddy log วน `obtaining certificate ... failed` | DNS ยังไม่ชี้มา หรือ 80/443 ยังไม่เปิด (security list หรือ iptables) | เช็ค `dig monitor.<โดเมน>` และ `curl -I http://<public ip>` จากข้างนอก |
| engine `unhealthy`, log บอกต่อ ClickHouse ไม่ได้ | ClickHouse ยังไม่ healthy หรือรหัสใน `.env` ถูกแก้หลังสร้าง volume แล้ว | `docker compose logs clickhouse`; ถ้าเปลี่ยนรหัสหลังสร้าง ต้อง `down -v` แล้วเริ่มใหม่ (ข้อมูลหาย) |
| sign in ไม่ผ่านทั้งที่รหัสถูก | เปิดผ่าน `http://` หรือเข้าด้วย IP ตรง ๆ | cookie เป็น `Secure` ต้องเข้าผ่าน `https://monitor.<โดเมน>` |
| ingest ได้ 401 | ไม่ส่ง `Authorization: Bearer <ENGINE_INGEST_TOKEN>` หรือ token ไม่ตรง | เทียบกับ `.env` |
| ingest ได้ 400 `Not an ... v1 envelope` | body ไม่ใช่ envelope v1 (`resource['service.name']` ต้องมี) | ให้แอปส่งผ่าน SDK หรือดูตัวอย่างในขั้น 5 |
| build ค้างหรือ OOM | RAM ไม่พอ (ต่ำกว่า 4 GB) | ขยาย VM หรือ build บน Mac แล้ว push image (`deploy/build-push.sh`, ดู README.md หัวข้อ Optional) |
| Oracle สร้าง A1 ไม่ได้ `Out of capacity` | region มี host ว่างไม่พอ | ลองซ้ำเป็นระยะ, ลดเป็น 1 OCPU / 6 GB แล้วค่อยขยาย, หรืออัปเกรดบัญชีเป็น Pay As You Go (ยังฟรีถ้าอยู่ในโควตา) |

## 8. ความปลอดภัยที่ตั้งไว้แล้ว และที่ควรทำเพิ่ม

ตั้งไว้แล้วใน `deploy/`

- มีแค่ Caddy ที่เปิดพอร์ต; ClickHouse / engine / monitor อยู่ใน docker network เท่านั้น
- HTTPS ทุกเส้นทาง; cookie session เป็น `HttpOnly; Secure; SameSite=Lax`
- HTTP ingest บังคับ bearer token; `ENGINE_CORS_ORIGIN` ล็อกที่ `https://monitor.<DOMAIN>`
- ClickHouse มี user เขียน (engine) และ user อ่านอย่างเดียว (query API / AI) แยกกัน รหัสสุ่ม
- container รันด้วย user `node` ไม่ใช่ root; มี memory limit ทุกตัว
- `.env` อยู่นอก git และ `chmod 600`

ควรทำเพิ่มเมื่อใช้งานจริง

- จำกัด SSH (22) ใน security list ให้เฉพาะ IP ของทีม หรือเข้าผ่าน VPN/Tailscale
- ถ้าให้ engine อ่าน queue ของแอปจริง ให้เปิด allowlist IP ของ VM ที่ queue และใช้ TLS + auth (SASL / amqps / rediss)
- สำรอง volume `clickhouse-data` ตามรอบที่ต้องการ (`docker run --rm -v skilllane-monitoring_clickhouse-data:/data -v $PWD:/backup alpine tar czf /backup/clickhouse-$(date +%F).tgz /data`)
- ตั้ง unattended-upgrades บน Ubuntu และอัปเดต image `clickhouse` / `caddy` เป็นระยะ

## 9. log เก่าเก็บบน S3 (ไม่บังคับ)

กันดิสก์ของ VM เต็ม: engine ย้าย part ของ `logs` และ `spans` ที่อายุเกิน `CLICKHOUSE_COLD_AFTER_DAYS` (default 14 วัน) จากดิสก์ไป bucket ทุกชั่วโมง
ยัง query ได้เหมือนเดิมทั้งหน้า monitor และ AI แต่ข้อมูลเก่าจะช้ากว่า และยังถูกลบเมื่อครบ TTL เดิม (log prod 90 วัน)
ถ้าดิสก์เหลือว่างไม่ถึง 10 % ClickHouse จะย้ายก่อนกำหนด

ไม่ใส่ `CLICKHOUSE_S3_ENDPOINT` = ปิด ทุกอย่างอยู่บนดิสก์ของ VM เหมือนเดิม และระบบทำงานปกติ เปิดใช้:

1. สร้าง bucket (AWS S3 หรือ S3-compatible เช่น Oracle Object Storage) และ access key ที่อ่าน/เขียน/ลบได้เฉพาะ bucket นั้น
2. ใส่ใน `deploy/.env` (`CLICKHOUSE_S3_ENDPOINT` ต้องลงท้ายด้วย `/`)

   ```sh
   CLICKHOUSE_S3_ENDPOINT=https://<bucket>.s3.<region>.amazonaws.com/clickhouse/
   CLICKHOUSE_S3_ACCESS_KEY_ID=<access key>
   CLICKHOUSE_S3_SECRET_ACCESS_KEY=<secret key>
   ```

3. `docker compose up -d` แล้วตรวจ

```sh
docker compose logs engine | grep ColdStorage    # parts older than 14 days move to volume cold ... / moved N parts to volume cold
docker compose exec clickhouse clickhouse-client -q \
  "SELECT table, disk_name, count(), formatReadableSize(sum(bytes_on_disk)) FROM system.parts
   WHERE database = 'skilllane_monitoring' AND active GROUP BY table, disk_name"
```

ข้อควรรู้

- **นี่ไม่ใช่ backup** metadata ของ part ที่อยู่บน S3 ยังเก็บบนดิสก์ของ VM ถ้า VM หาย ไฟล์ใน bucket อ่านกลับไม่ได้
- **bucket ไม่มี หรือ S3 ล่ม ระบบยังทำงานปกติ** แค่ย้ายไม่ได้: ข้อมูลอยู่บนดิสก์ต่อ engine เขียน warn `parts not moved to volume cold` แล้วลองใหม่ชั่วโมงถัดไป
  (ถ้าดิสก์ใกล้เต็ม ClickHouse จะพยายามย้ายเองด้วยและ log error ใน `clickhouse-server.err.log` จนกว่า bucket จะใช้ได้)
- **เปิดแล้วอย่าลบค่า `CLICKHOUSE_S3_*` ออก** ข้อมูลที่ย้ายไปแล้วอยู่บน bucket นั้น ถ้าเอาค่าออก ClickHouse ยังขึ้นแต่ query ที่แตะข้อมูลเก่าจะ error
  จะเลิกใช้ต้องย้ายกลับก่อน (`ALTER TABLE skilllane_monitoring.logs MOVE PARTITION '<วันที่>' TO VOLUME 'default'`) หรือรอให้หมดอายุตาม TTL
- ห้ามเอา `clickhouse-config/storage-s3.xml` ออกจาก compose ตารางที่เคยเปิดใช้อ้าง policy `tiered` อยู่ ClickHouse จะ start ไม่ขึ้น
- เปลี่ยนจำนวนวัน: แก้ `CLICKHOUSE_COLD_AFTER_DAYS` แล้ว `docker compose up -d engine` (ย้ายเฉพาะทางดิสก์ → S3 ลดวันแล้ว part ที่อยู่บน S3 ไม่กลับมา)
