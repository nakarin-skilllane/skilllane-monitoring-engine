# Daily Report: ชั้นข้อมูล + หน้าเว็บ + บทวิเคราะห์จาก AI

สถานะ: ร่างรอยืนยัน · 2026-10-26 · ระยะ 1 และ 2 (Slack อยู่ระยะ 3 นอกเอกสารนี้)

## 1. เป้าหมายและขอบเขต

ทุกเช้าสรุป "เมื่อวาน" ของแต่ละ env เป็นรายงาน 1 หน้าบน monitor มี 2 mode จากข้อมูลชุดเดียวกัน

- **PM**: ผู้ใช้ได้รับผลกระทบไหม ส่วนไหนของระบบมีปัญหา ต้องตัดสินใจอะไร (ภาษาธุรกิจ ไม่มี route, error code, ชื่อไฟล์, stack)
- **Dev**: ต้องแก้อะไรก่อน อยู่ตรงไหน เกี่ยวกับ deploy ไหน (มีลิงก์ไปหน้า error / trace เดิม)

รายงานมี 2 ชั้นที่ไม่พึ่งกัน

1. **ชั้นข้อมูล** (ไม่มี AI): ตัวเลข สถานะ กราฟ รายการปัญหา มาจาก query ทั้งหมด ใช้งานได้ครบแม้ไม่มี AI
2. **ชั้น AI** (OpenRouter → Claude): อ่านชั้นข้อมูลแล้วเขียนบทสรุป ตั้งชื่อภาษาคน อธิบายผลกระทบ แนะนำสิ่งที่ควรทำ ห้ามสร้างตัวเลขใหม่

| อยู่ในขอบเขต | นอกขอบเขต (ระยะต่อไป) |
|---|---|
| รายงานรายวันต่อ env, snapshot, สร้างย้อนหลังตามวัน | Slack / email / รูป infographic (ระยะ 3) |
| หน้า `/reports/daily` แท็บ PM / Dev | รายงานรายสัปดาห์, ช่วงเวลาอิสระ (ระยะ 4) |
| ชั้น AI ผ่าน OpenRouter + ตัวตรวจตัวเลข | ตารางฟีเจอร์, ผู้รับผิดชอบปัญหา, event ทางธุรกิจ (ตัดออก) |
| สิทธิ์ใหม่ใน role | แก้ schema ของ `logs` / `spans` |

## 2. นิยาม

- **วัน** = 00:00–24:00 Asia/Bangkok (UTC+7 ไม่มี DST) คือ `[D-1 17:00 UTC, D 17:00 UTC)` ใน SQL ใช้ `toDate(ts, 'Asia/Bangkok')` และกรองช่วงด้วยเวลา UTC เพื่อให้ตัด partition ได้
- **ค่าเทียบ** = ค่าเฉลี่ยต่อวันของ 7 วันก่อนหน้า ไม่รวมวันรายงาน วันที่ไม่มีข้อมูลนับเป็น 0
- **% เปลี่ยน** = `(ค่า − ค่าเฉลี่ย) / ค่าเฉลี่ย` ถ้าค่าเฉลี่ยเป็น 0: ค่าก็ 0 → `0%` · ค่ามากกว่า 0 → `null` และแสดง "ใหม่"
- **ทิศทางที่ดี** ต่อตัวเลข: ผู้ใช้ที่เจอปัญหา, โรงเรียน, error rate, p95 → ลงดี · request → กลาง (ไม่ระบายสี)
- **ขอบเขต** = 1 env ต่อรายงาน ทุก service รวมกัน รายการปัญหาแสดง service กำกับ
- **ผู้ใช้ที่เจอปัญหา** = `uniqExact(user_id)` ของบรรทัด `level IN ('error','fatal') OR http_status >= 500` (`user_id != ''`) · โรงเรียนใช้ `organization_id` แบบเดียวกัน
- **error rate / request / p95** = จาก `route_stats_1m` (entry span) · p95 ทั้งวันรวมด้วย `quantilesTDigestMerge` จาก state รายนาที (คลาด ~±1%) ไม่อ่าน spans
- **ปัญหา** = กลุ่ม `error_fingerprint != 0` ของ `logs`
  - **ใหม่**: ไม่พบใน 14 วันก่อนวันรายงาน
  - **เพิ่มขึ้น**: จำนวนวันรายงาน > ค่าเฉลี่ยต่อวัน 7 วัน × 1.5 และ > 10 ครั้ง
  - **ลดลง**: จำนวนวันรายงาน < ค่าเฉลี่ย 7 วัน × 0.5 · นอกนั้น **เท่าเดิม**
