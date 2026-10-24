import type { PrimeContextUsage, SessionUsage, SessionUsageTokens, TranscriptGeneration } from '../types/api'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

/** Strict harness context counts; explicit nulls mean the harness cannot measure them. */
export function parseContextUsage(raw: unknown): PrimeContextUsage | null {
  if (!isRecord(raw)) return null
  const contextWindow = tokenCount(raw.contextWindow)
  if (contextWindow === undefined || contextWindow === 0) return null
  const tokens = raw.tokens === null ? null : tokenCount(raw.tokens)
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow, percent }
}

function parseSessionUsageTokens(raw: unknown): SessionUsageTokens | undefined {
  if (!isRecord(raw)) return undefined
  const input = tokenCount(raw.input)
  const output = tokenCount(raw.output)
  const cacheRead = tokenCount(raw.cacheRead)
  const cacheWrite = tokenCount(raw.cacheWrite)
  const total = tokenCount(raw.total)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || total === undefined) return undefined
  return { input, output, cacheRead, cacheWrite, total }
}

/** Malformed cost stays unknown; a malformed token breakdown is discarded as one unit. */
export function parseSessionUsage(raw: unknown): SessionUsage | null {
  if (!isRecord(raw)) return null
  const cost = typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null
  const tokens = parseSessionUsageTokens(raw.tokens)
  if (cost === null && tokens === undefined && raw.cost !== null) return null
  return tokens ? { cost, tokens } : { cost }
}

function epochMs(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * One assistant response's output tokens over its wall time: from the request
 * start the harness stamps on the message to the completion time of the record
 * that persisted it, so the span includes time to first token. Failed and
 * aborted responses carry partial usage and stay out.
 */
export function parseResponseGeneration(message: unknown, completedAt: unknown): TranscriptGeneration | undefined {
  if (!isRecord(message) || message.role !== 'assistant') return undefined
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined
  const outputTokens = isRecord(message.usage) ? tokenCount(message.usage.output) : undefined
  const startedAt = epochMs(message.timestamp)
  const endedAt = epochMs(completedAt)
  if (!outputTokens || startedAt === undefined || endedAt === undefined || endedAt <= startedAt) return undefined
  return { outputTokens, durationMs: endedAt - startedAt }
}
