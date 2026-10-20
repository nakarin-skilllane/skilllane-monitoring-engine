import type { Metadata } from 'next'
import { EngineErrorState } from '@/components/states'
import type { CatalogGroup } from '@/lib/admin-api'
import { engineGet, getMe } from '@/lib/engine'
import { RolesList } from './RolesList'
import '../screen.css'

export const metadata: Metadata = { title: 'Role และสิทธิ์' }

export default async function RolesPage() {
  const [me, catalog] = await Promise.all([getMe(), engineGet<{ groups: CatalogGroup[] }>('/api/auth/permissions')])
  if (!me.ok) return <EngineErrorState error={me.error} />
  if (!catalog.ok) return <EngineErrorState error={catalog.error} />
  return (
    <div className="adm-stack">
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-title">Role และสิทธิ์</h1>
          <p className="page-sub">role = ชุดสิทธิ์ (เมนูที่เห็น × env) · ผู้ใช้ได้สิทธิ์รวมของทุก role ที่มี · สิทธิ์ซ้ำกันระหว่าง role ได้</p>
        </div>
      </header>
      <RolesList groups={catalog.data.groups} canEdit={!!me.data.permissions.roles} />
    </div>
  )
}
