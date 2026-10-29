# Monitoring UI: design brief (HTML mockups for approval)

Static HTML + CSS (+ a little vanilla JS for toggles) only. No Next.js yet: the team builds it after
these screens are approved. Every block on a screen must be fillable from the engine API in
`../../SPEC.md` §8, so the design is buildable as drawn.

## Who uses it and for what

- **Developer on call** (often at night, on a laptop): "something is wrong in prod: what, since when, where in the code, who is affected?"
- **Developer debugging one request**: given a user complaint, a trace id from the `request-id` header, or a user id → see every log line and span of that request.
- **Tech lead after a deploy**: "did the new version add errors or make routes slower?"
- **AI assistant** (indirect): every error and trace can be copied as a compact Markdown summary to paste into an AI chat.

The five requirements the product must visibly satisfy (each screen should make at least one obvious):
1. works with any app that installs the package (show service / role / env everywhere),
2. activity log with time (log explorer),
3. per-request tracing (trace list + waterfall),
4. AI friendly (copy-for-AI, stable field names, link to data dictionary),
5. readable errors that say where to fix (hint as title, fix sentence, origin function + file, target, category).

## Readable error rule (from skilllane-monitoring pretty format, keep it)

An error line is shown as:
- **title** = `error.hint` (constant per kind of error, e.g. "Value too long for column"), else the event title, else the message;
- then key=value chips in this order: method, path(route), status, source/job, file, target, duration;
- **error detail** = `error.detail` (this specific case when the SDK can tell), then **how to fix** = `error.how_to_fix`;
- **actual error** = `Type [CODE] message`;
- trace id + user id.
Category shown as a plain-language chip (Thai): bug "ต้องแก้โค้ด", input "ข้อมูลที่ส่งมาผิด", data "ข้อมูลในระบบขัดกัน", dependency "ระบบที่เรียกใช้มีปัญหา", config "ตั้งค่าผิด".

## Screens (one file each, all in this folder)

| File | Thai nav label | Purpose | API |
|---|---|---|---|
| `index.html` | – | hub: what this is, links to every screen, design principles, legend | – |
| `overview.html` | ภาพรวม | health of every service in the selected env; what needs attention now | `/api/overview` |
| `logs.html` | Log | activity log explorer: search, filter, histogram by level, readable rows, detail drawer | `/api/logs` |
| `traces.html` | Trace | find requests/jobs: duration-over-time scatter (errors highlighted) + table | `/api/traces` |
| `trace-detail.html` | (from Trace) | one trace: waterfall across services, failed span, span detail, the trace's logs | `/api/traces/:id` |
| `errors.html` | Error | error groups ("issues") with category, count trend, users, routes, new badge | `/api/errors` |
| `error-detail.html` | (from Error) | one error group: what / this case / where to fix / actual error / stack / occurrences / copy for AI | `/api/errors/:fingerprint` |
| `jobs.html` | งานเบื้องหลัง | queues, cron and consumers (BullMQ, Kafka, RabbitMQ, cron) + dependency status timeline | `/api/jobs`, `/api/dependencies` |

Shared: `assets/styles.css` (tokens + components), `assets/app.js` (theme toggle, drawer, tabs, copy buttons).
Each screen is a standalone HTML document (`<!doctype html>`, `<meta charset>`, viewport meta) linking `assets/styles.css`
and `assets/app.js` relatively, so it opens straight from disk. Screen-specific CSS goes in the page's own `<style>`.
Screens link to each other with relative links (row in Trace → `trace-detail.html`, group in Error → `error-detail.html`, etc.).

App shell on every screen: left sidebar (product name "skilllane monitor", nav items above, link to data dictionary),
top bar with **env switcher** (dev · staging · prod segmented control; prod visibly marked), **time range** (15 นาที / 1 ชั่วโมง / 6 ชั่วโมง / 24 ชั่วโมง / 7 วัน / กำหนดเอง),
a **global jump box** ("trace id, user id หรือคำค้น"), and a theme toggle. Selected: env `prod`, range "1 ชั่วโมงล่าสุด" (Errors and Jobs show 24 ชั่วโมง).

At the bottom of every screen: a collapsible `<details>` "หมายเหตุการออกแบบ" listing: purpose, which endpoint feeds each block,
interactions (what is clickable, what opens), and open questions for the team.

## Constraints

