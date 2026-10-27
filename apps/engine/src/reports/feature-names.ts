/**
 * Thai names of the first path segment of a route (the feature's resource). Unknown ones show
 * as `/resource` until the AI layer names them. Add entries as services grow.
 */
const NAMES: Record<string, string> = {
  auth: 'เข้าสู่ระบบ',
  login: 'เข้าสู่ระบบ',
  logout: 'ออกจากระบบ',
  me: 'โปรไฟล์ของฉัน',
  profile: 'โปรไฟล์',
  profiles: 'โปรไฟล์',
  users: 'ผู้ใช้',
  students: 'นักเรียน',
  teachers: 'ครู',
  parents: 'ผู้ปกครอง',
  schools: 'โรงเรียน',
  organizations: 'โรงเรียน / องค์กร',
  classes: 'ห้องเรียน',
  classrooms: 'ห้องเรียน',
  courses: 'คอร์สเรียน',
  lessons: 'บทเรียน',
  chapters: 'บทเรียน',
  contents: 'เนื้อหา',
  videos: 'วิดีโอ',
  exams: 'การสอบ',
  quizzes: 'แบบทดสอบ',
  questions: 'คลังข้อสอบ',
  assignments: 'การบ้าน',
  homeworks: 'การบ้าน',
  submissions: 'การส่งงาน',
  scores: 'คะแนน',
  grades: 'ผลการเรียน',
  attendance: 'การเข้าเรียน',
  attendances: 'การเข้าเรียน',
  schedules: 'ตารางเรียน',
  timetables: 'ตารางเรียน',
  certificates: 'ใบประกาศ',
  reports: 'รายงาน',
  dashboard: 'แดชบอร์ด',
  notifications: 'การแจ้งเตือน',
  announcements: 'ประกาศ',
  messages: 'ข้อความ',
  payments: 'การชำระเงิน',
  orders: 'คำสั่งซื้อ',
  files: 'ไฟล์',
  uploads: 'อัปโหลดไฟล์',
  imports: 'นำเข้าข้อมูล',
  exports: 'ส่งออกข้อมูล',
  search: 'ค้นหา',
  settings: 'ตั้งค่า',
  roles: 'สิทธิ์ผู้ใช้',
}

/** Thai name of a resource, or `/resource` (source `route`) when the dictionary has none. */
export function featureName(resource: string): { name: string; source: 'dict' | 'route' } {
  const name = NAMES[resource.toLowerCase()]
  return name ? { name, source: 'dict' } : { name: `/${resource}`, source: 'route' }
}
