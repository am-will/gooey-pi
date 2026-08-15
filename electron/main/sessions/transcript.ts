import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { MessagePart, TranscriptMessage } from '../../../src/types/api'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from '../jsonl-limits'
import { strictJsonLines } from '../jsonl'
import { isRecord } from '../validation'
import type { JsonRecord } from './metadata'
import { parseGooeyPiAgentMessage } from '../collaboration/message-envelope'

const MAX_TRANSCRIPT_GRAPH_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_GRAPH_RECORDS = 10_000
const MAX_TRANSCRIPT_MESSAGES = 400
const MAX_TRANSCRIPT_PARTS = 2_000
const MAX_TRANSCRIPT_TEXT_CHARS = 1024 * 1024
const MAX_TRANSCRIPT_TOOL_CHARS = 512 * 1024
const MAX_TRANSCRIPT_ARGS_CHARS = 256 * 1024
const MAX_TRANSCRIPT_IMAGE_CHARS = 2 * 1024 * 1024
export const MAX_PART_TEXT_CHARS = 256 * 1024
const MAX_PART_TOOL_CHARS = 128 * 1024
const MAX_PART_ARGS_CHARS = 128 * 1024
const MAX_PART_IMAGE_CHARS = 2 * 1024 * 1024
const MAX_PARTS_PER_RECORD = 200
const TRUNCATION_MARKER = '\n… [truncated] …\n'

