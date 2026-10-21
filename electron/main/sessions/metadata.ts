import { compactText } from '../../../src/lib/text'
import { createReadStream, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import type { SessionRecord, SessionStatus } from '../../../src/types/api'
import { SESSION_FILE_MAX_BYTES, SESSION_FILE_MAX_RECORDS, SESSION_FILE_RECORD_LIMIT_BYTES } from '../jsonl-limits'
import { isRecord } from '../validation'
import { textFromContent, validTimestamp } from './transcript'

export type JsonRecord = Record<string, unknown>

/** Per-file metadata snapshot; the owning SessionService stamps the harness when it builds SessionRecords. */
export interface SessionMetadata extends Omit<SessionRecord, 'harness'> { hasRunningRlmChildren?: boolean }

export class SessionFileLimitError extends Error {}
// The transcript reader of the same file MUST share this per-record tolerance.
const MAX_METADATA_RECORD_BYTES = SESSION_FILE_RECORD_LIMIT_BYTES
const MAX_TRACKED_METADATA_STATES = 5_000
export const METADATA_VERIFY_TAIL_BYTES = 4_096
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

export function statusFrom(
  taskState: string | undefined,
  lifecycle: string | undefined,
  lastRole: string | undefined,
  stopReason: string | undefined,
): SessionStatus {
  if (lifecycle === 'crash') return 'failed'
  if (lifecycle === 'archived') return 'complete'
  if (taskState === 'completed') return 'complete'
  if (taskState === 'needs_input') return 'waiting'
  if (stopReason === 'error') return 'failed'
  if (lastRole === 'assistant' || lastRole === 'toolResult') return 'complete'
  if (lastRole === 'user') return 'idle'
  return 'unknown'
}

export function applyLiveMetadata(metadata: SessionMetadata, live: JsonRecord): void {
  const active = live.isSessionActive !== false
  metadata.hasRunningRlmChildren = live.hasRunningRlmChildren === true || live.hasRunningSubagents === true
  if (live.workerState === 'failed') metadata.status = 'failed'
  else if (metadata.hasRunningRlmChildren || (active && (live.isStreaming === true || live.activity === 'working' || live.isCompacting === true))) metadata.status = 'running'
  else if (live.lifecycle === 'archived') metadata.status = 'complete'
  else if (live.taskState === 'completed') metadata.status = 'complete'
  else if (live.taskState === 'needs_input') metadata.status = 'waiting'
  else metadata.status = 'idle'
  if (typeof live.sessionName === 'string' && live.sessionName.trim()) metadata.title = compactText(live.sessionName, 100)
  if (typeof live.thinkingLevel === 'string') metadata.thinkingLevel = live.thinkingLevel
  if (typeof live.rlmDepth === 'number' && Number.isInteger(live.rlmDepth) && live.rlmDepth >= 0) metadata.depth = live.rlmDepth
  if (typeof live.modified === 'string') {
    const liveModified = Date.parse(live.modified)
    const jsonlModified = Date.parse(metadata.updatedAt)
    if (Number.isFinite(liveModified) && (!Number.isFinite(jsonlModified) || liveModified > jsonlModified)) {
      metadata.updatedAt = new Date(liveModified).toISOString()
    }
  }
  if (isRecord(live.model)) {
    if (typeof live.model.id === 'string') metadata.model = live.model.id
    if (typeof live.model.provider === 'string') metadata.provider = live.model.provider
  }
}

interface MetadataAccumulator extends BaseMetadataAccumulator {
  depth: number
  sessionName?: string
  lifecycle?: string
  taskState?: string
  taskStateBasedOnMessageCount?: number
  messageCount: number
}

function createAccumulator(filePath: string, fileStat: Stats): MetadataAccumulator {
  return {
    id: basename(filePath, '.jsonl'),
    projectPath: '',
    createdAt: fileStat.birthtime.toISOString(),
    updatedAt: fileStat.mtime.toISOString(),
    sawRecordTimestamp: false,
    depth: 0,
    firstUser: '',
    preview: '',
    messageCount: 0,
    records: 0,
  }
}

/** The subset of accumulator state that `message` records update, shared by every session dialect. */
export interface MessageActivityAccumulator {
  createdAt: string
  lastUserMessageAt?: string
  firstUser: string
  preview: string
  lastRole?: string
  stopReason?: string
}

export function ingestMessageActivity(state: MessageActivityAccumulator, record: JsonRecord): void {
  if (!isRecord(record.message)) return
  const message = record.message
  if (typeof message.role === 'string') state.lastRole = message.role
  if (typeof message.stopReason === 'string') state.stopReason = message.stopReason
  // Previews and first prompts show only visible text, never model reasoning.
  // Retained parse state only ever feeds one-line clips, so compact once here.
  const text = compactText(textFromContent(message.content, 4_096, { includeThinking: false }))
  if (message.role === 'user') {
    if (!state.firstUser && text) state.firstUser = text
    state.lastUserMessageAt = validTimestamp(message.timestamp, validTimestamp(record.timestamp, state.lastUserMessageAt ?? state.createdAt))
  }
  if ((message.role === 'assistant' || message.role === 'user') && text) state.preview = text
}

export interface BaseMetadataAccumulator extends MessageActivityAccumulator {
  id: string
  projectPath: string
  updatedAt: string
  sawRecordTimestamp: boolean
  model?: string
  provider?: string
  thinkingLevel?: string
  records: number
}

export function parseMetadataRecord(state: BaseMetadataAccumulator, line: string): JsonRecord | undefined {
  if (!line) return
  if (++state.records > SESSION_FILE_MAX_RECORDS) throw new SessionFileLimitError('Session file has too many records')
  let value: unknown
  try { value = JSON.parse(line) } catch { return }
  if (!isRecord(value)) return
  const timestamp = validTimestamp(value.timestamp, '')
  if (timestamp) { state.updatedAt = timestamp; state.sawRecordTimestamp = true }
  return value
}

export function ingestCommonRecord(state: BaseMetadataAccumulator, record: JsonRecord): void {
  if (record.type === 'session') {
    if (typeof record.id === 'string') state.id = record.id
    if (typeof record.cwd === 'string') state.projectPath = record.cwd
    state.createdAt = validTimestamp(record.timestamp, state.createdAt)
  } else if (record.type === 'thinking_level_change' && typeof record.thinkingLevel === 'string') state.thinkingLevel = record.thinkingLevel
  else if (record.type === 'message') ingestMessageActivity(state, record)
}

export function ingestSplitModelChange(state: BaseMetadataAccumulator, record: JsonRecord): void {
  if (typeof record.modelId === 'string') state.model = record.modelId
  if (typeof record.provider === 'string') state.provider = record.provider
}

export function sessionTitle(name: string | undefined, firstUser: string): string {
  return compactText(name ?? '', 100) || compactText(firstUser, 100) || 'Untitled session'
}

function ingestMetadataLine(state: MetadataAccumulator, line: string): void {
  const value = parseMetadataRecord(state, line)
  if (!value) return
  ingestCommonRecord(state, value)
  if (value.type === 'session') {
    if (typeof value.rlmDepth === 'number' && Number.isInteger(value.rlmDepth) && value.rlmDepth >= 0) state.depth = value.rlmDepth
    else if (typeof value.parentSession === 'string') state.depth = 1
  } else if (value.type === 'model_change') ingestSplitModelChange(state, value)
  else if (value.type === 'session_info' && typeof value.name === 'string') state.sessionName = compactText(value.name, 100)
  else if (value.type === 'session_state' && isRecord(value.state) && typeof value.state.status === 'string') state.lifecycle = value.state.status
  else if (value.type === 'agent_status' && isRecord(value.status)) {
    state.taskState = typeof value.status.taskState === 'string' ? value.status.taskState : undefined
    state.taskStateBasedOnMessageCount = typeof value.status.basedOnMessageCount === 'number'
      ? value.status.basedOnMessageCount
      : undefined
  } else if (value.type === 'message') state.messageCount += 1
}

function metadataFromAccumulator(state: MetadataAccumulator, filePath: string, fallbackUpdated: string): SessionMetadata {
  const title = sessionTitle(state.sessionName, state.firstUser)
  // Prime verdicts describe exactly the message count they were generated from.
  const taskState = typeof state.taskStateBasedOnMessageCount !== 'number'
    || state.taskStateBasedOnMessageCount === state.messageCount
    ? state.taskState
    : undefined
  return {
    id: state.id,
    filePath,
    projectPath: state.projectPath,
    title,
    createdAt: state.createdAt,
    updatedAt: state.sawRecordTimestamp ? state.updatedAt : fallbackUpdated,
    lastUserMessageAt: state.lastUserMessageAt ?? state.createdAt,
    status: statusFrom(taskState, state.lifecycle, state.lastRole, state.stopReason),
    model: state.model,
    provider: state.provider,
    thinkingLevel: state.thinkingLevel,
    depth: state.depth,
    pinned: false,
    unread: false,
    preview: compactText(state.preview || state.firstUser),
  }
}

interface IncrementalMetadataState<Accumulator> {
  size: number
  mtimeMs: number
  /** LF-free fragments of the final line, concatenated once when it completes. */
  pendingChunks: Buffer[]
  pendingBytes: number
  /** Last raw bytes of the parsed range, re-read and compared before resuming. */
  tail: Buffer
  accumulator: Accumulator
}

export interface SessionMetadataReaderIo {
  inspect(path: string): Promise<Stats>
  /** Opens a byte-range read of `[start, end]` (inclusive), mirroring createReadStream. */
  openStream(path: string, start: number, end: number): Readable
}

export const nodeMetadataReaderIo: SessionMetadataReaderIo = {
  inspect: stat,
  openStream: (path, start, end) => createReadStream(path, { start, end }),
}

/**
 * Harness-specific JSONL metadata parsing over the shared incremental
 * machinery: the accumulator must be a flat object so a shallow spread yields
 * an independent copy for speculative and resumed parses.
 */
export interface MetadataLineParser<Accumulator> {
  createAccumulator(filePath: string, fileStat: Stats): Accumulator
  ingestLine(accumulator: Accumulator, line: string): void
  snapshot(accumulator: Accumulator, filePath: string, fallbackUpdated: string): SessionMetadata
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function lastBytes(data: Buffer, max: number): Buffer {
  return data.length <= max ? data : Buffer.from(data.subarray(data.length - max))
}

function ingestBytes<Accumulator extends object>(parser: MetadataLineParser<Accumulator>, state: IncrementalMetadataState<Accumulator>, bytes: Buffer): void {
  state.tail = state.tail.length + bytes.length <= METADATA_VERIFY_TAIL_BYTES
    ? Buffer.concat([state.tail, bytes])
    : lastBytes(bytes.length >= METADATA_VERIFY_TAIL_BYTES ? bytes : Buffer.concat([state.tail, bytes]), METADATA_VERIFY_TAIL_BYTES)
  let start = 0
  while (true) {
    const newline = bytes.indexOf(LINE_FEED, start)
    if (newline < 0) break
    let line: Buffer
    if (state.pendingBytes) {
      if (state.pendingBytes + newline > MAX_METADATA_RECORD_BYTES) throw new SessionFileLimitError('JSONL record exceeded the maximum frame size')
      state.pendingChunks.push(bytes.subarray(0, newline))
      line = Buffer.concat(state.pendingChunks, state.pendingBytes + newline)
      state.pendingChunks = []
      state.pendingBytes = 0
    } else {
      if (newline - start > MAX_METADATA_RECORD_BYTES) throw new SessionFileLimitError('JSONL record exceeded the maximum frame size')
      line = bytes.subarray(start, newline)
    }
    const end = line.length && line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length
    parser.ingestLine(state.accumulator, line.toString('utf8', 0, end))
    start = newline + 1
  }
  if (start === bytes.length) return
  if (state.pendingBytes + bytes.length - start > MAX_METADATA_RECORD_BYTES) throw new SessionFileLimitError('JSONL record exceeded the maximum frame size')
  state.pendingChunks.push(Buffer.from(bytes.subarray(start)))
  state.pendingBytes += bytes.length - start
}

function snapshotState<Accumulator extends object>(parser: MetadataLineParser<Accumulator>, state: IncrementalMetadataState<Accumulator>, filePath: string, fallbackUpdated: string): SessionMetadata {
  if (!state.pendingBytes) return parser.snapshot(state.accumulator, filePath, fallbackUpdated)
  // A full stream read parses the final unterminated line; fold it into a
  // speculative copy so incremental snapshots stay identical without
  // committing a partial record to the retained parse state.
  const speculative = { ...state.accumulator }
  parser.ingestLine(speculative, trimTrailingCarriageReturn(Buffer.concat(state.pendingChunks, state.pendingBytes).toString('utf8')))
  return parser.snapshot(speculative, filePath, fallbackUpdated)
}

async function ingestRange<Accumulator extends object>(io: SessionMetadataReaderIo, parser: MetadataLineParser<Accumulator>, state: IncrementalMetadataState<Accumulator>, filePath: string, start: number, end: number): Promise<void> {
  if (end <= start) {
    state.size = end
    return
  }
  const stream = io.openStream(filePath, start, end - 1)
  try {
    for await (const chunk of stream) {
      ingestBytes(parser, state, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer)
    }
  } finally {
    stream.destroy()
  }
  state.size = end
}

export type SessionMetadataReader = (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>

/**
 * Creates a metadata reader that caches per-file parse state: appends read only
 * the new byte range plus the retained tail, which is verified byte-for-byte
 * before the parse resumes. Truncation, tail mismatch, or a same-size rewrite
 * fall back to a full re-read. `reservedHeaderBytes` excludes a fixed-width
 * mutable prefix (for example the OMP title slot) from the incremental parse:
 * the caller re-reads that prefix itself on every snapshot.
 */
export function createIncrementalMetadataReader<Accumulator extends object>(
  parser: MetadataLineParser<Accumulator>,
  io: SessionMetadataReaderIo = nodeMetadataReaderIo,
  reservedHeaderBytes = 0,
): SessionMetadataReader {
  const states = new Map<string, IncrementalMetadataState<Accumulator>>()
  const locks = new Map<string, Promise<unknown>>()

  const remember = (filePath: string, state: IncrementalMetadataState<Accumulator>): void => {
    states.delete(filePath)
    states.set(filePath, state)
    while (states.size > MAX_TRACKED_METADATA_STATES) {
      const oldest = states.keys().next().value as string | undefined
      if (oldest === undefined) break
      states.delete(oldest)
    }
  }

  const fullRead = async (filePath: string, fileStat: Stats): Promise<SessionMetadata> => {
    const state: IncrementalMetadataState<Accumulator> = {
      size: 0,
      mtimeMs: fileStat.mtimeMs,
      pendingChunks: [],
      pendingBytes: 0,
      tail: Buffer.alloc(0),
      accumulator: parser.createAccumulator(filePath, fileStat),
    }
    await ingestRange(io, parser, state, filePath, Math.min(reservedHeaderBytes, fileStat.size), fileStat.size)
    remember(filePath, state)
    return snapshotState(parser, state, filePath, fileStat.mtime.toISOString())
  }

  const perform = async (filePath: string, knownStat?: Stats): Promise<SessionMetadata> => {
    let fileStat: Stats
    try {
      fileStat = knownStat ?? await io.inspect(filePath)
    } catch (error) {
      states.delete(filePath)
      throw error
    }
    if (fileStat.size > SESSION_FILE_MAX_BYTES) {
      states.delete(filePath)
      throw new SessionFileLimitError('Session file is too large')
    }
    const state = states.get(filePath)
    if (state && fileStat.size === state.size && fileStat.mtimeMs === state.mtimeMs) {
      remember(filePath, state)
      return snapshotState(parser, state, filePath, fileStat.mtime.toISOString())
    }
    if (state && fileStat.size > state.size) {
      try {
        const verified = state.tail
        const verifyStart = state.size - verified.length
        const resumed: IncrementalMetadataState<Accumulator> = {
          size: state.size,
          mtimeMs: fileStat.mtimeMs,
          pendingChunks: [...state.pendingChunks],
          pendingBytes: state.pendingBytes,
          tail: state.tail,
          accumulator: { ...state.accumulator },
        }
        let verifiedBytes = 0
        let mismatch = false
        const stream = io.openStream(filePath, verifyStart, fileStat.size - 1)
        try {
          for await (const raw of stream) {
            let chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw as Buffer
            if (verifiedBytes < verified.length) {
              const compare = Math.min(verified.length - verifiedBytes, chunk.length)
              if (!chunk.subarray(0, compare).equals(verified.subarray(verifiedBytes, verifiedBytes + compare))) {
                mismatch = true
                break
              }
              verifiedBytes += compare
              chunk = chunk.subarray(compare)
            }
            if (chunk.length) ingestBytes(parser, resumed, chunk)
          }
        } finally {
          stream.destroy()
        }
        if (!mismatch && verifiedBytes === verified.length) {
          resumed.size = fileStat.size
          remember(filePath, resumed)
          return snapshotState(parser, resumed, filePath, fileStat.mtime.toISOString())
        }
      } catch (error) {
        if (error instanceof SessionFileLimitError) {
          states.delete(filePath)
          throw error
        }
        // A failed range read (rotation, permissions) falls through to a full read.
      }
    }
    try {
      return await fullRead(filePath, fileStat)
    } catch (error) {
      states.delete(filePath)
      throw error
    }
  }

  return (filePath, knownStat) => {
    const previous = locks.get(filePath) ?? Promise.resolve()
    const run = previous.then(() => perform(filePath, knownStat), () => perform(filePath, knownStat))
    const settled = run.then(() => undefined, () => undefined)
    locks.set(filePath, settled)
    void settled.then(() => { if (locks.get(filePath) === settled) locks.delete(filePath) })
    return run
  }
}

const primeMetadataParser: MetadataLineParser<MetadataAccumulator> = {
  createAccumulator,
  ingestLine: ingestMetadataLine,
  snapshot: metadataFromAccumulator,
}

export function createSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  return createIncrementalMetadataReader(primeMetadataParser, io)
}
