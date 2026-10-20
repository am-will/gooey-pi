import type { PromptDeliveryIntent, RuntimeInfo, SessionActionSnapshot } from '../types/api'

export const MAX_QUEUED_ACTIONS = 128
export const MAX_PREVIEW_LENGTH = 4_096

function boundedPreview(value: unknown): string | undefined {
  // Previews are used only for prefix matching against local steers, so truncating keeps stored
  // state bounded without dropping the whole snapshot when one queued message is long.
  return typeof value === 'string' ? value.slice(0, MAX_PREVIEW_LENGTH) : undefined
}

export function parseSessionActionSnapshot(value: unknown): SessionActionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Number.isSafeInteger(raw.queuedCount) || Number(raw.queuedCount) < 0 || Number(raw.queuedCount) > MAX_QUEUED_ACTIONS) return null
  if (!Array.isArray(raw.steering) || !Array.isArray(raw.followUps)) return null
  if (raw.steering.length > MAX_QUEUED_ACTIONS || raw.followUps.length > MAX_QUEUED_ACTIONS) return null
  const steering = raw.steering.map(boundedPreview)
  const followUps = raw.followUps.map(boundedPreview)
  if (steering.some((preview) => preview === undefined) || followUps.some((preview) => preview === undefined)) return null
  const activeRaw = raw.active
  let active: SessionActionSnapshot['active']
  if (activeRaw !== undefined) {
    if (!activeRaw || typeof activeRaw !== 'object' || Array.isArray(activeRaw)) return null
    const candidate = activeRaw as Record<string, unknown>
    if ((candidate.kind !== 'turn' && candidate.kind !== 'session_command')
      || (candidate.phase !== 'preparing' && candidate.phase !== 'committing' && candidate.phase !== 'running')) return null
    const label = candidate.label === undefined ? undefined : boundedPreview(candidate.label)
    if (candidate.label !== undefined && label === undefined) return null
    active = { kind: candidate.kind, phase: candidate.phase, ...(label === undefined ? {} : { label }) }
  }
  return { queuedCount: Number(raw.queuedCount), steering: steering as string[], followUps: followUps as string[], ...(active ? { active } : {}) }
}

export function emptySessionActionSnapshot(): SessionActionSnapshot {
  return { queuedCount: 0, steering: [], followUps: [] }
}

/**
 * True only when a runtime has nothing in flight: not streaming, not compacting, no active session
 * action and nothing queued. Callers that may stop or reuse a runtime must use this full check so
 * queued steers and follow-ups are never dropped between turns.
 */
export function isRuntimeIdle(runtime: Pick<RuntimeInfo, 'isStreaming' | 'isCompacting' | 'sessionActions'>): boolean {
  const actions = runtime.sessionActions
  return !runtime.isStreaming && !runtime.isCompacting && !actions?.active && (actions?.queuedCount ?? 0) === 0
}

export function streamingBehaviorForIntent(intent: PromptDeliveryIntent): 'steer' | 'followUp' {
  return intent === 'steer' ? 'steer' : 'followUp'
}
