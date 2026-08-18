import { useCallback, useEffect, useState } from 'react'
import type { PrimeWorkApi, RuntimeInfo, SubagentRecord, SubagentSubscriptionLevel } from '@/types/api'
import {
  applySubagentEvent,
  applySubagentRoster,
  EMPTY_SUBAGENT_ROSTER,
  isSubagentEvent,
  pruneFinishedSubagents,
  sortSubagents,
  SUBAGENT_POLL_INTERVAL_MS,
  SUBAGENT_SUBSCRIPTION_FOR_INSPECTION,
  SUBAGENT_SUBSCRIPTION_IDLE,
  type SubagentRoster,
} from '@/lib/subagents'

/**
 * Subscription levels tried in order until the harness accepts one.
 *
 * `events` is deliberately absent rather than merely deprioritised. It
 * re-broadcasts every subagent's own `message_update`/`tool_execution_*`
 * stream through the same non-critical `AgentEventForwarder` budget the parent
 * transcript uses, and it answers no question this panel asks. See
 * SUBAGENT_SUBSCRIPTION_FOR_INSPECTION for the measured frame counts.
 *
 * A harness that rejects every rung degrades to request/response polling,
 * which needs no subscription and adds no push frames at all.
 */
export const SUBAGENT_SUBSCRIPTION_LADDER: readonly SubagentSubscriptionLevel[] = [SUBAGENT_SUBSCRIPTION_FOR_INSPECTION]

/** How the roster is currently being fed. */
export type SubagentFeedMode = 'idle' | 'push' | 'poll' | 'unsupported'

export interface SubagentsApi {
  subagents: SubagentRecord[]
  mode: SubagentFeedMode
  /** Present when the harness refused both the subscription and the roster query. */
  error?: string
}

interface UseSubagentsOptions {
  bridge: PrimeWorkApi | null
  runtime: RuntimeInfo | null
  /** True while the Subagents panel is mounted and visible; drives the subscription. */
  active: boolean
}

/**
 * Owns the OMP subagent roster for the active runtime.
 *
 * The subscription is scoped to the panel rather than to the session: a
 * session nobody is inspecting costs zero extra frames, which is the point of
 * defaulting to `progress` and resting at `off`.
 */
export function useSubagents({ bridge, runtime, active }: UseSubagentsOptions): SubagentsApi {
  const [roster, setRoster] = useState<SubagentRoster>(EMPTY_SUBAGENT_ROSTER)
  const [mode, setMode] = useState<SubagentFeedMode>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const runtimeId = runtime?.runtimeId ?? null
  const supported = runtime?.subagentInspectionSupported === true

  // A roster belongs to one runtime; switching sessions must not show the
  // previous session's subagents while the new subscription is still settling.
  useEffect(() => {
    setRoster(EMPTY_SUBAGENT_ROSTER)
    setError(undefined)
  }, [runtimeId])

  const command = useCallback(async (payload: Record<string, unknown>) => {
    if (!bridge || !runtimeId) throw new Error('No active runtime')
    return bridge.agent.command(runtimeId, payload)
  }, [bridge, runtimeId])

  // Push frames. Subscribed independently of the transcript event pump so the
  // roster never perturbs transcript reconciliation, and torn down the moment
  // the panel closes.
  useEffect(() => {
    if (!bridge || !runtimeId || !supported || !active) return
    return bridge.agent.onEvent(({ runtimeId: id, event }) => {
      if (id !== runtimeId) return
      // A new parent turn retires the previous turn's finished subagents.
      if (event.type === 'agent_start') { setRoster(pruneFinishedSubagents); return }
      if (!isSubagentEvent(event)) return
      setRoster((current) => applySubagentEvent(current, event))
    })
  }, [active, bridge, runtimeId, supported])

  // Subscription lifecycle plus the degrade ladder.
  useEffect(() => {
    if (!bridge || !runtimeId) { setMode('idle'); return }
    if (!supported) { setMode('unsupported'); return }
    if (!active) { setMode('idle'); return }

    let live = true
    let pollTimer: number | null = null
    let subscribed: SubagentSubscriptionLevel | null = null

    const seed = async (): Promise<boolean> => {
      try {
        const response = await command({ type: 'get_subagents' })
        if (live) setRoster((current) => applySubagentRoster(current, response?.data))
        return true
      } catch {
        return false
      }
    }

    void (async () => {
      for (const level of SUBAGENT_SUBSCRIPTION_LADDER) {
        try {
          await command({ type: 'set_subagent_subscription', level })
          if (!live) return
          subscribed = level
          break
        } catch {
          // Try the next rung; a different harness build may accept it.
        }
      }
      if (!live) return
      // Push frames only fire on change, so the roster is seeded either way.
      const seeded = await seed()
      if (!live) return
      if (subscribed) { setMode('push'); setError(undefined); return }
      if (seeded) {
        setMode('poll')
        setError(undefined)
        if (pollTimer === null) pollTimer = window.setInterval(() => { void seed() }, SUBAGENT_POLL_INTERVAL_MS)
        return
      }
      setMode('unsupported')
      setError('This agent did not answer the subagent roster query.')
    })()

    return () => {
      live = false
      if (pollTimer !== null) window.clearInterval(pollTimer)
      // Return the harness to its resting level so a closed panel costs nothing.
      if (subscribed) void command({ type: 'set_subagent_subscription', level: SUBAGENT_SUBSCRIPTION_IDLE }).catch(() => undefined)
    }
  }, [active, bridge, command, runtimeId, supported])

  return { subagents: sortSubagents(roster), mode, error }
}
