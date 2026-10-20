'use client'

/**
 * Copy to clipboard (port of app.js §4): `.btn-copy` with the copy + check icons; after a real copy
 * the button gets `.is-copied` (the check draws, a filled button turns ok-tint) and the label says
 * "คัดลอกแล้ว" for 1.6 s; the live region announces it. Without clipboard access it falls back to
 * execCommand, then selects the target text for a manual copy (`.is-copy-manual`, 4 s).
 *
 *   <CopyButton text={traceId} variant="icon" ariaLabel="คัดลอก trace id" />
 *   <CopyButton targetId="ai-md" label="คัดลอกให้ AI" variant="cta" />   orange CTA: at most one per page
 *   <CopyLinkButton />                    copies the real current URL
 */
import { useRef, useState } from 'react'
import { announce } from '@/lib/announce'
import { Icon } from './icons'

export interface CopyButtonProps {
  /** Literal text to copy. */
  text?: string
  /** Copy the textContent of the element with this id. */
  targetId?: string
  /** Copy window.location.href at click time. */
  currentUrl?: boolean
  /** Visible label (`.btn-copy__label`); icon-only without it. */
  label?: string
  ariaLabel?: string
  /** default = bordered .btn · quiet · primary · cta (SkillLane orange, one per page) · icon = 24 px .btn-icon--xs · icon-md = 32 px .btn-icon */
  variant?: 'default' | 'quiet' | 'primary' | 'cta' | 'icon' | 'icon-md'
  size?: 'sm'
  /** copy (two squares) or link (chain) icon. */
  icon?: 'copy' | 'link'
  className?: string
  title?: string
}

const CLASSES: Record<NonNullable<CopyButtonProps['variant']>, string> = {
  default: 'btn',
  quiet: 'btn btn--quiet',
  primary: 'btn btn--primary',
  cta: 'btn btn--cta',
  icon: 'btn-icon btn-icon--xs',
  'icon-md': 'btn-icon',
}

function fallbackCopy(text: string, target: Element | null): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  Object.assign(ta.style, { position: 'fixed', top: '0', opacity: '0' })
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  if (!ok && target) {
    // last resort: select the visible text for a manual copy
    const range = document.createRange()
    range.selectNodeContents(target)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  return ok
}

export function CopyButton({ text, targetId, currentUrl, label, ariaLabel, variant = 'default', size, icon = 'copy', className, title }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const timer = useRef<number | undefined>(undefined)

  async function onClick() {
    const target = targetId ? document.getElementById(targetId) : null
    const raw = currentUrl ? window.location.href : (text ?? target?.textContent ?? '')
    const value = raw.replace(/^\n+|\s+$/g, '')
    let ok = false
    if (navigator.clipboard && window.isSecureContext) {
      ok = await navigator.clipboard.writeText(value).then(
        () => true,
        () => false,
      )
    }
    if (!ok) ok = fallbackCopy(value, target)
    setState(ok ? 'copied' : 'manual')
    announce(ok ? 'คัดลอกแล้ว' : 'เลือกข้อความแล้ว กด Ctrl หรือ Command กับ C เพื่อคัดลอก')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), ok ? 1600 : 4000)
  }

  const stateClass = state === 'copied' ? 'is-copied' : state === 'manual' ? 'is-copy-manual' : ''
  const cls = [CLASSES[variant], size === 'sm' && !variant.startsWith('icon') ? 'btn--sm' : '', 'btn-copy', stateClass, className ?? '']
    .filter(Boolean)
    .join(' ')
  const shown = state === 'copied' ? 'คัดลอกแล้ว' : state === 'manual' ? 'เลือกข้อความแล้ว กด Ctrl/⌘+C' : label
  return (
    <button className={cls} type="button" onClick={onClick} aria-label={ariaLabel} title={title ?? (label ? undefined : ariaLabel)}>
      <Icon name={icon} className="i--copy" />
      <Icon name="check" className="i--check" />
      {label ? <span className="btn-copy__label">{shown}</span> : null}
    </button>
  )
}

/** Page-head "คัดลอกลิงก์": the real current URL (env, range and filters included). */
export function CopyLinkButton({ label = 'คัดลอกลิงก์' }: { label?: string }) {
  return <CopyButton currentUrl label={label} variant="quiet" icon="link" />
}
