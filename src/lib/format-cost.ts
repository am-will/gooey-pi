import { formattingLocaleTag, translate } from '@/lib/i18n'
import type { PrimeContextUsage, SessionUsage } from '@/types/api'

/**
 * Formats a USD amount: `$0.42`, `$1.23`, `<$0.01` for tiny non-zero values.
 * Number grouping stays on `en-US` because it matches every supported locale's
 * separators; only the surrounding words come from the catalog.
 */
export function formatUsd(cost: number): string {
  if (cost > 0 && cost < 0.005) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

const count = (value: number) => value.toLocaleString('en-US')

/**
 * Human-readable session cost. A zero cost with tokens already spent means the
 * model has no catalog pricing (OAuth/subscription providers), so it reads as
 * "pricing unavailable" instead of a misleading $0.00. Returns null when the
 * session has no usage to report yet.
 */
export function formatSessionCost(usage: SessionUsage | undefined): string | null {
  if (!usage) return null
  const totalTokens = usage.tokens?.total ?? 0
  if (usage.cost === null) return totalTokens > 0 ? translate(formattingLocaleTag(), 'cost.pricingUnavailable') : null
  if (usage.cost > 0) return formatUsd(usage.cost)
  return totalTokens > 0 ? translate(formattingLocaleTag(), 'cost.pricingUnavailable') : null
}

/** Tooltip/aria text for the composer context dial: context tokens plus the session cost when known. */
export function contextDialLabel(contextUsage: PrimeContextUsage | undefined, sessionUsage: SessionUsage | undefined): string {
  const locale = formattingLocaleTag()
  if (!contextUsage || contextUsage.tokens === null) return translate(locale, 'cost.contextUnavailable')
  const label = translate(locale, 'cost.tokens', { used: count(contextUsage.tokens), total: count(contextUsage.contextWindow) })
  const totalTokens = sessionUsage?.tokens?.total ?? 0
  // Mirror formatSessionCost's "no catalog pricing" signal rather than comparing
  // against a localised string, which would differ per locale.
  const sessionCost = sessionUsage?.cost ?? null
  if (sessionCost === null || sessionCost <= 0) return totalTokens > 0 ? translate(locale, 'cost.dialUnavailable', { label }) : label
  return translate(locale, 'cost.dialCost', { label, cost: formatUsd(sessionCost) })
}

export function formatSessionTokens(usage: SessionUsage | undefined): string | null {
  const tokens = usage?.tokens
  if (!tokens || tokens.total <= 0) return null
  return translate(formattingLocaleTag(), 'cost.sessionTokens', {
    input: count(tokens.input),
    output: count(tokens.output),
    cached: count(tokens.cacheRead + tokens.cacheWrite),
  })
}
