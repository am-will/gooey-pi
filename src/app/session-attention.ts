import { isRequestedCompactionReason } from '@/lib/compaction-reason'
import { parseExtensionUiRequest } from '@/lib/extension-ui'
import type { SessionRecord, SessionStatus } from '@/types/api'

export const CLEARED_ATTENTION_STORAGE_KEY = 'prime-work.cleared-session-attention'
export const CLEARED_ACTIVITY_STORAGE_KEY = 'prime-work.cleared-activity'

const LAUNCH_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`

interface SessionLifecycleChange {
  status: SessionStatus
  markUnread?: boolean
}

export function sessionLifecycleChange(event: Record<string, unknown>): SessionLifecycleChange | undefined {
  const type = typeof event.type === 'string' ? event.type : ''
  // Harnesses also send notify, status, title and cancel frames as
  // extension_ui_request; only a dialog waits on the user.
  if (parseExtensionUiRequest(event)) return { status: 'waiting', markUnread: true }
  if (type === 'agent_start' || type === 'turn_start') return { status: 'running', markUnread: false }
  // Idle compaction is harness maintenance between turns: it must not look
  // like new work or re-raise the finished turn's attention.
  if ((type === 'compaction_start' || type === 'compaction_end') && event.reason === 'idle') return undefined
  if (type === 'compaction_start') return { status: 'running', markUnread: false }
  if (type === 'compaction_end' && event.willRetry !== true && isRequestedCompactionReason(event.reason)) return { status: 'complete', markUnread: false }
  // A provider auto-retry continues the turn that the preceding agent_end
  // seemed to finish; a failed auto_retry_end is the turn's real terminal.
  if (type === 'auto_retry_start') return { status: 'running', markUnread: false }
  if (type === 'auto_retry_end' && event.success !== true) return { status: 'failed' }
  if (type === 'agent_end') return { status: 'complete', markUnread: true }
  if (type === 'extension_error' || type === 'error' || type === 'transport_error') return { status: 'failed' }
  if (type === 'runtime_exit') return { status: event.expected === true ? 'complete' : 'failed', markUnread: event.expected === true }
  return undefined
}

function nextUpdatedAt(previous: string, now: number): string {
  const previousTime = Date.parse(previous)
  return new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : now)).toISOString()
}

export function applySessionLifecycleEvent(
  session: SessionRecord,
  event: Record<string, unknown>,
  visible: boolean,
  now = Date.now(),
): SessionRecord {
  const change = sessionLifecycleChange(event)
  if (!change) return session
  const eventRevision = (session.eventRevision ?? 0) + 1
  return {
    ...session,
    status: change.status,
    updatedAt: nextUpdatedAt(session.updatedAt, now),
    eventRevision,
    statusEventRevision: eventRevision,
    unread: change.markUnread === undefined ? session.unread : change.markUnread && !visible,
  }
}

export function sessionAttentionSignature(session: SessionRecord): string | undefined {
  const revision = session.eventRevision ?? session.updatedAt
  if (session.status === 'waiting') return `waiting:${revision}`
  if (session.status === 'failed') return `failed:${revision}`
  if (session.status === 'complete' && session.unread) return `complete:${revision}`
  return session.unread ? `unread:${revision}` : undefined
}

export function sessionCompanionNotificationSignature(session: SessionRecord): string | undefined {
  const revision = session.eventRevision ?? session.updatedAt
  if (session.status === 'waiting' || session.status === 'failed') return `${session.status}:${revision}`
  if (session.status === 'complete' && (session.unread || typeof session.eventRevision === 'number')) return `complete:${revision}`
  return session.unread ? `unread:${revision}` : undefined
}

export function signatureCleared(signature: string | undefined, clearedSignature: string | undefined, unread = false, updatedAt?: string): boolean {
  if (!signature || !clearedSignature) return false
  const [core, launch, clearedUpdatedAt] = clearedSignature.split('@')
  if (launch && launch !== LAUNCH_ID) {
    const status = signature.slice(0, signature.indexOf(':'))
    const clearedStatus = core.slice(0, core.indexOf(':'))
    return Boolean(updatedAt && clearedUpdatedAt && Date.parse(updatedAt) <= Date.parse(clearedUpdatedAt)
      && (status === clearedStatus || status === 'idle' || status === 'complete' && !unread))
  }
  clearedSignature = core
  if (signature === clearedSignature) return true
  const separator = signature.indexOf(':')
  const clearedSeparator = clearedSignature.indexOf(':')
  if (separator < 0 || clearedSeparator < 0 || signature.slice(separator + 1) !== clearedSignature.slice(clearedSeparator + 1)) return false
  const status = signature.slice(0, separator)
  return status === 'idle' || status === 'complete' && !unread
}

export function activityNotificationSignature(session: SessionRecord): string | undefined {
  if (session.archived || session.status === 'running') return undefined
  return `${session.status}:${session.eventRevision ?? session.updatedAt}`
}

export function companionClearEntry(session: SessionRecord): string | undefined {
  const signature = sessionCompanionNotificationSignature(session)
  return signature ? `${signature}@${LAUNCH_ID}@${session.updatedAt}` : undefined
}

export function activityClearEntry(session: SessionRecord): string | undefined {
  const signature = activityNotificationSignature(session)
  return signature ? `${signature}@${LAUNCH_ID}@${session.updatedAt}` : undefined
}

function parseClearedSignatures(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [id, signature] of Object.entries(parsed)) {
      if (typeof signature === 'string') result[id] = signature
    }
    return result
  } catch { return {} }
}

function readStoredSignatures(key: string, supplied?: string | null): Record<string, string> {
  try {
    return parseClearedSignatures(supplied !== undefined ? supplied : typeof window === 'undefined' ? null : window.localStorage.getItem(key))
  } catch { return {} }
}

/** Notification dismissal is best effort when browser storage is unavailable. */
export function writeClearedSignatures(key: string, signatures: Record<string, string>): void {
  try { window.localStorage.setItem(key, JSON.stringify(signatures)) } catch { /* State remains valid for this renderer lifetime. */ }
}

export function readClearedAttention(storedValue?: string | null): Record<string, string> {
  return readStoredSignatures(CLEARED_ATTENTION_STORAGE_KEY, storedValue)
}

export function readClearedActivity(storedValue?: string | null): Record<string, string> {
  return readStoredSignatures(CLEARED_ACTIVITY_STORAGE_KEY, storedValue)
}
