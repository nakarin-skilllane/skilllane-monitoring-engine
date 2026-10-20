'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type CatalogGroup, type Grant, type Role } from '@/lib/admin-api'
import type { PermissionId } from '@/lib/types'
import { backTo } from '../_components/flash'
import { Notice } from '../_components/Notice'

/** Per permission in the form: off, every env, or some envs. */
type Scope = { on: boolean; all: boolean; envs: string[] }
type Draft = { id?: string; name: string; description: string; scopes: Record<string, Scope> }

const OFF: Scope = { on: false, all: true, envs: [] }

function draftOf(role: Role | null, groups: CatalogGroup[]): Draft {
  const scopes: Record<string, Scope> = {}
  for (const g of groups) for (const item of g.items) scopes[item.id] = { ...OFF }
  for (const grant of role?.grants ?? []) {
    scopes[grant.permission] = { on: true, all: !grant.envs.length, envs: grant.envs }
  }
  return { id: role?.id, name: role?.name ?? '', description: role?.description ?? '', scopes }
}

function grantsOf(draft: Draft): Grant[] {
  return Object.entries(draft.scopes)
    .filter(([, s]) => s.on && (s.all || s.envs.length))
    .map(([permission, s]) => ({ permission: permission as PermissionId, envs: s.all ? [] : s.envs }))
}

/**
 * /admin/roles/new and /admin/roles/<id>. One section per catalog group:
 * "ดูข้อมูล" as a matrix permission × env (ทุก env or chosen envs), "จัดการระบบ"
 * as plain switches (always every env). Saving goes back to the list.
 */
export function RoleForm({ id, groups, envs }: { id?: string; groups: CatalogGroup[]; envs: string[] }) {
  const router = useRouter()
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(id ? null : draftOf(null, groups))
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // envs with data, plus any env a role already names (kept when the env has gone quiet)
  const columns = [...new Set([...envs, ...(roles ?? []).flatMap((r) => r.grants.flatMap((g) => g.envs))])].sort()

  useEffect(() => {
    api<{ roles: Role[] }>('GET', '/roles').then((res) => {
      if (!res.ok) return setError(res.message)
      setRoles(res.data.roles)
      if (!id) return
      const role = res.data.roles.find((r) => r.id === id)
      if (!role) return setMissing(true)
      if (role.builtin) return setError(`role ${role.name} เป็น role ของระบบ แก้ไขไม่ได้`)
      setDraft(draftOf(role, groups))
    })
  }, [id, groups])

  const setScope = (key: string, change: Partial<Scope>) =>
    setDraft((d) => (d ? { ...d, scopes: { ...d.scopes, [key]: { ...d.scopes[key], ...change } } } : d))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    setBusy(true)
    setError(null)
    const body = { name: draft.name, description: draft.description, grants: grantsOf(draft) }
    const res = draft.id ? await api('PATCH', `/roles/${draft.id}`, body) : await api('POST', '/roles', body)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    router.push(backTo('/admin/roles', draft.id ? `บันทึก role ${draft.name} แล้ว` : `สร้าง role ${draft.name} แล้ว`))
  }

  if (missing) {
    return (
      <>
        <Notice kind="error" title="ไม่พบ role นี้" text="อาจถูกลบไปแล้ว" />
        <BackLink />
      </>
    )
  }
  if (!draft) {
    return error ? (
      <>
        <Notice kind="error" title={error} />
        <BackLink />
      </>
    ) : (
      <p className="adm-field__hint">กำลังโหลด…</p>
    )
  }

  return (
    <>
      {error ? <Notice kind="error" title={error} /> : null}
      <section className="panel">
        <form className="panel__body adm-form" onSubmit={save}>
        <div className="adm-form__row">
          <label className="adm-field">
            <span className="adm-field__label">ชื่อ role</span>
            <input className="adm-input" value={draft.name} maxLength={60} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="adm-field">
            <span className="adm-field__label">คำอธิบาย</span>
            <input className="adm-input" value={draft.description} maxLength={300} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
        </div>
        {groups.map((group) => (
          <div className="adm-section" key={group.group}>
            <h3 className="adm-section__title">{group.label}</h3>
            {group.envScoped ? (
              <>
                <p className="adm-section__sub">เลือก &quot;ทุก env&quot; หรือเฉพาะ env ที่ต้องการ · ผู้ที่ได้สิทธิ์เฉพาะบาง env จะดูได้ทีละ env</p>
                <div className="table-wrap">
                  <table className="table table--dense adm-matrix">
                    <thead>
                      <tr>
                        <th scope="col">สิทธิ์</th>
                        <th scope="col">เปิด</th>
                        <th scope="col">ทุก env</th>
                        {columns.map((env) => (
                          <th scope="col" key={env} className="mono">
                            {env}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => {
                        const s = draft.scopes[item.id]
                        return (
                          <tr key={item.id}>
                            <td>
                              {item.label}
                              <small>{item.detail}</small>
                            </td>
                            <td>
                              <input type="checkbox" aria-label={`เปิด ${item.label}`} checked={s.on} onChange={(e) => setScope(item.id, { on: e.target.checked })} />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`${item.label} ทุก env`}
                                disabled={!s.on}
                                checked={s.on && s.all}
                                onChange={(e) => setScope(item.id, { all: e.target.checked })}
                              />
                            </td>
                            {columns.map((env) => (
                              <td key={env}>
                                <input
                                  type="checkbox"
                                  aria-label={`${item.label} ${env}`}
                                  disabled={!s.on || s.all}
                                  checked={s.on && (s.all || s.envs.includes(env))}
                                  onChange={(e) =>
                                    setScope(item.id, { envs: e.target.checked ? [...s.envs, env] : s.envs.filter((x) => x !== env) })
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="adm-checks">
                {group.items.map((item) => (
                  <label className="adm-check" key={item.id} title={item.detail}>
                    <input type="checkbox" checked={draft.scopes[item.id].on} onChange={(e) => setScope(item.id, { on: e.target.checked, all: true })} />
                    {item.label}
                    <span className="adm-field__hint">{item.detail}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
        </form>
      </section>
    </>
  )
}

function BackLink() {
  return (
    <div>
      <Link className="btn" href="/admin/roles" prefetch={false}>
        กลับไปที่รายการ role
      </Link>
    </div>
  )
}
