import { useCallback, useEffect } from 'react'
import type { useAppSettings } from '@/hooks/useAppSettings'
import type { useBootstrap } from '@/hooks/useBootstrap'
import type { HarnessId, PrimeWorkApi } from '@/types/api'

interface UseHarnessRefreshOptions {
  bridge: PrimeWorkApi | null
  activeHarness: HarnessId
  /** Re-detects every harness in the main process and returns the new meta and settings. */
  refreshHarnesses: ReturnType<typeof useBootstrap>['refreshHarnesses']
  /** Runs an external settings transaction after queued local changes, then adopts its settings. */
  reconcileExternalSettings: ReturnType<typeof useAppSettings>['reconcileExternalSettings']
  refreshProviders(force: boolean): Promise<void>
  /** Reloads the active harness's Capabilities records, whose availability follows the detected build. */
  refreshCapabilities(): Promise<void>
  reportError(error: unknown): void
}

/**
 * Settings' Refresh harnesses: re-detect the harnesses, adopt the settings
 * the main process reconciled with them, and reload the model catalog and
 * the Capabilities records when the active harness is still installed.
 *
 * The same refresh runs when the main process re-detects the harnesses on
 * its own (a Prime start that found a different build), so every view shows
 * the new version, implementation and capabilities without a manual Refresh.
 */
export function useHarnessRefresh({ bridge, activeHarness, refreshHarnesses, reconcileExternalSettings, refreshProviders, refreshCapabilities, reportError }: UseHarnessRefreshOptions) {
  const refresh = useCallback(async () => {
    const result = await reconcileExternalSettings(refreshHarnesses)
    if (!result) return
    if (result.settings.activeHarness === activeHarness && result.meta.harnesses[activeHarness].path) {
      await Promise.all([refreshProviders(true), refreshCapabilities()])
    }
  }, [activeHarness, reconcileExternalSettings, refreshCapabilities, refreshHarnesses, refreshProviders])

  useEffect(() => {
    const onHarnessesChanged = bridge?.app.onHarnessesChanged
    if (!onHarnessesChanged) return
    return onHarnessesChanged(() => { void refresh().catch(reportError) })
  }, [bridge, refresh, reportError])

  return refresh
}
