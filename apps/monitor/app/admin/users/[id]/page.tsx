import type { Metadata } from 'next'
import { UserFormPage } from '../UserFormPage'

export const metadata: Metadata = { title: 'แก้ไขผู้ใช้' }

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <UserFormPage id={id} />
}
