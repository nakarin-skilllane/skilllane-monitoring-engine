#!/usr/bin/env node
/**
 * Traffic generator for school-core-api (SPEC §10). Plain Node 20, no deps.
 *   TRAFFIC_URL   default http://localhost:5101
 *   TRAFFIC_RPS   default 8 requests per second
 *   TRAFFIC_USERS default 25 demo users
 * Runs until Ctrl-C; prints a one-line summary every 10 s.
 */
const BASE = (process.env.TRAFFIC_URL || 'http://localhost:5101').replace(/\/+$/, '')
const RPS = Math.max(0.1, Number(process.env.TRAFFIC_RPS) || 8)
const USERS = Math.max(1, Number(process.env.TRAFFIC_USERS) || 25)
const SUMMARY_MS = 10_000

const crypto = require('crypto')

const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1))
const pick = (list) => list[Math.floor(Math.random() * list.length)]

const FIRST = ['ณัฐวุฒิ', 'กมลชนก', 'ธนกร', 'พิมพ์ชนก', 'ศุภกฤต', 'ปภาวรินทร์', 'ภูริภัทร', 'ชนิดาภา']
const LAST = ['ศรีสุข', 'วงศ์ไทย', 'ใจดี', 'แก้วมณี', 'ทองคำ', 'บุญมา', 'พัฒนากุล', 'รัตนวงศ์']

