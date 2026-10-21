// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { readComposerDraft, saveComposerDraft } from '../../src/lib/composer-draft'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}

const other: ProjectRecord = {
  ...project,
  id: 'other',
  name: 'Other',
  path: '/other',
  folders: ['/other'],
  primaryFolder: '/other',
}

const session: SessionRecord = {
  id: 'session', harness: 'prime', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}

describe('selectProject workspace resume', () => {
  it('returns to the current unsent project chat instead of replacing it with the latest session', async () => {
    const activateWorkspace = vi.fn(() => 2)
    const setView = vi.fn()
    const actions = createWorkspaceActions(() => ({
      layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
      settingsState: { setSidebarOpen: vi.fn() },
      sessions: [session],
      workspace: {
        workspaceRef: { current: { project, session: undefined, generation: 1 } },
        activateWorkspace,
        reconcileRuntime: vi.fn(),
      },
      setView,
      setSessions: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
      bridge: { projects: { touch: vi.fn() } },
    } as unknown as WorkspaceActionsDeps))

    await actions.selectProject(project)

    expect(setView).toHaveBeenCalledWith('session')
    expect(activateWorkspace).not.toHaveBeenCalled()
  })

  it('still activates a different project', async () => {
    const activateWorkspace = vi.fn(() => 2)
    const reconcileRuntime = vi.fn()
    const actions = createWorkspaceActions(() => ({
      layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
      settingsState: { setSidebarOpen: vi.fn() },
      sessions: [],
      workspace: {
        workspaceRef: { current: { project, session: undefined, generation: 1 } },
        activateWorkspace,
        reconcileRuntime,
      },
      setView: vi.fn(),
      setSessions: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
      bridge: { projects: { touch: vi.fn() } },
    } as unknown as WorkspaceActionsDeps))

    await actions.selectProject(other)

    expect(activateWorkspace).toHaveBeenCalledWith(other, undefined)
    expect(reconcileRuntime).toHaveBeenCalledWith(2)
  })

  it('clears an unsent project draft when explicitly starting a new session', () => {
    saveComposerDraft('project:new', { text: '/plan ' })
    const activateWorkspace = vi.fn()
    const actions = createWorkspaceActions(() => ({
      bridge: null,
      initialized: true,
      activeProject: project,
      layout: { compactLayout: false, setSmallestSidebarAllowed: vi.fn() },
      settingsState: { setSidebarOpen: vi.fn() },
      workspace: {
        workspaceRef: { current: { project, session: undefined, generation: 1 } },
        activateWorkspace,
        setMessages: vi.fn(),
      },
      setView: vi.fn(),
      setPaletteOpen: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    actions.newSession(project)

    expect(readComposerDraft('project:new')).toBeNull()
    expect(activateWorkspace).toHaveBeenCalledWith(project)
  })
})

it('adopts an inferred project immediately while Git refresh remains pending', async () => {
  const inferred = { ...project, id: 'inferred', inferred: true }
  const workspaceRef = { current: { project: inferred, session: undefined, generation: 1, cwd: project.path } }
  const replaceActiveProject = vi.fn()
  let resolveGit!: (value: { isRepo: boolean; files: [] }) => void
  const git = new Promise<{ isRepo: boolean; files: [] }>((resolve) => { resolveGit = resolve })
  const setGitSnapshot = vi.fn()
  const reportError = vi.fn()
  const actions = createWorkspaceActions(() => ({ bridge: { projects: { grantInferred: async () => project }, git: { status: () => git } }, workspace: { workspaceRef, replaceActiveProject },
    setProjects: vi.fn(), gitRequestRef: { current: 0 }, setGitSnapshot, reportError } as unknown as WorkspaceActionsDeps))
  await expect(actions.grantProject(inferred)).resolves.toBe(project)
  expect(replaceActiveProject).toHaveBeenCalledWith('inferred', project)
  expect(setGitSnapshot).not.toHaveBeenCalled()
  resolveGit({ isRepo: false, files: [] })
  await git
  expect(setGitSnapshot).toHaveBeenCalledWith({ cwd: project.path, status: { isRepo: false, files: [] } })
  expect(reportError).not.toHaveBeenCalled()
})

it.each([true, false])('only reattaches and clears the fallback when removing the active project (%s)', async (active) => {
  const fallback = { ...session, projectPath: other.path, unread: true }
  const activateWorkspace = vi.fn(() => 2)
  const reconcileRuntime = vi.fn(async () => undefined)
  const clearSessionAttention = vi.fn()
  const resetBrowserView = vi.fn()
  const setSessions = vi.fn()
  const actions = createWorkspaceActions(() => ({ bridge: { projects: { remove: async () => true } }, projects: [project, other], sessions: [fallback],
    workspace: { workspaceRef: { current: { project: active ? project : other, generation: 1 } }, activateWorkspace, reconcileRuntime },
    setProjects: vi.fn(), setSessions, setToast: vi.fn(), reportError: vi.fn(), clearSessionAttention, resetBrowserView } as unknown as WorkspaceActionsDeps))
  await actions.removeProject(project)
  if (active) {
    expect(activateWorkspace).toHaveBeenCalledWith(other, fallback)
    expect(reconcileRuntime).toHaveBeenCalledWith(2)
    expect(clearSessionAttention).toHaveBeenCalledWith(fallback)
    expect(setSessions.mock.calls[0][0]([fallback])[0].unread).toBe(false)
    expect(resetBrowserView).toHaveBeenCalledOnce()
  } else {
    expect(activateWorkspace).not.toHaveBeenCalled()
    expect(reconcileRuntime).not.toHaveBeenCalled()
    expect(resetBrowserView).not.toHaveBeenCalled()
  }
})
