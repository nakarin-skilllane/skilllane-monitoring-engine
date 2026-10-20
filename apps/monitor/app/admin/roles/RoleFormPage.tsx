import Link from 'next/link'
import { EngineErrorState } from '@/components/states'
import type { CatalogGroup } from '@/lib/admin-api'
import { engineGet, getMeta } from '@/lib/engine'
import { RoleForm } from './RoleForm'
import '../screen.css'

/** Shared by /admin/roles/new and /admin/roles/<id>: crumbs, title, the form (env columns from /api/meta). */
export async function RoleFormPage({ id }: { id?: string }) {
  const [meta, catalog] = await Promise.all([getMeta(), engineGet<{ groups: CatalogGroup[] }>('/api/auth/permissions')])
  if (!catalog.ok) return <EngineErrorState error={catalog.error} />
  return (
    <div className="adm-stack">
      <header className="page-head">
        <div className="page-head__text">
          <nav className="crumbs" aria-label="ตำแหน่ง">
            <Link href="/admin/roles" prefetch={false}>
              Role และสิทธิ์
            </Link>
            <span className="crumbs__sep">/</span>
            <span>{id ? 'แก้ไข' : 'สร้าง'}</span>
          </nav>
          <h1 className="page-title">{id ? 'แก้ไข role' : 'สร้าง role'}</h1>
        </div>
      </header>
      <RoleForm id={id} groups={catalog.data.groups} envs={meta.ok ? meta.data.envs : []} />
    </div>
  )
}
