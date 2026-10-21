import type { PrimeThinkingLevel } from '../types/api'
import type { MessageKey } from './locales/types'

/** Message keys keep reasoning labels responsive to interface-language changes. */
export const THINKING_LEVEL_KEYS = {
  off: 'composer.effort.off',
  minimal: 'composer.effort.minimal',
  low: 'composer.effort.low',
  medium: 'composer.effort.medium',
  high: 'composer.effort.high',
  xhigh: 'composer.effort.xhigh',
  max: 'composer.effort.max',
} as const satisfies Record<PrimeThinkingLevel, MessageKey>
