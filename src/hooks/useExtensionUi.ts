import type { AgentRpcCommand } from '@/types/agent-command'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { ASK_USER_TIMEOUT_MS, extensionUiDialogId, questionnaireContents, parseExtensionUiCancel, parseExtensionUiRequest, type ExtensionUiRequest, type QuestionnaireSelectRequest } from '@/lib/extension-ui'
import { formattingLocaleTag, translate } from '@/lib/i18n'
import type { ExtensionUiQuestionnaireProgress, PrimeWorkApi, RuntimeInfo, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: PrimeWorkApi | null
  askUserTimeoutMs?: number
  activeRuntimeId?: string
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  reportError(error: unknown): void
}

export interface PendingExtensionUi {
  runtimeId: string
  request: ExtensionUiRequest
  requests?: QuestionnaireSelectRequest[]
  // GooeyPi's own Ask User timeout, as opposed to one the harness enforces.
  // It pauses while its dialog is hidden; remainingMs is what is left of it
  // when its timer next starts.
  ownedTimeout?: { remainingMs: number; hiddenRemainingMs?: number }
  hiddenDeadline?: number
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
  askUserTimeoutMs = ASK_USER_TIMEOUT_MS,
  activeRuntimeId,
  runtimeSessionsRef,
  setSessions,
  setRuntime,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<PendingExtensionUi | null>(null)
  const extensionUiRef = useRef<PendingExtensionUi | null>(null)
  const pendingByRuntimeRef = useRef<Map<string, PendingExtensionUi>>(new Map())
  const progressByRuntimeRef = useRef(new Map<string, Map<string, ExtensionUiQuestionnaireProgress>>())
  const timerByRuntimeRef = useRef<Map<string, number>>(new Map())
  const timedOutQuestionnairesRef = useRef<Set<string>>(new Set())
  const askUserTimeoutRef = useRef(askUserTimeoutMs)
  useLayoutEffect(() => { askUserTimeoutRef.current = askUserTimeoutMs })
  const activeRuntimeIdRef = useRef(activeRuntimeId)
  useLayoutEffect(() => { activeRuntimeIdRef.current = activeRuntimeId })

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const targetRuntimeId = runtimeId ?? extensionUiRef.current?.runtimeId
    if (!targetRuntimeId) return
    const timer = timerByRuntimeRef.current.get(targetRuntimeId)
    if (timer !== undefined) window.clearTimeout(timer)
    timerByRuntimeRef.current.delete(targetRuntimeId)
    progressByRuntimeRef.current.delete(targetRuntimeId)
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
      } satisfies AgentRpcCommand).catch(() => undefined)
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
        const requests = pending.requests ?? []
        const results = await Promise.allSettled(requests.map((request) => bridge.agent.command(pending.runtimeId, {
          type: 'extension_ui_response', id: request.id,
          ...('values' in response ? { value: response.values[request.id] ?? '' } : { cancelled: true }),
        } satisfies AgentRpcCommand)))
        const failed = results.flatMap((result, index) => result.status === 'rejected' ? [{ id: requests[index].id, error: result.reason }] : [])
        await Promise.allSettled(failed.map(({ id }) => bridge.agent.command(pending.runtimeId, { type: 'extension_ui_response', id, cancelled: true } satisfies AgentRpcCommand)))
        if (failed.length) throw failed[0].error
        return
      }
      if ('values' in response) { cancelPending(pending); return }
      await bridge.agent.command(pending.runtimeId, {
        type: 'extension_ui_response',
        id: pending.request.id,
        ...response,
      } satisfies AgentRpcCommand)
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

  const startTimer = useCallback((pending: PendingExtensionUi, delay: number, hidden = false): PendingExtensionUi => {
    const { runtimeId, request } = pending
    window.clearTimeout(timerByRuntimeRef.current.get(runtimeId))
    timerByRuntimeRef.current.set(runtimeId, window.setTimeout(() => {
      const current = pendingByRuntimeRef.current.get(runtimeId)
      if (current?.request.id === request.id) expirePending(current)
    }, delay))
    return hidden ? { ...pending, hiddenDeadline: Date.now() + delay } : { ...pending, deadline: Date.now() + delay }
  }, [expirePending])

  // A harness timeout runs from arrival, because the harness enforces the same
  // deadline itself. GooeyPi's own Ask User timeout only runs while its dialog
  // is visible (its runtime is active and the window is not hidden), so a
  // question in a background session waits for the user. App-owned questions
  // expire after 30 cumulative hidden minutes so abandoned questions settle.
  const syncTimer = useCallback((runtimeId: string): PendingExtensionUi | null => {
    const pending = pendingByRuntimeRef.current.get(runtimeId)
    if (!pending) return null
    let next = pending
    if (!pending.ownedTimeout) {
      const timeout = 'timeout' in pending.request ? pending.request.timeout : undefined
      if (timeout !== undefined && pending.deadline === undefined) next = startTimer(pending, timeout)
    } else {
      const visible = activeRuntimeIdRef.current === runtimeId && document.visibilityState !== 'hidden'
      const ownedTimeout = { ...pending.ownedTimeout }
      if (visible) {
        if (pending.hiddenDeadline !== undefined) {
          window.clearTimeout(timerByRuntimeRef.current.get(runtimeId))
          timerByRuntimeRef.current.delete(runtimeId)
          ownedTimeout.hiddenRemainingMs = Math.max(0, pending.hiddenDeadline - Date.now())
          next = { ...pending, ownedTimeout, hiddenDeadline: undefined }
        }
        if (next.deadline === undefined && ownedTimeout.remainingMs > 0) next = startTimer(next, ownedTimeout.remainingMs)
      } else {
        if (pending.deadline !== undefined) {
          ownedTimeout.remainingMs = Math.max(0, pending.deadline - Date.now())
          next = { ...pending, ownedTimeout, deadline: undefined }
        }
        if (next.hiddenDeadline === undefined) next = startTimer(next, ownedTimeout.hiddenRemainingMs ?? 30 * 60_000, true)
      }
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
    if (!bridge) return
    if (!request) {
      const id = extensionUiDialogId(rawEvent)
      if (id) void bridge.agent.command(runtimeId, { type: 'extension_ui_response', id, cancelled: true } satisfies AgentRpcCommand).catch(() => undefined)
      return
    }

    if (request.method === 'select' && request.questionnaire) {
      const groupedRequest = { ...request, questionnaire: request.questionnaire }
      const progress = progressByRuntimeRef.current.get(runtimeId)?.get(request.questionnaire.groupId)
      if (progress?.settled.includes(request.questionnaire.index)) return
      const questionnaireKey = `${runtimeId}:${request.questionnaire.groupId}`
      if (timedOutQuestionnairesRef.current.has(questionnaireKey)) {
        void bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: request.id,
          cancelled: true,
        } satisfies AgentRpcCommand).catch(() => undefined)
        return
      }
      const previous = pendingByRuntimeRef.current.get(runtimeId)
      const sameQuestionnaire = previous?.request.method === 'questionnaire' && previous.request.id === request.questionnaire.groupId
      if (previous && !sameQuestionnaire) {
        cancelPending(previous)
        clearExtensionUi(runtimeId)
        if (progress) progressByRuntimeRef.current.set(runtimeId, new Map([[progress.groupId, progress]]))
      }

      const existing = (sameQuestionnaire ? previous?.requests ?? [] : []).filter((item) => !progress?.settled.includes(item.questionnaire.index))
      const requests = existing.some((item) => item.id === request.id)
        ? existing
        : [...existing, groupedRequest]
      const { questions, total, complete } = questionnaireContents(requests, progress)
      presentPending({
        // Later questions of a group keep the timer the first one started.
        ...(sameQuestionnaire
          ? previous
          : { runtimeId, ownedTimeout: request.timeout === undefined ? { remainingMs: askUserTimeoutRef.current } : undefined }),
        request: {
          method: 'questionnaire',
          id: request.questionnaire.groupId,
          // The App shell owns this hook (above `I18nProvider`), so the dialog
          // title is worded from the app-wide locale mirror at request time.
          title: translate(formattingLocaleTag(), 'extensionUi.answerTitle', { count: total }),
          questions,
          total,
          complete,
          // Only a harness-timed questionnaire's timer reads this. GooeyPi's
          // own timeout runs from ownedTimeout.
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

  const rehydrateExtensionUi = useCallback((runtime: Pick<RuntimeInfo, 'runtimeId' | 'pendingExtensionUi' | 'pendingExtensionUiGroups'>) => {
    if (runtime.pendingExtensionUi === undefined && runtime.pendingExtensionUiGroups === undefined) return
    const frames = runtime.pendingExtensionUi ?? []
    const ids = new Set(frames.map(extensionUiDialogId).filter((id) => id !== undefined))
    const previous = pendingByRuntimeRef.current.get(runtime.runtimeId)
    if (previous && !requestIds(previous).some((id) => ids.has(id))) clearExtensionUi(runtime.runtimeId)
    const groups = new Map((runtime.pendingExtensionUiGroups ?? []).map((group) => [group.groupId, group]))
    if (groups.size) progressByRuntimeRef.current.set(runtime.runtimeId, groups)
    else progressByRuntimeRef.current.delete(runtime.runtimeId)
    for (const frame of frames) {
      const parsed = parseExtensionUiRequest(frame)
      const current = pendingByRuntimeRef.current.get(runtime.runtimeId)
      // Recompute grouped membership even for a known id when other indexes settled.
      if (parsed && !(parsed.method === 'select' && parsed.questionnaire) && current && requestIds(current).includes(parsed.id)) continue
      showExtensionUi(runtime.runtimeId, frame)
    }
  }, [clearExtensionUi, showExtensionUi])

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
    progressByRuntimeRef.current.clear()
    timedOutQuestionnairesRef.current.clear()
  }, [cancelPending])

  return { extensionUi, clearExtensionUi, respondToExtensionUi, showExtensionUi, rehydrateExtensionUi, hasOpenRequestForSession }
}
