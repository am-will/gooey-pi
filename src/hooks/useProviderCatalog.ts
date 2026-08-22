import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HarnessId, PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeWorkApi, ProviderAuthEvent, RuntimeInfo } from '@/types/api'

type ActiveProviderAuthEvent = Exclude<ProviderAuthEvent, { type: 'cancelled' }>

/** Stable fallback identities so consumers can memoize on prop equality. */
const DEFAULT_REASONING_LEVELS: PrimeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function groupModelsByProvider(models: readonly PrimeModelDescriptor[] | undefined): Map<string, PrimeModelDescriptor[]> {
  const grouped = new Map<string, PrimeModelDescriptor[]>()
  for (const model of models ?? []) {
    if (model.enabled === false) continue
    const bucket = grouped.get(model.provider)
    if (bucket) bucket.push(model)
    else grouped.set(model.provider, [model])
  }
  return grouped
}

interface UseProviderCatalogOptions {
  bridge: PrimeWorkApi | null
  /** Prevent startup work before the persisted harness selection is loaded. */
  ready?: boolean
  /** Harness whose model catalog is shown; catalogs are cached per harness. */
  harness?: HarnessId
  runtime: RuntimeInfo | null
  /** Persisted per-harness model preference. */
  lastSelectedModel?: string
  rememberModel?(modelKey: string): void
  syncRuntime(runtimeId: string): Promise<void>
  reportError(error: unknown): void
}

