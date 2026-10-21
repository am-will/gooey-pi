import type { TranscriptMessage } from '@/types/api'

// Keyed by the union, so a new kind fails to compile until it is classified here.
const NEUTRAL_KINDS: Record<NonNullable<TranscriptMessage['kind']>, boolean> = {
  'steer-read-marker': true,
  notice: true,
  error: false,
}

/**
 * A role 'system' row reports how a run went (an error, or a compaction row)
 * unless its kind is a neutral one: a steer-read marker or a notice.
 */
export function isSystemReport(message: TranscriptMessage | undefined): boolean {
  return message?.role === 'system' && !(message.kind && NEUTRAL_KINDS[message.kind])
}
