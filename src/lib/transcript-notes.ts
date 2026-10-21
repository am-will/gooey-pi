import { fallbackNoticeFromText } from '@/lib/events/model-fallback'
import type { MessageKey } from '@/lib/i18n'

// This plain module cannot read the React context, so helpers take the translator
// as an argument.
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

/**
 * Localised copy for a provider-fallback notice, or null when `text` is not one.
 *
 * The notice reaches the renderer as English data: the desktop process composes
 * it while reading a session log (`electron/main/sessions/bucketed.ts`), and the
 * reducer does the same for live events. Every surface that shows it therefore
 * has to map it back onto its catalog entry — the transcript row and the
 * inspector summary both call this. Text that is not a notice returns null, which
 * is what keeps harness and user copy from being rewritten.
 */
export function localizedFallbackNotice(text: string, t: Translate): string | null {
  const notice = fallbackNoticeFromText(text)
  if (!notice) return null
  return notice.from
    ? t('transcript.fallbackSwitchedFrom', { label: notice.label, from: notice.from })
    : t('transcript.fallbackSwitched', { label: notice.label })
}
