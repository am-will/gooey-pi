// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTerminalSessions } from '../../src/hooks/useTerminalSessions'
import { useProjectScriptRuns } from '../../src/hooks/useProjectScriptRuns'
import { ProjectScriptBusyError } from '../../src/lib/project-scripts'
import { useLocaleTranslator } from '../../src/lib/i18n'
import type { ProjectRecord, PrimeWorkApi, WorkspaceView } from '../../src/types/api'
import type { TerminalDrawerHandle } from '../../src/components/TerminalDrawer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const baseProject: ProjectRecord = { id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false, createdAt: '2026-01-01', lastOpenedAt: '2026-01-01', sessionCount: 0, scripts: { setup: '', run: 'npm run dev' } }
function handle(onExit?: (code?: number) => void): TerminalDrawerHandle {
  return { clearSelection: vi.fn(), readSelectionContext: vi.fn(() => ({ tabId: 'tab', label: 'shell', text: 'text', truncated: false })), runCommand: vi.fn((_command, _label, done) => { onExit = done; return 'tab' }), stopCommand: vi.fn(() => onExit?.()) }
}

it('admits explicit future owners synchronously and closes every matching session drawer', async () => {
  let owner = { workspaceKey: 'current', cwd: '/current', sessionPath: undefined as string | undefined }
  const beforeClose = vi.fn(); const onOpenChange = vi.fn()
  let state!: ReturnType<typeof useTerminalSessions>
  function Probe() { state = useTerminalSessions({ ...owner, beforeClose, onOpenChange }); return null }
  await act(async () => { root.render(<Probe />) })
  let id!: string
  await act(async () => {
    const first = state.openTerminal({ workspaceKey: 'future', cwd: '/future', sessionPath: '/saved' }); id = first.id
    expect(state.openTerminal({ workspaceKey: 'future', cwd: '/future' })).toBe(first)
    expect(state.openTerminal({ workspaceKey: 'other-key', cwd: '/future', sessionPath: '/saved' })).toBe(first)
  })
  expect(state.terminals).toHaveLength(1)
  expect(state.open).toBe(false)
  owner = { workspaceKey: 'future', cwd: '/future', sessionPath: '/saved' }
  await act(async () => { root.render(<Probe />) })
  expect(state.active?.id).toBe(id)
  const drawer = handle()
  state.drawerRefs.current.set(id, drawer)
  expect(state.getContext()?.text).toBe('text')
  state.clearSelection()
  expect(drawer.clearSelection).toHaveBeenCalledOnce()
  await act(async () => { state.addTerminal({ id: 'second', workspaceKey: 'another', cwd: '/future', sessionPath: '/saved' }); state.setSelection({ tabId: 'tab', label: 'shell', text: 'old', truncated: false }) })
  await act(async () => { state.closeForSession('/saved') })
  expect(beforeClose.mock.calls).toEqual([[id], ['second']])
  expect(state.terminals).toEqual([])
  expect(state.drawerRefs.current.size).toBe(0)
  expect(state.selection).toBeUndefined()
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false, true, false])
})

it('retains project runs across full-page visits and rejects stale completion callbacks', async () => {
  let view: WorkspaceView = 'session'
  let terminals!: ReturnType<typeof useTerminalSessions>
  let scripts!: ReturnType<typeof useProjectScriptRuns>
  const bridge = { projects: {} } as unknown as PrimeWorkApi
  const notify = vi.fn(); const reportError = vi.fn()
  function Probe() {
    const { t } = useLocaleTranslator('en')
    terminals = useTerminalSessions({ workspaceKey: 'one', cwd: '/project', onOpenChange: () => undefined, beforeClose: (id) => scripts.cancelForDrawer(id) })
    scripts = useProjectScriptRuns({ bridge, project: baseProject, cwd: '/project', workspaceKey: 'one', view, terminals, grantProject: async (project) => project, patchProjectScripts: () => undefined, notify, reportError, t })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { await scripts.startProjectScript('run') })
  const firstRun = scripts.activeRun!
  const firstCommand = terminals.terminals[0].initialCommand!
  expect(firstRun.ownsDrawer).toBe(true)
  await expect(scripts.startProjectScript('run')).rejects.toBeInstanceOf(ProjectScriptBusyError)
  view = 'settings'
  await act(async () => { root.render(<Probe />) })
  expect(scripts.activeRun?.requestId).toBe(firstRun.requestId)
  await act(async () => { firstCommand.onExit(0) })
  expect(scripts.activeRun).toBeUndefined()
  expect(notify).toHaveBeenCalledOnce()
  const existing = terminals.terminals[0]
  const drawer = handle()
  await act(async () => { await scripts.startProjectScript('run') })
  expect(scripts.activeRun?.tabId).toBeUndefined()
  expect(drawer.runCommand).not.toHaveBeenCalled()
  terminals.drawerRefs.current.set(existing.id, drawer)
  await act(async () => { terminals.onReady() })
  const secondRun = scripts.activeRun!
  expect(secondRun.requestId).not.toBe(firstRun.requestId)
  expect(secondRun.ownsDrawer).toBe(false)
  expect(drawer.runCommand).toHaveBeenCalledOnce()
  await act(async () => { firstCommand.onExit(2) })
  expect(scripts.activeRun?.requestId).toBe(secondRun.requestId)
  await act(async () => { scripts.stopProjectScript() })
  expect(scripts.activeRun).toBeUndefined()
  expect(drawer.stopCommand).toHaveBeenCalledExactlyOnceWith('tab')
  expect(notify).toHaveBeenCalledOnce()
  await act(async () => { await scripts.startProjectScript('run') })
  await act(async () => { terminals.close(existing.id) })
  expect(scripts.activeRun).toBeUndefined()
  expect(terminals.terminals).toHaveLength(0)
})