- **ส่วนที่ error สูงสุด** = route (`METHOD /path`) หรือ job key ใน `route_stats_1m` เรียงตาม `errors` แล้วตามผู้ใช้ที่เจอปัญหาของ route นั้น (จาก `logs.http_route` / `job_type`) แสดง 5 อันดับ

## 3. เกณฑ์สถานะ (ตั้งค่าได้ผ่าน `.env`)

ตรวจจากบนลงล่าง ข้อแรกที่ตรงคือสถานะ เก็บเหตุผลทุกข้อที่ตรงไว้ใน `statusReasons`

| สถานะ | เงื่อนไขเริ่มต้น | ตัวแปร |
|---|---|---|
| มีปัญหา | error rate > ค่าเฉลี่ย × 2 · หรือ dependency ล่มรวม > 30 นาที · หรือ crash ของ app ≥ 1 | `REPORT_BAD_ERROR_RATE_X=2`, `REPORT_BAD_OUTAGE_MIN=30` |
| มีปัญหาบางช่วง | error rate > ค่าเฉลี่ย × 1.5 · หรือมีเหตุการณ์สำคัญ ≥ 1 | `REPORT_WARN_ERROR_RATE_X=1.5` |
| ปกติ | นอกเหนือจากนั้น | |

นิยามใหม่ / เพิ่มขึ้น: `REPORT_NEW_LOOKBACK_DAYS=14`, `REPORT_INCREASE_X=1.5`, `REPORT_INCREASE_MIN=10`
เหตุการณ์ "error rate สูงเป็นช่วง": ช่วง 5 นาทีที่ error rate > ค่าเฉลี่ยของวันเทียบ × `REPORT_SPIKE_X=3` และ request ≥ `REPORT_SPIKE_MIN_REQ=50` ช่วงที่ติดกันรวมเป็นเหตุการณ์เดียว

## 4. เนื้อหารายงาน

### ส่วนหัว (ใช้ร่วม คำนวณครั้งเดียว)
วันที่ · env · สถานะ (จุดสี + ข้อความ + เหตุผล) · สรุป 1 บรรทัดต่อ mode (template จากตัวเลข หรือข้อความจาก AI ถ้ามี) · ตัวเลขหลัก 5 การ์ด: ผู้ใช้ที่เจอปัญหา, โรงเรียนที่ได้รับผลกระทบ, error rate, p95, request แต่ละใบ = ค่า + ค่าเฉลี่ย 7 วัน + % เปลี่ยน + สีตามทิศทางที่ดี

### PM mode
| การ์ด | เนื้อหา |
|---|---|
| เหตุการณ์สำคัญ (เต็มกว้าง) | ช่วงเวลา · เกิดอะไร · กระทบกี่คน · สถานะ (จบแล้ว / ยังไม่จบ ณ สิ้นวัน) จาก dependency ล่ม, ช่วง error rate สูง, crash, cron ล้ม |
| ส่วนที่ error สูงสุด | 5 อันดับ: ชื่อ (AI หรือชื่อจาก path) · จำนวนครั้ง · ผู้ใช้ · % สำเร็จ · ไม่แสดง route |
| ต้องตัดสินใจ / ติดตาม | ปัญหาใหม่ที่กระทบผู้ใช้ · ปัญหาที่เกิดซ้ำ ≥ 3 วันใน 7 วัน · ตัวเลขหลักที่แย่ลงเกินเกณฑ์ |
| บทวิเคราะห์จาก AI | สรุปและสิ่งที่ควรทำ หรือกล่องแจ้งเหตุผลเมื่อ AI ใช้ไม่ได้ (ข้อ 7) |
| แนวโน้ม 7 วัน | กราฟเส้น: ผู้ใช้ที่เจอปัญหา, p95 ต่อวัน |

### Dev mode
| การ์ด | เนื้อหา |
|---|---|
| ปัญหาใหม่ / เพิ่มขึ้น Top 5 (เต็มกว้าง) | เรียงตามผู้ใช้ · ป้าย ใหม่ / +x% / เท่าเดิม / ลดลง · `error_type` + `error_hint` · route หรือ job · `origin_file › origin_function` · ครั้ง · ผู้ใช้ · เวลาเริ่ม · ลิงก์ `/errors/<fingerprint>` และ `/traces/<trace_id>` ตัวอย่าง · หมายเหตุจาก AI ถ้ามี |
| ระบบที่พึ่งพา | ชื่อ · ชนิด · ช่วงที่ล่ม · รวมนาที · ข้อความ error |
| งานเบื้องหลัง | job / cron · สำเร็จ / ล้มเหลว · cron ที่ไม่รันตามรอบ |
| deploy | service · version เดิม → ใหม่ · เวลา · ปัญหาใหม่ที่เริ่มภายใน 2 ชม. หลัง deploy ของ service เดียวกัน |
| endpoint ที่ช้าขึ้น | route · p95 เฉลี่ย 7 วัน · p95 วันรายงาน · ไฮไลต์เมื่อช้ากว่า 20% (route ที่มี request ≥ 50) |
| แนวโน้ม 7 วัน | กราฟเส้น: error rate, p95 ต่อวัน |

