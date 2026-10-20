import type { Metadata } from 'next'
import { UserFormPage } from '../UserFormPage'

export const metadata: Metadata = { title: 'สร้างผู้ใช้' }

export default function NewUserPage() {
  return <UserFormPage />
}