it('gates automatic setup by view and persists an actual setup exit through the selected harness', async () => {
  let view: WorkspaceView = 'settings'
  let project = { ...baseProject, scripts: { setup: 'npm ci', run: 'npm run dev', setupLastRun: '' } }
  const markSetupStarted = vi.fn(async () => ({ ...project.scripts, setupLastRun: 'npm ci' }))
  const finishSetup = vi.fn(async () => ({ ...project.scripts, setupLastRun: 'npm ci' }))
  const bridge = { projects: { markSetupStarted, finishSetup } } as unknown as PrimeWorkApi
  const patchProjectScripts = vi.fn((_id: string, updated: NonNullable<ProjectRecord['scripts']>) => { project = { ...project, scripts: { setupLastRun: '', ...updated } } })
  const notify = vi.fn(); const reportError = vi.fn()
  let terminals!: ReturnType<typeof useTerminalSessions>
  let scripts!: ReturnType<typeof useProjectScriptRuns>
  function Probe() {
    const { t } = useLocaleTranslator('en')
    terminals = useTerminalSessions({ workspaceKey: 'one', cwd: '/project', onOpenChange: () => undefined, beforeClose: (id) => scripts.cancelForDrawer(id) })
    scripts = useProjectScriptRuns({ bridge, project, cwd: '/project', workspaceKey: 'one', view, terminals, grantProject: async (project) => project, patchProjectScripts, notify, reportError, t })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  expect(markSetupStarted).not.toHaveBeenCalled()
  view = 'session'
  await act(async () => { root.render(<Probe />) })
  expect(markSetupStarted).toHaveBeenCalledExactlyOnceWith('project', 'npm ci', 'omp')
  const command = terminals.terminals[0].initialCommand!
  await act(async () => { terminals.consumeInitialCommand(terminals.terminals[0].id); command.onExit(7) })
  expect(finishSetup).toHaveBeenCalledExactlyOnceWith('project', 'npm ci', 7, 'omp')
  expect(scripts.activeRun).toBeUndefined()
  expect(notify).toHaveBeenCalledOnce()
  expect(reportError).not.toHaveBeenCalled()
})

it('serializes inferred-project admission before creating a script drawer', async () => {
  let grant!: (project: ProjectRecord) => void
  const admission = new Promise<ProjectRecord>((resolve) => { grant = resolve })
  const grantProject = vi.fn(() => admission)
  const project = { ...baseProject, inferred: true }
  const bridge = { projects: {} } as unknown as PrimeWorkApi
  let terminals!: ReturnType<typeof useTerminalSessions>
  let scripts!: ReturnType<typeof useProjectScriptRuns>
  function Probe() {
    const { t } = useLocaleTranslator('en')
    terminals = useTerminalSessions({ workspaceKey: 'one', cwd: '/project', onOpenChange: () => undefined })
    scripts = useProjectScriptRuns({ bridge, project, cwd: '/project', workspaceKey: 'one', view: 'settings', terminals, grantProject, patchProjectScripts: () => undefined, notify: () => undefined, reportError: () => undefined, t })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  let first!: Promise<void>
  await act(async () => { first = scripts.startProjectScript('run') })
  await expect(scripts.startProjectScript('run')).rejects.toBeInstanceOf(ProjectScriptBusyError)
  expect(grantProject).toHaveBeenCalledOnce()
  expect(terminals.terminals).toHaveLength(0)
  await act(async () => { grant(baseProject); await first })
  expect(terminals.terminals).toHaveLength(1)
  expect(scripts.activeRun?.projectId).toBe(baseProject.id)
})