/** A made-up 13-digit Thai national ID with a valid checksum. */
function nationalId() {
  const digits = `1${String(rand(10_000_000_000, 99_999_999_999))}`
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i)
  return `${digits}${(11 - (sum % 11)) % 10}`
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A JWT-shaped bearer token (the demo apps do not verify it). */
function tokenFor(user) {
  const header = b64({ alg: 'RS256', typ: 'JWT' })
  const payload = b64({ sub: user.id, school: user.school, role: user.role, exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${header}.${payload}.${crypto.randomBytes(32).toString('base64url')}`
}

const users = Array.from({ length: USERS }, (_, i) => ({
  id: `u_${1001 + i}`,
  school: `s_${101 + (i % 6)}`,
  role: i % 7 === 0 ? 'admin' : i % 3 === 0 ? 'student' : 'teacher',
  email: `teacher${1001 + i}@school${101 + (i % 6)}.ac.th`,
  name: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
  session: crypto.randomBytes(16).toString('hex'),
}))
for (const user of users) user.token = tokenFor(user)

function headersFor(user) {
  return {
    'x-demo-user': user.id,
    'x-demo-school': user.school,
    'current-role': user.role,
    authorization: `Bearer ${user.token}`,
    cookie: `session=${user.session}; lang=th`,
  }
}

/** multipart/form-data with one field and one picture (random bytes). */
function multipart(fields, file) {
  const boundary = `----skilllanedemo${crypto.randomBytes(8).toString('hex')}`
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  )
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Weights from SPEC §10 (+ login, profile, attach). Each returns
 * { method, path, body?, anonymous?, raw?, contentType? }; `user` is the caller.
 */
const SCENARIOS = [
  {
    name: 'my',
    weight: 35,
    make: () => ({
      method: 'GET',
      path:
        Math.random() < 0.6
          ? `/question-bank/my?subject=${pick(['MATH', 'SCI', 'THAI', 'ENG', 'SOC'])}&page=${rand(1, 3)}&limit=20`
          : '/question-bank/my',
    }),
  },
  {
    name: 'import',
    weight: 15,
    make: (user) => ({
      method: 'POST',
      path: '/question-bank/import',
      body: {
        fileName: `question-bank-${rand(1, 40)}.xlsx`,
        uploadedBy: { id: user.id, email: user.email },
        options: { sheet: 'Questions', skipDuplicates: true, dryRun: false },
      },
    }),
  },
  {
    // ids ending in 7 hit the NULL_READ bug; send them often enough to see.
    name: 'report',
    weight: 15,
    make: () => {
      const id = Math.random() < 0.3 ? rand(1, 49) * 10 + 7 : rand(1, 499)
      return { method: 'GET', path: `/classes/${id}/report` }
    },
  },
  {
    // ids above 900 do not exist → 404
    name: 'exam',
    weight: 10,
    make: () => ({ method: 'GET', path: `/exams/${Math.random() < 0.4 ? rand(901, 999) : rand(1, 900)}` }),
  },
  {
    name: 'submit',
    weight: 8,
    make: () => {
      const invalid = Math.random() < 0.8
      const answers = Array.from({ length: rand(3, 6) }, (_, i) => ({
        questionId: 1000 + i,
        choice: pick(['A', 'B', 'C', 'D']),
      }))
      if (invalid) answers[0].choice = pick(['E', 'X', ''])
      return {
        method: 'POST',
        path: `/exams/${rand(1, 900)}/submit`,
        body: { studentId: rand(100, 49_999), startedAt: new Date(Date.now() - rand(20, 60) * 60_000).toISOString(), answers },
      }
    },
  },
  {
    name: 'generate',
    weight: 7,
    make: (user) => ({
      method: 'POST',
      path: `/reports/${rand(1, 5000)}/generate`,
      body: {
        format: 'sheet',
        term: '2569/1',
        classIds: [rand(1, 499), rand(1, 499)],
        recipients: [user.email, `academic@${user.school.replace('s_', 'school')}.ac.th`],
        notify: true,
      },
    }),
  },
  {
    name: 'students',
    weight: 7,
    make: () => ({ method: 'GET', path: `/classes/${rand(1, 499)}/students?term=2569/1&include=scores` }),
  },
  // half of the /me calls come without the demo user → 401 auth.rejected
  { name: 'me', weight: 3, make: () => ({ method: 'GET', path: '/me', anonymous: Math.random() < 0.5 }) },
  {
    // email + password in, tokens + Set-Cookie out; 15% wrong password → 401
    name: 'login',
    weight: 3,
    make: (user) => ({
      method: 'POST',
      path: '/auth/login',
      anonymous: true,
      body: {
        email: user.email,
        password: `Demo@${rand(1000, 9999)}`,
        rememberMe: Math.random() < 0.5,
        device: { platform: pick(['web', 'ios', 'android']), appVersion: '5.12.0' },
      },
    }),
  },
  {
    // personal data (email, phone, Thai national ID) and a password change
    name: 'profile',
    weight: 2,
    make: (user) => {
      const password = `Demo@${rand(1000, 9999)}`
      return {
        method: 'PUT',
        path: '/me/profile',
        body: {
          displayName: user.name,
          email: user.email,
          phone: `08${rand(10_000_000, 99_999_999)}`,
          nationalId: nationalId(),
          birthDate: `20${rand(10, 12)}-0${rand(1, 9)}-${rand(10, 28)}`,
          guardian: { name: `${pick(FIRST)} ${pick(LAST)}`, phone: `09${rand(10_000_000, 99_999_999)}`, nationalId: nationalId() },
          ...(Math.random() < 0.5
            ? { security: { currentPassword: `Old@${rand(1000, 9999)}`, newPassword: password, confirmPassword: password } }
            : {}),
        },
      }
    },
  },
  {
    // a picture for a question: multipart/form-data (the SDK keeps names and sizes only)
    name: 'attach',
    weight: 2,
    make: () => {
      const form = multipart(
        { questionId: String(rand(1000, 1200)), caption: 'รูปประกอบโจทย์' },
        { name: `diagram-${rand(1, 99)}.png`, type: 'image/png', bytes: crypto.randomBytes(rand(8, 40) * 1024) },
      )
      return { method: 'POST', path: '/question-bank/files', raw: form.body, contentType: form.contentType }
    },
  },
]
const TOTAL_WEIGHT = SCENARIOS.reduce((sum, s) => sum + s.weight, 0)

function pickScenario() {
  let roll = Math.random() * TOTAL_WEIGHT
  for (const scenario of SCENARIOS) {
    roll -= scenario.weight
    if (roll < 0) return scenario
  }
  return SCENARIOS[0]
}

function newWindow() {
  return { sent: 0, s2: 0, s4: 0, s5: 0, net: 0, ms: [], byName: {} }
}
let win = newWindow()
const total = newWindow()
let inflight = 0

function record(window, name, status, ms) {
  window.sent++
  window.byName[name] = (window.byName[name] || 0) + 1
  if (status === 0) window.net++
  else if (status >= 500) window.s5++
  else if (status >= 400) window.s4++
  else window.s2++
  if (status) window.ms.push(ms)
}

async function fire() {
  const scenario = pickScenario()
  const user = pick(users)
  const request = scenario.make(user)
  const headers = request.anonymous ? {} : headersFor(user)
  if (request.body) headers['content-type'] = 'application/json'
  if (request.contentType) headers['content-type'] = request.contentType
  const started = Date.now()
  let status = 0
  inflight++
  try {
    const res = await fetch(BASE + request.path, {
      method: request.method,
      headers,
      body: request.raw ?? (request.body ? JSON.stringify(request.body) : undefined),
      signal: AbortSignal.timeout(15_000),
    })
    status = res.status
    await res.arrayBuffer()
  } catch {
    status = 0
  } finally {
    inflight--
  }
  const ms = Date.now() - started
  record(win, scenario.name, status, ms)
  record(total, scenario.name, status, ms)
}

function p95(values) {
  if (!values.length) return '-'
  const sorted = [...values].sort((a, b) => a - b)
  const ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function line(window, seconds, label) {
  const time = new Date().toTimeString().slice(0, 8)
  const rate = (window.sent / seconds).toFixed(1)
  const mix = SCENARIOS.map((s) => `${s.name}=${window.byName[s.name] || 0}`).join(' ')
  return (
    `[traffic] ${time} ${label} ${window.sent} req ${rate}/s ` +
    `2xx=${window.s2} 4xx=${window.s4} 5xx=${window.s5} net=${window.net} ` +
    `p95=${p95(window.ms)} inflight=${inflight} | ${mix}`
  )
}

const startedAt = Date.now()
console.log(`[traffic] ${BASE} at ${RPS} req/s, ${USERS} users; Ctrl-C to stop`)
const ticker = setInterval(fire, 1000 / RPS)
const summary = setInterval(() => {
  console.log(line(win, SUMMARY_MS / 1000, 'last 10s'))
  win = newWindow()
}, SUMMARY_MS)

function stop() {
  clearInterval(ticker)
  clearInterval(summary)
  const seconds = Math.max(1, (Date.now() - startedAt) / 1000)
  console.log(line(total, seconds, `total ${Math.round(seconds)}s`))
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
