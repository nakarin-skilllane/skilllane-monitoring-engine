import { redirect } from 'next/navigation'
import { type RawSearchParams, withParams } from '@/lib/params'

/** `/` → `/overview`, keeping the query (env, range, theme). */
export default async function Home({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  redirect(withParams('/overview', await searchParams, {}))
}
