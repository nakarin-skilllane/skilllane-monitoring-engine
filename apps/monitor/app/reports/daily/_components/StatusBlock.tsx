import { StateChip } from '@/components/badges'
import type { ReportAiStatus, ReportStatus } from '@/lib/types'
import { aiMissingText, STATUS_STATE, STATUS_TEXT } from '../_lib/model'
import { SourceTag } from './SourceTag'

/** Status + one-line summary [กฎ], then the AI box or the grey bar saying why it is missing. */
export function StatusBlock({ status, summary, aiStatus, aiMessage, aiText }: { status: ReportStatus; summary: string; aiStatus: ReportAiStatus; aiMessage: string; aiText?: string }) {
  return (
    <div className="rp-status">
      <p className="rp-status__line">
        <StateChip state={STATUS_STATE[status]}>{STATUS_TEXT[status]}</StateChip> <span>{summary}</span> <SourceTag kind="rule" />
      </p>
      {aiStatus === 'ok' && aiText ? (
        <p className="rp-ai"><SourceTag kind="ai" /> {aiText}</p>
      ) : (
        <p className="rp-ai rp-ai--missing" role="note">{aiMissingText(aiStatus, aiMessage)}</p>
      )}
    </div>
  )
}
