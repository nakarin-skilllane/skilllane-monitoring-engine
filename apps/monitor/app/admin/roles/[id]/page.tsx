import type { Metadata } from 'next'
import { RoleFormPage } from '../RoleFormPage'

export const metadata: Metadata = { title: 'แก้ไข role' }

export default async function EditRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RoleFormPage id={id} />
}
