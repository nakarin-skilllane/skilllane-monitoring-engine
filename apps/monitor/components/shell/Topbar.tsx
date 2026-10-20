'use client'

/**
 * Top bar (markup and Thai copy of _shell.html): env control, time range (+ custom
 * from/to in ICT), `.range-abs`, jump search ("/" focuses it), theme toggle, and the
 * menu button + brand shown below 900 px. Everything is URL state:
 * env / from / to are search params; changing them keeps the screen and its filters
 * (minus the paging cursor). `data-env` draws the prod line.
 *
 * Env control: dev · staging · prod as a segmented control for those the engine knows
 * (/api/meta envs); every other env and "ทุก env" in a compact select. Only envs with data in the last hour
 * (ACTIVE_MS, whatever the screen's range: the 24 h screens too) are main options and counted; the others
 * (leftover test runs) sit behind one option "env ที่ไม่มีข้อมูลใน 1 ชม. (n)…" that expands them into an
 * optgroup (and reopens the list). The current env is always a main option. When the select holds nothing
 * current it is narrow, and hidden under 600 px (lib/freshness.ts).
 *
 * Custom range: the select shows the applied window ("11:00–12:00 ICT") with "กำหนดเอง…" to edit it;
 * the form stacks its two inputs under 600 px; cancel / apply / Esc put focus back on the select.
 */
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { fmtRangeShort, fromIctInput, toIctInput } from '@/lib/format'
import { isActiveEnv } from '@/lib/freshness'
import type { Me } from '@/lib/types'
import {
  ALL_ENVS,
  ENV_SEGMENTS,
  RANGE_BOUND_KEYS,
  RANGE_PRESETS,
  buildHref,
  jumpHref,
  keepOf,
  parseScope,
  rangeAbs,
  screenFromPath,
  withParams,
} from '@/lib/params'
import { BrandMark, Icon } from '../icons'
import { ThemeToggle } from '../ThemeToggle'
import { NavToggle } from './AppFrame'
import { PRODUCT_NAME } from './names'

const DROP = Object.fromEntries(RANGE_BOUND_KEYS.map((k) => [k, null]))
/** An env is a main option of the env select when its newest line is this recent (not the screen's range). */
const ACTIVE_MS = 3600_000
/** Select value of the option that expands the envs without recent data. */
const SHOW_OLD = '__old'

/** Re-render every `ms` so relative ranges (now-1h) keep their absolute label current. */
function useTick(ms: number): number {
  const [, set] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => set((n) => n + 1), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return Date.now()
}

export interface TopbarProps {
  envs: string[]
  /** env → newest line (latestByEnv(meta)); without it every env counts as having data. */
  latest?: Record<string, string>
  /** The user reads only `envs`, one at a time: no "ทุก env". */
  limited?: boolean
  /** The signed-in user (menu on the right); undefined when the engine did not answer. */
  me?: Me
}

export function Topbar({ envs, latest, limited, me }: TopbarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const screen = screenFromPath(pathname) ?? 'overview'
  const now = useTick(30_000)
  const scope = parseScope(sp, screen, { envs, now, limited })
  const go = (changes: Record<string, string | null>) => router.push(withParams(pathname, sp, { ...changes, ...DROP }), { scroll: false })

  return (
    <header className="topbar" data-env={scope.env ?? ''}>
      <NavToggle className="btn-icon topbar__menu" controls label="เปิดเมนู">
        <Icon name="menu" />
      </NavToggle>
      <Link className="topbar__brand" href={buildHref('/about', keepOf(sp))} prefetch={false}>
        <BrandMark />
        {PRODUCT_NAME}
      </Link>
      <div className="topbar__scope">
        <EnvControl envs={envs} env={scope.env} latest={latest} activeFromMs={now - ACTIVE_MS} limited={limited} onPick={(env) => go({ env })} />
        <RangeControl
          preset={scope.preset}
          fromMs={scope.fromMs}
          toMs={scope.toMs}
          nowMs={now}
          onPreset={(from) => go({ from, to: null })}
          onCustom={(from, to) => go({ from, to })}
        />
        <span className="range-abs" suppressHydrationWarning>
          {rangeAbs(scope)}
        </span>
      </div>
      <JumpSearch />
      <div className="topbar__end">
        <ThemeToggle />
        {me ? <UserMenu me={me} /> : null}
      </div>
    </header>
  )
}