- Thai UI labels with technical terms in English as engineers say them (log, trace, span, route, p95, error rate, queue).
  Error hints/fixes stay English (the library writes them in English). Numbers with thousands separators; durations `84 ms`, `1.8 s`.
  Times in ICT: `14:18:07.412` in lists, `17 ต.ค. 14:18` for dates.
- Light and dark themes, both first class (on-call at night). Tokens on `:root`, dark under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and again `:root[data-theme="dark"] {…}`;
  `body` has an explicit token background. The toggle sets `data-theme` on `<html>`.
- Fonts only from Google Fonts, must cover Thai. Suggested: IBM Plex Sans Thai (UI) + IBM Plex Mono (ids, code, numbers);
  another Thai-capable pairing is fine if justified in DESIGN.md. Real fallback stacks.
- No external images or icon CDNs. Icons as small inline SVG. Charts as hand-drawn inline SVG with realistic data,
  drawn to scale, colors from tokens (readable in both themes). No chart libraries.
- Works at 400 px wide: sidebar collapses, tables scroll inside their own container, page never scrolls sideways.
- Accessible: visible focus, contrast AA, `prefers-reduced-motion`, semantic headings/tables.
- Information-dense but calm: an operations tool, not a marketing page. No hero sections, no emoji, no gradient blobs.
  Avoid the stock "AI look" (cream + serif + terracotta, purple gradient, everything in rounded cards with shadows).
- Visual identity (since 2026-10-18): the tone of www.skilllane.com: white panels on light grey, SkillLane deep green
  `#00532a` as brand and accent, its promo orange only for the logo and one call to action per page (DESIGN.md §1, §3).
  Semantic colors (error red, warn amber, ok green, info) are separate from the accent.

## Canonical demo dataset (every screen must agree with this)

Now = 17 Oct 2026 14:20 ICT. Env `prod`. Deploy `school-core-api` 31.4.0 at 08:00 today (previous 31.3.2).

Services (last 1 h, prod):
| service / role | traffic | errors | p95 | notes |
|---|---|---|---|---|
| school-core-api / api | 1,180 req/min | 0.16 % (112 × 5xx) | 312 ms | main API; 5xx = 65 GET /classes/:id/report + 47 POST /question-bank/import |
| school-core-api / worker | 4 job/min (240 attempts) | 2.1 % (5 failed attempts) | 4.2 s | BullMQ, RabbitMQ and cron jobs; afternoon peak (3,890 attempts in 24 h) |
| school-core-api / persister | 240 msg/min | 0 % | 38 ms | Kafka consumer `school.events.score` |
| school-etl-api / api | 54 req/min | 0 % | 1.9 s | Excel parsing |
| video-transcoder-api / api | 310 req/min | 0.1 % | 95 ms | |

Top routes, school-core-api/api, last 1 h:
`GET /question-bank/my` 14,210 req, 0 % err, p95 140 ms ·
`GET /me` 12,800, 0 %, 22 ms ·
`GET /classes/:id/students` 9,870, 0 %, **p95 2.4 s (slow)** ·
`GET /exams/:id` 8,940, 0 % (3.1 % 4xx), 96 ms ·
`POST /exams/:id/submit` 6,120, 0 % (1.1 % 4xx = 65), 180 ms ·
`GET /classes/:id/report` 3,480, **1.9 %**, 420 ms ·
`POST /question-bank/import` 412, **11.4 %**, 2.1 s ·
`POST /reports/:id/generate` 380, 0 %, 60 ms.

Error groups (prod, last 24 h):
1. **Value too long for column** · ORA-12899 · category data · error · count 214 · users 37 · first seen 16 ต.ค. 09:12 · last 14:18 ·
   route `POST /question-bank/import` · usecase `ImportQuestionBankCommand` · origin `ImportQuestionBankHandler.execute` ·
   file `src/domain/question-bank/import-question-bank.handler.ts` · target `QuestionBankEntity.title` · failed step `oracle INSERT QUESTION_BANK`.
   hint detail: "A text value exceeds the column size. Common in Excel imports; validate length before saving."
   fix: "QuestionBankEntity.title got 312 (max 255). Validate the length in the DTO or import before saving."
   actual: `QueryFailedError [ORA-12899] ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)`.
