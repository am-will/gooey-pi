import type { CSSProperties } from 'react'
import { contextDialLabel } from '@/lib/format-cost'
import { useI18n } from '@/lib/i18n'
import type { PrimeContextUsage, SessionUsage } from '@/types/api'

export function ContextUsageDial({ contextUsage, sessionUsage }: { contextUsage?: PrimeContextUsage; sessionUsage?: SessionUsage }) {
  const { t } = useI18n()
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? null : Math.min(100, Math.max(0, contextUsage.percent))
  const contextLabel = contextDialLabel(contextUsage, sessionUsage)
  const contextDisplayPercent = contextPercent === null ? null : Math.min(99, Math.round(contextPercent))
  const contextStyle: CSSProperties & { '--context-percent': string } = { '--context-percent': `${contextPercent ?? 0}%` }
  return (
    <span
      className={`context-usage-dial ${contextPercent === null ? 'is-unavailable' : contextPercent >= 95 ? 'is-critical' : contextPercent >= 80 ? 'is-warning' : ''}`}
      role="meter"
      tabIndex={0}
      aria-label={t('composer.context.usage')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={contextPercent === null ? undefined : Math.round(contextPercent)}
      aria-valuetext={contextLabel}
      title={contextLabel}
      data-tooltip={contextLabel}
      style={contextStyle}
    >
      <span>{contextDisplayPercent ?? '—'}</span>
    </span>
  )
}
