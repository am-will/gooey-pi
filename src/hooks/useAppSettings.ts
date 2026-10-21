import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS } from '@/lib/data'
import {
  confirmedPanelSettings,
  PANEL_SETTING_KEYS,
  type PanelSettingKey,
} from '@/lib/settings-state'
import type { AppSettings, InspectorTab, PrimeWorkApi } from '@/types/api'

interface UseAppSettingsOptions {
  bridge: PrimeWorkApi | null
  reportError(error: unknown): void
}

export function useAppSettings({ bridge, reportError }: UseAppSettingsOptions) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [initialized, setInitialized] = useState(!bridge)
  const [sidebarOpen, setSidebarOpenState] = useState(true)
  const [inspectorOpen, setInspectorOpenState] = useState(true)
  const [terminalOpen, setTerminalOpenState] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary')
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const confirmedSettingsRef = useRef(settings)
  const settingsMutationRef = useRef(0)
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve())
  const transientPanelKeysRef = useRef<Set<PanelSettingKey>>(new Set())
  const inspectorTabTouchedRef = useRef(false)

  const setSidebarOpen = useCallback((value: boolean) => {
    transientPanelKeysRef.current.add('sidebarOpen')
    setSidebarOpenState(value)
  }, [])
  const setInspectorOpen = useCallback((value: boolean) => {
    transientPanelKeysRef.current.add('inspectorOpen')
    setInspectorOpenState(value)
  }, [])
  const setTerminalOpen = useCallback((value: boolean) => {
    transientPanelKeysRef.current.add('terminalOpen')
    setTerminalOpenState(value)
  }, [])

  const applySettings = useCallback((next: AppSettings, panelPatch: Partial<AppSettings>) => {
    settingsRef.current = next
    setSettings(next)
    if ('sidebarOpen' in panelPatch) setSidebarOpenState(next.sidebarOpen)
    if ('inspectorOpen' in panelPatch) setInspectorOpenState(next.inspectorOpen)
    if ('terminalOpen' in panelPatch) setTerminalOpenState(next.terminalOpen)
  }, [])

  // Persisted panel values for the panels the user has not opened or closed
  // for the moment; a transient panel keeps what it shows.
  const confirmedPanelPatch = useCallback((next: AppSettings) => (
    confirmedPanelSettings(next, PANEL_SETTING_KEYS.filter((key) => !transientPanelKeysRef.current.has(key)))
  ), [])

  const takeConfirmedPanelPatch = useCallback((next: AppSettings) => {
    const patch = confirmedPanelPatch(next)
    transientPanelKeysRef.current.clear()
    return patch
  }, [confirmedPanelPatch])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<boolean> => {
    const mutation = ++settingsMutationRef.current
    const previous = settingsRef.current
    for (const key of PANEL_SETTING_KEYS) if (key in patch) transientPanelKeysRef.current.delete(key)
    applySettings({ ...previous, ...patch }, patch)
    if (!bridge) {
      confirmedSettingsRef.current = settingsRef.current
      transientPanelKeysRef.current.clear()
      return true
    }
    const operation = settingsQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await bridge.settings.update(patch)
      confirmedSettingsRef.current = saved
      if (settingsMutationRef.current === mutation) applySettings(saved, takeConfirmedPanelPatch(saved))
    })
    settingsQueueRef.current = operation.catch(() => undefined)
    try {
      await operation
      return true
    } catch (error) {
      if (settingsMutationRef.current === mutation) applySettings(confirmedSettingsRef.current, takeConfirmedPanelPatch(confirmedSettingsRef.current))
      reportError(error)
      return false
    }
  }, [applySettings, bridge, reportError, takeConfirmedPanelPatch])

  const reconcileExternalSettings = useCallback(async <T extends { settings: AppSettings }>(
    operation: () => Promise<T | null>,
  ): Promise<T | null> => {
    // Start the external transaction only after locally queued settings have
    // persisted, so its returned snapshot cannot predate them.
    await settingsQueueRef.current
    const revision = settingsMutationRef.current
    const result = await operation()
    if (!result) return null
    confirmedSettingsRef.current = result.settings
    // A new optimistic mutation started while the external operation ran.
    // Keep it visible; its queued result will become the next authority.
    // The external snapshot carries only persisted panel values, so a panel
    // opened or closed for the moment keeps what it shows and stays
    // transient for the next local save.
    if (settingsMutationRef.current === revision) applySettings(result.settings, confirmedPanelPatch(result.settings))
    return result
  }, [applySettings, confirmedPanelPatch])

  useEffect(() => {
    if (!bridge) {
      setInitialized(true)
      return
    }
    setInitialized(false)
    let cancelled = false
    const startupRevision = settingsMutationRef.current
    void bridge.settings.get().then((value) => {
      if (cancelled || settingsMutationRef.current !== startupRevision) return
      confirmedSettingsRef.current = value
      applySettings(value, value)
      if (!inspectorTabTouchedRef.current) setInspectorTab(value.defaultInspectorTab)
    }).catch((error) => { if (!cancelled) reportError(error) }).finally(() => {
      if (!cancelled) setInitialized(true)
    })
    return () => { cancelled = true }
  }, [applySettings, bridge, reportError])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = (theme: 'light' | 'dark') => {
      document.documentElement.dataset.theme = theme
      void bridge?.app?.setTitleBarTheme?.(theme)?.catch(() => undefined)
    }
    applyTheme(settings.theme === 'system' ? media.matches ? 'dark' : 'light' : settings.theme)
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
    const sync = () => {
      if (settings.theme === 'system') applyTheme(media.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [bridge, settings.reduceMotion, settings.theme])

  const selectInspectorTab = useCallback((tab: InspectorTab) => {
    inspectorTabTouchedRef.current = true
    setInspectorTab(tab)
  }, [])

  return {
    settings,
    initialized,
    sidebarOpen,
    setSidebarOpen,
    inspectorOpen,
    setInspectorOpen,
    terminalOpen,
    setTerminalOpen,
    inspectorTab,
    selectInspectorTab,
    updateSettings,
    reconcileExternalSettings,
  }
}
