import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HarnessId, NativeHeartbeatRecord, PrimeWorkApi } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface NativeHeartbeatOptions {
  bridge: PrimeWorkApi | null
  harness: HarnessId
  visible: boolean
  reportError(error: unknown): void
}

interface HeartbeatScope {
  bridge: PrimeWorkApi | null
  harness: HarnessId
  active: boolean
  automaticEnabled: boolean
  requested: number
  manualRequested: number
  completed: number
  running: Promise<void> | null
}

const EMPTY_HEARTBEATS: NativeHeartbeatRecord[] = []

export function useNativeHeartbeats({ bridge, harness, visible, reportError: onError }: NativeHeartbeatOptions) {
  const reportError = useStableCallback(onError)
  const scope = useMemo<HeartbeatScope>(() => ({ bridge, harness, active: false, automaticEnabled: false, requested: 0, manualRequested: 0, completed: 0, running: null }), [bridge, harness])
  const [result, setResult] = useState<{ scope: HeartbeatScope; records: NativeHeartbeatRecord[] } | null>(null)

  useEffect(() => {
    scope.active = true
    return () => { scope.active = false }
  }, [scope])

  const requestRefresh = useCallback(async (manual: boolean): Promise<void> => {
    const nativeBridge = scope.bridge
    if (!scope.active || scope.harness !== 'prime' || !nativeBridge) return
    if (!manual && (!scope.automaticEnabled || document.visibilityState !== 'visible')) return
    scope.requested += 1
    if (manual) scope.manualRequested = scope.requested
    if (scope.running) return scope.running
    scope.running = (async () => {
      while (scope.active && scope.completed < scope.requested) {
        if (scope.manualRequested <= scope.completed && (!scope.automaticEnabled || document.visibilityState !== 'visible')) break
        const revision = scope.requested
        try {
          const records = await nativeBridge.heartbeats.list()
          if (scope.active && revision === scope.requested) setResult({ scope, records })
        } catch (error) {
          if (scope.active && revision === scope.requested) reportError(error)
        }
        scope.completed = revision
      }
    })().finally(() => { scope.running = null })
    return scope.running
  }, [reportError, scope])
  const refreshHeartbeats = useCallback(() => requestRefresh(true), [requestRefresh])

  useEffect(() => {
    if (!bridge || harness !== 'prime' || !visible) return
    let interval: number | undefined
    let unsubscribe: (() => void) | undefined
    const stop = () => {
      scope.automaticEnabled = false
      if (interval !== undefined) window.clearInterval(interval)
      interval = undefined
      unsubscribe?.()
      unsubscribe = undefined
    }
    const syncVisibility = () => {
      stop()
      if (document.visibilityState !== 'visible') return
      scope.automaticEnabled = true
      void requestRefresh(false)
      unsubscribe = bridge.agent.onEvent(({ event }) => {
        if (event.type === 'heartbeats_changed') void requestRefresh(false)
      })
      interval = window.setInterval(() => { void requestRefresh(false) }, 30_000)
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', syncVisibility) }
  }, [bridge, harness, requestRefresh, scope, visible])

  return { heartbeats: harness === 'prime' && result?.scope === scope ? result.records : EMPTY_HEARTBEATS, refreshHeartbeats }
}
