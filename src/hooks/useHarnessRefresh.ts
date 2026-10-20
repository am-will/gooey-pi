import { useCallback } from 'react'
import type { AppMeta, AppSettings, HarnessId } from '@/types/api'

interface HarnessRefreshResult {
  meta: AppMeta
  settings: AppSettings
}

interface UseHarnessRefreshOptions {
  activeHarness: HarnessId
  /** Re-detects every harness in the main process and returns the new meta and settings. */
  refreshHarnesses(): Promise<HarnessRefreshResult | null>
  /** Runs an external settings transaction after queued local changes, then adopts its settings. */
  reconcileExternalSettings<T extends { settings: AppSettings }>(operation: () => Promise<T | null>): Promise<T | null>
  refreshProviders(force: boolean): Promise<void>
}

/**
 * Settings' Refresh harnesses: re-detect the harnesses, adopt the settings
 * the main process reconciled with them, and reload the model catalog when
 * the active harness is still installed.
 */
export function useHarnessRefresh({ activeHarness, refreshHarnesses, reconcileExternalSettings, refreshProviders }: UseHarnessRefreshOptions) {
  return useCallback(async () => {
    const result = await reconcileExternalSettings(refreshHarnesses)
    if (!result) return
    if (result.settings.activeHarness === activeHarness && result.meta.harnesses[activeHarness].path) {
      await refreshProviders(true)
    }
  }, [activeHarness, reconcileExternalSettings, refreshHarnesses, refreshProviders])
}
