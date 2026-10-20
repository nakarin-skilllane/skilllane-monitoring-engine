import type { Metadata } from 'next'
import { RoleFormPage } from '../RoleFormPage'

export const metadata: Metadata = { title: 'สร้าง role' }

export default function NewRolePage() {
  return <RoleFormPage />
}