**crash** = `app.uncaught_exception`, `app.boot_failed` หรือ `app.started` ที่ไม่มี `app.shutdown` ของ host + service เดียวกันก่อนหน้า (SDK ไม่มี `app.previous_crash`)
**cron ไม่รันตามรอบ** = เดาจากประวัติ: job ชื่อแบบ `Class.method` (จาก `@nestjs/schedule`) ที่มี `job.started` ≥ 3 ครั้งใน 7 วัน ถ้าช่องว่างในวันรายงานยาวกว่าระยะห่างกลาง (median) × 2 ถือว่าพลาด

## 5. สถาปัตยกรรม

```
engine (instance ที่ ENGINE_APPLY_SCHEMA=true)
  reports/
    report-scheduler.ts   08:00 Asia/Bangkok ต่อ env ใน REPORT_ENVS → build → save → analyze
    report-builder.ts     query (reader) → payload  · ฟังก์ชันคำนวณล้วนแยกไฟล์ (rules.ts) ทดสอบได้
    rules.ts              สถานะ, ใหม่/เพิ่มขึ้น, % เปลี่ยน, ตัดวัน, ชื่อจาก path, template
    report-store.ts       daily_reports (writer, config database)
    analyzer/
      analyzer.ts         เตรียม input → provider → ตรวจ schema → ตัวตรวจตัวเลข → บันทึก ai
      openrouter.ts       provider: POST https://openrouter.ai/api/v1/chat/completions
      number-guard.ts     ตัดประโยคที่มีตัวเลขไม่อยู่ใน payload
    reports.controller.ts /api/reports/*
monitor
  app/reports/daily/      หน้า PM / Dev, เลือกวันและ env, สถานะ AI, ปุ่มสร้าง/วิเคราะห์ใหม่
```

- query ข้อมูล telemetry ทั้งหมดผ่าน `ClickhouseService.reader` (user อ่านอย่างเดียว จำกัด 30 วินาทีต่อ query)
- บันทึก snapshot ผ่าน `writer` ลง config database (แบบเดียวกับ users / roles) ไม่ใช้ writer อ่าน telemetry
- ใช้ service เดิมเมื่อทำได้: `releases.service` (deploy), `ops.service` (dependency, job), ส่วนนับ users ของ `errors.service`
- ตัวตั้งเวลาแบบเดียวกับ `ColdStorageMover` (`setTimeout` ไปเวลาถัดไป, `unref`, ปิดตอน shutdown) เมื่อ engine เพิ่ง start และเลยเวลาแล้วแต่ยังไม่มีรายงานของเมื่อวาน ให้สร้างทันที

## 6. ข้อมูลที่เก็บ

```sql
CREATE TABLE IF NOT EXISTS <config_db>.daily_reports (
  env          LowCardinality(String),
  report_date  Date,
  status       LowCardinality(String),   -- ok | partial | bad
  payload      String,                   -- JSON ชั้นข้อมูล (ข้อ 4) + schemaVersion
  ai           String,                   -- JSON ชั้น AI (ข้อ 7) หรือ '' ถ้ายังไม่มี
  ai_status    LowCardinality(String),   -- disabled | pending | ok | failed
  generated_at DateTime64(3, 'UTC'),
  updated_at   DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (env, report_date)
```
อ่านด้วย `FINAL` · สร้างใหม่หรือวิเคราะห์ใหม่ = insert แถวใหม่ทั้งแถว · ไม่มี TTL (ตัวเลขยังอยู่แม้ข้อมูลดิบถูก TTL ลบ)
payload ไม่มี `user_id`, email หรือเนื้อหา request มีแค่จำนวน

จำนวนครั้งที่เรียก AI ต่อวัน: นับใน memory ของ engine + ตรวจซ้ำจาก `ai.attempts` ของรายงานวันนั้น ไม่เกิน `REPORT_AI_MAX_RUNS_PER_DAY` (default 10) รวมทุก env

## 7. ชั้น AI