2. **Read from undefined value** · NULL_READ · category bug · error · count 66 (1 at 08:03, 65 in 13:20–14:20) · users 21 · **NEW since 31.4.0** (first seen 17 ต.ค. 08:03) · last 14:16 ·
   route `GET /classes/:id/report` · usecase `GetClassReportQuery` · origin `GetClassReportHandler.execute` ·
   file `src/domain/class-report/get-class-report.handler.ts` · target `school`.
   fix: "\"school\" is a relation of ClassroomEntity, StudentEntity: the parent object was undefined, or school was not loaded. Check relations / leftJoinAndSelect."
   actual: `TypeError: Cannot read properties of undefined (reading 'school')`.
3. **Google API rate limited** · rateLimitExceeded · category dependency · shown as ERR with "38 retry · 3 ล้มเหลวจริง" (a single job.retry line is WRN) · count 41 (38 retries, 3 final failures: #88044 09:03, #88207 11:26, #88391 13:58) · last 14:12 · users 14 · job `report:generate` queue `report` (BullMQ) ·
   origin `GoogleSheetsService.exportReport` · file `src/domain/report/google-sheets.service.ts` · target `sheets.googleapis.com`.
   hint detail: "Too many requests to the Google API. The rate-limit service retries with backoff; reduce concurrency if frequent."
   fix (latest occurrence): "sheets.googleapis.com returned 429 rateLimitExceeded on 'Write requests per minute per user'. The job retries with backoff; lower the export concurrency or batch the writes."
4. **Redis "cache" refused connection** · ECONNREFUSED · category dependency · error · count 3 (dependency.down 13:42:35.118 + 2 cache-client errors; requests fall back to the DB, so no 5xx) · 13:42:35–13:43:20 (down 45.2 s) · target `10.0.3.21:6379` · affects `cache`.
   Lines: down 13:42:35.118 ERR · still_down 13:43:05.118 WRN retry 6 · up 13:43:20.318 INF retry 9 reason recovered.
5. **Not found** · HTTP_404 / EntityNotFoundError · category input · warn · count 2,771 (277 in the last hour) · users 402 · first seen 3 ต.ค. 15:02 · route `GET /exams/:id` · origin `GetExamHandler.execute` · target `ExamEntity` ·
   fix: "No ExamEntity found by (id). Check the id the client sent, or whether the row was deleted."
6. **Invalid request** · HTTP_400 · category input · warn · count 655 (65 in the last hour, same day shape as group 5) · users 287 · first seen 4 ต.ค. 09:40 · route `POST /exams/:id/submit` · target `answers.*.choice` ·
   fix: "Rejected fields: answers.*.choice. The response message lists the rule each one broke."
7. **Query cancelled** · ORA-01013 · category dependency · error · count 12 · route `GET /classes/:id/students`.
8. **DB deadlock** · ORA-00060 · category data · error · count 4 · usecase `SubmitExamCommand`.

Trace A (error, used in trace-detail and linked from errors/logs): `4bf92f3577b34da6a3ce929d0e0e4736`,
17 ต.ค. 14:18:07.412, `POST /question-bank/import` → 500, 1,842 ms, 13 spans, 1 error, services school-core-api/api + school-etl-api/api,
user `u_1029` (teacher, school `s_118`). Spans (start ms → end ms):
1. `POST /question-bank/import` SERVER school-core-api 0 → 1,842 (ERROR, 500)
2. `request handler - /question-bank/import` INTERNAL 2 → 1,840
3. `GET` (ioredis) CLIENT 6 → 8, peer 10.0.3.21:6379
4. `POST` (http client) CLIENT 12 → 1,322, peer school-etl-api:5102
5. `POST /etl/parse-excel` SERVER school-etl-api 16 → 1,318
6. `request handler - /etl/parse-excel` INTERNAL 17 → 1,317
7. `S3.GetObject` CLIENT 22 → 305 (school-etl-api)
8. `parse-excel` INTERNAL 308 → 1,302 (school-etl-api)
9. `oracle SELECT QUESTION_BANK` CLIENT 1,330 → 1,362
10. `oracle SELECT SUBJECT` CLIENT 1,365 → 1,381
11. `oracle INSERT QUESTION_BANK` CLIENT 1,390 → 1,812 **ERROR** ORA-12899 (failed step)
12. `oracle ROLLBACK` CLIENT 1,815 → 1,826
13. `POST /question-bank/import` response write INTERNAL 1,828 → 1,840
Logs of trace A: 14:18:07.414 INF school-core-api/api `ImportQuestionBankHandler` "Importing question bank file" ·
14:18:08.729 INF school-etl-api/api "Parsed excel" rows=120 · 14:18:09.226 ERR school-core-api/api error group 1 ·
14:18:09.254 ERR school-core-api/api `http.request` POST /question-bank/import 500 1,842 ms.

Trace B (slow, OK): `9a1c4e0b7d2f4c8e8b3a6f5d2e1c0b9a`, 14:11:52.090, `GET /classes/:id/students` 200, 2,712 ms; the slow span is `oracle SELECT STUDENT` 2,430 ms.
Trace C (job): `e7c3d2a1f09e885ca13e9b0a8d4f21b6`, BullMQ `report:generate` #88412 attempt 2/3 failed with error group 3, 10,040 ms.
Job #88412 timeline: attempt 1/3 started 14:12:10.465, job.retry 14:12:20.377 (9,912 ms) · attempt 2/3 (Trace C, 9 spans) started 14:12:31.468, job.retry 14:12:41.508 (10,040 ms) · attempt 3/3 started 14:13:11.520, job.finished 14:13:15.164 (3,644 ms).

Jobs (prod, 24 h): BullMQ `report` (`report:generate`) started 380 · finished 339 · retried 38 · failed 3 · p95 4.2 s ·
BullMQ `notification` (`notification:send`) 2,410 · 0 failed · p95 310 ms ·
BullMQ `export` (`export:class-score`) 120 · 1 failed · p95 12.6 s ·
Kafka `school.events.score` (persister) 345,600 messages · 0 failed · p95 38 ms · consumer group rebalanced at 13:05 ·
RabbitMQ `lms.sync` 860 · 4 redelivered · 0 failed ·
cron `ReportCleanupService.purge` hourly, last OK 14:00 · cron `AttendanceSyncService.sync` every 15 min, failed once at 11:45.

Dependencies (prod): redis `cache` 10.0.3.21:6379 up since 13:43:20 (was down 45.2 s) · redis `queue` 10.0.3.22:6379 up ·
kafka `producer` kafka-0.kafka:9092 up · rabbitmq 10.0.5.10:5672 up · http `ThaID` imauth.bora.dopa.go.th 4 rejected requests (401) in the last hour.

Users: `u_1029` teacher s_118, `u_2201` student s_118, `u_0412` admin s_007, `u_3318` teacher s_042.

## Change log of this dataset

- 2026-10-18 · look · UI renamed **skilllane monitor** (backend names `@skilllane/*` and ClickHouse db `skilllane_monitoring` unchanged), palette moved to the skilllane.com tone, motion system and 3D views added (DESIGN.md §1, §3, §7b, §7c); no dataset value changed.
- 2026-10-18 · design review pass · The review found numbers that disagreed between screens because this BRIEF disagreed with itself. Decisions (every screen follows them, DESIGN.md §10):
  - school-core-api/api error rate 0.42 % → **0.16 %**: the only failing routes give 66 + 47 ≈ 112 5xx per hour (65 + 47 used, so group 2's 08:03 occurrence stays outside the hour). There is no 5xx spike; per-minute 5xx are 0–4.
  - worker 86 job/min → **4 job/min** (240 attempts in the last hour, 5 failed = 2.1 %): 86/min was 5,160 per hour against 3,890 attempts in 24 h on Jobs. The afternoon is busier than the 24 h average (2.7/min).
  - `POST /exams/:id/submit` 4xx 10.7 % → **1.1 %**: group 6 is 655 in 24 h; with the same day shape as group 5 (2,771 in 24 h, 277 in the last hour) that is 65 in the last hour = 1.1 % of 6,120.
  - Log lines in the last hour: ERR 228 = 2 × 112 (error line + `http.request` line per failed request) + 3 ECONNREFUSED + 1 job.failed; WRN 694 = 2 × 342 4xx + 4 job.retry + 4 ThaID 401 + still_down + redelivered.
  - Trace C / job #88412 timeline fixed (above); group 3 last seen 14:12; its file is `src/domain/report/google-sheets.service.ts`.
  - Hourly 24 h series start at 16 ต.ค. 14:20 on every screen. Group 1 = 14, 16, 11, 5, 3, 6, 6, 4, 1, 0 × 7, 2, 6 (3 before 08:00 + 3 after), 13, 20, 24, 21, 15, 47 → 31.3.2 = 71, 31.4.0 = 143, peak 47 in the last hour.
  - firstSeen of groups 5 and 6 moved inside the window the engine can return (3 ต.ค. 15:02, 4 ต.ค. 09:40).
