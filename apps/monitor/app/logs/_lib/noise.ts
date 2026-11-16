/**
 * /logs noise groups and repeats in the URL (pure).
 *
 *   show=all | none | probe,cache   noise groups shown; absent = none, or all while the page is narrowed to one thing
 *   repeats=collapse | all          repeats kept to their latest line or not; absent = collapse, or all while narrowed
 *
 * Narrowed = a trace, a job, an error group, a route or one repeat pattern: every line of it is wanted. The console's
 * "แสดง noise" sets both at once (show=all&repeats=all, or show=none&repeats=collapse while narrowed).
 */
import { shownGroups } from '@/lib/noise'

export const NOISE_GROUPS = ['probe', 'preflight', 'middleware', 'cache', 'cron', 'startup'] as const
type NoiseGroup = (typeof NOISE_GROUPS)[number]

export const shownNoise = (show: string | undefined, narrowed: boolean): NoiseGroup[] => shownGroups(NOISE_GROUPS, show, narrowed)

export function collapsesRepeats(repeats: string | undefined, narrowed: boolean): boolean {
  return repeats === undefined ? !narrowed : repeats === 'collapse'
}