**ตั้งค่า**
```sh
REPORT_AI_PROVIDER=openrouter            # ว่าง = ปิด
OPENROUTER_API_KEY=
REPORT_AI_MODEL=anthropic/claude-opus-5.5
REPORT_AI_MAX_RUNS_PER_DAY=10
REPORT_AI_TIMEOUT_MS=120000
```

**input** = payload ย่อ: ส่วนหัว, ส่วนที่ error สูงสุด, Top issues (type, hint, route/job, origin, ครั้ง, ผู้ใช้, ป้าย), เหตุการณ์, dependency, deploy, endpoint ช้า, แนวโน้ม · แต่ละรายการมี `key` ให้ AI อ้างถึง

**output** (`response_format: json_schema`, strict)
```ts
{
  pmHeadline: string            // ≤ 1 ประโยค ภาษาธุรกิจ
  devHeadline: string
  areaNames: { key: string; nameTh: string; impactTh: string }[]       // ส่วนที่ error สูงสุด
  issueNotes: { key: string; plainTitleTh: string; impactTh: string; suggestionTh: string }[]
  insightsTh: string[]          // ≤ 5 ข้อ
  actionsTh: { audience: 'pm' | 'dev'; text: string }[]               // ≤ 5 ข้อ
}
```
prompt ระบุ: คนอ่าน PM ห้ามศัพท์เทคนิคในข้อความ PM · ใช้เฉพาะตัวเลขที่อยู่ใน input · ห้ามคาดเดาสาเหตุที่ไม่มีหลักฐาน · ภาษาไทย

**ตรวจผล**
1. ตรวจ JSON กับ schema ฝั่งเรา ผิดรูปแบบ → ลองใหม่ 1 ครั้ง แล้วนับเป็น `invalid`
2. ตัวตรวจตัวเลข: ดึงตัวเลขทุกตัวจากข้อความ (รวม `1,234`, `2.1%`, ทศนิยม) เทียบกับเซตตัวเลขใน input (ยอมคลาดจากการปัดเศษ) ประโยคที่มีตัวเลขไม่อยู่ในเซตถูกตัด และนับไว้ใน `ai.droppedSentences`
3. `key` ที่ไม่มีใน input ถูกตัด

**ai JSON ที่เก็บ**: `{ provider, model, status, reason?, content?, attempts, droppedSentences, usage: { inputTokens, outputTokens, costUsd? }, generatedAt }`

**เมื่อ AI ใช้ไม่ได้**
| กรณี | ทำอะไร | `reason` · ข้อความบนหน้า |
|---|---|---|
| ไม่ได้ตั้ง provider / key | ไม่เรียก | `disabled` · "ยังไม่ได้เปิดใช้ AI วิเคราะห์" |
| 429 / 502 / 503 / timeout / network | ลองใหม่ทันที 2 ครั้ง (backoff) แล้วตัวตั้งเวลาลองใหม่ 3 รอบ ห่าง 30 นาที | `unavailable` · "AI ไม่ว่างชั่วคราว จะลองใหม่อัตโนมัติ" |
| 401 / 403 | ไม่ลองซ้ำ | `auth` · "key ของ AI ไม่ถูกต้อง" |
| 402 / เครดิตหมด | ไม่ลองซ้ำ | `quota` · "เครดิต AI หมด" |
| ผิดรูปแบบหลังลองใหม่ / ถูกปฏิเสธ / ยาวเกิน | ไม่ลองซ้ำ | `invalid` · "วิเคราะห์ไม่สำเร็จ" |
| เกินเพดานต่อวัน | ไม่เรียก | `limit` · "ใช้ AI ครบโควตาวันนี้แล้ว" |

ทุกกรณีมีปุ่ม "วิเคราะห์ใหม่" สำหรับผู้มีสิทธิ์ `reports_manage` ยกเว้น `disabled`

**เมื่อไม่มี AI สิ่งที่หน้าใช้แทน**: headline จาก template · ชื่อส่วนจาก path (`POST /classes/:id/exams/:examId/submit` → "classes › exams › submit") · ไม่มีผลกระทบ / คำแนะนำรายปัญหา · ตัวเลข กราฟ รายการ ลิงก์ ครบเหมือนเดิม

## 8. API (engine)

| method + path | สิทธิ์ | ทำอะไร |
|---|---|---|
| `GET /api/reports/daily?env&date` | `reports` (ตาม env) | snapshot ของวันนั้น ไม่มี → 404 พร้อม `{ canGenerate }` · ไม่ส่ง `date` = เมื่อวาน (Asia/Bangkok) |
| `GET /api/reports/daily/dates?env` | `reports` | วันที่มี snapshot (ให้ตัวเลือกวัน) |
| `POST /api/reports/daily/generate` `{env, date}` | `reports_manage` | คำนวณชั้นข้อมูลใหม่แล้ววิเคราะห์ (สร้างย้อนหลังได้) |
| `POST /api/reports/daily/analyze` `{env, date}` | `reports_manage` | วิเคราะห์ใหม่จาก payload เดิม |