export function useProviderCatalog({ bridge, ready = true, harness = 'prime', runtime, lastSelectedModel = '', rememberModel, syncRuntime, reportError }: UseProviderCatalogOptions) {
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<PrimeThinkingLevel>('medium')
  const [fast, setFast] = useState(false)
  // Per-harness cache: switching back to a harness shows its last catalog
  // immediately while the background refresh updates it.
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessId, PrimeModelCatalog>>>({})
  const catalog = catalogs[harness] ?? null
  const setCatalogFor = useCallback((target: HarnessId, next: PrimeModelCatalog) => {
    setCatalogs((current) => ({ ...current, [target]: next }))
  }, [])
  const [authEvent, setAuthEvent] = useState<ActiveProviderAuthEvent | null>(null)
  const modelRef = useRef(model)
  const effortRef = useRef(effort)
  const fastRef = useRef(fast)
  const mutationRevisionRef = useRef(0)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const runtimeIdRef = useRef(runtime?.runtimeId)
  useLayoutEffect(() => { runtimeIdRef.current = runtime?.runtimeId })

  const updateModel = useCallback((value: string) => { modelRef.current = value; setModel(value) }, [])
  const updateEffort = useCallback((value: PrimeThinkingLevel) => { effortRef.current = value; setEffort(value) }, [])
  const updateFast = useCallback((value: boolean) => { fastRef.current = value; setFast(value) }, [])

  const queueRuntimeMutation = useCallback((
    runtimeId: string,
    command: () => Promise<void>,
    rollback: () => void,
  ) => {
    const revision = ++mutationRevisionRef.current
    mutationQueueRef.current = mutationQueueRef.current.then(async () => {
      try {
        await command()
      } catch (error) {
        if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
          rollback()
          try { await syncRuntime(runtimeId) } catch (syncError) { reportError(syncError) }
        }
        reportError(error)
        return
      }
      if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
        try { await syncRuntime(runtimeId) } catch (error) { reportError(error) }
      }
    })
  }, [reportError, syncRuntime])

  useEffect(() => () => {
    mutationRevisionRef.current += 1
    runtimeIdRef.current = undefined
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (!bridge || !ready) return
    const target = harness
    setCatalogFor(target, await bridge.providers.catalog(force, target))
  }, [bridge, harness, ready, setCatalogFor])

  const rememberSelection = useCallback((value: string) => {
    if (value && value !== lastSelectedModel) rememberModel?.(value)
  }, [lastSelectedModel, rememberModel])
  const rememberSelectionRef = useRef(rememberSelection)
  useLayoutEffect(() => { rememberSelectionRef.current = rememberSelection })

  const firstUsableModel = useCallback((nextCatalog: PrimeModelCatalog | null | undefined) => (
    nextCatalog?.models.find((candidate) => candidate.enabled !== false && candidate.available)
  ), [])

  const fallbackModel = useCallback((nextCatalog: PrimeModelCatalog | null | undefined) => (
    nextCatalog?.models.find((candidate) => candidate.key === lastSelectedModel && candidate.enabled !== false && candidate.available)
      ?? firstUsableModel(nextCatalog)
  ), [firstUsableModel, lastSelectedModel])

  const selectedModel = useMemo<PrimeModelDescriptor | undefined>(() => {
    return catalog?.models.find((candidate) => candidate.key === model && candidate.enabled !== false && candidate.available)
  }, [catalog, model])
  const reasoningLevels = selectedModel?.availableThinkingLevels ?? runtime?.availableThinkingLevels ?? DEFAULT_REASONING_LEVELS
  // Group once per catalog identity so the composer's <option> tree can memoize.
  const modelsByProvider = useMemo(() => groupModelsByProvider(catalog?.models), [catalog?.models])

  useEffect(() => {
    if (reasoningLevels.includes(effort)) return
    updateEffort(reasoningLevels.includes('medium') ? 'medium' : reasoningLevels[0] ?? 'off')
  }, [effort, reasoningLevels, updateEffort])

  useEffect(() => {
    if (!bridge || !ready) return
    let cancelled = false
    const target = harness
    void bridge.providers.catalog(false, target).then((next) => { if (!cancelled) setCatalogFor(target, next) }).catch(reportError)
    return () => { cancelled = true }
  }, [bridge, harness, ready, reportError, setCatalogFor])

  // The composer's selection belongs to one harness's catalog. Clear the old
  // harness before resolving the new harness's remembered or first model.
  const previousHarnessRef = useRef(harness)
  useEffect(() => {
    if (previousHarnessRef.current === harness) return
    previousHarnessRef.current = harness
    updateModel('')
    updateFast(false)
  }, [harness, updateFast, updateModel])

  useEffect(() => {
    if (!catalog) return
    const current = catalog.models.find((candidate) => candidate.key === modelRef.current && candidate.enabled !== false && candidate.available)
    if (current) return
    const fallback = fallbackModel(catalog)
    updateModel(fallback?.key ?? '')
    if (fallback) rememberSelection(fallback.key)
    if (!fallback?.fastModeSupported) updateFast(false)
  }, [catalog, fallbackModel, harness, rememberSelection, updateFast, updateModel])

  useEffect(() => {
    if (!bridge) return
    return bridge.providers.onAuthEvent((event) => {
      if (event.type === 'complete') {
        setAuthEvent(event)
        void refresh(true).catch(reportError)
      } else if (event.type === 'cancelled') {
        setAuthEvent(null)
      } else if (event.type === 'error') {
        setAuthEvent(event)
      } else if (event.type === 'auth' || event.type === 'progress' || event.type === 'prompt' || event.type === 'select') {
        setAuthEvent(event)
      }
    })
  }, [bridge, refresh, reportError])

  useEffect(() => {
    if (!runtime?.model?.provider || !runtime.model.id || !catalog) return
    const effectiveModel = catalog.models.find((candidate) => candidate.provider === runtime.model?.provider && candidate.id === runtime.model?.id && candidate.enabled !== false && candidate.available)
    if (effectiveModel) {
      updateModel(effectiveModel.key)
      rememberSelectionRef.current(effectiveModel.key)
    }
    if (runtime.thinkingLevel && effectiveModel?.availableThinkingLevels.includes(runtime.thinkingLevel as PrimeThinkingLevel)) updateEffort(runtime.thinkingLevel as PrimeThinkingLevel)
  }, [catalog, runtime?.model?.id, runtime?.model?.provider, runtime?.thinkingLevel, updateEffort, updateModel])

  // Scoped to the runtime's reported tier so a catalog refresh cannot revert
  // an optimistic fast-mode toggle that the runtime has not confirmed yet.
  useEffect(() => {
    if (!runtime) return
    updateFast(runtime.serviceTier === 'priority')
  }, [runtime?.runtimeId, runtime?.serviceTier, updateFast])

  const changeModel = useCallback((nextModelKey: string) => {
    const previous = { model: modelRef.current, effort: effortRef.current, fast: fastRef.current }
    const nextModel = catalog?.models.find((candidate) => candidate.key === nextModelKey)
    const nextEffort = nextModel && !nextModel.availableThinkingLevels.includes(effortRef.current)
      ? nextModel.availableThinkingLevels.includes('medium') ? 'medium' : nextModel.availableThinkingLevels[0] ?? 'off'
      : effortRef.current
    updateModel(nextModelKey)
    updateEffort(nextEffort)
    if (!nextModel?.fastModeSupported) updateFast(false)
    if (!bridge || !runtime || !nextModel) {
      if (nextModel) rememberSelection(nextModelKey)
      return
    }
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => {
        await bridge.agent.command(runtime.runtimeId, { type: 'set_model', provider: nextModel.provider, modelId: nextModel.id })
        await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort })
        rememberSelectionRef.current(nextModelKey)
      },
      () => { updateModel(previous.model); updateEffort(previous.effort); updateFast(previous.fast) },
    )
  }, [bridge, catalog?.models, queueRuntimeMutation, rememberSelection, runtime, updateEffort, updateFast, updateModel])

  const changeEffort = useCallback((nextEffort: PrimeThinkingLevel) => {
    const previous = effortRef.current
    updateEffort(nextEffort)
    if (!bridge || !runtime) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort }) },
      () => updateEffort(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateEffort])

  const changeFast = useCallback((enabled: boolean) => {
    const previous = fastRef.current
    updateFast(enabled)
    if (!bridge || !runtime) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' }) },
      () => updateFast(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateFast])

  // Credentials remain Prime-only, while desktop-owned provider visibility is
  // stored independently for each harness.
  const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    setCatalogFor('prime', await bridge.providers.saveApiKey(providerId, apiKey))
  }, [bridge, setCatalogFor])

  const logout = useCallback(async (providerId: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    setCatalogFor('prime', await bridge.providers.logout(providerId))
  }, [bridge, setCatalogFor])

  const setEnabled = useCallback(async (providerId: string, enabled: boolean) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    const next = await bridge.providers.setEnabled(providerId, enabled, harness)
    setCatalogFor(harness, next)
    const disabledProviders = next.providers.filter((provider) => !provider.enabled).map((provider) => provider.id)
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === modelRef.current)?.provider
    if (selectedProvider && disabledProviders.includes(selectedProvider)) {
      const fallback = fallbackModel(next)
      updateModel(fallback?.key ?? '')
      if (fallback) rememberSelection(fallback.key)
      updateFast(false)
    }
  }, [bridge, catalog?.models, fallbackModel, harness, rememberSelection, setCatalogFor, updateFast, updateModel])

  const setAllEnabled = useCallback(async () => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    setCatalogFor(harness, await bridge.providers.setDisabled([], harness))
  }, [bridge, harness, setCatalogFor])

  const setAllDisabled = useCallback(async () => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    const providerIds = catalog?.providers.map((provider) => provider.id).sort() ?? []
    if (!providerIds.length) throw new Error('Provider catalogue is not loaded.')
    setCatalogFor(harness, await bridge.providers.setDisabled(providerIds, harness))
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === modelRef.current)?.provider
    if (selectedProvider && providerIds.includes(selectedProvider)) {
      updateModel('')
      updateFast(false)
    }
  }, [bridge, catalog?.models, catalog?.providers, harness, setCatalogFor, updateFast, updateModel])

  const setModelEnabled = useCallback(async (modelKey: string, enabled: boolean) => {
    if (!bridge) throw new Error('Models can only be configured in the desktop app.')
    const next = await bridge.providers.setModelEnabled(modelKey, enabled, harness)
    setCatalogFor(harness, next)
    if (!enabled && modelRef.current === modelKey) {
      const fallback = fallbackModel(next)
      updateModel(fallback?.key ?? '')
      if (fallback) rememberSelection(fallback.key)
      updateFast(false)
    }
  }, [bridge, fallbackModel, harness, rememberSelection, setCatalogFor, updateFast, updateModel])

  const startOAuth = useCallback(async (providerId: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    await bridge.providers.startOAuth(providerId)
  }, [bridge])

  const respondOAuth = useCallback((promptId: string, value?: string) => {
    if (!bridge || !authEvent) return
    void bridge.providers.respondOAuth(authEvent.flowId, promptId, value).catch(reportError)
  }, [authEvent, bridge, reportError])

  const cancelOAuth = useCallback(() => {
    if (bridge && authEvent) void bridge.providers.cancelOAuth(authEvent.flowId).catch(reportError)
    setAuthEvent(null)
  }, [authEvent, bridge, reportError])

  return {
    model, effort, fast, catalog, authEvent, selectedModel, reasoningLevels, modelsByProvider,
    refresh, changeModel, changeEffort, changeFast,
    saveApiKey, logout, setEnabled, setAllEnabled, setAllDisabled, setModelEnabled, startOAuth, respondOAuth, cancelOAuth,
  }
}
