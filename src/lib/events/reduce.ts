import type { MessagePart, QueuedPrompt, TranscriptMessage } from '@/types/api'
import { applyCompactionEvent, isCompactionEvent } from './compaction'
import { nextTranscriptId, withPartId } from './ids'
import { fallbackModelFromRecord, fallbackNoticeText } from './model-fallback'
import { agentMessagePart, record, resultText, string } from './parse'

export interface PrimeEventReplayStats {
  messageScans: number
  eventScans: number
  partScans: number
  transcriptCopies: number
}

interface PartNode {
  part: MessagePart
  previous?: PartNode
  next?: PartNode
}

interface PartDraft {
  head?: PartNode
  tail?: PartNode
  length: number
  firstToolById: Map<string | undefined, PartNode>
}

/** Applies a frame batch with one transcript scan and one scan of each drafted part list. */
/**
 * Tool events without a toolCallId must still pair their start/update/end
 * events onto one tool row instead of appending a phantom second row, so
 * they share a stable name-derived fallback id.
 */
function effectiveToolId(id: string | undefined, name: string): string {
  return id ?? `tool-fallback:${name}`
}

const EMPTY_TURN_FALLBACK = 'Completed without a text response.'
const LOCAL_STEER_PICKUP = Symbol('gooeypi-steer-pickup')
const LOCAL_STEER_ACCEPTED = Symbol('gooeypi-steer-accepted')

/** Renderer-only event: fixes an admitted steer in history at response time. */
export function createSteerAcceptedEvent(prompt: QueuedPrompt): Record<string, unknown> {
  return { type: 'gooeypi_steer_accepted', prompt, [LOCAL_STEER_ACCEPTED]: true }
}

/** Renderer-only event: the symbol prevents an agent frame from spoofing a local pickup. */
export function createSteerPickupEvent(prompts: QueuedPrompt[]): Record<string, unknown> {
  return { type: 'gooeypi_steer_pickup', prompts, [LOCAL_STEER_PICKUP]: true }
}

