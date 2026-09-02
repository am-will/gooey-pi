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
