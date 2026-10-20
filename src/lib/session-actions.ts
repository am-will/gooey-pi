import type { PromptDeliveryIntent, SessionActionSnapshot } from '../types/api'

export const MAX_QUEUED_ACTIONS = 128
export const MAX_PREVIEW_LENGTH = 4_096

function boundedPreview(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_PREVIEW_LENGTH ? value : undefined
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

/**
 * Whether a queue preview stands for a prompt. Previews are literal for
 * ordinary prompts and may be compacted for very long ones, so either text
 * may be a prefix of the other.
 */
export function previewMatchesPrompt(preview: string, prompt: string): boolean {
  return prompt.startsWith(preview) || preview.startsWith(prompt)
}

export function emptySessionActionSnapshot(): SessionActionSnapshot {
  return { queuedCount: 0, steering: [], followUps: [] }
}

export function streamingBehaviorForIntent(intent: PromptDeliveryIntent): 'steer' | 'followUp' {
  return intent === 'steer' ? 'steer' : 'followUp'
}