สิทธิ์ใหม่ใน `permissions.ts`: `reports` (กลุ่มดูข้อมูล ผูก env) และ `reports_manage` (กลุ่มจัดการ) role เดิมไม่ได้สิทธิ์ใหม่อัตโนมัติ ยกเว้น admin

## 9. หน้าเว็บ (monitor)

- เมนู "รายงาน" ใน `NavLinks.tsx` (permission `reports`) · route `/reports/daily?date=YYYY-MM-DD&env=prod&mode=pm|dev` default: เมื่อวาน, env แรกที่มีสิทธิ์ (prod ถ้ามี), `pm`
- ส่วนหัว + 5 การ์ด (ชุดเดียวกันทั้งสอง mode) → แท็บ PM / Dev → การ์ดตามข้อ 4
- ตัวเลือกวันจาก `/dates` · ตัวเลือก env · สถานะ AI (กำลังวิเคราะห์ / ล้ม + เหตุผล / ปุ่มวิเคราะห์ใหม่)
- ไม่มี snapshot: "ยังไม่มีรายงานของวันนี้" + ปุ่ม "สร้างรายงาน" ถ้ามีสิทธิ์
- ใช้ component และ design system เดิม (`Kpi`, `Panel`, `charts`, `badges`, `Tabs`) PM mode ไม่ render route, error code, ไฟล์ หรือ stack

## 10. ทดสอบ

- เพิ่ม `vitest` ใน engine (repo ยังไม่มี test framework)
- unit (`rules.ts`, `number-guard.ts`): เกณฑ์สถานะทุกขอบ, ใหม่ / เพิ่มขึ้น / ลดลง, ตัดวัน Asia/Bangkok (รอบเที่ยงคืนไทย = 17:00 UTC), % เปลี่ยนเมื่อค่าเฉลี่ยเป็น 0, ชื่อจาก path, ตัวตรวจตัวเลข (รูปแบบตัวเลขไทย/อังกฤษ, การปัดเศษ, ประโยคที่ต้องตัด)
- analyzer กับ provider จำลอง: สำเร็จ, 429 แล้วสำเร็จ, 401, 402, JSON ผิดรูปแบบ, ตัวเลขแต่ง, เกินเพดาน
- integration: ClickHouse ใน docker + ข้อมูลจำลอง 15 วัน มี fingerprint ใหม่ 1 ตัว, dependency ล่ม 1 ครั้ง, cron ไม่รัน 1 ครั้ง, deploy 1 ครั้ง → ตรวจ payload ตรงตามคาด
- ตัวเลขส่วนหัวในหน้า PM และ Dev มาจากวัตถุเดียวกัน (ตรวจใน test ของหน้า)
- วัดเวลา build กับข้อมูลระดับ prod บน server: เป้า ≤ 30 วินาที ถ้าเกิน เสนอ MV `error_daily (env, day, fingerprint, count, users uniqState)` แยกต่างหาก

## 11. ลำดับงาน

1. **ระยะ 1 ชั้นข้อมูล + หน้าเว็บ**: `rules.ts` + test → builder → store → scheduler → controller + สิทธิ์ → หน้า `/reports/daily` → integration test + วัดเวลา
2. **ระยะ 2 ชั้น AI**: provider OpenRouter → number guard + test → analyzer + สถานะ + เพดาน → ปุ่มวิเคราะห์ใหม่ / สถานะบนหน้า → ทดสอบกับ key จริงบนเครื่องซ้อม

## 12. ความเสี่ยงและเรื่องที่ยังเดา

- ส่วน "ใหม่" อ่าน `logs` 14 วัน กรองด้วย fingerprint (มี bloom index) ต้องวัดจริง (ข้อ 10)
- cron ไม่รันตามรอบเป็นการเดาจากประวัติ job ที่รันไม่สม่ำเสมออาจเตือนผิด แสดงเป็น "อาจไม่รันตามรอบ"
- spans เก็บ 14 วัน ลิงก์ trace ตัวอย่างของรายงานเก่าอาจเปิดไม่ได้ แสดงว่า "trace หมดอายุแล้ว"
- ข้อมูลที่ส่งออกไป OpenRouter เป็นตัวเลขสรุปและชื่อ error ที่ mask แล้ว ทีมควรปิดการใช้ข้อมูลฝึกโมเดลในบัญชี OpenRouter
