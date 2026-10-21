import { formattingLocaleTag, translate } from '@/lib/i18n'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import { isCompactionReason } from '@/lib/compaction-reason'
import { nextTranscriptId, withPartId } from './ids'
import { record, string } from './parse'

/** Compaction policy: parsing, dedupe, and transcript application. */

// Compaction runs while agent events stream in, outside React, so its fallback
// error copy comes from the interface locale mirror like the other reducers.
const compactionIncomplete = () => translate(formattingLocaleTag(), 'transcript.compactionIncomplete')

type CompactionPart = Extract<MessagePart, { type: 'compaction' }>

function compactionReason(value: unknown): CompactionPart['reason'] {
  return isCompactionReason(value) ? value : undefined
}

function compactionOutcome(value: unknown): CompactionPart['outcome'] {
  return value === 'failed' || value === 'cancelled' || value === 'skipped' ? value : undefined
}

function compactionResult(value: unknown): Pick<CompactionPart, 'summary' | 'tokensBefore' | 'firstKeptEntryId'> {
  const result = record(value)
  const tokensBefore = typeof result?.tokensBefore === 'number' && Number.isFinite(result.tokensBefore) && result.tokensBefore >= 0
    ? result.tokensBefore
    : undefined
  return {
    summary: string(result?.summary),
    tokensBefore,
    firstKeptEntryId: string(result?.firstKeptEntryId),
  }
}

function compactionPartFromStart(raw: Record<string, unknown>): CompactionPart {
  return {
    type: 'compaction',
    status: 'running',
    reason: compactionReason(raw.reason),
    action: string(raw.action),
    customInstructions: string(raw.customInstructions),
  }
}

function compactionPartFromEnd(raw: Record<string, unknown>): CompactionPart {
  const result = compactionResult(raw.result)
  const aborted = raw.aborted === true
  // Harness adapters mark a successful pass that rewrote history in place,
  // and so produced no summary, as completed.
  const hasResult = Boolean(result.summary || result.tokensBefore !== undefined || result.firstKeptEntryId)
  const status = aborted ? 'cancelled' : hasResult || raw.completed === true ? 'done' : 'failed'
  const outcome = aborted ? 'cancelled' : raw.errorSeverity === 'warning' ? 'skipped' : status === 'failed' ? 'failed' : undefined
  return {
    type: 'compaction',
    status,
    reason: compactionReason(raw.reason),
    action: string(raw.action),
    outcome,
    ...result,
    error: string(raw.errorMessage),
    customInstructions: string(raw.customInstructions),
    willRetry: raw.willRetry === true,
  }
}

function compactionOutcomePart(message: Record<string, unknown>): CompactionPart | undefined {
  if (message.customType !== 'compaction_outcome') return undefined
  const details = record(message.details)
  const outcome = compactionOutcome(details?.outcome) ?? 'failed'
  return {
    type: 'compaction',
    status: outcome === 'cancelled' ? 'cancelled' : 'failed',
    reason: compactionReason(details?.reason),
    outcome,
    error: string(message.content) ?? compactionIncomplete(),
  }
}

function compactionOutcomeFromEvent(raw: Record<string, unknown>): CompactionPart | undefined {
  if (raw.type === 'custom_message') return compactionOutcomePart(raw)
  if (raw.type !== 'message_end') return undefined
  const message = record(raw.message)
  return message ? compactionOutcomePart(message) : undefined
}

export function isCompactionEvent(raw: Record<string, unknown>): boolean {
  const type = string(raw.type) ?? string(raw.event)
  return type === 'compaction_start' || type === 'compaction_end' || Boolean(compactionOutcomeFromEvent(raw))
}

