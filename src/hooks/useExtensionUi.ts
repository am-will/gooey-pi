import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { ASK_USER_TIMEOUT_MS, parseExtensionUiCancel, parseExtensionUiRequest, type ExtensionUiRequest } from '@/lib/extension-ui'
import type { PrimeWorkApi, RuntimeInfo, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: PrimeWorkApi | null
  activeRuntimeId?: string
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  reportError(error: unknown): void
}

type QuestionnaireSelectRequest = Extract<ExtensionUiRequest, { method: 'select' }>

export interface PendingExtensionUi {
  runtimeId: string
  request: ExtensionUiRequest
  requests?: QuestionnaireSelectRequest[]
  // GooeyPi's own Ask User timeout, as opposed to one the harness enforces.
  // It pauses while its dialog is hidden; remainingMs is what is left of it
  // when its timer next starts.
  ownedTimeout?: { remainingMs: number }
  // Epoch ms at which the running timer expires the dialog.
  deadline?: number
}

export function pendingExtensionUiForRuntime(
  pending: ReadonlyMap<string, PendingExtensionUi>,
  runtimeId?: string,
): PendingExtensionUi | null {
  return runtimeId ? pending.get(runtimeId) ?? null : null
}

function requestIds(pending: PendingExtensionUi): string[] {
  return pending.request.method === 'questionnaire'
    ? (pending.requests ?? []).map((request) => request.id)
    : [pending.request.id]
}

