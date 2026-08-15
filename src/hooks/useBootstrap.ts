import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { findRuntimeForWorkspace, selectStartupWorkspace } from '@/lib/workspace'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type {
  AppMeta,
  HarnessId,
  PrimeWorkApi,
  ProjectRecord,
  RuntimeInfo,
  AutomationScheduleRecord,
  SessionRecord,
} from '@/types/api'

interface UseBootstrapOptions {
  bridge: PrimeWorkApi | null
  /** Wait until persisted settings select the authoritative startup harness. */
  ready?: boolean
  /** Harness whose projects, sessions, and runtimes populate the workspace. */
  harness?: HarnessId
  setProjects: React.Dispatch<React.SetStateAction<ProjectRecord[]>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setSchedules: React.Dispatch<React.SetStateAction<AutomationScheduleRecord[]>>
  setScheduleError(value: string): void
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  activateWorkspace(project?: ProjectRecord, session?: SessionRecord, runtime?: RuntimeInfo): number
  attachRuntime(runtime: RuntimeInfo | undefined, generation: number): void
  sessionHasOpenExtensionUi?(filePath: string): boolean
  /** Runs when the effect notices a harness change, before refetching (view reset). Must be identity-stable. */
  onHarnessSwitch?(): void
  reportError(error: unknown): void
}

const NO_OPEN_EXTENSION_UI = () => false

function sessionRecordChanged(previous: SessionRecord, record: SessionRecord, status = record.status): boolean {
  return previous.id !== record.id
    || previous.projectPath !== record.projectPath
    || previous.title !== record.title
    || previous.createdAt !== record.createdAt
    || previous.updatedAt !== record.updatedAt
    || previous.lastUserMessageAt !== record.lastUserMessageAt
    || previous.status !== status
    || previous.model !== record.model
    || previous.provider !== record.provider
    || previous.thinkingLevel !== record.thinkingLevel
    || previous.depth !== record.depth
    || previous.pinned !== record.pinned
    || previous.preview !== record.preview
    || previous.archived !== record.archived
}

function catalogMergeStatus(
  previous: SessionRecord | undefined,
  record: SessionRecord,
  sessionHasOpenExtensionUi: (filePath: string) => boolean,
): SessionRecord['status'] {
  // The catalog cannot see an open extension-UI request, so renderer-owned
  // waiting state remains authoritative until that request settles.
  if (previous?.status === 'waiting' && sessionHasOpenExtensionUi(record.filePath)) return previous.status
  // Runtime-backed catalog scans can report idle after agent_end even though
  // the renderer has already observed the terminal event. The matching status
  // revision proves that this non-idle status is live renderer state;
  // startup/external records and catalog-owned transitions have no provenance.
  if (record.status === 'idle' && typeof previous?.statusEventRevision === 'number'
    && previous.statusEventRevision === previous.eventRevision
    && (previous.status === 'running' || previous.status === 'waiting'
      || previous.status === 'complete' || previous.status === 'failed')) return previous.status
  return record.status
}

export function mergeSessionCatalog(
  current: SessionRecord[],
  records: SessionRecord[],
  activeFile: string | undefined,
  changedFiles: ReadonlyMap<string, number>,
  catalogRevision: number,
  sessionHasOpenExtensionUi: (filePath: string) => boolean = NO_OPEN_EXTENSION_UI,
): SessionRecord[] {
  const previousByPath = new Map(current.map((session) => [session.filePath, session]))
  return records.map((record) => {
    const previous = previousByPath.get(record.filePath)
    const status = catalogMergeStatus(previous, record, sessionHasOpenExtensionUi)
    // Status provenance survives corroborating or deliberately ignored
    // snapshots, but a catalog transition to a different status takes
    // ownership. eventRevision itself remains monotonic for attention IDs.
    const statusEventRevision = status === previous?.status ? previous.statusEventRevision : undefined
    const needsAttention = (record.status === 'waiting' || record.status === 'complete')
      && previous?.status !== record.status
    const recordChanged = !previous || sessionRecordChanged(previous, record, status)
    // A session's sync revision only advances when its own file changed:
    // catalog-wide ticks must not re-sync (or re-render) untouched sessions.
    const syncRevision = changedFiles.get(record.filePath)
      ?? (catalogRevision && recordChanged ? catalogRevision : previous?.syncRevision ?? record.syncRevision)
    const lastUserMessageAt = previous?.lastUserMessageAt
      && (!record.lastUserMessageAt || Date.parse(previous.lastUserMessageAt) > Date.parse(record.lastUserMessageAt))
      ? previous.lastUserMessageAt
      : record.lastUserMessageAt
    const unread = record.filePath === activeFile ? false : needsAttention ? true : previous?.unread ?? record.unread
    if (previous && !recordChanged && previous.unread === unread && previous.syncRevision === syncRevision
      && previous.status === status && previous.statusEventRevision === statusEventRevision
      && previous.lastUserMessageAt === lastUserMessageAt) return previous
    return {
      ...record,
      status,
      lastUserMessageAt,
      // eventRevision is renderer-only lifecycle state; disk records never
      // carry it, so always keep the live value.
      eventRevision: previous?.eventRevision,
      statusEventRevision,
      unread,
      syncRevision,
    }
  })
}

