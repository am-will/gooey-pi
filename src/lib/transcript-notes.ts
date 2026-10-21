import type { MessagePart } from '@/types/api'
import type { MessageKey } from '@/lib/i18n'

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

/** Translate only structured app notices, leaving harness and user prose untouched. */
export function transcriptText(part: Extract<MessagePart, { type: 'text' }>, t: Translate): string {
  const notice = part.notice
  if (!notice) return part.text
  switch (notice.kind) {
    case 'provider-fallback':
      return notice.from
        ? t('transcript.fallbackSwitchedFrom', { label: notice.label, from: notice.from })
        : t('transcript.fallbackSwitched', { label: notice.label })
    case 'empty-turn': return t('transcript.emptyTurn')
    case 'steer-read': return t('transcript.steerReadMarker', { count: notice.count })
  }
}
