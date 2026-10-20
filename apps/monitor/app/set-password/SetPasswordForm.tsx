'use client'

import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { BrandMark } from '@/components/icons'
import { PRODUCT_NAME } from '@/components/shell/names'
import { api } from '@/lib/admin-api'
import { Notice } from '../admin/_components/Notice'
import '../admin/screen.css'

const MIN = 12

type Invite = { valid: false } | { valid: true; username: string; name: string; purpose: 'set' | 'reset' }

/** The one-time link from an admin: shows whose account it is, sets the password, then sign in. */
export function SetPasswordForm({ token }: { token: string }) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) {
      setInvite({ valid: false })
      return
    }
    api<Invite>('GET', `/auth/invite/${encodeURIComponent(token)}`).then((res) => setInvite(res.ok ? res.data : { valid: false }))
  }, [token])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const password = String(form.get('password') ?? '')
    if (password.length < MIN) return setError(`รหัสผ่านต้องยาวอย่างน้อย ${MIN} ตัวอักษร`)
    if (password !== form.get('confirm')) return setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
    setBusy(true)
    setError(null)
    const res = await api('POST', '/auth/set-password', { token, password })
    setBusy(false)
    if (!res.ok) return setError(res.message)
    setDone(true)
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-card__brand">
        <BrandMark />
        {PRODUCT_NAME}
      </div>
      <h1 className="auth-card__title" id="auth-title">
        {invite?.valid && invite.purpose === 'reset' ? 'ตั้งรหัสผ่านใหม่' : 'ตั้งรหัสผ่าน'}
      </h1>
      {invite === null ? <p className="auth-card__sub">กำลังตรวจลิงก์…</p> : null}
      {invite && !invite.valid ? (
        <Notice kind="error" title="ลิงก์นี้ใช้ไม่ได้แล้ว หรือหมดอายุ" text="ขอลิงก์ใหม่จากผู้ดูแลระบบ" />
      ) : null}
      {invite?.valid && done ? (
        <>
          <Notice kind="ok" title="ตั้งรหัสผ่านแล้ว" text={`เข้าสู่ระบบด้วยชื่อผู้ใช้ ${invite.username}`} />
          <Link className="btn btn--primary" href="/login">
            ไปหน้าเข้าสู่ระบบ
          </Link>
        </>
      ) : null}
      {invite?.valid && !done ? (
        <form className="auth-form" onSubmit={submit}>
          <p className="auth-card__sub">
            บัญชี <strong>{invite.username}</strong>
            {invite.name && invite.name !== invite.username ? ` (${invite.name})` : ''} · อย่างน้อย {MIN} ตัวอักษร
          </p>
          <input type="text" name="username" value={invite.username} autoComplete="username" readOnly hidden />
          <label className="adm-field">
            <span className="adm-field__label">รหัสผ่านใหม่</span>
            <input className="adm-input" name="password" type="password" autoComplete="new-password" minLength={MIN} required autoFocus />
          </label>
          <label className="adm-field">
            <span className="adm-field__label">ยืนยันรหัสผ่าน</span>
            <input className="adm-input" name="confirm" type="password" autoComplete="new-password" minLength={MIN} required />
          </label>
          {error ? <Notice kind="error" title={error} /> : null}
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : 'ตั้งรหัสผ่าน'}
          </button>
        </form>
      ) : null}
    </section>
  )
}
