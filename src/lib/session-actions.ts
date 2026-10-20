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

function samePreviews(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((preview, index) => preview === right[index])
}

/** Whether two snapshots report the same queue and the same active action. */
export function sameSessionActions(left: SessionActionSnapshot | undefined, right: SessionActionSnapshot): boolean {
  return left !== undefined
    && left.queuedCount === right.queuedCount
    && samePreviews(left.steering, right.steering)
    && samePreviews(left.followUps, right.followUps)
    && left.active?.kind === right.active?.kind
    && left.active?.phase === right.active?.phase
    && left.active?.label === right.active?.label
}

function withoutFirstMatch(previews: string[], prompt: string): string[] | null {
  const index = previews.findIndex((preview) => previewMatchesPrompt(preview, prompt))
  return index < 0 ? null : previews.filter((_, candidate) => candidate !== index)
}

/**
 * The snapshot after the harness delivered a queued prompt into the running
 * turn: the first matching steering preview (else follow-up) leaves the queue
 * and the queued count drops by one. A delivery proves a turn is running, so
 * the snapshot keeps its active action and marks a running turn when it had
 * none. Null when no queued preview matches the prompt.
 */
export function consumeDeliveredPrompt(snapshot: SessionActionSnapshot, prompt: string): SessionActionSnapshot | null {
  const steering = withoutFirstMatch(snapshot.steering, prompt)
  const followUps = steering ? null : withoutFirstMatch(snapshot.followUps, prompt)
  if (!steering && !followUps) return null
  return {
    queuedCount: Math.max(0, snapshot.queuedCount - 1),
    steering: steering ?? snapshot.steering,
    followUps: followUps ?? snapshot.followUps,
    active: snapshot.active ?? { kind: 'turn', phase: 'running' },
  }
}

/** The snapshot without its active action: the queue a finished run leaves behind. */
export function withoutActiveAction(snapshot: SessionActionSnapshot): SessionActionSnapshot {
  const { active: _, ...queue } = snapshot
  return queue
}

export function streamingBehaviorForIntent(intent: PromptDeliveryIntent): 'steer' | 'followUp' {
  return intent === 'steer' ? 'steer' : 'followUp'
}
