import type { AgentRpcCommand } from '@/types/agent-command'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isUsableModel, preferredModel } from '@/lib/models'
import { formattingLocaleTag, translate } from '@/lib/i18n'
import { PRIME_THINKING_LEVELS } from '@/types/api/models'
import type { HarnessId, PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeWorkApi, ProviderAuthEvent, RuntimeInfo, SessionRecord } from '@/types/api'

type ActiveProviderAuthEvent = Exclude<ProviderAuthEvent, { type: 'cancelled' }>

/**
 * The App shell calls this hook above the `I18nProvider` it renders, so
 * `useI18n()` there would only ever return the English default. These messages
 * are thrown on demand and surface in Provider Settings' inline error, so the
 * app-wide locale mirror is read when the error is created.
 */

/** Stable fallback identities so consumers can memoize on prop equality. */
const DEFAULT_REASONING_LEVELS = PRIME_THINKING_LEVELS

/**
 * How long to wait between automatic re-reads of a catalog that came back empty.
 *
 * A failed read used to be terminal for the session: nothing but a harness switch or an OAuth flow
 * asked for the list again, so a harness that was slow to boot left the model picker unusable until
 * relaunch. Retrying is what fixes that; bounding the schedule is what keeps a harness that is not
 * installed -- which answers instantly and forever -- from becoming a poll loop. Only a forced read
 * counts as an attempt, and the schedule restarts when the user asks again from the picker.
 */
export const CATALOG_RETRY_DELAYS_MS = [2_000, 8_000, 20_000]

interface CatalogFailure {
  /** Why the list is missing, in the harness's own words; null when the read itself failed. */
  reason: string | null
}

/**
 * Distinguish a failed read from a harness that legitimately has nothing to show.
 *
 * The main process degrades a failed probe to an empty list plus a `warning` saying what happened, so
 * an empty list carrying a warning is a failure the user can act on. An empty list with no warning
 * means no provider is configured, which the picker already words correctly on its own.
 */
function emptyCatalogFailureReason(catalog: PrimeModelCatalog): string | null {
  if (catalog.models.length > 0) return null
  const warning = catalog.warning?.trim()
  return warning ? warning : null
}

/** Resolve a session's persisted model against the catalog, matching either the model id or the full key. */
function findSessionModel(catalog: PrimeModelCatalog, session: Pick<SessionRecord, 'model' | 'provider'> | undefined): PrimeModelDescriptor | undefined {
  if (!session?.provider || !session.model) return undefined
  return catalog.models.find((candidate) => candidate.provider === session.provider && (candidate.id === session.model || candidate.key === session.model) && isUsableModel(candidate))
    ?? catalog.models.find((candidate) => candidate.id === session.model && isUsableModel(candidate))
}

interface PendingSelection { model: string; effort: PrimeThinkingLevel }

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
  /** Active session metadata if available. */
  activeSession?: SessionRecord
  /** Persisted per-harness model preference. */
  lastSelectedModel?: string
  rememberModel?(modelKey: string): void
  syncRuntime(runtimeId: string): Promise<void>
  reportError(error: unknown): void
}

