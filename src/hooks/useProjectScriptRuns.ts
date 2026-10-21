import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectScriptBusyError, setupNeedsRun, type ProjectScriptKind } from '@/lib/project-scripts'
import type { HarnessId, PrimeWorkApi, ProjectRecord, WorkspaceView } from '@/types/api'
import type { MessageKey, useLocaleTranslator } from '@/lib/i18n'
import type { useTerminalSessions } from './useTerminalSessions'
import { useStableCallback } from './useStableCallback'

export interface ActiveProjectScriptRun {
  requestId: string
  projectId: string
  kind: ProjectScriptKind
  command: string
  harness: HarnessId
  drawerId?: string
  tabId?: string
  ownsDrawer: boolean
}
export type ProjectScriptRunOutcome = { cancelled: true } | { exitCode: number }
interface ProjectScriptRunsOptions {
  bridge: PrimeWorkApi | null
  project?: ProjectRecord
  cwd?: string
  sessionPath?: string
  workspaceKey: string
  view: WorkspaceView
  terminals: ReturnType<typeof useTerminalSessions>
  grantProject(project: ProjectRecord): Promise<ProjectRecord>
  patchProjectScripts(projectId: string, scripts: NonNullable<ProjectRecord['scripts']>): void
  notify(message: string): void
  reportError(error: unknown): void
  t: ReturnType<typeof useLocaleTranslator>['t']
}

export function useProjectScriptRuns({ bridge, project, cwd, sessionPath, workspaceKey, view, terminals, grantProject, patchProjectScripts, notify, reportError, t }: ProjectScriptRunsOptions) {
  const [activeRun, setActiveRun] = useState<ActiveProjectScriptRun>()
  const activeRunRef = useRef<ActiveProjectScriptRun | undefined>(undefined)
  const startingRef = useRef(false)
  const report = useStableCallback(reportError)
  const tell = useStableCallback(notify)
  const patchScripts = useStableCallback(patchProjectScripts)
  const labelFor = useStableCallback((kind: ProjectScriptKind) => t(kind === 'setup' ? 'app.projectScript.setupLabel' : 'app.projectScript.runLabel'))
  const finish = useCallback((run: ActiveProjectScriptRun, outcome: ProjectScriptRunOutcome) => {
    if (activeRunRef.current?.requestId !== run.requestId) return
    activeRunRef.current = undefined
    setActiveRun(undefined)
    if ('cancelled' in outcome) return
    const label = labelFor(run.kind)
    const key: MessageKey = outcome.exitCode === 0 ? 'app.projectScript.completed' : 'app.projectScript.exited'
    const message = t(key, { label, code: outcome.exitCode })
    if (run.kind === 'setup' && bridge) {
      void bridge.projects.finishSetup(run.projectId, run.command, outcome.exitCode, run.harness)
        .then((scripts) => { if (scripts) { patchScripts(run.projectId, scripts); tell(message) } }).catch(report)
    } else tell(message)
  }, [bridge, labelFor, patchScripts, report, t, tell])
  const cancelForDrawer = useStableCallback((id: string) => {
    const run = activeRunRef.current
    if (run?.drawerId === id) finish(run, { cancelled: true })
  })
  const startProjectScript = useCallback(async (kind: ProjectScriptKind) => {
    if (!bridge || !project || !cwd) throw new Error(t('app.projectScript.desktopOnly'))
    if (activeRunRef.current || startingRef.current) throw new ProjectScriptBusyError()
    startingRef.current = true
    try {
      const granted = project.inferred ? await grantProject(project) : project
      const command = granted.scripts?.[kind]?.trim() ?? ''
      if (!command) throw new Error(t(kind === 'setup' ? 'app.projectScript.configureSetup' : 'app.projectScript.configureRun'))
      if (kind === 'setup') patchScripts(granted.id, await bridge.projects.markSetupStarted(granted.id, command, granted.harness))
      const run: ActiveProjectScriptRun = { requestId: crypto.randomUUID(), projectId: granted.id, harness: granted.harness, kind, command, ownsDrawer: false }
      const existing = terminals.terminalsRef.current.find((terminal) => terminal.workspaceKey === workspaceKey || Boolean(sessionPath && terminal.sessionPath === sessionPath))
      if (existing) {
        const pending = { ...run, drawerId: existing.id }
        activeRunRef.current = pending
        setActiveRun(pending)
      } else {
        const drawerId = crypto.randomUUID()
        const tabId = crypto.randomUUID()
        const started = { ...run, drawerId, tabId, ownsDrawer: true }
        activeRunRef.current = started
        setActiveRun(started)
        terminals.addTerminal({ id: drawerId, workspaceKey, cwd, sessionPath, initialCommand: {
          id: tabId, command, label: labelFor(kind),
          onExit: (exitCode) => finish(started, exitCode === undefined ? { cancelled: true } : { exitCode }),
        } })
      }
    } finally { startingRef.current = false }
  }, [bridge, cwd, finish, grantProject, labelFor, patchScripts, project, sessionPath, t, terminals.addTerminal, terminals.terminalsRef, workspaceKey])
  const saveProjectScripts = useCallback(async (scripts: { setup: string; run: string }) => {
    if (!bridge || !project) throw new Error(t('app.projectScript.selectProject'))
    const granted = project.inferred ? await grantProject(project) : project
    patchScripts(granted.id, await bridge.projects.updateScripts(granted.id, scripts, granted.harness))
  }, [bridge, grantProject, patchScripts, project, t])
  const stopProjectScript = useCallback(() => {
    const run = activeRunRef.current
    if (!run) return
    finish(run, { cancelled: true })
    if (!run.drawerId || !run.tabId) return
    const drawer = terminals.drawerRefs.current.get(run.drawerId)
    if (drawer) drawer.stopCommand(run.tabId)
    else terminals.close(run.drawerId)
  }, [finish, terminals.close, terminals.drawerRefs])
  useEffect(() => {
    const run = activeRun
    if (!run || run.tabId || !run.drawerId) return
    const drawer = terminals.drawerRefs.current.get(run.drawerId)
    if (!drawer) return
    try {
      const tabId = drawer.runCommand(run.command, labelFor(run.kind), (exitCode) => finish(run, exitCode === undefined ? { cancelled: true } : { exitCode }))
      const started = { ...run, tabId }
      activeRunRef.current = started
      setActiveRun(started)
    } catch (error) { finish(run, { cancelled: true }); report(error) }
  }, [activeRun, finish, labelFor, report, terminals.drawerRefs, terminals.revision])
  useEffect(() => {
    if (view !== 'session' || !project?.scripts || !setupNeedsRun(project.scripts) || activeRunRef.current) return
    void startProjectScript('setup').catch((error: unknown) => { if (!(error instanceof ProjectScriptBusyError)) report(error) })
  }, [activeRun, project?.id, project?.scripts, report, startProjectScript, view])
  return { activeRun, activeRunRef, startProjectScript, saveProjectScripts, stopProjectScript, finish, cancelForDrawer }
}
