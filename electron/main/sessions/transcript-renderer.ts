import type { MessagePart, TranscriptGeneration, TranscriptMessage } from '../../../src/types/api'
import { isCompactionReason } from '../../../src/lib/compaction-reason'
import { parseResponseGeneration } from '../../../src/lib/usage'
import { SESSION_FILE_MAX_RECORDS } from '../jsonl-limits'
import { isRecord } from '../validation'
import type { JsonRecord } from './metadata'
import { parseGooeyPiAgentMessage } from '../collaboration/message-envelope'
import { providerErrorDetail } from '../agent-rpc/limits'
import { boundedEntryTimestamp, systemNotice, boundedString, textFromContent, MAX_PART_TEXT_CHARS, type TranscriptDialect } from './transcript'

const MAX_TRANSCRIPT_GRAPH_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_GRAPH_RECORDS = 10_000
const MAX_TRANSCRIPT_MESSAGES = 400
const MAX_TRANSCRIPT_PARTS = 2_000
const MAX_TRANSCRIPT_TEXT_CHARS = 1024 * 1024
const MAX_TRANSCRIPT_TOOL_CHARS = 512 * 1024
const MAX_TRANSCRIPT_ARGS_CHARS = 256 * 1024
const MAX_TRANSCRIPT_IMAGE_CHARS = 2 * 1024 * 1024
const MAX_PART_TOOL_CHARS = 128 * 1024
const MAX_PART_ARGS_CHARS = 128 * 1024
const MAX_PART_IMAGE_CHARS = 2 * 1024 * 1024
const MAX_PARTS_PER_RECORD = 200

function customActivityName(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).map((word) => word.toLowerCase() === 'ipython'
    ? 'IPython'
    : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ') || 'Activity'
}

/** A turn spans several harness responses; their output and response time add up. */
function addGeneration(turn: TranscriptMessage, response: TranscriptGeneration | undefined): void {
  if (!response) return
  const total = turn.generation
  turn.generation = total ? { outputTokens: total.outputTokens + response.outputTokens, durationMs: total.durationMs + response.durationMs } : response
}

function roleOf(message: JsonRecord): TranscriptMessage['role'] {
  switch (message.role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    default: return 'tool'
  }
}

/**
 * Pi 1.3 persists its model-facing system prompt and tool loadout as `system`
 * messages, at session start and whenever the loadout changes. Like Pi's own
 * views, the transcript renders none of them, whatever the dialect admits.
 */
function isSystemPromptSnapshot(entry: JsonRecord): boolean {
  return entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'system'
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

/** The system row naming the provider error an assistant message ended with; undefined for any other message. */
function providerErrorRow(message: JsonRecord, id: string, timestamp: TranscriptMessage['timestamp']): TranscriptMessage | undefined {
  const error = providerErrorDetail(message)
  return error === undefined ? undefined : { id: `${id}:error`, role: 'system', timestamp, parts: [{ type: 'text', text: error }] }
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

export async function renderTranscriptLines(lines: AsyncIterable<string>, isStreaming = false, dialect: TranscriptDialect): Promise<TranscriptMessage[]> {
  const entries = new Map<string, { id: string; parentId: string | null; entry: JsonRecord; bytes: number }>()
  // A light id→parentId edge map covers every record, so the parent-chain walk
  // still traverses nodes that never render (and never charge the budgets).
  const parentEdges = new Map<string, string | null>()
  let graphBytes = 0
  let leafId: string | null = null
  let recordCount = 0
  // The metadata reader of the same file MUST share this per-record tolerance:
  // a record the catalog accepts must never make the transcript unopenable.
  for await (const line of lines) {
    if (!line) continue
    if (++recordCount > SESSION_FILE_MAX_RECORDS) throw new Error('Session transcript has too many records')
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
    if (isSystemPromptSnapshot(entry) || !dialect.isRenderable(entry)) continue
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
  // A provider error ended its turn only when the next record is a user
  // message or the end of the session. A retry, a compaction or any later
  // output in between means the agent recovered from it.
  let failedTurn: TranscriptMessage | undefined
  for (const { id, entry } of branch) {
    const safeId = boundedString(id, 1_024)
    if (failedTurn) {
      if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user') transcript.push(failedTurn)
      failedTurn = undefined
    }
    if (entry.type === 'compaction') {
      // Pi, OMP and both Prime builds persist no trigger with a completed
      // compaction, so the row names no reason; only a Prime
      // compaction_outcome row below records one.
      const tokensBefore = typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : undefined
      const summary = typeof entry.summary === 'string' ? boundedString(entry.summary, MAX_PART_TEXT_CHARS) : undefined
      const firstKeptEntryId = typeof entry.firstKeptEntryId === 'string' ? boundedString(entry.firstKeptEntryId, 1_024) : undefined
      const customInstructions = typeof entry.customInstructions === 'string' ? boundedString(entry.customInstructions, MAX_PART_TEXT_CHARS) : undefined
      transcript.push(systemNotice(entry, safeId, [{ type: 'compaction', status: 'done', tokensBefore, summary, firstKeptEntryId, customInstructions }]))
      activeAssistant = undefined
      continue
    }
    if (entry.type === 'custom_message') {
      const details = isRecord(entry.details) ? entry.details : undefined
      const from = isRecord(details?.from) ? details.from : undefined
      const customType = typeof entry.customType === 'string' ? boundedString(entry.customType, 200) : 'activity'
      if (customType === 'compaction_outcome') {
        const outcome = details?.outcome === 'cancelled' ? 'cancelled' : details?.outcome === 'skipped' ? 'skipped' : 'failed'
        const reason = isCompactionReason(details?.reason) ? details.reason : undefined
        const text = boundedString(textFromContent(entry.content), MAX_PART_TEXT_CHARS)
        transcript.push(systemNotice(entry, safeId, [{ type: 'compaction', status: outcome === 'cancelled' ? 'cancelled' : 'failed', outcome, reason, error: text }]))
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
      const timestamp = boundedEntryTimestamp(entry)
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
    // Messages start at their own timestamp; the enclosing entry is persisted at completion.
    const entryTimestamp = boundedEntryTimestamp(entry)
    const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp : entryTimestamp
    const timestamp = typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp
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
      addGeneration(activeAssistant, parseResponseGeneration(message, entryTimestamp))
      failedTurn = providerErrorRow(message, safeId, completedAt)
      continue
    }
    const item: TranscriptMessage = { id: safeId, role, timestamp, parts }
    transcript.push(item)
    activeAssistant = undefined
  }
  if (isStreaming && activeAssistant) { activeAssistant.streaming = true; activeAssistant.completedAt = undefined }
  // While the session still streams, the agent may yet retry the failed call.
  else if (failedTurn) transcript.push(failedTurn)
  return boundedTranscript(transcript)
}
