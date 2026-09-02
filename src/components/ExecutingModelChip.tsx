import { AlertTriangle } from 'lucide-react'
import type { RuntimeInfo } from '@/types/api'

export interface ExecutingModelChipProps {
  executingModel: RuntimeInfo['executingModel']
}

export function ExecutingModelChip({ executingModel }: ExecutingModelChipProps) {
  if (!executingModel?.isFallback) return null
  return (
    <span
      className="model-fallback-chip"
      role="status"
      title={`Provider fallback: running on ${executingModel.label} instead of the selected model.`}
    >
      <AlertTriangle size={12} /> Running on {executingModel.label}
    </span>
  )
}
