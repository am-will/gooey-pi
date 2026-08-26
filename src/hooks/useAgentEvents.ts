import { useEffect } from 'react'
import { contextUsageFromEvent } from '@/app/agent-events'
import { applySessionLifecycleEvent, sessionLifecycleChange } from '@/app/session-attention'
import { fallbackModelFromRecord } from '@/lib/events/model-fallback'
import { parseSessionActionSnapshot } from '@/lib/session-actions'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type { PrimeWorkApi, RuntimeInfo, SessionActionSnapshot, SessionRecord } from '@/types/api'

interface UseAgentEventsOptions {
  bridge: PrimeWorkApi | null
  runtimeIdRef: React.RefObject<string | null>
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  runtimeOwnerRef: React.RefObject<{ runtimeId: string; generation: number } | null>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  reconcileQueuedPrompts?(snapshot: SessionActionSnapshot): void
  clearQueuedPromptFlushFailures?(): void
  clearQueuedPrompts?(): void
  queueAgentEvent(event: Record<string, unknown>): void
  reconcileTranscriptForEvent(runtimeId: string, event: Record<string, unknown>): void
  showExtensionUi(runtimeId: string, event: Record<string, unknown>): void
  clearExtensionUi(runtimeId?: string): void
  refreshGit(): Promise<void>
  refreshGitOnTerminalEvent: boolean
  activeSessionVisible: boolean
}

export function useAgentEvents({
  bridge,
  runtimeIdRef,
  runtimeSessionsRef,
  runtimeOwnerRef,
  workspaceRef,
  setSessions,
  setRuntime,
  reconcileQueuedPrompts = () => undefined,
  clearQueuedPromptFlushFailures = () => undefined,
  clearQueuedPrompts = () => undefined,
  queueAgentEvent,
  reconcileTranscriptForEvent,
  showExtensionUi,
  clearExtensionUi,
  refreshGit,
  refreshGitOnTerminalEvent,
  activeSessionVisible,
}: UseAgentEventsOptions) {
  useEffect(() => {
    if (!bridge) return
    let gitRefreshTimer: number | null = null
    const scheduleGitRefresh = () => {
      if (gitRefreshTimer !== null) return
      gitRefreshTimer = window.setTimeout(() => {
        gitRefreshTimer = null
        void refreshGit()
      }, 160)
    }
    const unsubscribe = bridge.agent.onEvent(({ runtimeId, event }) => {
      const type = typeof event.type === 'string' ? event.type : ''
      const sessionFile = runtimeSessionsRef.current.get(runtimeId)
        ?? (runtimeIdRef.current === runtimeId ? workspaceRef.current.sessionFile : undefined)
      if (sessionFile) {
        runtimeSessionsRef.current.set(runtimeId, sessionFile)
        if (sessionLifecycleChange(event)) {
          const visible = activeSessionVisible && workspaceRef.current.sessionFile === sessionFile
          setSessions((items) => items.map((session) => session.filePath === sessionFile
            ? applySessionLifecycleEvent(session, event, visible)
            : session))
        }
      }
      showExtensionUi(runtimeId, event)
      if (type === 'runtime_exit') clearExtensionUi(runtimeId)
      if (runtimeIdRef.current !== runtimeId) {
        if (type === 'runtime_exit') runtimeSessionsRef.current.delete(runtimeId)
        return
      }
      if (type === 'context_usage') {
        const contextUsage = contextUsageFromEvent(event)
        if (contextUsage) setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, contextUsage } : current)
        return
      }
      if (type === 'session_action_update') {
        const sessionActions = parseSessionActionSnapshot(event.actions)
        if (sessionActions) {
          setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, sessionActions } : current)
          reconcileQueuedPrompts(sessionActions)
        }
      }

      queueAgentEvent(event)
      reconcileTranscriptForEvent(runtimeId, event)
      if (type === 'agent_start') {
        setRuntime((current) => current?.runtimeId === runtimeId
          ? { ...current, isStreaming: true, isCompacting: false, executingModel: null }
          : current)
      }
      if (type === 'model_change' || type === 'model_changed') {
        const fallback = fallbackModelFromRecord(event)
        if (fallback) {
          setRuntime((current) => current?.runtimeId === runtimeId
            ? { ...current, executingModel: { ...fallback, isFallback: true } }
            : current)
        }
      }
      if (type === 'compaction_start') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isCompacting: true } : current)
      }
      if (type === 'compaction_end') {
        setRuntime((current) => current?.runtimeId === runtimeId
          ? { ...current, isCompacting: false, isStreaming: event.willRetry === true || current.isStreaming }
          : current)
      }
      // A provider auto-retry continues the same turn after a backoff delay:
      // the agent_end that preceded auto_retry_start was not the end of the
      // turn, so the runtime stays busy until the retry resolves.
      if (type === 'auto_retry_start') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: true } : current)
      }
      if (type === 'auto_retry_end' && event.success !== true) {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false } : current)
      }
      if (type === 'runtime_exit') {
        clearExtensionUi(runtimeId)
        runtimeSessionsRef.current.delete(runtimeId)
        runtimeIdRef.current = null
        runtimeOwnerRef.current = null
        setRuntime((current) => current?.runtimeId === runtimeId ? null : current)
      } else if (type === 'agent_end' || type === 'extension_error' || type === 'error' || type === 'transport_error') {
        clearQueuedPromptFlushFailures()
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false, isCompacting: false } : current)
        if (refreshGitOnTerminalEvent) scheduleGitRefresh()
      }
    })
    return () => {
      unsubscribe()
      if (gitRefreshTimer !== null) window.clearTimeout(gitRefreshTimer)
    }
  }, [
    activeSessionVisible,
    bridge,
    clearExtensionUi,
    clearQueuedPromptFlushFailures,
    clearQueuedPrompts,
    reconcileQueuedPrompts,
    workspaceRef,
    queueAgentEvent,
    reconcileTranscriptForEvent,
    refreshGit,
    refreshGitOnTerminalEvent,
    runtimeIdRef,
    runtimeOwnerRef,
    runtimeSessionsRef,
    setRuntime,
    setSessions,
    showExtensionUi,
  ])
}
