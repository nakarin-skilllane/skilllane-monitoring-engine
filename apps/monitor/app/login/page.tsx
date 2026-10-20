import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getMe } from '@/lib/engine'
import { LoginForm } from './LoginForm'
import './screen.css'

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' }

/** Only a path on this monitor, never another site (an open redirect). */
function safeNext(value: string | string[] | undefined): string {
  const next = typeof value === 'string' ? value : ''
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/overview'
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const next = safeNext(sp.next)
  const me = await getMe()
  if (me.ok) redirect(next)
  return <LoginForm next={next} engineDown={!me.ok && me.error.kind !== 'http'} />
}
