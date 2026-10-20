import { Icon } from '@/components/icons'

/** One result line under a form: error (red), ok (green). */
export function Notice({ kind, title, text }: { kind: 'error' | 'ok'; title: string; text?: string }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={kind === 'error' ? 'alert-octagon' : 'check-circle'} className="callout__icon" />
      <p className="callout__title">{title}</p>
      {text ? <p className="callout__text">{text}</p> : null}
    </div>
  )
}
