import type { HarnessId } from '../types/api'

export const HARNESS_SELECTOR_ORDER: readonly HarnessId[] = ['pi', 'omp', 'prime']

/** Product name shown in window chrome and the brand switcher. */
export const HARNESS_PRODUCT_NAMES: Record<HarnessId, string> = { prime: 'Prime Work', omp: 'OMP Work', pi: 'Pi Work' }

/** The agent each harness runs, used in settings and error copy. */
export const HARNESS_AGENT_NAMES: Record<HarnessId, string> = { prime: 'Prime Agent', omp: 'OMP', pi: 'Pi' }

/** Short conversational name ("Prime is working"). */
export const HARNESS_SHORT_NAMES: Record<HarnessId, string> = { prime: 'Prime', omp: 'OMP', pi: 'Pi' }

/** Provider documentation each harness links to from Settings. */
export const HARNESS_PROVIDER_DOCS: Record<HarnessId, string> = {
  omp: 'https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md',
  prime: 'https://github.com/PrimeIntellect-ai/prime-agent',
  pi: 'https://pi.dev',
}
