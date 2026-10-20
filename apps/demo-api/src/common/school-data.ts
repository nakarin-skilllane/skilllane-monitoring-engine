import { createHash } from 'crypto'

/**
 * Made-up Thai school data for the demo payloads: names, classes, subjects,
 * scores, emails and national IDs (valid checksum, so the SDK's masking is
 * visible on them). Deterministic per seed, so a trace reads consistently.
 */

const FIRST_NAMES = [
  'ณัฐวุฒิ', 'กมลชนก', 'ธนกร', 'พิมพ์ชนก', 'ศุภกฤต', 'ปภาวรินทร์', 'ภูริภัทร', 'ชนิดาภา',
  'วรเมธ', 'ณิชาภัทร', 'กิตติพัฒน์', 'อรณิชา', 'ธีรภัทร', 'สุชานันท์', 'ปัณณวัฒน์', 'เบญญาภา',
]
const LAST_NAMES = [
  'ศรีสุข', 'วงศ์ไทย', 'ใจดี', 'แก้วมณี', 'ทองคำ', 'บุญมา', 'พัฒนากุล', 'รัตนวงศ์',
  'สมบูรณ์ชัย', 'เพชรรัตน์', 'อินทรสุวรรณ', 'จันทร์เพ็ญ',
]
export const SUBJECTS = [
  { code: 'MATH', name: 'คณิตศาสตร์' },
  { code: 'SCI', name: 'วิทยาศาสตร์' },
  { code: 'THAI', name: 'ภาษาไทย' },
  { code: 'ENG', name: 'ภาษาอังกฤษ' },
  { code: 'SOC', name: 'สังคมศึกษา' },
]
const TOPICS = [
  'สมการเชิงเส้นตัวแปรเดียว', 'ระบบสุริยะ', 'การอ่านจับใจความ', 'Present Perfect Tense',
  'ประวัติศาสตร์สมัยสุโขทัย', 'อัตราส่วนและร้อยละ', 'เซลล์ของสิ่งมีชีวิต', 'คำราชาศัพท์',
]

export const pickBy = <T>(list: T[], seed: number): T => list[Math.abs(seed) % list.length]

export function studentName(seed: number): string {
  return `${pickBy(FIRST_NAMES, seed)} ${pickBy(LAST_NAMES, seed * 7 + 3)}`
}

/** ม.1/1 … ม.6/9 from a class id. */
export function className(classId: number): string {
  return `ม.${(classId % 6) + 1}/${(classId % 9) + 1}`
}

export function classCode(classId: number): string {
  return `M${(classId % 6) + 1}/${(classId % 9) + 1}`
}

export function questionTitle(seed: number): string {
  const subject = pickBy(SUBJECTS, seed)
  return `แบบฝึกหัด${subject.name} ${className(seed)} เรื่อง${pickBy(TOPICS, seed * 3 + 1)} ข้อที่ ${(seed % 40) + 1}`
}

export function emailOf(userId: string): string {
  return `${userId.replace(/^u_/, 'teacher')}@school${(Number(userId.replace(/\D/g, '')) % 6) + 101}.ac.th`
}

/** A 13-digit Thai national ID with a valid checksum (made up). */
export function nationalId(seed: number): string {
  let digits = String(1_100_000_000_00 + (Math.abs(seed) * 7_919) % 99_999_999_999).slice(0, 12)
  if (digits[0] === '0') digits = `1${digits.slice(1)}`
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i)
  return `${digits}${(11 - (sum % 11)) % 10}`
}

/** bcrypt-shaped hash of a password (only the shape matters). */
export function passwordHash(password: string): string {
  const digest = createHash('sha256').update(password).digest('base64').replace(/[+/=]/g, '')
  return `$2b$10$${digest.slice(0, 53).padEnd(53, 'x')}`
}

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** A JWT-shaped access token for a demo user (signature is not real). */
export function accessToken(userId: string, schoolId?: string, role = 'teacher'): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: 'demo-2569' })
  const payload = base64url({
    sub: userId,
    school: schoolId,
    role,
    iss: 'https://auth.school.demo',
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })
  const signature = createHash('sha256').update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/** Score 0–100 with one decimal, stable per student and exam. */
export function scoreOf(studentId: number, examId: number): number {
  return Math.round(((studentId * 37 + examId * 11) % 1000) / 10 * 10) / 10
}
