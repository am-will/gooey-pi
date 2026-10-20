import type { PrimeCompactionReason } from '../types/api'

// Keyed by the type, so adding a reason there fails to compile until it is listed here.
const COMPACTION_REASONS: Record<PrimeCompactionReason, true> = {
  manual: true,
  threshold: true,
  overflow: true,
  requested: true,
  idle: true,
  incomplete: true,
}

/** Recognizes a compaction reason from live events and persisted compaction outcomes alike. */
export function isCompactionReason(value: unknown): value is PrimeCompactionReason {
  return typeof value === 'string' && Object.hasOwn(COMPACTION_REASONS, value)
}
