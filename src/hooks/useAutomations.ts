import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { AutomationScheduleRecord, HarnessId, PrimeWorkApi } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface AutomationsOptions {
  bridge: PrimeWorkApi | null
  harness: HarnessId
  initialSchedules?: AutomationScheduleRecord[]
  reportError(error: unknown): void
}

export function useAutomations({ bridge, harness, initialSchedules, reportError }: AutomationsOptions) {
  const [schedules, setSchedules] = useState<AutomationScheduleRecord[]>(() => initialSchedules ?? [])
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleFocusId, setScheduleFocusId] = useState<string | null>(null)
  const requestRef = useRef(0)
  const report = useStableCallback(reportError)
  const refreshSchedules = useCallback(async () => {
    if (!bridge) return
    const request = ++requestRef.current
    try {
      const next = await bridge.schedules.list(harness)
      if (requestRef.current === request) { setSchedules(next); setScheduleError('') }
    } catch (error) {
      if (requestRef.current !== request) return
      setScheduleError(errorMessage(error))
      report(error)
    }
  }, [bridge, harness, report])
  useEffect(() => {
    if (!bridge) return
    const unsubscribe = bridge.schedules.onChanged(() => { void refreshSchedules() })
    return () => { requestRef.current += 1; unsubscribe() }
  }, [bridge, refreshSchedules])
  return { schedules, setSchedules, scheduleError, setScheduleError, scheduleFocusId, setScheduleFocusId, refreshSchedules }
}
