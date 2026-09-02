import type { PrimeEventBuffer } from '@/lib/events'
import type { PrimeContextUsage, SessionUsage, SessionUsageTokens, TranscriptMessage } from '@/types/api'

export interface PendingAgentEvent {
  generation: number
  event: Record<string, unknown>
}

export interface TranscriptEventOwner {
  generation: number
  eventBuffer: PrimeEventBuffer
}

export interface TranscriptReconciliationMarker {
  generation: number
  runtimeId: string
  sessionFile: string
  admissionRevision?: number
}

const TERMINAL_TRANSCRIPT_EVENTS = new Set([
  'agent_end',
  'compaction_end',
  'extension_error',
  'error',
  'runtime_exit',
])

export function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : ''
}

export function contextUsageFromEvent(event: Record<string, unknown>): PrimeContextUsage | null {
  if (eventType(event) !== 'context_usage' || typeof event.contextUsage !== 'object' || event.contextUsage === null || Array.isArray(event.contextUsage)) return null
  const raw = event.contextUsage as Record<string, unknown>
  if (!Number.isSafeInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0) return null
  const tokens = raw.tokens === null ? null : Number.isSafeInteger(raw.tokens) && Number(raw.tokens) >= 0 ? Number(raw.tokens) : undefined
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow: Number(raw.contextWindow), percent }
}

const SESSION_TOKEN_FIELDS: Array<keyof SessionUsageTokens> = ['input', 'output', 'cacheRead', 'cacheWrite', 'total']

export function sessionUsageFromEvent(event: Record<string, unknown>): SessionUsage | null {
  if (eventType(event) !== 'session_usage' || typeof event.sessionUsage !== 'object' || event.sessionUsage === null || Array.isArray(event.sessionUsage)) return null
  const raw = event.sessionUsage as Record<string, unknown>
  const cost = raw.cost === null ? null : typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : undefined
  if (cost === undefined) return null
  if (raw.tokens === undefined) return { cost }
  if (typeof raw.tokens !== 'object' || raw.tokens === null || Array.isArray(raw.tokens)) return null
  const rawTokens = raw.tokens as Record<string, unknown>
  const tokens: Partial<SessionUsageTokens> = {}
  for (const field of SESSION_TOKEN_FIELDS) {
    const value = rawTokens[field]
    if (!Number.isSafeInteger(value) || Number(value) < 0) return null
    tokens[field] = Number(value)
  }
  return { cost, tokens: tokens as SessionUsageTokens }
}

export function needsTranscriptReconciliation(event: Record<string, unknown>): boolean {
  // transport_error: the runtime's event stream broke, so replayed events are
  // untrustworthy. transport_limit: the desktop rate limiter dropped events
  // mid-turn; the agent is still running and only the transcript needs an
  // authoritative re-read once the turn settles.
  const type = eventType(event)
  return type === 'transport_error' || type === 'transport_limit'
}

export function isTranscriptTerminalEvent(event: Record<string, unknown>): boolean {
  return TERMINAL_TRANSCRIPT_EVENTS.has(eventType(event))
    && !(eventType(event) === 'compaction_end' && event.willRetry === true)
}

export function reconciliationMatches(
  marker: TranscriptReconciliationMarker,
  generation: number,
  runtimeId: string,
  sessionFile: string | undefined,
): boolean {
  return marker.generation === generation
    && marker.runtimeId === runtimeId
    && marker.sessionFile === sessionFile
}


export function authoritativeTranscriptReadIsCurrent(
  marker: TranscriptReconciliationMarker,
  current: { generation: number; sessionFile?: string; admissionRevision?: number },
  currentRuntimeId: string | null,
): boolean {
  return marker.generation === current.generation
    && marker.sessionFile === current.sessionFile
    && (marker.admissionRevision ?? 0) === (current.admissionRevision ?? 0)
    && (currentRuntimeId === null || currentRuntimeId === marker.runtimeId)
}

const LOCAL_MESSAGE_ID = /^(?:user|assistant|stream|error|compaction)-/

function messageText(message: TranscriptMessage): string {
  return message.parts.map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '').join('\n').trim()
}

/**
 * Merges a background (non-authoritative) transcript read into the live
 * message list instead of replacing it wholesale: renderer-local rows that
 * trail the last message the disk read knows about — an optimistic user
 * bubble, a streaming placeholder, a system error row — survive unless the
 * read already contains their persisted counterpart.
 */
export function reconcileTranscriptMessages(
  current: TranscriptMessage[],
  incoming: TranscriptMessage[],
): TranscriptMessage[] {
  if (!current.length) return incoming
  const incomingIds = new Set(incoming.map((message) => message.id))
  const localTail: TranscriptMessage[] = []
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (incomingIds.has(current[index].id)) break
    localTail.unshift(current[index])
  }
  if (!localTail.length) return incoming
  const currentIds = new Set(current.map((message) => message.id))
  const persistedTail = incoming.filter((message) => !currentIds.has(message.id))
  const persisted = (local: TranscriptMessage): boolean => {
    if (local.role === 'user') {
      const text = messageText(local)
      return persistedTail.some((message) => message.role === 'user' && messageText(message) === text)
    }
    return persistedTail.some((message) => message.role === local.role)
  }
  const additions = localTail.filter((local) => LOCAL_MESSAGE_ID.test(local.id) && !persisted(local))
  return additions.length ? [...incoming, ...additions] : incoming
}

/** Maximum events held for animation-frame replay before falling back to an authoritative transcript read. */
export const AGENT_EVENT_QUEUE_LIMIT = 50_000

/** Maximum events replayed per macrotask when draining a large queue on visibilitychange. */
export const AGENT_EVENT_FLUSH_CHUNK = 2_000

export function admitAgentEvent(
  generation: number,
  event: Record<string, unknown>,
  pendingLoad: TranscriptEventOwner | null,
  frameQueue: PendingAgentEvent[],
  queueLimit = AGENT_EVENT_QUEUE_LIMIT,
): 'transcript' | 'frame' | 'overflow' {
  if (pendingLoad?.generation === generation) {
    pendingLoad.eventBuffer.push(event)
    return 'transcript'
  }
  if (frameQueue.length >= queueLimit) return 'overflow'
  frameQueue.push({ generation, event })
  return 'frame'
}

export function eventsForWorkspace(queue: PendingAgentEvent[], generation: number): Record<string, unknown>[] {
  return queue.filter((entry) => entry.generation === generation).map((entry) => entry.event)
}