export function useExtensionUi({
  bridge,
  activeRuntimeId,
  runtimeSessionsRef,
  setSessions,
  setRuntime,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<PendingExtensionUi | null>(null)
  const extensionUiRef = useRef<PendingExtensionUi | null>(null)
  const pendingByRuntimeRef = useRef<Map<string, PendingExtensionUi>>(new Map())
  const timerByRuntimeRef = useRef<Map<string, number>>(new Map())
  const timedOutQuestionnairesRef = useRef<Set<string>>(new Set())
  const activeRuntimeIdRef = useRef(activeRuntimeId)
  useLayoutEffect(() => { activeRuntimeIdRef.current = activeRuntimeId })

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const targetRuntimeId = runtimeId ?? extensionUiRef.current?.runtimeId
    if (!targetRuntimeId) return
    const timer = timerByRuntimeRef.current.get(targetRuntimeId)
    if (timer !== undefined) window.clearTimeout(timer)
    timerByRuntimeRef.current.delete(targetRuntimeId)
    pendingByRuntimeRef.current.delete(targetRuntimeId)
    if (extensionUiRef.current?.runtimeId === targetRuntimeId) {
      extensionUiRef.current = null
      setExtensionUi(null)
    }
  }, [])

  const cancelPending = useCallback((pending: PendingExtensionUi) => {
    if (!bridge) return
    for (const id of requestIds(pending)) {
      void bridge.agent.command(pending.runtimeId, {
        type: 'extension_ui_response',
        id,
        cancelled: true,
      }).catch(() => undefined)
    }
  }, [bridge])

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    const pending = extensionUiRef.current
    if (!pending) return
    clearExtensionUi(pending.runtimeId)
    if ('cancelled' in response && response.cancelled) {
      if (!bridge) return
      try {
        await bridge.agent.stop(pending.runtimeId)
        setRuntime((current) => current?.runtimeId === pending.runtimeId ? { ...current, isStreaming: false } : current)
      } catch (error) {
        // If stopping the runtime fails, still resolve the extension request so
        // it cannot remain blocked behind a dialog that is no longer visible.
        cancelPending(pending)
        setRuntime((current) => current?.runtimeId === pending.runtimeId ? { ...current, isStreaming: false } : current)
        if (activeRuntimeIdRef.current === pending.runtimeId) reportError(error)
      }
      return
    }
    setRuntime((current) => current?.runtimeId === pending.runtimeId ? { ...current, isStreaming: true } : current)
    const pendingSession = runtimeSessionsRef.current.get(pending.runtimeId)
    if (pendingSession) {
      setSessions((items) => items.map((session) => session.filePath === pendingSession
        ? { ...session, status: 'running', unread: false }
        : session))
    }
    if (!bridge) return
    try {
      if (pending.request.method === 'questionnaire') {
        if ('values' in response) {
          for (const request of pending.requests ?? []) {
            await bridge.agent.command(pending.runtimeId, {
              type: 'extension_ui_response',
              id: request.id,
              value: response.values[request.id] ?? '',
            })
          }
        } else {
          for (const id of requestIds(pending)) {
            await bridge.agent.command(pending.runtimeId, {
              type: 'extension_ui_response',
              id,
              cancelled: true,
            })
          }
        }
        return
      }
      await bridge.agent.command(pending.runtimeId, {
        type: 'extension_ui_response',
        id: pending.request.id,
        ...response,
      })
    } catch (error) {
      setRuntime((current) => current?.runtimeId === pending.runtimeId ? { ...current, isStreaming: false } : current)
      if (activeRuntimeIdRef.current === pending.runtimeId) reportError(error)
    }
  }, [bridge, cancelPending, clearExtensionUi, reportError, runtimeSessionsRef, setRuntime, setSessions])

  const expirePending = useCallback((pending: PendingExtensionUi) => {
    if (pending.request.method === 'questionnaire') timedOutQuestionnairesRef.current.add(`${pending.runtimeId}:${pending.request.id}`)
    cancelPending(pending)
    clearExtensionUi(pending.runtimeId)
  }, [cancelPending, clearExtensionUi])

  const startTimer = useCallback((pending: PendingExtensionUi, delay: number): PendingExtensionUi => {
    const { runtimeId, request } = pending
    timerByRuntimeRef.current.set(runtimeId, window.setTimeout(() => {
      const current = pendingByRuntimeRef.current.get(runtimeId)
      if (current?.request.id === request.id) expirePending(current)
    }, delay))
    return { ...pending, deadline: Date.now() + delay }
  }, [expirePending])

  // A harness timeout runs from arrival, because the harness enforces the same
  // deadline itself. GooeyPi's own Ask User timeout only runs while its dialog
  // is visible (its runtime is active and the window is not hidden), so a
  // question in a background session waits for the user.
  const syncTimer = useCallback((runtimeId: string): PendingExtensionUi | null => {
    const pending = pendingByRuntimeRef.current.get(runtimeId)
    if (!pending) return null
    let next = pending
    if (!pending.ownedTimeout) {
      const timeout = 'timeout' in pending.request ? pending.request.timeout : undefined
      if (timeout !== undefined && pending.deadline === undefined) next = startTimer(pending, timeout)
    } else if (activeRuntimeIdRef.current === runtimeId && document.visibilityState !== 'hidden') {
      if (pending.deadline === undefined) next = startTimer(pending, pending.ownedTimeout.remainingMs)
    } else if (pending.deadline !== undefined) {
      window.clearTimeout(timerByRuntimeRef.current.get(runtimeId))
      timerByRuntimeRef.current.delete(runtimeId)
      next = { ...pending, ownedTimeout: { remainingMs: Math.max(0, pending.deadline - Date.now()) }, deadline: undefined }
    }
    if (next !== pending) pendingByRuntimeRef.current.set(runtimeId, next)
    return next
  }, [startTimer])

  const showPendingForActiveRuntime = useCallback(() => {
    for (const runtimeId of pendingByRuntimeRef.current.keys()) syncTimer(runtimeId)
    const visible = pendingExtensionUiForRuntime(pendingByRuntimeRef.current, activeRuntimeIdRef.current)
    extensionUiRef.current = visible
    setExtensionUi(visible)
  }, [syncTimer])

  const presentPending = useCallback((pending: PendingExtensionUi) => {
    pendingByRuntimeRef.current.set(pending.runtimeId, pending)
    const current = syncTimer(pending.runtimeId)
    if (activeRuntimeIdRef.current !== pending.runtimeId) return
    extensionUiRef.current = current
    setExtensionUi(current)
  }, [syncTimer])

  const showExtensionUi = useCallback((runtimeId: string, rawEvent: Record<string, unknown>) => {
    const cancelledId = parseExtensionUiCancel(rawEvent)
    if (cancelledId) {
      // The harness has already settled the cancelled request, so answering it
      // again is a no-op. Expiring the whole questionnaire also releases its
      // other questions and turns away any that arrive later.
      const pending = pendingByRuntimeRef.current.get(runtimeId)
      if (pending && requestIds(pending).includes(cancelledId)) expirePending(pending)
      return
    }
    const request = parseExtensionUiRequest(rawEvent)
    if (!request || !bridge) return

    if (request.method === 'select' && request.questionnaire) {
      const questionnaireKey = `${runtimeId}:${request.questionnaire.groupId}`
      if (timedOutQuestionnairesRef.current.has(questionnaireKey)) {
        void bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: request.id,
          cancelled: true,
        }).catch(() => undefined)
        return
      }
      const previous = pendingByRuntimeRef.current.get(runtimeId)
      const sameQuestionnaire = previous?.request.method === 'questionnaire' && previous.request.id === request.questionnaire.groupId
      if (previous && !sameQuestionnaire) {
        cancelPending(previous)
        clearExtensionUi(runtimeId)
      }

      const existing = sameQuestionnaire ? previous?.requests ?? [] : []
      const requests = existing.some((item) => item.id === request.id)
        ? existing
        : [...existing, request]
      const questions = requests
        .map((item) => ({
          id: item.id,
          title: item.title,
          options: item.options,
          index: item.questionnaire?.index ?? 0,
        }))
        .sort((a, b) => a.index - b.index)
      const total = request.questionnaire.total
      presentPending({
        // Later questions of a group keep the timer the first one started.
        ...(sameQuestionnaire
          ? previous
          : { runtimeId, ownedTimeout: request.timeout === undefined ? { remainingMs: ASK_USER_TIMEOUT_MS } : undefined }),
        request: {
          method: 'questionnaire',
          id: request.questionnaire.groupId,
          title: `Answer ${total} question${total === 1 ? '' : 's'}`,
          questions,
          total,
          complete: questions.length >= total,
          timeout: request.timeout ?? ASK_USER_TIMEOUT_MS,
        },
        requests,
      })
      return
    }

    const previous = pendingByRuntimeRef.current.get(runtimeId)
    if (previous) {
      cancelPending(previous)
      clearExtensionUi(runtimeId)
    }
    presentPending({ runtimeId, request })
  }, [bridge, cancelPending, clearExtensionUi, expirePending, presentPending])

  const hasOpenRequestForSession = useCallback((filePath: string): boolean => {
    for (const runtimeId of pendingByRuntimeRef.current.keys()) {
      if (runtimeSessionsRef.current.get(runtimeId) === filePath) return true
    }
    return false
  }, [runtimeSessionsRef])

  useEffect(() => { showPendingForActiveRuntime() }, [activeRuntimeId, showPendingForActiveRuntime])

  useEffect(() => {
    document.addEventListener('visibilitychange', showPendingForActiveRuntime)
    return () => document.removeEventListener('visibilitychange', showPendingForActiveRuntime)
  }, [showPendingForActiveRuntime])

  useEffect(() => () => {
    for (const timer of timerByRuntimeRef.current.values()) window.clearTimeout(timer)
    for (const pending of pendingByRuntimeRef.current.values()) cancelPending(pending)
    timerByRuntimeRef.current.clear()
    pendingByRuntimeRef.current.clear()
    timedOutQuestionnairesRef.current.clear()
  }, [cancelPending])

  return { extensionUi, clearExtensionUi, respondToExtensionUi, showExtensionUi, hasOpenRequestForSession }
}
