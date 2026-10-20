import type { TranscriptMessage } from '@/types/api'

/**
 * A role 'system' row is neutral when it carries a kind (a notice or a
 * steer-read marker). Without one it reports how a run went: an error, or a
 * compaction row.
 */
export function isSystemReport(message: TranscriptMessage | undefined): boolean {
  return message?.role === 'system' && message.kind === undefined
}
