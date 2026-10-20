// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const existing: SessionRecord = {
  id: 'existing', harness: 'prime', filePath: '/sessions/existing.jsonl', projectPath: '/project', title: 'Existing work',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, unread: false,
}

let container: HTMLDivElement
let root: Root
let workspace: ReturnType<typeof useWorkspaceRuntime>

function WorkspaceProbe({ sessions }: { sessions: SessionRecord[] }) {
  workspace = useWorkspaceRuntime({ bridge: null, initialProject: project, sessions, initialMessages: [], reportError: () => undefined })
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('workspace view identity', () => {
  it('keys the view by the session a workspace opened, or by its new chat', () => {
    act(() => root.render(createElement(WorkspaceProbe, { sessions: [existing] })))
    expect(workspace.viewKey).toBe('new:0')

    act(() => { workspace.activateWorkspace(project, existing) })
    expect(workspace.viewKey).toBe('existing')

    act(() => { workspace.activateWorkspace(project) })
    expect(workspace.viewKey).toBe('new:2')
  })
})
