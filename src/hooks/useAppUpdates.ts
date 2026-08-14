import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState, PrimeWorkApi } from '@/types/api'

const FALLBACK_STATE: AppUpdateState = { phase: 'unsupported', message: 'Automatic updates are available in installed builds.' }

export function useAppUpdates(bridge: PrimeWorkApi | null, reportError: (error: unknown) => void) {
  const [state, setState] = useState<AppUpdateState>(bridge ? { phase: 'idle' } : FALLBACK_STATE)

  useEffect(() => {
    if (!bridge) {
      setState(FALLBACK_STATE)
      return
    }
    let cancelled = false
    const unsubscribe = bridge.updates.onChanged((next) => { if (!cancelled) setState(next) })
    void bridge.updates.getState()
      .then((next) => { if (!cancelled) setState(next) })
      .catch((error) => { if (!cancelled) reportError(error) })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, reportError])

  const act = useCallback(async () => {
    if (!bridge) return
    try {
      // The onChanged subscription is the single writer for main-process state.
      if (state.phase === 'available' || state.phase === 'downloaded') await bridge.updates.downloadAndInstall()
      else await bridge.updates.check()
    } catch (error) {
      reportError(error)
    }
  }, [bridge, reportError, state.phase])

  return { state, act }
}
