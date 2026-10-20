import type { Metadata } from 'next'
import { SetPasswordForm } from './SetPasswordForm'
import '../login/screen.css'

export const metadata: Metadata = { title: 'ตั้งรหัสผ่าน' }

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  return <SetPasswordForm token={typeof sp.token === 'string' ? sp.token : ''} />
}
