import type { PrimeContextUsage, SessionUsage, SessionUsageTokens } from '../types/api'

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
