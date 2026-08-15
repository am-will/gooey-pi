import type { SessionRecord, SessionStatus } from '@/types/api'

interface SessionLifecycleChange {
  status: SessionStatus
  markUnread?: boolean
}

export function sessionLifecycleChange(event: Record<string, unknown>): SessionLifecycleChange | undefined {
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'extension_ui_request') return { status: 'waiting', markUnread: true }
  if (type === 'agent_start' || type === 'turn_start') return { status: 'running', markUnread: false }
  if (type === 'compaction_start') return { status: 'running', markUnread: false }
  if (type === 'compaction_end' && event.willRetry !== true && (event.reason === 'manual' || event.reason === 'requested')) return { status: 'complete', markUnread: false }
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

export function sessionShowsCompanionNotification(session: SessionRecord, clearedSignature?: string): boolean {
  if (session.archived) return false
  const signature = sessionCompanionNotificationSignature(session)
  return Boolean(signature && signature !== clearedSignature)
}

export function activityNotificationSignature(session: SessionRecord): string | undefined {
  if (session.archived || session.status === 'running') return undefined
  return `${session.status}:${session.eventRevision ?? session.updatedAt}`
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

export function readClearedAttention(storedValue?: string | null): Record<string, string> {
  const raw = storedValue !== undefined
    ? storedValue
    : typeof window === 'undefined' ? null : window.localStorage.getItem('prime-work.cleared-session-attention')
  return parseClearedSignatures(raw)
}

export function readClearedActivity(storedValue?: string | null): Record<string, string> {
  const raw = storedValue !== undefined
    ? storedValue
    : typeof window === 'undefined' ? null : window.localStorage.getItem('prime-work.cleared-activity')
  return parseClearedSignatures(raw)
}
