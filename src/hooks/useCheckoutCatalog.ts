import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, CheckoutCatalog, PrimeWorkApi, ProjectRecord } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface CheckoutCatalogOptions {
  bridge: PrimeWorkApi | null
  project?: ProjectRecord
  checkoutStrategy: AppSettings['checkoutStrategy']
  reportError(error: unknown): void
}

export function useCheckoutCatalog({ bridge, project, checkoutStrategy, reportError }: CheckoutCatalogOptions) {
  const [checkoutCatalog, setCheckoutCatalog] = useState<CheckoutCatalog>()
  const [checkoutsLoading, setCheckoutsLoading] = useState(false)
  const checkoutRequestRef = useRef(0)
  const report = useStableCallback(reportError)
  const refreshCheckouts = useCallback(async () => {
    const requestId = ++checkoutRequestRef.current
    if (!bridge || !project || project.inferred) { setCheckoutCatalog(undefined); setCheckoutsLoading(false); return }
    setCheckoutsLoading(true)
    try {
      const next = await bridge.projects.listCheckouts(project.id, project.harness)
      if (checkoutRequestRef.current === requestId) setCheckoutCatalog(next)
    } catch (error) {
      if (checkoutRequestRef.current === requestId) { setCheckoutCatalog(undefined); report(error) }
    } finally {
      if (checkoutRequestRef.current === requestId) setCheckoutsLoading(false)
    }
  }, [bridge, checkoutStrategy, project, report])
  useEffect(() => { void refreshCheckouts(); return () => { checkoutRequestRef.current += 1 } }, [refreshCheckouts])
  return { checkoutCatalog, checkoutsLoading, checkoutRequestRef, refreshCheckouts }
}
