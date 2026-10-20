'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, type CatalogGroup, envText, type Role } from '@/lib/admin-api'
import { useFlash } from '../_components/flash'
import { Notice } from '../_components/Notice'

/** /admin/roles: every role, delete in the row (409 in use → confirm, then taken off its users); create and edit have pages. */
export function RolesList({ groups, canEdit }: { groups: CatalogGroup[]; canEdit: boolean }) {
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [flash, setFlash] = useFlash()
  const [error, setError] = useState<string | null>(null)
  const labels = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i.label] as const)))

  const load = useCallback(async () => {
    const res = await api<{ roles: Role[] }>('GET', '/roles')
    if (res.ok) setRoles(res.data.roles)
    else setError(res.message)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const remove = async (role: Role) => {
    if (!window.confirm(`ลบ role ${role.name}?`)) return
    let res = await api('DELETE', `/roles/${role.id}`)
    if (!res.ok && res.status === 409) {
      const users = ((res.body as { users?: string[] } | null)?.users ?? []).join(', ')
      if (!window.confirm(`role ${role.name} ยังมีผู้ใช้: ${users}\nลบ role และถอดออกจากผู้ใช้เหล่านี้?`)) return
      res = await api('DELETE', `/roles/${role.id}?force=true`)
    }
    if (!res.ok) {
      setFlash(null)
      return setError(res.message)
    }
    setError(null)
    setFlash(`ลบ role ${role.name} แล้ว`)
    await load()
  }

  return (
    <>
      {error ? <Notice kind="error" title={error} /> : null}
      {flash ? <Notice kind="ok" title={flash} /> : null}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Role ทั้งหมด</h2>
          <span className="panel__meta">{roles ? `${roles.length} role` : ''}</span>
          {canEdit ? (
            <div className="panel__actions">
              <Link className="btn btn--primary btn--sm" href="/admin/roles/new" prefetch={false}>
                สร้าง role
              </Link>
            </div>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">ชื่อ</th>
                <th scope="col">สิทธิ์</th>
                <th scope="col" className="num">
                  ผู้ใช้
                </th>
                <th scope="col">
                  <span className="sr-only">จัดการ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(roles ?? []).map((role) => (
                <tr key={role.id}>
                  <td>
                    <strong>{role.name}</strong>
                    {role.builtin ? <span className="tag"> ระบบ</span> : null}
                    {role.description ? <div className="adm-field__hint">{role.description}</div> : null}
                  </td>
                  <td>
                    <div className="chips">
                      {role.grants.map((g) => (
                        <span className="tag" key={g.permission} title={envText(g.envs)}>
                          {labels.get(g.permission) ?? g.permission}
                          {g.envs.length ? ` · ${g.envs.join(',')}` : ''}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="num">{role.userCount}</td>
                  <td>
                    {canEdit && !role.builtin ? (
                      <div className="adm-row-actions">
                        <Link className="btn btn--sm" href={`/admin/roles/${role.id}`} prefetch={false}>
                          แก้ไข
                        </Link>
                        <button className="btn btn--quiet btn--sm" type="button" onClick={() => remove(role)}>
                          ลบ
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
