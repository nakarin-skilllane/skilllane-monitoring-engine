'use client'

import { type FormEvent, useState } from 'react'
import { BrandMark } from '@/components/icons'
import { PRODUCT_NAME } from '@/components/shell/names'
import { api } from '@/lib/admin-api'
import { Notice } from '../admin/_components/Notice'
import '../admin/screen.css'

/** Username + password → POST /engine/auth/login (the engine sets the session cookie) → `next`. */
export function LoginForm({ next, engineDown }: { next: string; engineDown: boolean }) {
  const [error, setError] = useState<string | null>(engineDown ? 'ติดต่อ engine ไม่ได้ ลองใหม่อีกครั้ง' : null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    const res = await api('POST', '/auth/login', { username: form.get('username'), password: form.get('password') })
    if (!res.ok) {
      setBusy(false)
      setError(res.message)
      return
    }
    // a full load: the layout reads the new session on the server
    window.location.assign(next)
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-card__brand">
        <BrandMark />
        {PRODUCT_NAME}
      </div>
      <div>
        <h1 className="auth-card__title" id="auth-title">
          เข้าสู่ระบบ
        </h1>
        <p className="auth-card__sub">ใช้ชื่อผู้ใช้และรหัสผ่านที่ได้จากผู้ดูแลระบบ</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label className="adm-field">
          <span className="adm-field__label">ชื่อผู้ใช้</span>
          <input className="adm-input" name="username" autoComplete="username" required autoFocus />
        </label>
        <label className="adm-field">
          <span className="adm-field__label">รหัสผ่าน</span>
          <input className="adm-input" name="password" type="password" autoComplete="current-password" required />
        </label>
        {error ? <Notice kind="error" title={error} /> : null}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>
      </form>
    </section>
  )
}
