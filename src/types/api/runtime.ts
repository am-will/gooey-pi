import type { HarnessId } from './harness'
import type { PrimeThinkingLevel, PrimeServiceTier } from './models'
export interface PrimeContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}
export interface SessionUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}
/** Cumulative cost and token totals for the in-context session, as reported by get_session_stats. */
export interface SessionUsage {
  /** USD cost summed from catalog pricing; null when the harness reports none. */
  cost: number | null
  tokens?: SessionUsageTokens
}
export interface RuntimeInfo {
  /** Outstanding harness dialogs that can be restored after a renderer reload. */
  pendingExtensionUi?: Record<string, unknown>[]
  runtimeId: string
  harness: HarnessId
  sessionId?: string
  sessionFile?: string
  cwd: string
  isStreaming: boolean
  sessionActions?: SessionActionSnapshot
  isCompacting?: boolean
  model?: { provider?: string; id?: string; name?: string } | null
  /** Renderer-local notice; never persisted or used to update the model picker. */
  executingModel?: { provider?: string; id: string; label: string; isFallback: true } | null
  thinkingLevel?: string
  availableThinkingLevels?: PrimeThinkingLevel[]
  fastModeSupported?: boolean
  imageInputSupported?: boolean
  fastModeAvailable?: boolean
  serviceTier?: PrimeServiceTier
  contextUsage?: PrimeContextUsage
  sessionUsage?: SessionUsage
}
export interface PrimeEventEnvelope {
  runtimeId: string
  event: Record<string, unknown>
}
export interface SessionActionSnapshot {
  queuedCount: number
  steering: string[]
  followUps: string[]
  active?: {
    kind: 'turn' | 'session_command'
    phase: 'preparing' | 'committing' | 'running'
    label?: string
  }
}
