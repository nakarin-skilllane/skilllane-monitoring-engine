import { PageSkeleton } from '@/components/states'

/** Shown while a screen's server components load (the shell stays). A screen may add its own loading.tsx. */
export default function Loading() {
  return <PageSkeleton />
}
