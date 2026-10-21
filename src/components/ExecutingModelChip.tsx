import { AlertTriangle } from 'lucide-react'
import type { RuntimeInfo } from '@/types/api'
import { useI18n } from '@/lib/i18n'

export interface ExecutingModelChipProps {
  executingModel: RuntimeInfo['executingModel']
}

export function ExecutingModelChip({ executingModel }: ExecutingModelChipProps) {
  const { t } = useI18n()
  if (!executingModel?.isFallback) return null
  return (
    <span
      className="model-fallback-chip"
      role="status"
      title={t('executingModel.fallbackTooltip', { model: executingModel.label })}
    >
      <AlertTriangle size={12} /> {t('executingModel.running', { model: executingModel.label })}
    </span>
  )
}
