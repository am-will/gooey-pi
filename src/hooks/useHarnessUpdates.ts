import { useCallback, useEffect, useState } from 'react'
import type { HarnessId, HarnessUpdateState, PrimeWorkApi } from '@/types/api'

/**
 * Registry update states for every harness. The main process owns checking
 * cadence and the update itself; this hook only mirrors state and exposes the
 * two user actions.
 */
export function useHarnessUpdates(bridge: PrimeWorkApi | null, reportError: (error: unknown) => void) {
  const [states, setStates] = useState<Record<HarnessId, HarnessUpdateState> | null>(null)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const unsubscribe = bridge.harnessUpdates.onChanged((next) => { if (!cancelled) setStates(next) })
    void bridge.harnessUpdates.getState()
      .then((next) => { if (!cancelled) setStates(next) })
      .catch((error) => { if (!cancelled) reportError(error) })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, reportError])

  const check = useCallback(async (force = false) => {
    if (!bridge) return
    try { setStates(await bridge.harnessUpdates.check(force)) } catch (error) { reportError(error) }
  }, [bridge, reportError])

  const update = useCallback(async (harness: HarnessId) => {
    if (!bridge) return null
    // Errors surface through the state's phase; rejections here are wiring
    // failures (guard refused, IPC unavailable) and go to the caller's toast.
    try { return await bridge.harnessUpdates.update(harness) } catch (error) { reportError(error); return null }
  }, [bridge, reportError])

  return { states, check, update }
}
