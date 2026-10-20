'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { api, type CatalogGroup, effectiveOf, envText, type Invite, inviteLink, type Role, type UserRow } from '@/lib/admin-api'
import { backTo } from '../_components/flash'
import { Notice } from '../_components/Notice'
import { InviteLink, InviteModal } from './InviteParts'
import { STATUS } from './UsersList'

type Draft = { username: string; name: string; roleIds: string[] }

/** The link part of the edit form: loading, the open link, or none (expired / secret changed). */
type EditInvite = { state: 'loading' } | { state: 'open'; invite: Invite } | { state: 'none'; message: string }

type Modal = { title: string; text: string; url: string; expiresAt: string }

const LINK_TEXT = 'ส่งลิงก์นี้ให้เจ้าตัวเพื่อตั้งรหัสผ่าน · ดูลิงก์นี้อีกได้ที่หน้านี้จนกว่าเจ้าตัวจะตั้งรหัส'

/**
 * /admin/users/new and /admin/users/<id>. Create → this user's edit page with
 * the set-password link in a modal (`?created=1`, dropped after it opens, so a
 * refresh stays on the page without the modal). Edit: name, roles, and the
 * password part: the open link while no password is set (plus a new link),
 * else a reset (→ modal with the new link).
 */
export function UserForm({ id, meId, groups }: { id?: string; meId: string; groups: CatalogGroup[] }) {
  const router = useRouter()
  const [user, setUser] = useState<UserRow | null | undefined>(id ? undefined : null)
  const [roles, setRoles] = useState<Role[]>([])
  const [draft, setDraft] = useState<Draft>({ username: '', name: '', roleIds: [] })
  const [editInvite, setEditInvite] = useState<EditInvite | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banning, setBanning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const labels = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i.label] as const)))

  const load = useCallback(async () => {
    const [u, r] = await Promise.all([id ? api<{ users: UserRow[] }>('GET', '/users') : null, api<{ roles: Role[] }>('GET', '/roles')])
    if (r.ok) setRoles(r.data.roles)
    if (!u) return
    if (!u.ok) return setError(u.message)
    const found = u.data.users.find((x) => x.id === id) ?? null
    setUser(found)
    if (found) setDraft({ username: found.username, name: found.name, roleIds: found.roleIds })
    return found
  }, [id])

  // first load; a fresh create opens its link in a modal
  useEffect(() => {
    void load().then(async (found) => {
      const url = new URL(window.location.href)
      if (!found || url.searchParams.get('created') !== '1') return
      url.searchParams.delete('created')
      window.history.replaceState(null, '', `${url.pathname}${url.search}`)
      const res = await api<{ invite: Invite }>('GET', `/users/${found.id}/invite`)
      if (res.ok) setModal({ title: `สร้าง ${found.username} แล้ว`, text: LINK_TEXT, url: inviteLink(res.data.invite), expiresAt: res.data.invite.expiresAt })
    })
  }, [load])

  // a pending user: the open link
  useEffect(() => {
    if (!user || user.hasPassword) {
      setEditInvite(null)
      return
    }
    let live = true
    setEditInvite({ state: 'loading' })
    api<{ invite: Invite }>('GET', `/users/${user.id}/invite`).then((res) => {
      if (live) setEditInvite(res.ok ? { state: 'open', invite: res.data.invite } : { state: 'none', message: res.message })
    })
    return () => {
      live = false
    }
  }, [user])

  /** Reset (password set) or a fresh link (pending, the old one gone). */
  const newLink = async () => {
    if (!user) return
    const pending = !user.hasPassword
    const ask = pending
      ? `ออกลิงก์ใหม่ให้ ${user.username}? ลิงก์เดิมจะใช้ไม่ได้`
      : `รีเซ็ตรหัสผ่านของ ${user.username}? รหัสเดิมใช้ไม่ได้ทันที เจ้าตัวจะถูกออกจากระบบ และต้องตั้งรหัสใหม่จากลิงก์`
    if (!window.confirm(ask)) return
    const res = await api<{ invite: Invite }>('POST', `/users/${user.id}/reset-password`)
    if (!res.ok) return setError(res.message)
    setModal({
      title: pending ? `ลิงก์ใหม่ของ ${user.username}` : `รีเซ็ตรหัสผ่านของ ${user.username} แล้ว`,
      text: LINK_TEXT,
      url: inviteLink(res.data.invite),
      expiresAt: res.data.invite.expiresAt,
    })
    await load()
  }

  /** The ban switch: applies at once (a ban signs the user out everywhere), separate from the form's save. */
  const toggleBan = async () => {
    if (!user) return
    const ban = user.status !== 'banned'
    if (ban && !window.confirm(`ระงับ ${user.username}? เจ้าตัวจะถูกออกจากระบบทันที และเข้าระบบไม่ได้จนกว่าจะยกเลิก`)) return
    setBanning(true)
    setError(null)
    const res = await api('POST', `/users/${user.id}/${ban ? 'ban' : 'unban'}`)
    setBanning(false)
    if (!res.ok) return setError(res.message)
    setNotice(ban ? `ระงับ ${user.username} แล้ว` : `ยกเลิกการระงับ ${user.username} แล้ว`)
    await load()
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    if (id) {
      const res = await api('PATCH', `/users/${id}`, { name: draft.name, roleIds: draft.roleIds })
      setBusy(false)
      if (!res.ok) return setError(res.message)
      return router.push(backTo('/admin/users', `บันทึก ${draft.username} แล้ว`))
    }
    const res = await api<{ user: UserRow; invite: Invite }>('POST', '/users', { username: draft.username, name: draft.name, roleIds: draft.roleIds })
    setBusy(false)
    if (!res.ok) return setError(res.message)
    router.push(`/admin/users/${res.data.user.id}?created=1`)
  }

  if (id && user === undefined) return error ? <Notice kind="error" title={error} /> : <p className="adm-field__hint">กำลังโหลด…</p>
  if (id && user === null) {
    return (
      <>
        <Notice kind="error" title="ไม่พบผู้ใช้นี้" text="อาจถูกลบไปแล้ว" />
        <BackLink />
      </>
    )
  }
  if (user && (user.system || user.id === meId)) {
    return (
      <>
        <Notice
          kind="error"
          title={user.system ? 'ผู้ดูแลระบบจาก env แก้ไขจากหน้านี้ไม่ได้' : 'แก้ไขบัญชีของตัวเองจากหน้านี้ไม่ได้'}
          text={user.system ? 'เปลี่ยนที่ SKILLLANE_MONITORING_ADMIN_USERNAME / SKILLLANE_MONITORING_ADMIN_PASSWORD ของ engine' : 'เปลี่ยนรหัสผ่านได้ที่หน้าบัญชีของฉัน'}
        />
        <BackLink />
      </>
    )
  }

  const effective = effectiveOf(roles.filter((r) => draft.roleIds.includes(r.id)))

  return (
    <>
      {error ? <Notice kind="error" title={error} /> : null}
      {notice && !error ? <Notice kind="ok" title={notice} /> : null}
      {modal ? <InviteModal {...modal} onClose={() => setModal(null)} /> : null}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{user ? user.username : 'ผู้ใช้ใหม่'}</h2>
          {user ? <span className={`panel__meta adm-status--${user.status}`}>{STATUS[user.status]}</span> : null}
        </div>
        <form className="panel__body adm-form" onSubmit={save}>
          <div className="adm-form__row">
            <label className="adm-field">
              <span className="adm-field__label">ชื่อผู้ใช้ (ใช้เข้าสู่ระบบ)</span>
              <input
                className="adm-input"
                value={draft.username}
                disabled={!!id}
                required
                autoFocus={!id}
                placeholder="somchai หรือ somchai@company.com"
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">ชื่อที่แสดง</span>
              <input className="adm-input" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
          </div>
          {user ? (
            <div className="adm-section">
              <h3 className="adm-section__title">การใช้งาน</h3>
              <div>
                <button
                  className="adm-switch"
                  type="button"
                  role="switch"
                  aria-checked={user.status === 'banned'}
                  disabled={banning}
                  onClick={toggleBan}
                >
                  <span className="adm-switch__track" aria-hidden="true" />
                  ระงับการใช้งาน
                </button>
              </div>
              <p className="adm-section__sub">
                {user.status === 'banned'
                  ? 'ถูกระงับอยู่: เข้าระบบไม่ได้ · ปิดสวิตช์เพื่อให้กลับมาใช้ได้'
                  : 'เปิดสวิตช์แล้วมีผลทันที: เจ้าตัวถูกออกจากระบบและเข้าใหม่ไม่ได้ (ไม่ต้องกดบันทึก)'}
              </p>
            </div>
          ) : null}
          {user ? (
            <div className="adm-section">
              <h3 className="adm-section__title">รหัสผ่าน</h3>
              {!user.hasPassword ? (
                <>
                  <p className="adm-section__sub">ยังไม่ได้ตั้งรหัสผ่าน · ส่งลิงก์นี้ให้เจ้าตัว</p>
                  {editInvite?.state === 'loading' ? <p className="adm-field__hint">กำลังโหลดลิงก์…</p> : null}
                  {editInvite?.state === 'open' ? <InviteLink url={inviteLink(editInvite.invite)} expiresAt={editInvite.invite.expiresAt} /> : null}
                  {editInvite?.state === 'none' ? <p className="adm-field__hint">{editInvite.message}</p> : null}
                  <div>
                    <button className="btn btn--sm" type="button" onClick={newLink}>
                      ออกลิงก์ใหม่
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="adm-section__sub">ตั้งรหัสผ่านแล้ว · รีเซ็ตแล้วรหัสเดิมใช้ไม่ได้ทันที และได้ลิงก์ให้ตั้งรหัสใหม่</p>
                  <div>
                    <button className="btn btn--sm" type="button" onClick={newLink}>
                      รีเซ็ตรหัสผ่าน
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
          <div className="adm-section">
            <h3 className="adm-section__title">Role</h3>
            <p className="adm-section__sub">เลือกได้หลาย role · ให้ได้เฉพาะ role ที่สิทธิ์ไม่เกินสิทธิ์ของคุณ</p>
            <div className="adm-checks">
              {roles.map((role) => (
                <label className="adm-check" key={role.id} title={role.description}>
                  <input
                    type="checkbox"
                    checked={draft.roleIds.includes(role.id)}
                    onChange={(e) =>
                      setDraft({ ...draft, roleIds: e.target.checked ? [...draft.roleIds, role.id] : draft.roleIds.filter((r) => r !== role.id) })
                    }
                  />
                  {role.name}
                </label>
              ))}
            </div>
          </div>
          <div className="adm-section">
            <h3 className="adm-section__title">สิทธิ์ที่ได้จริง</h3>
            <p className="adm-section__sub">รวมจาก role ที่เลือก · แก้ที่ role ไม่ใช่ที่นี่</p>
            <div className="adm-effective">
              {effective.length ? (
                effective.map((e) => (
                  <div className="adm-effective__row" key={e.permission}>
                    <strong>{labels.get(e.permission) ?? e.permission}</strong>
                    <span>{envText(e.envs)}</span>
                    <span className="adm-effective__from">จาก {e.from.join(', ')}</span>
                  </div>
                ))
              ) : (
                <p className="adm-field__hint">ยังไม่มีสิทธิ์: เข้าระบบได้แต่ไม่เห็นข้อมูล</p>
              )}
            </div>
          </div>
          <div className="adm-form__actions">
            <Link className="btn" href="/admin/users" prefetch={false}>
              {id ? 'กลับ' : 'ยกเลิก'}
            </Link>
            <button className="btn btn--primary" type="submit" disabled={busy || !draft.username.trim()}>
              {busy ? 'กำลังบันทึก…' : id ? 'บันทึก' : 'สร้างและออกลิงก์'}
            </button>
          </div>
        </form>
      </section>
    </>
  )
}

function BackLink() {
  return (
    <div>
      <Link className="btn" href="/admin/users" prefetch={false}>
        กลับไปที่รายชื่อผู้ใช้
      </Link>
    </div>
  )
}
