import type { PrimeThinkingLevel } from '@/types/api'

/** Display names for reasoning levels, shared by every renderer surface that offers a level. */
export const THINKING_LEVEL_LABELS: Record<PrimeThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Standard',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
