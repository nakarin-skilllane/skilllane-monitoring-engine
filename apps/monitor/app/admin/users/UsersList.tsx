'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, type Role, type UserRow } from '@/lib/admin-api'
import { useFlash } from '../_components/flash'
import { Notice } from '../_components/Notice'
import { fmtTime } from './InviteParts'

export const STATUS: Record<UserRow['status'], string> = { active: 'ใช้งาน', pending: 'รอตั้งรหัสผ่าน', banned: 'ถูกระงับ' }

/** /admin/users: every user, delete in the row; create and edit (incl. ban) have pages of their own. */
export function UsersList({ meId }: { meId: string }) {
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [flash, setFlash] = useFlash()
  const [error, setError] = useState<string | null>(null)
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id

  const load = useCallback(async () => {
    const [u, r] = await Promise.all([api<{ users: UserRow[] }>('GET', '/users'), api<{ roles: Role[] }>('GET', '/roles')])
    if (u.ok) setUsers(u.data.users)
    else setError(u.message)
    if (r.ok) setRoles(r.data.roles)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const remove = async (user: UserRow) => {
    if (!window.confirm(`ลบ ${user.username}? เจ้าตัวจะเข้าระบบไม่ได้อีก`)) return
    const res = await api('DELETE', `/users/${user.id}`)
    if (!res.ok) {
      setFlash(null)
      return setError(res.message)
    }
    setError(null)
    setFlash(`ลบ ${user.username} แล้ว`)
    await load()
  }

  return (
    <>
      {error ? <Notice kind="error" title={error} /> : null}
      {flash ? <Notice kind="ok" title={flash} /> : null}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">ผู้ใช้ทั้งหมด</h2>
          <span className="panel__meta">{users ? `${users.length} คน` : ''}</span>
          <div className="panel__actions">
            <Link className="btn btn--primary btn--sm" href="/admin/users/new" prefetch={false}>
              สร้างผู้ใช้
            </Link>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">ผู้ใช้</th>
                <th scope="col">Role</th>
                <th scope="col">สถานะ</th>
                <th scope="col">เข้าระบบล่าสุด</th>
                <th scope="col">
                  <span className="sr-only">จัดการ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.name}</strong>
                    <div className="mono adm-field__hint">{user.username}</div>
                  </td>
                  <td>
                    <div className="chips">
                      {user.roleIds.map((id) => (
                        <span className="tag" key={id}>
                          {roleName(id)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={`adm-status--${user.status}`}>{STATUS[user.status]}</td>
                  <td className="nowrap">{fmtTime(user.lastLoginAt)}</td>
                  <td>
                    {user.system ? (
                      <span className="adm-field__hint">ตั้งจาก env ของ engine</span>
                    ) : user.id === meId ? (
                      <span className="adm-field__hint">บัญชีของคุณ</span>
                    ) : (
                      <div className="adm-row-actions">
                        <Link className="btn btn--sm" href={`/admin/users/${user.id}`} prefetch={false}>
                          แก้ไข
                        </Link>
                        <button className="btn btn--quiet btn--sm" type="button" onClick={() => remove(user)}>
                          ลบ
                        </button>
                      </div>
                    )}
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
