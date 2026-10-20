import { PRIME_THINKING_LEVELS } from '../../src/types/api'
import type { PrimeModelDescriptor, PrimeThinkingLevel } from '../../src/types/api'
import type { ModelCatalogProvider } from './model-catalog'

const SPOKEN_NUMBER_TOKENS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
}

function normalizedModelText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => SPOKEN_NUMBER_TOKENS[token] ?? token)
    .join(' ')
}

function modelMatchScore(query: string, model: PrimeModelDescriptor): number {
  const wanted = normalizedModelText(query)
  if (!wanted) return 0
  // A field with no ASCII letters or digits (e.g. a CJK display name) normalizes to '', and
  // `wanted.includes('')` is always true, so empty fields would otherwise match every query.
  const fields = [model.key, model.id, model.name, `${model.provider} ${model.name}`, `${model.provider} ${model.id}`]
    .map(normalizedModelText)
    .filter((field) => field.length > 0)
  if (fields.includes(wanted)) return 10_000
  const wantedTokens = new Set(wanted.split(' '))
  let best = 0
  for (const field of fields) {
    if (field.includes(wanted) || wanted.includes(field)) best = Math.max(best, 7_000 - Math.abs(field.length - wanted.length))
    const fieldTokens = new Set(field.split(' '))
    const overlap = [...wantedTokens].filter((token) => fieldTokens.has(token)).length
    if (overlap) {
      const coverage = overlap / wantedTokens.size
      const precision = overlap / fieldTokens.size
      best = Math.max(best, Math.round(4_000 * coverage + 1_000 * precision))
    }
  }
  return best
}

export function rankedModelMatches(query: string, models: readonly PrimeModelDescriptor[]): PrimeModelDescriptor[] {
  return models
    .map((model) => ({ model, score: modelMatchScore(query, model) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.model.name.localeCompare(right.model.name) || left.model.key.localeCompare(right.model.key))
    .map(({ model }) => model)
}

const MODEL_LISTING_LIMIT = 100

/** The bounded model list payload shared by the voice and agent-collaboration `models` tools. */
export function modelListing(query: string, available: readonly PrimeModelDescriptor[]) {
  const matches = query ? rankedModelMatches(query, available) : available
  const models = matches.slice(0, MODEL_LISTING_LIMIT).map((model) => ({
    key: model.key,
    name: model.name,
    provider: model.provider,
    reasoning_levels: model.availableThinkingLevels,
  }))
  return { models, matched: matches.length, returned: models.length, truncated: matches.length > models.length }
}

export function resolveModel(query: string, models: readonly PrimeModelDescriptor[]): PrimeModelDescriptor {
  const match = rankedModelMatches(query, models)[0]
  if (!match) throw new Error(`No available model from a visible provider matched “${query}”`)
  return match
}

const REASONING_RANK = new Map(PRIME_THINKING_LEVELS.map((level, index) => [level, index]))

function requestedReasoningRank(value: string): number {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const exact = PRIME_THINKING_LEVELS.find((level) => normalized === level)
  if (exact) return REASONING_RANK.get(exact)!
  if (/\b(max|maximum|highest|ultra)\b/.test(normalized)) return REASONING_RANK.get('max')!
  if (/\b(xhigh|extra high|very high)\b/.test(normalized)) return REASONING_RANK.get('xhigh')!
  if (/\b(high|deep|strong)\b/.test(normalized)) return REASONING_RANK.get('high')!
  if (/\b(medium|mid|middle|normal|balanced|default)\b/.test(normalized)) return REASONING_RANK.get('medium')!
  if (/\b(low|light|quick)\b/.test(normalized)) return REASONING_RANK.get('low')!
  if (/\b(minimal|minimum|tiny|little)\b/.test(normalized)) return REASONING_RANK.get('minimal')!
  if (/\b(off|none|no reasoning|disable)\b/.test(normalized)) return REASONING_RANK.get('off')!
  return REASONING_RANK.get('medium')!
}

export function resolveReasoning(value: string, available: readonly PrimeThinkingLevel[]): PrimeThinkingLevel {
  if (!available.length) throw new Error('The selected model does not expose any reasoning levels')
  const wanted = requestedReasoningRank(value)
  return [...available].sort((left, right) => {
    const leftRank = REASONING_RANK.get(left)!
    const rightRank = REASONING_RANK.get(right)!
    const distance = Math.abs(leftRank - wanted) - Math.abs(rightRank - wanted)
    return distance || (wanted >= REASONING_RANK.get('medium')! ? rightRank - leftRank : leftRank - rightRank)
  })[0]
}

export async function availableModels(catalog: ModelCatalogProvider, disabledProviders: ReadonlySet<string>, disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor[]> {
  const snapshot = await catalog.catalog(false, disabledProviders, disabledModels)
  const enabledProviders = new Set(snapshot.providers.filter((provider) => provider.enabled).map((provider) => provider.id))
  return snapshot.models.filter((model) => model.available && model.enabled !== false && enabledProviders.has(model.provider))
}