export function useProviderCatalog({ bridge, ready = true, harness = 'prime', runtime, activeSession, lastSelectedModel = '', rememberModel, syncRuntime, reportError }: UseProviderCatalogOptions) {
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
  // Kept beside the catalogs rather than derived from them: the first read of a run can reject, in
  // which case there is no catalog to inspect at all and the reason lives only here.
  const [catalogFailures, setCatalogFailures] = useState<Partial<Record<HarnessId, CatalogFailure>>>({})
  const catalogFailure = catalogFailures[harness] ?? null
  const [refreshing, setRefreshing] = useState(false)
  const retryAttemptRef = useRef(0)
  const clearCatalogRetry = useCallback(() => {
    retryAttemptRef.current = 0
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
    setRefreshing(true)
    try {
      const next = await bridge.providers.catalog(force, target)
      setCatalogFor(target, next)
      const reason = emptyCatalogFailureReason(next)
      setCatalogFailures((current) => ({ ...current, [target]: reason === null ? undefined : { reason } }))
    } catch (error) {
      // The read rejecting means nothing was ever served for this harness, so the picker would have
      // no warning to show and would look like an empty account. Keep the reason here instead.
      setCatalogFailures((current) => ({ ...current, [target]: { reason: error instanceof Error ? error.message : String(error) } }))
      throw error
    } finally {
      setRefreshing(false)
    }
  }, [bridge, harness, ready, setCatalogFor])

  const retryCatalog = useCallback(() => {
    clearCatalogRetry()
    return refresh(true).catch(() => {})
  }, [clearCatalogRetry, refresh])

  const rememberSelection = useCallback((value: string) => {
    if (value && value !== lastSelectedModel) rememberModel?.(value)
  }, [lastSelectedModel, rememberModel])
  const rememberSelectionRef = useRef(rememberSelection)
  useLayoutEffect(() => { rememberSelectionRef.current = rememberSelection })

  const fallbackModel = useCallback((nextCatalog: PrimeModelCatalog | null | undefined) => {
    if (nextCatalog) {
      const sessionModel = findSessionModel(nextCatalog, activeSession)
      if (sessionModel) return sessionModel
    }
    return preferredModel(nextCatalog?.models, lastSelectedModel)
  }, [activeSession, lastSelectedModel])

  const selectedModel = useMemo<PrimeModelDescriptor | undefined>(() => {
    return catalog?.models.find((candidate) => candidate.key === model && isUsableModel(candidate))
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
    void refresh().catch(reportError)
  }, [bridge, harness, ready, reportError, refresh])

  // One failed read used to be the last word for the whole session: only a harness switch or an OAuth
  // callback asked for the list again, so a harness that was slow to boot left the picker empty until
  // relaunch. Retry on a bounded schedule instead -- the harness is often ready seconds later -- and
  // stop rather than turn "not installed", which fails instantly forever, into a poll loop.
  useEffect(() => {
    if (!bridge || !ready || !catalogFailure) {
      retryAttemptRef.current = 0
      return
    }
    if (refreshing) return
    const attempt = retryAttemptRef.current
    if (attempt >= CATALOG_RETRY_DELAYS_MS.length) return
    const timer = setTimeout(() => {
      retryAttemptRef.current = attempt + 1
      void refresh(true).catch(() => {})
    }, CATALOG_RETRY_DELAYS_MS[attempt])
    return () => clearTimeout(timer)
  }, [bridge, catalogFailure, harness, ready, refresh, refreshing])

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
    const current = catalog.models.find((candidate) => candidate.key === modelRef.current && isUsableModel(candidate))
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

  // Selections made while a session has no live runtime are only local state,
  // so they are parked per session (new tabs share the '' key) until a runtime
  // reports them back or the user returns to that tab.
  const pendingSelectionsRef = useRef(new Map<string, PendingSelection>())
  const sessionKey = activeSession?.id ?? ''
  const sessionKeyRef = useRef(sessionKey)
  useLayoutEffect(() => { sessionKeyRef.current = sessionKey })
  // Starts undefined so the first render with a catalog counts as a switch and
  // restores the initial session's effort as well as its model.
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!catalog) return
    const sessionChanged = activeSessionIdRef.current !== activeSession?.id
    activeSessionIdRef.current = activeSession?.id

    // Precedence: live runtime, then the tab's unsent selection, then the
    // session's persisted metadata. The latter two only apply when the tab
    // changes so a catalog refresh cannot revert what the user picked.
    if (runtime?.model?.provider && runtime.model.id) {
      pendingSelectionsRef.current.delete(sessionKey)
      const runtimeModel = catalog.models.find((candidate) => candidate.provider === runtime.model?.provider && candidate.id === runtime.model?.id && isUsableModel(candidate))
      if (runtimeModel) {
        if (modelRef.current !== runtimeModel.key) updateModel(runtimeModel.key)
        rememberSelectionRef.current(runtimeModel.key)
      }
      if (runtime.thinkingLevel && runtimeModel?.availableThinkingLevels.includes(runtime.thinkingLevel as PrimeThinkingLevel)) {
        if (effortRef.current !== runtime.thinkingLevel) updateEffort(runtime.thinkingLevel as PrimeThinkingLevel)
      }
      return
    }
    if (!sessionChanged) return

    const pending = pendingSelectionsRef.current.get(sessionKey)
    const pendingModel = pending && catalog.models.find((candidate) => candidate.key === pending.model && isUsableModel(candidate))
    if (pending && pendingModel) {
      if (modelRef.current !== pendingModel.key) updateModel(pendingModel.key)
      if (pendingModel.availableThinkingLevels.includes(pending.effort) && effortRef.current !== pending.effort) updateEffort(pending.effort)
      return
    }

    const sessionModel = findSessionModel(catalog, activeSession)
    if (sessionModel && modelRef.current !== sessionModel.key) updateModel(sessionModel.key)
    if (activeSession?.thinkingLevel && sessionModel?.availableThinkingLevels.includes(activeSession.thinkingLevel as PrimeThinkingLevel)) {
      if (effortRef.current !== activeSession.thinkingLevel) updateEffort(activeSession.thinkingLevel as PrimeThinkingLevel)
    }
  }, [activeSession, catalog, runtime?.model?.id, runtime?.model?.provider, runtime?.thinkingLevel, sessionKey, updateEffort, updateModel])

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
      if (nextModel) {
        pendingSelectionsRef.current.set(sessionKeyRef.current, { model: nextModelKey, effort: nextEffort })
        rememberSelection(nextModelKey)
      }
      return
    }
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => {
        await bridge.agent.command(runtime.runtimeId, { type: 'set_model', provider: nextModel.provider, modelId: nextModel.id } satisfies AgentRpcCommand)
        await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort } satisfies AgentRpcCommand)
        rememberSelectionRef.current(nextModelKey)
      },
      () => { updateModel(previous.model); updateEffort(previous.effort); updateFast(previous.fast) },
    )
  }, [bridge, catalog?.models, queueRuntimeMutation, rememberSelection, runtime, updateEffort, updateFast, updateModel])

  const changeEffort = useCallback((nextEffort: PrimeThinkingLevel) => {
    const previous = effortRef.current
    updateEffort(nextEffort)
    if (!bridge || !runtime) {
      pendingSelectionsRef.current.set(sessionKeyRef.current, { model: modelRef.current, effort: nextEffort })
      return
    }
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort } satisfies AgentRpcCommand) },
      () => updateEffort(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateEffort])

  const changeFast = useCallback((enabled: boolean) => {
    const previous = fastRef.current
    updateFast(enabled)
    if (!bridge || !runtime) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' } satisfies AgentRpcCommand) },
      () => updateFast(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateFast])

  const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
    setCatalogFor(harness, await bridge.providers.saveApiKey(providerId, apiKey, harness))
  }, [bridge, harness, setCatalogFor])

  const logout = useCallback(async (providerId: string) => {
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
    setCatalogFor(harness, await bridge.providers.logout(providerId, harness))
  }, [bridge, harness, setCatalogFor])

  const setEnabled = useCallback(async (providerId: string, enabled: boolean) => {
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
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
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
    setCatalogFor(harness, await bridge.providers.setDisabled([], harness))
  }, [bridge, harness, setCatalogFor])

  const setAllDisabled = useCallback(async () => {
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
    const providerIds = catalog?.providers.map((provider) => provider.id).sort() ?? []
    if (!providerIds.length) throw new Error(translate(formattingLocaleTag(), 'error.providerCatalogNotLoaded'))
    setCatalogFor(harness, await bridge.providers.setDisabled(providerIds, harness))
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === modelRef.current)?.provider
    if (selectedProvider && providerIds.includes(selectedProvider)) {
      updateModel('')
      updateFast(false)
    }
  }, [bridge, catalog?.models, catalog?.providers, harness, setCatalogFor, updateFast, updateModel])

  const setModelEnabled = useCallback(async (modelKey: string, enabled: boolean) => {
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.modelsDesktopOnly'))
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
    if (!bridge) throw new Error(translate(formattingLocaleTag(), 'error.providersDesktopOnly'))
    await bridge.providers.startOAuth(providerId, harness)
  }, [bridge, harness])

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
    catalogFailed: catalogFailure !== null,
    catalogError: catalogFailure?.reason ?? null,
    catalogRetrying: refreshing && catalogFailure !== null,
    retryCatalog,
    refresh, changeModel, changeEffort, changeFast,
    saveApiKey, logout, setEnabled, setAllEnabled, setAllDisabled, setModelEnabled, startOAuth, respondOAuth, cancelOAuth,
  }
}

/** What the provider hook gives the composer and the settings pages; exported so a caller can type its own prop. */
export type ProviderCatalog = ReturnType<typeof useProviderCatalog>
