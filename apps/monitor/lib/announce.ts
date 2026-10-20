/** Polite screen-reader announcements through the shell's live region (#sr-live). Client only. */
export const LIVE_REGION_ID = 'sr-live'

export function announce(text: string): void {
  const el = document.getElementById(LIVE_REGION_ID)
  if (!el) return
  el.textContent = ''
  // a new text node after a tick, so repeating the same message is announced again
  window.setTimeout(() => {
    el.textContent = text
  }, 30)
}
