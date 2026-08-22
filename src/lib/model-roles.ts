import { PRIME_THINKING_LEVELS, type PrimeModelCatalog, type PrimeThinkingLevel } from '../types/api'

/**
 * Model-role selector grammar shared by the main process and the renderer.
 *
 * A harness stores each model role as `provider/id`, optionally suffixed with
 * `:thinkingLevel` (`anthropic/claude-opus-5:xhigh`). Main validates a
 * selector before writing it; the settings form splits the same selector into
 * its two controls. Both use this module so the two can never disagree about
 * where the model ends and the thinking level begins.
 */
export interface ModelRoleSelector {
  /** Catalog model key (`provider/id`). */
  key: string
  /** Absent when the selector pins no thinking level and the harness default applies. */
  thinkingLevel?: PrimeThinkingLevel
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(PRIME_THINKING_LEVELS)

export function isPrimeThinkingLevel(value: string): value is PrimeThinkingLevel {
  return THINKING_LEVELS.has(value)
}

/**
 * Splits a selector against a catalog. Model ids may themselves contain a
 * colon, so a selector that already is a catalog key wins outright, and only
 * otherwise is the value split from the right into a key and a thinking
 * suffix. Returns null when no catalog model matches, which is how an
 * unresolvable selector is rejected before a write and shown verbatim in the
 * form.
 */
export function parseModelRoleSelector(value: string, catalog: PrimeModelCatalog): ModelRoleSelector | null {
  if (catalog.models.some((model) => model.key === value)) return { key: value }
  const separator = value.lastIndexOf(':')
  if (separator <= 0) return null
  const key = value.slice(0, separator)
  const level = value.slice(separator + 1)
  const model = catalog.models.find((candidate) => candidate.key === key)
  if (!model || !isPrimeThinkingLevel(level) || !model.availableThinkingLevels.includes(level)) return null
  return { key, thinkingLevel: level }
}

/** Inverse of `parseModelRoleSelector`; an empty key answers an empty selector. */
export function formatModelRoleSelector(key: string, thinkingLevel?: PrimeThinkingLevel | ''): string {
  if (!key) return ''
  return thinkingLevel ? `${key}:${thinkingLevel}` : key
}
