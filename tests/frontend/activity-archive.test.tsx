// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityNotificationSignature, sessionShowsCompanionNotification } from '../../src/app/session-attention'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { ActivityPage } from '../../src/pages/ActivityPage'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 2,
}
const activeSession: SessionRecord = {
  id: 'active', harness: 'prime', filePath: '/sessions/active.jsonl', projectPath: '/project', title: 'Active chat',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', status: 'complete', depth: 0, unread: true,
}
const archivedSession: SessionRecord = {
  ...activeSession,
  id: 'archived',
  filePath: '/sessions/archived.jsonl',
  title: 'Archived chat',
  archived: true,
  status: 'failed',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('archived activity cleanup', () => {
  it('never renders archived chats in Activity', async () => {
    const onOpen = vi.fn()
    await act(async () => {
      root.render(<ActivityPage sessions={[activeSession, archivedSession]} projects={[project]} clearedActivity={{}} onOpen={onOpen} onClear={vi.fn()} />)
    })

    expect(container.textContent).toContain('Active chat')
    expect(container.textContent).not.toContain('Archived chat')
    expect(container.querySelector('[aria-label="Activity filter"]')?.textContent).not.toContain('Archived')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open Active chat"]')!.click()
    })
    expect(onOpen).toHaveBeenCalledWith(activeSession)
  })

  it('clears one notification from its icon and keeps running work out of clear all', async () => {
    const failedSession: SessionRecord = {
      ...activeSession,
      id: 'failed',
      filePath: '/sessions/failed.jsonl',
      title: 'Failed chat',
      status: 'failed',
    }
    const runningSession: SessionRecord = {
      ...activeSession,
      id: 'running',
      filePath: '/sessions/running.jsonl',
      title: 'Running chat',
      status: 'running',
    }
    const onClear = vi.fn()
    await act(async () => {
      root.render(<ActivityPage sessions={[activeSession, failedSession, runningSession]} projects={[project]} clearedActivity={{}} onOpen={vi.fn()} onClear={onClear} />)
    })

    expect(container.querySelector('[aria-label="Clear Active chat activity"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Clear Failed chat activity"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Clear Running chat activity"]')).toBeNull()
    const toolGroup = container.querySelector('.activity-tools__right')!
    expect(toolGroup.firstElementChild?.classList.contains('page-search')).toBe(true)
    expect(toolGroup.lastElementChild?.textContent).toBe('Clear all')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear Failed chat activity"]')!.click()
    })
    expect(onClear).toHaveBeenLastCalledWith([failedSession])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.activity-clear-all')!.click()
    })
    expect(onClear).toHaveBeenLastCalledWith([activeSession, failedSession])
  })

  it('hides a cleared activity until its session revision changes', async () => {
    const signature = activityNotificationSignature(activeSession)!
    await act(async () => {
      root.render(<ActivityPage sessions={[activeSession]} projects={[project]} clearedActivity={{ [activeSession.id]: signature }} onOpen={vi.fn()} onClear={vi.fn()} />)
    })
    expect(container.textContent).not.toContain('Active chat')

    await act(async () => {
      root.render(<ActivityPage sessions={[{ ...activeSession, eventRevision: 1 }]} projects={[project]} clearedActivity={{ [activeSession.id]: signature }} onOpen={vi.fn()} onClear={vi.fn()} />)
    })
    expect(container.textContent).toContain('Active chat')
  })

  it('suppresses notifications from sessions that are already archived', () => {
    expect(sessionShowsCompanionNotification(archivedSession)).toBe(false)
  })

  it('acknowledges and clears unread state when archiving succeeds', async () => {
    const archive = vi.fn(async () => true)
    const clearSessionAttention = vi.fn()
    const closeTerminalForSession = vi.fn()
    const setToast = vi.fn()
    let sessions = [activeSession]
    const setSessions = vi.fn((update: (items: SessionRecord[]) => SessionRecord[]) => { sessions = update(sessions) })
    const actions = createWorkspaceActions(() => ({
      bridge: { sessions: { archive } },
      settingsState: { settings: DEFAULT_SETTINGS },
      workspace: { workspaceRef: { current: { session: undefined } } },
      setSessions,
      setToast,
      closeTerminalForSession,
      clearSessionAttention,
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await actions.setSessionArchived(activeSession, true)

    expect(archive).toHaveBeenCalledWith(activeSession.filePath, true)
    expect(clearSessionAttention).toHaveBeenCalledWith(activeSession)
    expect(closeTerminalForSession).toHaveBeenCalledWith(activeSession.filePath)
    expect(sessions[0]).toMatchObject({ id: activeSession.id, archived: true, unread: false })
    expect(setToast).toHaveBeenCalledWith('Archived. Find it in Settings › Archived chats.')
  })

  it('toasts in the language the app is set to', async () => {
    const archive = vi.fn(async () => true)
    const setToast = vi.fn()
    const actions = createWorkspaceActions(() => ({
      bridge: { sessions: { archive } },
      settingsState: { settings: { ...DEFAULT_SETTINGS, locale: 'zh-CN' as const } },
      workspace: { workspaceRef: { current: { session: undefined } } },
      setSessions: vi.fn(),
      setToast,
      closeTerminalForSession: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await actions.setSessionArchived(activeSession, true)
    expect(setToast).toHaveBeenCalledWith('已归档。可在「设置 › 已归档的聊天」里找到。')

    await actions.setSessionArchived(activeSession, false)
    expect(setToast).toHaveBeenLastCalledWith('会话已恢复。')
  })

  it('recreates the browser host when archiving the open session', async () => {
    const archive = vi.fn(async () => true)
    const resetBrowserView = vi.fn()
    const activateWorkspace = vi.fn()
    const actions = createWorkspaceActions(() => ({
      bridge: { sessions: { archive } },
      initialized: true,
      activeProject: project,
      layout: { compactLayout: false },
      settingsState: { settings: DEFAULT_SETTINGS },
      workspace: { workspaceRef: { current: { project, session: activeSession } }, activateWorkspace },
      setSessions: vi.fn(),
      setView: vi.fn(),
      setPaletteOpen: vi.fn(),
      setToast: vi.fn(),
      resetBrowserView,
      closeTerminalForSession: vi.fn(),
      clearSessionAttention: vi.fn(),
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await actions.setSessionArchived(activeSession, true)

    expect(resetBrowserView).toHaveBeenCalledOnce()
    expect(activateWorkspace).toHaveBeenCalledWith(project)
  })
})