export function replayPrimeEvents(
  messages: TranscriptMessage[],
  events: Record<string, unknown>[],
  stats?: PrimeEventReplayStats,
): TranscriptMessage[] {
  if (!events.length) return messages
  let base = messages
  let next = base
  let copiedMessages = false
  let lastStreamingAssistant = -1
  const streaming = new Set<number>()
  const draftedMessages = new Set<number>()
  const partDrafts = new Map<number, PartDraft>()

  const scanStreaming = () => {
    for (let index = 0; index < base.length; index += 1) {
      if (stats) stats.messageScans += 1
      const message = base[index]
      if (!message.streaming) continue
      streaming.add(index)
      if (message.role === 'assistant') lastStreamingAssistant = index
    }
  }
  scanStreaming()

  const copyTranscript = () => {
    if (copiedMessages) return
    next = base.slice()
    copiedMessages = true
    if (stats) stats.transcriptCopies += 1
  }
  const draftMessage = (index: number): TranscriptMessage => {
    copyTranscript()
    if (!draftedMessages.has(index)) {
      next[index] = { ...next[index] }
      draftedMessages.add(index)
    }
    return next[index]
  }
  const appendNode = (draft: PartDraft, part: MessagePart): PartNode => {
    const node: PartNode = { part, previous: draft.tail }
    if (draft.tail) draft.tail.next = node
    else draft.head = node
    draft.tail = node
    draft.length += 1
    if (part.type === 'toolCall' && !draft.firstToolById.has(part.id)) draft.firstToolById.set(part.id, node)
    return node
  }
  const draftParts = (index: number): PartDraft => {
    const existing = partDrafts.get(index)
    if (existing) return existing
    const message = draftMessage(index)
    const draft: PartDraft = { length: 0, firstToolById: new Map() }
    for (const part of message.parts) {
      if (stats) stats.partScans += 1
      appendNode(draft, part)
    }
    partDrafts.set(index, draft)
    return draft
  }
  const insertAfter = (draft: PartDraft, node: PartNode, part: MessagePart): PartNode => {
    const inserted: PartNode = { part, previous: node, next: node.next }
    if (node.next) node.next.previous = inserted
    else draft.tail = inserted
    node.next = inserted
    draft.length += 1
    return inserted
  }
  const appendAssistant = (prefix: 'assistant' | 'stream'): number => {
    copyTranscript()
    const now = Date.now()
    const index = next.length
    next.push({ id: nextTranscriptId(prefix), role: 'assistant', timestamp: now, startedAt: now, streaming: true, parts: [] })
    draftedMessages.add(index)
    streaming.add(index)
    lastStreamingAssistant = index
    return index
  }
  const resumeTailAssistant = (): number | undefined => {
    const tailIndex = next.length - 1
    if (tailIndex < 0 || next[tailIndex].role !== 'assistant') return undefined
    const message = draftMessage(tailIndex)
    message.streaming = true
    message.completedAt = undefined
    streaming.add(tailIndex)
    lastStreamingAssistant = tailIndex
    return tailIndex
  }
  const assistantIndex = () => lastStreamingAssistant >= 0
    ? lastStreamingAssistant
    : resumeTailAssistant() ?? appendAssistant('stream')
  const upsertToolDraft = (index: number, id: string, name: string, args: unknown): PartNode => {
    const draft = draftParts(index)
    const existing = id ? draft.firstToolById.get(id) : undefined
    const tool: MessagePart = { type: 'toolCall', id, name, args }
    if (existing) {
      // Execution updates may omit args; keep the args captured at start
      // rather than blanking the tool preview mid-execution.
      if (args === undefined && existing.part.type === 'toolCall') tool.args = existing.part.args
      existing.part = { ...tool, partId: existing.part.partId }
      return existing
    }
    return appendNode(draft, withPartId(tool))
  }
  const setToolResult = (draft: PartDraft, call: PartNode, result: MessagePart) => {
    if (call.next?.part.type === 'toolResult') call.next.part = { ...result, partId: call.next.part.partId }
    else insertAfter(draft, call, withPartId(result))
  }
  const finalizeStreaming = (completedAt: number, addFallback: boolean) => {
    for (const index of streaming) {
      const message = draftMessage(index)
      message.streaming = false
      message.completedAt = completedAt
      const parts = partDrafts.get(index)
      if (addFallback && (parts?.length ?? message.parts.length) === 0) {
        appendNode(draftParts(index), withPartId({ type: 'text', text: EMPTY_TURN_FALLBACK }))
      }
    }
    streaming.clear()
    lastStreamingAssistant = -1
  }
  const dropTailFallback = (index: number) => {
    const draft = draftParts(index)
    const tail = draft.tail
    if (tail?.part.type !== 'text' || tail.part.text !== EMPTY_TURN_FALLBACK) return
    draft.tail = tail.previous
    if (draft.tail) draft.tail.next = undefined
    else draft.head = undefined
    draft.length -= 1
  }
  const materializeDrafts = () => {
    for (const [index, draft] of partDrafts) {
      const parts: MessagePart[] = []
      for (let node = draft.head; node; node = node.next) parts.push(node.part)
      draftMessage(index).parts = parts
    }
    partDrafts.clear()
  }
  const rebase = (transcript: TranscriptMessage[]) => {
    base = transcript
    next = transcript
    copiedMessages = false
    draftedMessages.clear()
    streaming.clear()
    lastStreamingAssistant = -1
    scanStreaming()
  }

  const steerMessage = (value: unknown, state: 'accepted' | 'read'): TranscriptMessage | undefined => {
    const prompt = record(value)
    const id = string(prompt?.id)
    const text = string(prompt?.text)
    if (!id || !text) return undefined
    const timestamp = typeof prompt?.timestamp === 'number' && Number.isFinite(prompt.timestamp) ? prompt.timestamp : Date.now()
    const parts = Array.isArray(prompt?.parts) ? prompt.parts as MessagePart[] : [{ type: 'text' as const, text }]
    return { id: `user-${id}`, role: 'user', steerState: state, timestamp, parts }
  }

  for (const raw of events) {
    if (stats) stats.eventScans += 1
    const type = string(raw.type) ?? string(raw.event)
    if (!type) continue
    if (type === 'gooeypi_steer_accepted' && (raw as Record<PropertyKey, unknown>)[LOCAL_STEER_ACCEPTED] === true) {
      const accepted = steerMessage(raw.prompt, 'accepted')
      if (!accepted || next.some((message) => message.id === accepted.id)) continue
      // Freeze the output already visible when the RPC response confirms
      // admission. Later deltas open a new assistant segment below this row,
      // so the steer cannot ride the live bottom edge as output grows.
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      next.push(accepted)
      continue
    }
    if (type === 'gooeypi_steer_pickup' && (raw as Record<PropertyKey, unknown>)[LOCAL_STEER_PICKUP] === true) {
      const prompts = Array.isArray(raw.prompts) ? raw.prompts : []
      const pickedUp = prompts.flatMap((value) => {
        const message = steerMessage(value, 'read')
        return message ? [message] : []
      })
      if (!pickedUp.length) continue
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      for (const message of pickedUp) {
        const existingIndex = next.findIndex((candidate) => candidate.id === message.id)
        if (existingIndex >= 0) draftMessage(existingIndex).steerState = 'read'
        else next.push(message)
      }
      const markerId = `steer-read-${pickedUp.map((message) => message.id).join('-')}`
      if (!next.some((message) => message.id === markerId)) {
        next.push({
          id: markerId,
          role: 'system',
          kind: 'steer-read-marker',
          timestamp: Date.now(),
          parts: [{ type: 'text', text: pickedUp.length === 1 ? 'Steer read here' : `${pickedUp.length} steers read here` }],
        })
      }
      continue
    }
    if (isCompactionEvent(raw)) {
      // Compaction changes the transcript shape (it closes the current
      // assistant turn and inserts a system activity row), so it applies to a
      // materialized transcript: flush the draft, apply the compaction policy,
      // and re-open drafting on the result.
      materializeDrafts()
      rebase(applyCompactionEvent(next, raw) ?? next)
      continue
    }
    if (type === 'agent_start' || type === 'turn_start') {
      // Gate on a streaming *assistant* to match the sequential reducer: a
      // compaction system row carried over from a previous batch may still be
      // streaming, yet a new turn must open a fresh assistant message.
      if (lastStreamingAssistant < 0 && resumeTailAssistant() === undefined) appendAssistant('assistant')
      continue
    }
    if (type === 'auto_retry_start') {
      // A provider auto-retry continues the turn that the preceding agent_end
      // finalized: reopen the tail assistant so the transcript keeps showing
      // work in progress through the backoff, and drop the empty-turn fallback
      // the finalize added so retried content does not stream in after it.
      if (lastStreamingAssistant < 0) {
        const resumed = resumeTailAssistant()
        if (resumed === undefined) appendAssistant('assistant')
        else dropTailFallback(resumed)
      }
      continue
    }
    if (type === 'message_update') {
      const delta = record(raw.assistantMessageEvent) ?? record(raw.delta)
      const deltaType = string(delta?.type)
      const text = string(delta?.delta) ?? ''
      if ((deltaType === 'text_delta' || deltaType === 'thinking_delta') && text) {
        const draft = draftParts(assistantIndex())
        const partType = deltaType === 'text_delta' ? 'text' : 'thinking'
        if (draft.tail?.part.type === partType) draft.tail.part = { ...draft.tail.part, text: draft.tail.part.text + text }
        else appendNode(draft, withPartId({ type: partType, text }))
      } else if (deltaType === 'toolcall_end') {
        const tool = record(delta?.toolCall)
        const name = string(tool?.name) ?? 'Tool'
        upsertToolDraft(assistantIndex(), effectiveToolId(string(tool?.id), name), name, tool?.arguments ?? tool?.args)
      }
      continue
    }
    if (type === 'tool_execution_start') {
      const name = string(raw.toolName) ?? 'Tool'
      upsertToolDraft(assistantIndex(), effectiveToolId(string(raw.toolCallId), name), name, raw.args)
      continue
    }
    if (type === 'tool_execution_update') {
      const index = assistantIndex()
      const name = string(raw.toolName) ?? 'Tool'
      const id = effectiveToolId(string(raw.toolCallId), name)
      upsertToolDraft(index, id, name, raw.args)
      const draft = draftParts(index)
      const call = draft.firstToolById.get(id)
      if (call) setToolResult(draft, call, { type: 'toolResult', name, text: resultText(raw.partialResult), streaming: true })
      continue
    }
    if (type === 'tool_execution_end') {
      const index = assistantIndex()
      const name = string(raw.toolName) ?? 'Tool'
      const id = effectiveToolId(string(raw.toolCallId), name)
      const draft = draftParts(index)
      const call = draft.firstToolById.get(id)
      const resultPart: MessagePart = { type: 'toolResult', name, text: resultText(raw.result), isError: raw.isError === true }
      if (call) setToolResult(draft, call, resultPart)
      else {
        appendNode(draft, withPartId({ type: 'toolCall', id, name }))
        appendNode(draft, withPartId(resultPart))
      }
      continue
    }
    if (type === 'custom_message') {
      const part = agentMessagePart(raw)
      if (part) appendNode(draftParts(assistantIndex()), withPartId(part))
      continue
    }
    if (type === 'agent_end') {
      finalizeStreaming(Date.now(), true)
      continue
    }
    if (type === 'model_change' || type === 'model_changed') {
      const fallback = fallbackModelFromRecord(raw)
      if (!fallback) continue
      const text = fallbackNoticeText(fallback.label)
      const last = next.at(-1)
      if (last?.role === 'system' && last.parts.length === 1 && last.parts[0]?.type === 'text' && last.parts[0].text === text) continue
      const timestamp = Date.now()
      finalizeStreaming(timestamp, false)
      copyTranscript()
      next.push({ id: nextTranscriptId('fallback'), role: 'system', timestamp, parts: [withPartId({ type: 'text', text })] })
      continue
    }
    if (type === 'extension_error' || type === 'error' || type === 'transport_error') {
      const text = string(raw.error) ?? string(raw.message) ?? 'Prime encountered an error.'
      finalizeStreaming(Date.now(), false)
      if (next.at(-1)?.role === 'system') continue
      copyTranscript()
      next.push({ id: nextTranscriptId('error'), role: 'system', timestamp: Date.now(), parts: [withPartId({ type: 'text', text })] })
      continue
    }
    if (type === 'runtime_exit') {
      finalizeStreaming(Date.now(), false)
      if (raw.expected === true || next.at(-1)?.role === 'system') continue
      const reason = raw.code !== null && raw.code !== undefined ? `exit code ${String(raw.code)}` : string(raw.signal) ?? 'an unknown error'
      copyTranscript()
      // Harness-neutral: this reducer serves both Prime Agent and OMP events.
      next.push({ id: nextTranscriptId('error'), role: 'system', timestamp: Date.now(), parts: [withPartId({ type: 'text', text: `The agent stopped unexpectedly (${reason}). Send the message again to restart it.` })] })
    }
  }

  materializeDrafts()
  return next
}

export interface PrimeEventBuffer {
  readonly size: number
  push(event: Record<string, unknown>): void
  replay(messages: TranscriptMessage[]): TranscriptMessage[]
}

export function createPrimeEventBuffer(): PrimeEventBuffer {
  const events: Record<string, unknown>[] = []
  return {
    get size() { return events.length },
    push(event) { events.push(event) },
    replay(messages) { return replayPrimeEvents(messages, events) },
  }
}

/**
 * Sequential application is a batch of one: there is exactly one reducer, so
 * single-event and batched replay cannot diverge for any event type.
 */
export function applyPrimeEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] {
  return replayPrimeEvents(messages, [raw])
}
