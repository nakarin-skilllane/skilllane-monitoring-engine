'use client'

/**
 * Theme toggle (port of app.js §1): shows the icon of the theme you switch to (CSS),
 * saves the choice (lib/theme.ts), keeps aria-pressed / label in sync with the OS theme.
 */
import { useEffect, useState } from 'react'
import { currentTheme, setTheme, type Theme } from '@/lib/theme'
import { Icon } from './icons'

export function ThemeToggle() {
  const [theme, setState] = useState<Theme>('light')

  useEffect(() => {
    const sync = () => setState(currentTheme())
    sync()
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', sync)
    window.addEventListener('themechange', sync)
    return () => {
      mq?.removeEventListener?.('change', sync)
      window.removeEventListener('themechange', sync)
    }
  }, [])

  const dark = theme === 'dark'
  const label = dark ? 'เปลี่ยนเป็นธีมสว่าง' : 'เปลี่ยนเป็นธีมมืด'
  return (
    <button
      className="btn-icon theme-toggle"
      type="button"
      data-theme-toggle=""
      aria-pressed={dark}
      aria-label={label}
      title={label}
      onClick={() => setTheme(currentTheme() === 'dark' ? 'light' : 'dark')}
    >
      <Icon name="moon" className="i--moon" />
      <Icon name="sun" className="i--sun" />
    </button>
  )
}