/** Name, account page, sign out (the engine clears the cookie). */
function UserMenu({ me }: { me: Me }) {
  const signOut = async () => {
    await fetch('/engine/auth/logout', { method: 'POST' }).catch(() => undefined)
    window.location.assign('/login')
  }
  return (
    <div className="user-menu">
      <Link className="user-menu__name" href="/account" prefetch={false} title={`${me.username} · บัญชีของฉัน`}>
        {me.name || me.username}
      </Link>
      <button className="btn btn--quiet btn--sm" type="button" onClick={signOut}>
        ออกจากระบบ
      </button>
    </div>
  )
}

function EnvControl({
  envs,
  env,
  latest,
  activeFromMs,
  limited,
  onPick,
}: {
  envs: string[]
  env?: string
  latest?: Record<string, string>
  /** Newest line at or after this = a main option (now − ACTIVE_MS). */
  activeFromMs: number
  limited?: boolean
  onPick: (env: string) => void
}) {
  const [showOld, setShowOld] = useState(false)
  const segments = ENV_SEGMENTS.filter((e) => envs.includes(e))
  const inSegments = !!env && (segments as readonly string[]).includes(env)
  const rest = envs.filter((e) => !(segments as readonly string[]).includes(e))
  // data in the last hour: listed and counted; the rest (leftover test runs) behind "env ที่ไม่มีข้อมูล…", the
  // current env always listed (an env typed into the URL that the engine does not list included)
  const active = rest.filter((e) => e === env || !latest || isActiveEnv(latest, e, activeFromMs))
  const old = rest.filter((e) => !active.includes(e))
  if (env && !inSegments && !active.includes(env)) active.unshift(env)
  const selectValue = env === undefined ? ALL_ENVS : inSegments ? '' : env
  // nothing current in the select (only old envs and ทุก env): narrow, and off the phone header
  const quiet = segments.length > 0 && inSegments && active.length === 0
  return (
    <>
      {segments.length ? (
        <div className="seg seg--env" role="group" aria-label="Environment">
          {segments.map((e) => (
            <button key={e} className={e === 'prod' ? 'seg__btn seg__btn--prod' : 'seg__btn'} type="button" aria-pressed={e === env} onClick={() => onPick(e)}>
              {e === 'prod' ? <span className="seg__dot" aria-hidden="true" /> : null}
              {e}
            </button>
          ))}
        </div>
      ) : null}
      {rest.length || active.length || !segments.length ? (
        <label className={quiet ? 'select shell-env shell-env--quiet' : 'select shell-env'}>
          <span className="sr-only">{segments.length ? 'env อื่น' : 'Environment'}</span>
          <select
            className="select__control"
            name="env"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value
              if (v !== SHOW_OLD) {
                if (v) onPick(v)
                return
              }
              // expand the old envs in place and open the list again where the browser can (showPicker)
              setShowOld(true)
              const select = e.currentTarget
              window.requestAnimationFrame(() => {
                try {
                  select.showPicker?.()
                } catch {
                  // no user activation left, or not supported: the expanded list opens on the next click
                }
              })
            }}
          >
            {inSegments ? <option value="">{active.length ? `env อื่น (${active.length})` : 'env อื่น'}</option> : null}
            {active.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
            {limited ? null : <option value={ALL_ENVS}>ทุก env</option>}
            {old.length && showOld ? (
              <optgroup label={`ไม่มีข้อมูลใน 1 ชั่วโมงล่าสุด (${old.length})`}>
                {old.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </optgroup>
            ) : old.length ? (
              <option value={SHOW_OLD}>env ที่ไม่มีข้อมูลใน 1 ชม. ({old.length})…</option>
            ) : null}
          </select>
          <Icon name="chevron" className="select__chev" />
        </label>
      ) : null}
    </>
  )
}

/** Select value of the applied custom window (an option of its own, so "กำหนดเอง…" can open the form again). */
const APPLIED = 'applied'

