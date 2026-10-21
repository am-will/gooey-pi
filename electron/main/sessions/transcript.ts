import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { TranscriptMessage } from '../../../src/types/api'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from '../jsonl-limits'
import { strictJsonLines } from '../jsonl'
import { isRecord } from '../validation'
import type { JsonRecord } from './metadata'

export const MAX_PART_TEXT_CHARS = 256 * 1024
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

export function validTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = new Date(value)
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString()
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return fallback
}

/**
 * Harness-specific transcript rendering over the shared branch machinery.
 * `isRenderable` selects which records enter the retained graph (and can be
 * selected as the active leaf); `renderEntry` renders retained record types the
 * shared walk does not handle itself (anything other than `message`,
 * `compaction`, and `custom_message`). The walk skips system prompt snapshots
 * before asking the dialect.
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
  return renderTranscriptLines(strictJsonLines(createReadStream(filePath), SESSION_FILE_RECORD_LIMIT_BYTES), isStreaming, dialect)
}

export async function renderTranscriptLines(lines: AsyncIterable<string>, isStreaming = false, dialect: TranscriptDialect = primeTranscriptDialect): Promise<TranscriptMessage[]> {
  const renderer = await import('./transcript-renderer')
  return renderer.renderTranscriptLines(lines, isStreaming, dialect)
}

export const readTranscript: TranscriptFileReader = createTranscriptReader()