export function boundedString(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  if (max <= TRUNCATION_MARKER.length) return value.slice(-max)
  const available = max - TRUNCATION_MARKER.length
  const head = Math.floor(available / 3)
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(-(available - head))}`
}

export function textFromContent(content: unknown, max = MAX_PART_TEXT_CHARS): string {
  if (typeof content === 'string') return boundedString(content, max)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (!isRecord(part)) continue
    const addition = part.type === 'text' && typeof part.text === 'string' ? part.text
      : part.type === 'thinking' && typeof part.thinking === 'string' ? part.thinking : ''
    if (!addition) continue
    text += `${text ? '\n' : ''}${addition}`
    if (text.length > max) return boundedString(text, max)
  }
  return text
}

export function compactText(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function customActivityName(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).map((word) => word.toLowerCase() === 'ipython'
    ? 'IPython'
    : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ') || 'Activity'
}

export function validTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = new Date(value)
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString()
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return fallback
}

function roleOf(message: JsonRecord): TranscriptMessage['role'] {
  switch (message.role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'system': return 'system'
    default: return 'tool'
  }
}

function boundedArgs(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized.length <= MAX_PART_ARGS_CHARS ? value : boundedString(serialized, MAX_PART_ARGS_CHARS)
  } catch { return '[unserializable arguments]' }
}

function partsFromMessage(message: JsonRecord): MessagePart[] {
  const content = message.content
  const parts: MessagePart[] = []
  if (typeof content === 'string') parts.push({ type: 'text', text: boundedString(content, MAX_PART_TEXT_CHARS) })
  else if (Array.isArray(content)) {
    const selected = content.length <= MAX_PARTS_PER_RECORD ? content : [...content.slice(0, 20), ...content.slice(-(MAX_PARTS_PER_RECORD - 20))]
    for (const raw of selected) {
      if (!isRecord(raw) || typeof raw.type !== 'string') continue
      if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: boundedString(raw.text, MAX_PART_TEXT_CHARS) })
      else if (raw.type === 'thinking' && typeof raw.thinking === 'string') parts.push({ type: 'thinking', text: boundedString(raw.thinking, MAX_PART_TEXT_CHARS) })
      else if ((raw.type === 'toolCall' || raw.type === 'tool_call') && typeof raw.name === 'string') {
        parts.push({
          type: 'toolCall',
          id: typeof raw.id === 'string' ? boundedString(raw.id, 1_024) : undefined,
          name: boundedString(raw.name, 512),
          args: boundedArgs(raw.arguments ?? raw.args),
        })
      } else if (raw.type === 'image') {
        parts.push({
          type: 'image',
          mimeType: typeof raw.mimeType === 'string' ? boundedString(raw.mimeType, 128) : undefined,
          data: typeof raw.data === 'string' ? boundedString(raw.data, MAX_PART_IMAGE_CHARS) : undefined,
          dataTruncated: typeof raw.data === 'string' && raw.data.length > MAX_PART_IMAGE_CHARS || undefined,
        })
      }
    }
  }
  if (message.role === 'toolResult' || message.role === 'tool') {
    const text = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n')
    return [{
      type: 'toolResult',
      name: typeof message.toolName === 'string' ? boundedString(message.toolName, 512) : undefined,
      text: boundedString(text, MAX_PART_TOOL_CHARS),
      isError: message.isError === true,
    }]
  }
  if (message.role === 'bashExecution') {
    return [{
      type: 'toolResult',
      name: 'bash',
      text: typeof message.output === 'string' ? boundedString(message.output, MAX_PART_TOOL_CHARS) : '',
      isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
    }]
  }
  return parts.length ? parts : [{ type: 'text', text: '' }]
}

function boundedTranscript(transcript: TranscriptMessage[]): TranscriptMessage[] {
  let textBudget = MAX_TRANSCRIPT_TEXT_CHARS
  let toolBudget = MAX_TRANSCRIPT_TOOL_CHARS
  let argsBudget = MAX_TRANSCRIPT_ARGS_CHARS
  let imageBudget = MAX_TRANSCRIPT_IMAGE_CHARS
  let partBudget = MAX_TRANSCRIPT_PARTS
  const bounded: TranscriptMessage[] = []

  for (const message of transcript.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    const parts: MessagePart[] = []
    for (const part of [...message.parts].reverse()) {
      if (partBudget <= 0) break
      let next: MessagePart | undefined
      if (part.type === 'text' || part.type === 'thinking' || part.type === 'agentMessage') {
        if (textBudget > 0) {
          const text = boundedString(part.text, textBudget)
          textBudget -= text.length
          next = part.type === 'agentMessage'
            ? { ...part, text, agentName: part.agentName ? boundedString(part.agentName, 200) : undefined }
            : { ...part, text }
        }
      } else if (part.type === 'toolResult') {
        if (toolBudget > 0) {
          const text = boundedString(part.text, toolBudget)
          toolBudget -= text.length
          next = { ...part, text }
        }
      } else if (part.type === 'toolCall') {
        let args: unknown
        if (part.args !== undefined && argsBudget > 0) {
          const serialized = typeof part.args === 'string' ? part.args : JSON.stringify(part.args)
          if (serialized.length <= argsBudget) args = part.args
          else args = boundedString(serialized, argsBudget)
          argsBudget -= Math.min(serialized.length, argsBudget)
        }
        next = { ...part, args }
      } else if (part.type === 'compaction') {
        const boundedText = (value: string | undefined): string | undefined => {
          if (!value || textBudget <= 0) return undefined
          const text = boundedString(value, textBudget)
          textBudget -= text.length
          return text
        }
        next = {
          ...part,
          summary: boundedText(part.summary),
          error: boundedText(part.error),
          customInstructions: boundedText(part.customInstructions),
        }
      } else if (part.type === 'image') {
        let data: string | undefined
        if (part.data && imageBudget > 0) {
          data = boundedString(part.data, imageBudget)
          imageBudget -= Math.min(part.data.length, imageBudget)
        }
        next = { ...part, data, dataTruncated: part.dataTruncated || Boolean(part.data && data !== part.data) || undefined }
      }
      if (next) {
        parts.push(next)
        partBudget -= 1
      }
    }
    if (parts.length) bounded.push({ ...message, parts: parts.reverse() })
  }
  return bounded.reverse()
}

/**
 * Harness-specific transcript rendering over the shared branch machinery.
 * `isRenderable` selects which records enter the retained graph (and can be
 * selected as the active leaf); `renderEntry` renders retained record types the
 * shared walk does not handle itself (anything other than `message`,
 * `compaction`, and `custom_message`).
 */
export interface TranscriptDialect {
  isRenderable(entry: JsonRecord): boolean
  renderEntry?(entry: JsonRecord, safeId: string): TranscriptMessage | undefined
}

const primeTranscriptDialect: TranscriptDialect = {
  isRenderable: (entry) => entry.type === 'message' || entry.type === 'compaction'
    || (entry.type === 'custom_message' && entry.display === true),
}

export type TranscriptFileReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

export function createTranscriptReader(dialect: TranscriptDialect = primeTranscriptDialect): TranscriptFileReader {
  return (filePath, isStreaming) => readTranscriptWithDialect(dialect, filePath, isStreaming)
}

async function readTranscriptWithDialect(dialect: TranscriptDialect, filePath: string, isStreaming: boolean): Promise<TranscriptMessage[]> {
  if ((await stat(filePath)).size > 256 * 1024 * 1024) throw new Error('Session transcript is too large to display')
  const entries = new Map<string, { id: string; parentId: string | null; entry: JsonRecord; bytes: number }>()
  // A light id→parentId edge map covers every record, so the parent-chain walk
  // still traverses nodes that never render (and never charge the budgets).
  const parentEdges = new Map<string, string | null>()
  let graphBytes = 0
  let leafId: string | null = null
  let recordCount = 0
  // The metadata reader of the same file MUST share this per-record tolerance:
  // a record the catalog accepts must never make the transcript unopenable.
  for await (const line of strictJsonLines(createReadStream(filePath), SESSION_FILE_RECORD_LIMIT_BYTES)) {
    if (!line) continue
    if (++recordCount > 200_000) throw new Error('Session transcript has too many records')
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isRecord(entry) || entry.type === 'session' || typeof entry.id !== 'string' || entry.id.length > 1_024) continue
    const parentId = typeof entry.parentId === 'string' && entry.parentId.length <= 1_024 ? entry.parentId : null
    parentEdges.delete(entry.id)
    parentEdges.set(entry.id, parentId)
    while (parentEdges.size > MAX_TRANSCRIPT_GRAPH_RECORDS * 4) {
      const oldestEdge = parentEdges.keys().next().value as string | undefined
      if (oldestEdge === undefined) break
      parentEdges.delete(oldestEdge)
    }
    if (!dialect.isRenderable(entry)) continue
    const existing = entries.get(entry.id)
    if (existing) {
      graphBytes -= existing.bytes
      entries.delete(entry.id)
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    entries.set(entry.id, { id: entry.id, parentId, entry, bytes })
    graphBytes += bytes
    // The leaf is the last *renderable* record: a trailing non-renderable
    // record (for example one with parentId: null) must not select the branch.
    leafId = entry.id
    while (entries.size > MAX_TRANSCRIPT_GRAPH_RECORDS || graphBytes > MAX_TRANSCRIPT_GRAPH_BYTES) {
      const oldestId = entries.keys().next().value as string | undefined
      if (oldestId === undefined) break
      graphBytes -= entries.get(oldestId)?.bytes ?? 0
      entries.delete(oldestId)
    }
  }
  const walkBranch = (startId: string | null): Array<{ id: string; entry: JsonRecord }> => {
    const collected: Array<{ id: string; entry: JsonRecord }> = []
    const visited = new Set<string>()
    let currentId = startId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const node = entries.get(currentId)
      if (node) collected.push(node)
      currentId = parentEdges.get(currentId) ?? null
    }
    return collected
  }
  let branch = walkBranch(leafId)
  if (!branch.length && entries.size) {
    // The active branch dead-ended before reaching any retained record; fall
    // back to the most recently retained renderable record instead of
    // rendering an empty transcript.
    let fallbackId: string | null = null
    for (const id of entries.keys()) fallbackId = id
    branch = walkBranch(fallbackId)
  }
  branch.reverse()
  const transcript: TranscriptMessage[] = []
  let activeAssistant: TranscriptMessage | undefined
  // First toolCall part index per id for the active turn: tool results resolve
  // their call in O(1) instead of scanning the accumulated parts.
  let toolCallIndexById = new Map<string, number>()
  const beginAssistantTurn = (): void => { toolCallIndexById = new Map() }
  const registerToolCalls = (startIndex: number, added: MessagePart[]): void => {
    for (let offset = 0; offset < added.length; offset += 1) {
      const part = added[offset]
      if (part.type === 'toolCall' && part.id !== undefined && !toolCallIndexById.has(part.id)) {
        toolCallIndexById.set(part.id, startIndex + offset)
      }
    }
  }
  const appendAssistantParts = (added: MessagePart[]): void => {
    if (!activeAssistant) return
    registerToolCalls(activeAssistant.parts.length, added)
    activeAssistant.parts.push(...added)
  }
  for (const { id, entry } of branch) {
    const safeId = boundedString(id, 1_024)
    if (entry.type === 'compaction') {
      const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
      const tokensBefore = typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : undefined
      const summary = typeof entry.summary === 'string' ? boundedString(entry.summary, MAX_PART_TEXT_CHARS) : undefined
      const firstKeptEntryId = typeof entry.firstKeptEntryId === 'string' ? boundedString(entry.firstKeptEntryId, 1_024) : undefined
      const customInstructions = typeof entry.customInstructions === 'string' ? boundedString(entry.customInstructions, MAX_PART_TEXT_CHARS) : undefined
      transcript.push({
        id: safeId,
        role: 'system',
        timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        parts: [{ type: 'compaction', status: 'done', tokensBefore, summary, firstKeptEntryId, customInstructions }],
      })
      activeAssistant = undefined
      continue
    }
    if (entry.type === 'custom_message') {
      const details = isRecord(entry.details) ? entry.details : undefined
      const from = isRecord(details?.from) ? details.from : undefined
      const customType = typeof entry.customType === 'string' ? boundedString(entry.customType, 200) : 'activity'
      if (customType === 'compaction_outcome') {
        const outcome = details?.outcome === 'cancelled' ? 'cancelled' : details?.outcome === 'skipped' ? 'skipped' : 'failed'
        const reason = details?.reason === 'manual' || details?.reason === 'threshold' || details?.reason === 'overflow' || details?.reason === 'requested'
          ? details.reason
          : undefined
        const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
        const text = boundedString(textFromContent(entry.content), MAX_PART_TEXT_CHARS)
        transcript.push({
          id: safeId,
          role: 'system',
          timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          parts: [{ type: 'compaction', status: outcome === 'cancelled' ? 'cancelled' : 'failed', outcome, reason, error: text }],
        })
        activeAssistant = undefined
        continue
      }
      const isAgentMessage = customType === 'agent_message'
      const isGoalSummary = customType === 'goal_context'
      const detailMessage = typeof details?.message === 'string' ? details.message : undefined
      const goalObjective = typeof details?.objective === 'string' ? details.objective : undefined
      const agentName = typeof from?.sessionName === 'string' ? boundedString(from.sessionName, 200) : undefined
      const readableText = isGoalSummary ? goalObjective ?? detailMessage : detailMessage
      const text = boundedString(readableText ?? textFromContent(entry.content), MAX_PART_TEXT_CHARS)
      const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
      if (isAgentMessage && activeAssistant) {
        appendAssistantParts([{ type: 'agentMessage', text, agentName }])
        activeAssistant.completedAt = timestamp ?? activeAssistant.completedAt
      } else if (!isAgentMessage && !isGoalSummary && activeAssistant) {
        const name = customActivityName(customType)
        appendAssistantParts([{ type: 'toolCall', id: safeId, name }, { type: 'toolResult', name, text }])
        activeAssistant.completedAt = timestamp ?? activeAssistant.completedAt
      } else {
        const name = customActivityName(customType)
        transcript.push({
          id: safeId,
          role: isAgentMessage ? 'agent' : isGoalSummary ? 'goal' : 'tool',
          timestamp,
          agentName: isAgentMessage ? agentName : undefined,
          parts: isAgentMessage || isGoalSummary
            ? [{ type: 'text', text }]
            : [{ type: 'toolCall', id: safeId, name }, { type: 'toolResult', name, text }],
        })
        activeAssistant = undefined
      }
      continue
    }
    if (entry.type !== 'message') {
      // A dialect-specific record type reached the walk; render it standalone.
      const rendered = dialect.renderEntry?.(entry, safeId)
      if (rendered) transcript.push(rendered)
      activeAssistant = undefined
      continue
    }
    const message = isRecord(entry.message) ? entry.message : {}
    const collaborationMessage = message.role === 'user' ? parseGooeyPiAgentMessage(textFromContent(message.content)) : undefined
    if (collaborationMessage) {
      const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp
        : typeof entry.timestamp === 'string' ? entry.timestamp : undefined
      transcript.push({
        id: safeId,
        role: 'agent',
        timestamp: typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp,
        agentName: collaborationMessage.fromTitle ? boundedString(collaborationMessage.fromTitle, 200) : undefined,
        parts: [{ type: 'text', text: boundedString(collaborationMessage.text, MAX_PART_TEXT_CHARS) }],
      })
      activeAssistant = undefined
      continue
    }
    const role = roleOf(message)
    const entryTimestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
    const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp
      : entryTimestamp
    const timestamp = typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp
    // The message timestamp marks assistant start; the enclosing entry
    // timestamp marks persistence/completion.
    const completedAt = entryTimestamp ?? timestamp
    const parts = partsFromMessage(message)
    if (role === 'tool' && activeAssistant) {
      const toolCallId = typeof message.toolCallId === 'string' ? boundedString(message.toolCallId, 1_024) : undefined
      const callIndex = toolCallId !== undefined ? toolCallIndexById.get(toolCallId) ?? -1 : -1
      if (callIndex >= 0) {
        activeAssistant.parts.splice(callIndex + 1, 0, ...parts)
        for (const [callId, index] of toolCallIndexById) {
          if (index > callIndex) toolCallIndexById.set(callId, index + parts.length)
        }
        registerToolCalls(callIndex + 1, parts)
      } else appendAssistantParts(parts)
      activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt
      continue
    }
    if (role === 'assistant') {
      if (activeAssistant) {
        appendAssistantParts(parts)
        activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt
      } else {
        beginAssistantTurn()
        registerToolCalls(0, parts)
        activeAssistant = { id: safeId, role, timestamp, startedAt: timestamp, completedAt, parts }
        transcript.push(activeAssistant)
      }
      continue
    }
    const item: TranscriptMessage = { id: safeId, role, timestamp, parts }
    transcript.push(item)
    activeAssistant = undefined
  }
  if (isStreaming && activeAssistant) { activeAssistant.streaming = true; activeAssistant.completedAt = undefined }
  return boundedTranscript(transcript)
}

export const readTranscript: TranscriptFileReader = createTranscriptReader()