export function useBootstrap({
  bridge,
  ready = true,
  harness = 'prime',
  setProjects,
  setSessions,
  setSchedules,
  setScheduleError,
  runtimeSessionsRef,
  workspaceRef,
  activateWorkspace,
  attachRuntime,
  sessionHasOpenExtensionUi = NO_OPEN_EXTENSION_UI,
  onHarnessSwitch,
  reportError,
}: UseBootstrapOptions) {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [initialized, setInitialized] = useState(!bridge)
  const previousHarnessRef = useRef(harness)

  const refreshHarnesses = useCallback(async () => {
    if (!bridge) return null
    const result = await bridge.app.refreshHarnesses()
    setMeta(result.meta)
    return result
  }, [bridge])

  useEffect(() => {
    if (!bridge || !ready) {
      setInitialized(!bridge)
      return
    }
    // Switching harness rides the exact workspace-switch path: clear the
    // visible catalog, bump the workspace generation (which resets runtime,
    // transcript, and queued prompts), then bootstrap the new harness. The
    // generation captured below guards the async startup activation the same
    // way it does on first launch.
    if (previousHarnessRef.current !== harness) {
      previousHarnessRef.current = harness
      setProjects([])
      setSessions([])
      onHarnessSwitch?.()
      activateWorkspace()
    }
    let cancelled = false
    const startupGeneration = workspaceRef.current.generation
    const projectsRequest = bridge.projects.list(harness)
    const sessionsRequest = bridge.sessions.list(undefined, true, harness)
    const runtimesRequest = bridge.agent.list().then((value) => {
      if (!cancelled) {
        // Merge instead of replacing: entries learned from live events while the
        // bootstrap list was in flight must survive the snapshot.
        for (const runtime of value) {
          if (runtime.sessionFile) runtimeSessionsRef.current.set(runtime.runtimeId, runtime.sessionFile)
        }
      }
      return value.filter((runtime) => runtime.harness === harness)
    }).catch((error) => {
      if (!cancelled) reportError(error)
      return [] as RuntimeInfo[]
    })

    void bridge.app.getMeta().then((value) => {
      if (!cancelled) setMeta(value)
    }).catch((error) => { if (!cancelled) reportError(error) })

    void bridge.schedules.list(harness).then((value) => {
      if (!cancelled) {
        setSchedules(value)
        setScheduleError('')
      }
    }).catch((error) => {
      if (!cancelled) {
        setScheduleError(errorMessage(error))
        reportError(error)
      }
    })

    void Promise.allSettled([projectsRequest, sessionsRequest]).then((results) => {
      if (cancelled) return
      const [projectResult, sessionResult] = results
      if (projectResult.status === 'rejected') reportError(projectResult.reason)
      if (sessionResult.status === 'rejected') reportError(sessionResult.reason)
      const nextProjects = projectResult.status === 'fulfilled' ? projectResult.value : []
      const nextSessions = (sessionResult.status === 'fulfilled' ? sessionResult.value : []).map((session) => session.status === 'waiting'
        ? { ...session, unread: true }
        : session)
      setProjects(nextProjects)
      setSessions(nextSessions)

      let selectedGeneration: number | undefined
      if (projectResult.status === 'fulfilled' && workspaceRef.current.generation === startupGeneration) {
        const selected = selectStartupWorkspace(nextProjects, nextSessions, [])
        selectedGeneration = activateWorkspace(selected.project, selected.session)
      }
      setInitialized(true)

      // Runtime discovery is intentionally not on the critical path. It may
      // only attach to the exact startup generation/session it was selected for.
      void runtimesRequest.then((runtimes) => {
        if (cancelled || selectedGeneration === undefined) return
        const current = workspaceRef.current
        if (current.generation !== selectedGeneration) return
        const matching = findRuntimeForWorkspace(runtimes, current.cwd, current.sessionFile)
        if (matching) attachRuntime(matching, selectedGeneration)
      })
    })
    return () => { cancelled = true }
  }, [
    activateWorkspace,
    attachRuntime,
    bridge,
    harness,
    onHarnessSwitch,
    reportError,
    ready,
    runtimeSessionsRef,
    setProjects,
    setScheduleError,
    setSchedules,
    setSessions,
    workspaceRef,
  ])

  useEffect(() => {
    if (!bridge || !ready || !initialized) return
    let disposed = false
    let refreshTimer: number | null = null
    let requestId = 0
    const pendingChangedFiles = new Map<string, number>()
    let pendingCatalogRevision = 0
    let nextRevision = 0
    const unsubscribe = bridge.sessions.onChanged((change) => {
      // Events that predate harness scoping carry no harness and mean prime.
      if ((change.harness ?? 'prime') !== harness) return
      const revision = ++nextRevision
      if (change.filePath) pendingChangedFiles.set(change.filePath, revision)
      else pendingCatalogRevision = revision
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        const currentRequest = ++requestId
        const changedFiles = new Map(pendingChangedFiles)
        const catalogRevision = pendingCatalogRevision
        void bridge.sessions.list(undefined, true, harness).then((nextSessions) => {
          if (disposed || currentRequest !== requestId) return
          setSessions((current) => mergeSessionCatalog(
            current,
            nextSessions,
            workspaceRef.current.sessionFile,
            changedFiles,
            catalogRevision,
            sessionHasOpenExtensionUi,
          ))
          for (const [filePath, changedRevision] of changedFiles) {
            if (pendingChangedFiles.get(filePath) === changedRevision) pendingChangedFiles.delete(filePath)
          }
          if (pendingCatalogRevision === catalogRevision) pendingCatalogRevision = 0
        }).catch((error) => {
          if (!disposed && currentRequest === requestId) reportError(error)
        })
      }, 80)
    })
    return () => {
      disposed = true
      requestId += 1
      unsubscribe()
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [bridge, harness, initialized, ready, reportError, sessionHasOpenExtensionUi, setSessions, workspaceRef])

  return { meta, initialized, refreshHarnesses }
}
