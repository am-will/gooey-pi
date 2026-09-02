import type { PrimeContextUsage, SessionUsage } from '@/types/api'

export const PRICING_UNAVAILABLE = 'Pricing unavailable'

/** Formats a USD amount: `$0.42`, `$1.23`, `<$0.01` for tiny non-zero values. */
export function formatUsd(cost: number): string {
  if (cost > 0 && cost < 0.005) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

/**
 * Human-readable session cost. A zero cost with tokens already spent means the
 * model has no catalog pricing (OAuth/subscription providers), so it reads as
 * "pricing unavailable" instead of a misleading $0.00. Returns null when the
 * session has no usage to report yet.
 */
export function formatSessionCost(usage: SessionUsage | undefined): string | null {
  if (!usage) return null
  const totalTokens = usage.tokens?.total ?? 0
  if (usage.cost === null) return totalTokens > 0 ? PRICING_UNAVAILABLE : null
  if (usage.cost > 0) return formatUsd(usage.cost)
  return totalTokens > 0 ? PRICING_UNAVAILABLE : null
}

/** Tooltip/aria text for the composer context dial: context tokens plus the session cost when known. */
export function contextDialLabel(contextUsage: PrimeContextUsage | undefined, sessionUsage: SessionUsage | undefined): string {
  if (!contextUsage || contextUsage.tokens === null) return 'Context usage unavailable until the next response'
  const label = `${contextUsage.tokens.toLocaleString('en-US')} / ${contextUsage.contextWindow.toLocaleString('en-US')} tokens`
  const cost = formatSessionCost(sessionUsage)
  if (cost === null) return label
  return `${label} · ${cost === PRICING_UNAVAILABLE ? 'pricing unavailable' : `${cost} session cost`}`
}

export function formatSessionTokens(usage: SessionUsage | undefined): string | null {
  const tokens = usage?.tokens
  if (!tokens || tokens.total <= 0) return null
  const count = (value: number) => value.toLocaleString('en-US')
  return `${count(tokens.input)} in / ${count(tokens.output)} out / ${count(tokens.cacheRead + tokens.cacheWrite)} cached`
}
