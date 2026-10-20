'use client'

/**
 * Last-resort boundary for an unexpected exception in a screen: a Thai panel inside the
 * shell instead of a Next error page. Engine failures do not end up here (lib/engine.ts
 * returns them as values and pages render <EngineErrorState>).
 */
import { EmptyState } from '@/components/states'

export default function ScreenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="panel" role="alert">
      <EmptyState
        icon="alert-triangle"
        title="หน้านี้แสดงผลไม่ได้"
        text={
          <>
            เกิดข้อผิดพลาดระหว่างสร้างหน้า ({error.message || 'unknown error'}
            {error.digest ? <> · digest <code className="code-inline">{error.digest}</code></> : null}) · ลองใหม่ หรือเปิดหน้าอื่นจากเมนู
          </>
        }
        actions={
          <button className="btn btn--sm" type="button" onClick={reset}>
            ลองใหม่
          </button>
        }
      />
    </div>
  )
}
