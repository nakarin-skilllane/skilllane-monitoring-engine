import type { Metadata } from 'next'
import { getMe } from '@/lib/engine'
import { EngineErrorState } from '@/components/states'
import { envText } from '@/lib/admin-api'
import type { PermissionId } from '@/lib/types'
import { ChangePasswordForm } from './ChangePasswordForm'
import '../admin/screen.css'

export const metadata: Metadata = { title: 'บัญชีของฉัน' }

const LABELS: Record<PermissionId, string> = {
  overview: 'ภาพรวม',
  logs: 'Logs',
  traces: 'Traces',
  errors: 'Errors',
  jobs: 'Jobs',
  topology: 'แผนที่ระบบ',
  users: 'จัดการผู้ใช้',
  roles: 'จัดการ role',
}

/** Who I am, what I can see, and my password. */
export default async function AccountPage() {
  const me = await getMe()
  if (!me.ok) return <EngineErrorState error={me.error} />
  const u = me.data
  const perms = (Object.keys(LABELS) as PermissionId[]).filter((p) => u.permissions[p])
  return (
    <div className="adm-stack">
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-title">บัญชีของฉัน</h1>
          <p className="page-sub">
            {u.name} · <span className="mono">{u.username}</span>
            {u.kind === 'env' ? ' · ผู้ดูแลระบบจาก env' : ''}
          </p>
        </div>
      </header>
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">สิทธิ์ของฉัน</h2>
          <span className="panel__meta">รวมจากทุก role</span>
        </div>
        <div className="panel__body adm-effective">
          {perms.length ? (
            perms.map((p) => (
              <div className="adm-effective__row" key={p}>
                <strong>{LABELS[p]}</strong>
                <span className="adm-effective__from">{envText(u.permissions[p]!)}</span>
              </div>
            ))
          ) : (
            <p>ยังไม่มีสิทธิ์ดูข้อมูล ติดต่อผู้ดูแลระบบ</p>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">เปลี่ยนรหัสผ่าน</h2>
        </div>
        <div className="panel__body">
          {u.kind === 'env' ? (
            <p className="adm-field__hint">รหัสผ่านของผู้ดูแลระบบตั้งจาก SKILLLANE_MONITORING_ADMIN_PASSWORD ของ engine</p>
          ) : (
            <ChangePasswordForm username={u.username} />
          )}
        </div>
      </section>
    </div>
  )
}
