'use client'

import { type FormEvent, useState } from 'react'
import { api } from '@/lib/admin-api'
import { Notice } from '../admin/_components/Notice'

const MIN = 12

/** Current + new password; other browsers are signed out, this one stays in. */
export function ChangePasswordForm({ username }: { username: string }) {
  const [result, setResult] = useState<{ kind: 'error' | 'ok'; title: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formEl = e.currentTarget
    const form = new FormData(formEl)
    const newPassword = String(form.get('newPassword') ?? '')
    if (newPassword.length < MIN) return setResult({ kind: 'error', title: `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN} ตัวอักษร` })
    if (newPassword !== form.get('confirm')) return setResult({ kind: 'error', title: 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน' })
    setBusy(true)
    const res = await api('POST', '/auth/change-password', { currentPassword: form.get('currentPassword'), newPassword })
    setBusy(false)
    if (!res.ok) return setResult({ kind: 'error', title: res.message })
    formEl.reset()
    setResult({ kind: 'ok', title: 'เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นที่เข้าสู่ระบบไว้จะต้องเข้าใหม่' })
  }

  return (
    <form className="adm-form" onSubmit={submit}>
      <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
      <div className="adm-form__row">
        <label className="adm-field">
          <span className="adm-field__label">รหัสผ่านปัจจุบัน</span>
          <input className="adm-input" name="currentPassword" type="password" autoComplete="current-password" required />
        </label>
        <label className="adm-field">
          <span className="adm-field__label">รหัสผ่านใหม่</span>
          <input className="adm-input" name="newPassword" type="password" autoComplete="new-password" minLength={MIN} required />
          <span className="adm-field__hint">อย่างน้อย {MIN} ตัวอักษร</span>
        </label>
        <label className="adm-field">
          <span className="adm-field__label">ยืนยันรหัสผ่านใหม่</span>
          <input className="adm-input" name="confirm" type="password" autoComplete="new-password" minLength={MIN} required />
        </label>
      </div>
      {result ? <Notice kind={result.kind} title={result.title} /> : null}
      <div className="adm-form__actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'เปลี่ยนรหัสผ่าน'}
        </button>
      </div>
    </form>
  )
}
