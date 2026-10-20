'use client'

import { useEffect, useRef } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { Icon } from '@/components/icons'

export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '–'

/** The set-password link with a copy button and its expiry. */
export function InviteLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  return (
    <div className="adm-invite">
      <div className="adm-link">
        <input className="adm-input" value={url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="ลิงก์ตั้งรหัสผ่าน" />
        <CopyButton text={url} label="คัดลอก" />
      </div>
      <span className="adm-field__hint">ใช้ได้ครั้งเดียว ถึง {fmtTime(expiresAt)} ICT · ส่งให้เจ้าตัวเปิดเพื่อตั้งรหัสผ่าน</span>
    </div>
  )
}

/** Modal (native <dialog>) with a fresh link: after creating a user or resetting a password. */
export function InviteModal({
  title,
  text,
  url,
  expiresAt,
  onClose,
}: {
  title: string
  text: string
  url: string
  expiresAt: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog ref={ref} className="adm-modal" aria-labelledby="adm-modal-title" onClose={onClose}>
      <div className="adm-modal__head">
        <h2 className="adm-modal__title" id="adm-modal-title">
          {title}
        </h2>
        <button className="btn-icon" type="button" aria-label="ปิด" onClick={() => ref.current?.close()}>
          <Icon name="close" />
        </button>
      </div>
      <div className="adm-modal__body">
        <p>{text}</p>
        <InviteLink url={url} expiresAt={expiresAt} />
      </div>
      <div className="adm-modal__foot">
        <button className="btn btn--primary" type="button" onClick={() => ref.current?.close()}>
          เสร็จแล้ว
        </button>
      </div>
    </dialog>
  )
}
