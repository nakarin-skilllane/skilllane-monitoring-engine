/**
 * Theme: `data-theme` on <html>. `?theme=dark|light` wins for that page load (not saved,
 * for screenshots), then the saved choice, else the OS preference (CSS media query).
 */
export const THEME_KEY = 'skilllane-monitor-theme'

/** Inline <head> script: sets data-theme before first paint (no flash). Keep it tiny and ES5. */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,p=new URLSearchParams(location.search).get('theme'),t=p==='dark'||p==='light'?p:localStorage.getItem('${THEME_KEY}');if(t==='dark'||t==='light')d.setAttribute('data-theme',t)}catch(e){}})()`

export type Theme = 'light' | 'dark'

/** The theme in effect (attribute, else OS). Client only. */
export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // storage blocked: the theme still applies to this page
  }
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }))
}
