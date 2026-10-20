import type { Metadata } from 'next'
import { EngineErrorState } from '@/components/states'
import { getMe } from '@/lib/engine'
import { UsersList } from './UsersList'
import '../screen.css'

export const metadata: Metadata = { title: 'ผู้ใช้' }

export default async function UsersPage() {
  const me = await getMe()
  if (!me.ok) return <EngineErrorState error={me.error} />
  return (
    <div className="adm-stack">
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-title">ผู้ใช้</h1>
          <p className="page-sub">สร้างผู้ใช้แล้วส่งลิงก์ตั้งรหัสผ่านให้เจ้าตัว · ลิงก์ใช้ได้ครั้งเดียว ภายใน 72 ชั่วโมง</p>
        </div>
      </header>
      <UsersList meId={me.data.id} />
    </div>
  )
}