function sameCompactionResult(left: CompactionPart, right: CompactionPart): boolean {
  if (left.reason && right.reason && left.reason !== right.reason) return false
  // OMP may try several methods for one trigger (shake, then context-full); each pass is its own result.
  if (left.action && right.action && left.action !== right.action) return false
  if (left.firstKeptEntryId && right.firstKeptEntryId) return left.firstKeptEntryId === right.firstKeptEntryId
  if (left.status !== 'done' && right.status !== 'done') {
    return Boolean(left.reason && right.reason && left.reason === right.reason && (!left.error || !right.error || left.error === right.error))
  }
  return Boolean(left.summary && right.summary && left.summary === right.summary && left.tokensBefore === right.tokensBefore)
}

/**
 * Session files record no compaction trigger, so a transcript read replaces a
 * live compaction row with a persisted one that names no reason. The persisted
 * row of a pass the live transcript showed keeps the reason its events reported.
 */
export function keepLiveCompactionReasons(live: TranscriptMessage[], persisted: TranscriptMessage[]): TranscriptMessage[] {
  const reported = live.flatMap((message) => message.parts.filter((part): part is CompactionPart => part.type === 'compaction' && part.reason !== undefined))
  if (!reported.length) return persisted
  let changed = false
  const merged = persisted.map((message) => {
    let learned = false
    const parts = message.parts.map((part): MessagePart => {
      if (part.type !== 'compaction' || part.reason) return part
      const reason = reported.find((candidate) => sameCompactionResult(candidate, part))?.reason
      if (!reason) return part
      learned = true
      return { ...part, reason }
    })
    if (!learned) return message
    changed = true
    return { ...message, parts }
  })
  return changed ? merged : persisted
}

/** An end that omits a field (OMP ends carry no reason) must not erase what the running row learned at start. */
function definedCompactionFields(part: CompactionPart): Partial<CompactionPart> {
  return Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined))
}

function compactionIndex(messages: TranscriptMessage[], status?: CompactionPart['status']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts.find((candidate): candidate is CompactionPart => candidate.type === 'compaction')
    if (part && (status === undefined || part.status === status)) return index
  }
  return -1
}

function appendCompaction(messages: TranscriptMessage[], part: CompactionPart, now: number): TranscriptMessage[] {
  return [...messages, {
    id: nextTranscriptId('compaction'),
    role: 'system',
    timestamp: now,
    startedAt: now,
    completedAt: part.status === 'running' ? undefined : now,
    streaming: part.status === 'running',
    parts: [withPartId(part)],
  }]
}

/**
 * Applies one compaction event to a materialized transcript. Returns undefined
 * when the event carries no compaction semantics; returns the input array
 * unchanged when the event is a duplicate of already-recorded state.
 */
export function applyCompactionEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] | undefined {
  const type = string(raw.type) ?? string(raw.event)
  if (type === 'compaction_start') {
    const running = compactionIndex(messages, 'running')
    if (running >= 0) return messages
    const completedAt = Date.now()
    const finalized = messages.map((message) => message.role === 'assistant' && message.streaming
      ? { ...message, streaming: false, completedAt }
      : message)
    return appendCompaction(finalized, compactionPartFromStart(raw), completedAt)
  }
  let part: CompactionPart | undefined
  if (type === 'compaction_end') part = compactionPartFromEnd(raw)
  else part = compactionOutcomeFromEvent(raw)
  if (!part) return undefined

  const running = compactionIndex(messages, 'running')
  if (running >= 0) {
    const alreadyPersisted = part.status !== 'running' && messages.some((message, index) => index !== running
      && message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && sameCompactionResult(candidate, part!)))
    if (alreadyPersisted) return messages.filter((_, index) => index !== running)
    const completedAt = Date.now()
    return messages.map((message, index) => index === running
      ? { ...message, completedAt, streaming: false, parts: message.parts.map((candidate) => candidate.type === 'compaction' ? { ...candidate, ...definedCompactionFields(part!) } : candidate) }
      : message)
  }
  if (part.status !== 'running') {
    const duplicate = messages.some((message) => message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && sameCompactionResult(candidate, part!)))
    if (duplicate) return messages
  }
  return appendCompaction(messages, part, Date.now())
}