function RangeControl({
  preset,
  fromMs,
  toMs,
  nowMs,
  onPreset,
  onCustom,
}: {
  preset: string
  fromMs: number
  toMs: number
  nowMs: number
  onPreset: (from: string) => void
  onCustom: (from: string, to: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const id = useId()
  const fromRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const value = editing ? 'custom' : preset === 'custom' ? APPLIED : preset

  useEffect(() => {
    if (editing) fromRef.current?.focus()
  }, [editing])

  /** Close the form and give focus back to the range select (it stays mounted). */
  function close() {
    setEditing(false)
    selectRef.current?.focus()
  }

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const from = fromIctInput(String(data.get('from') ?? ''))
    const to = fromIctInput(String(data.get('to') ?? ''))
    if (!from || !to || Date.parse(from) >= Date.parse(to)) {
      fromRef.current?.setCustomValidity('เวลาเริ่มต้องมาก่อนเวลาสิ้นสุด')
      fromRef.current?.reportValidity()
      return
    }
    close()
    onCustom(from, to)
  }

  function onFormKey(e: ReactKeyboardEvent<HTMLFormElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <>
      <label className="select select--lead">
        <Icon name="clock" className="select__icon" />
        <span className="sr-only">ช่วงเวลา</span>
        <select
          ref={selectRef}
          className="select__control"
          name="range"
          value={value}
          onChange={(e) => {
            if (e.target.value === 'custom') setEditing(true)
            else if (e.target.value === APPLIED) setEditing(false)
            else {
              setEditing(false)
              onPreset(e.target.value)
            }
          }}
        >
          {RANGE_PRESETS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
          {preset === 'custom' ? (
            // the applied window stays readable on phones, where .range-abs is hidden
            <option value={APPLIED} suppressHydrationWarning>
              {fmtRangeShort(fromMs, toMs, nowMs)}
            </option>
          ) : null}
          <option value="custom">กำหนดเอง…</option>
        </select>
        <Icon name="chevron" className="select__chev" />
      </label>
      {editing ? (
        <form className="shell-range" onSubmit={apply} onKeyDown={onFormKey} aria-label="กำหนดช่วงเวลาเอง (ICT)">
          <label htmlFor={`${id}-from`} className="sr-only">
            ตั้งแต่ (ICT)
          </label>
          <input
            ref={fromRef}
            id={`${id}-from`}
            className="shell-range__input"
            type="datetime-local"
            name="from"
            required
            defaultValue={toIctInput(fromMs)}
            onInput={(e) => e.currentTarget.setCustomValidity('')}
          />
          <span className="shell-range__sep" aria-hidden="true">
            –
          </span>
          <label htmlFor={`${id}-to`} className="sr-only">
            ถึง (ICT)
          </label>
          <input id={`${id}-to`} className="shell-range__input" type="datetime-local" name="to" required defaultValue={toIctInput(toMs)} />
          <button className="btn btn--sm btn--primary" type="submit">
            ใช้ช่วงนี้
          </button>
          <button className="btn btn--sm btn--quiet" type="button" onClick={close}>
            ยกเลิก
          </button>
        </form>
      ) : null}
    </>
  )
}

function JumpSearch() {
  const router = useRouter()
  const sp = useSearchParams()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const a = document.activeElement as HTMLElement | null
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return
      e.preventDefault()
      input.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const href = jumpHref(input.current?.value ?? '', keepOf(sp))
    if (href && input.current) {
      // the top bar outlives the navigation: start the next search empty
      input.current.value = ''
      input.current.blur()
      router.push(href)
    }
  }

  return (
    <form className="jump" role="search" action="/logs" onSubmit={submit}>
      <Icon name="search" />
      <label className="sr-only" htmlFor="jump-q">
        ค้นหา trace id, user id หรือคำค้น
      </label>
      <input ref={input} className="jump__input" id="jump-q" type="search" name="q" placeholder="trace id, user id หรือคำค้น" autoComplete="off" spellCheck={false} />
      <kbd className="jump__kbd" aria-hidden="true">
        /
      </kbd>
    </form>
  )
}
