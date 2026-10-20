import Link from 'next/link'
import { EngineErrorState } from '@/components/states'
import type { CatalogGroup } from '@/lib/admin-api'
import { engineGet, getMe } from '@/lib/engine'
import { UserForm } from './UserForm'
import '../screen.css'

/** Shared by /admin/users/new and /admin/users/<id>: crumbs, title, the form. */
export async function UserFormPage({ id }: { id?: string }) {
  const [me, catalog] = await Promise.all([getMe(), engineGet<{ groups: CatalogGroup[] }>('/api/auth/permissions')])
  if (!me.ok) return <EngineErrorState error={me.error} />
  if (!catalog.ok) return <EngineErrorState error={catalog.error} />
  return (
    <div className="adm-stack">
      <header className="page-head">
        <div className="page-head__text">
          <nav className="crumbs" aria-label="ตำแหน่ง">
            <Link href="/admin/users" prefetch={false}>
              ผู้ใช้
            </Link>
            <span className="crumbs__sep">/</span>
            <span>{id ? 'แก้ไข' : 'สร้าง'}</span>
          </nav>
          <h1 className="page-title">{id ? 'แก้ไขผู้ใช้' : 'สร้างผู้ใช้'}</h1>
        </div>
      </header>
      <UserForm id={id} meId={me.data.id} groups={catalog.data.groups} />
    </div>
  )
}
