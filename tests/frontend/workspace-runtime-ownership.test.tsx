// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project: ProjectRecord = { id: 'inferred', harness: 'omp', name: 'Project', path: '/work', folders: ['/work'], primaryFolder: '/work', pinned: false, createdAt: '', lastOpenedAt: '', sessionCount: 0 }
const session: SessionRecord = { id: 'session', harness: 'omp', filePath: '/sessions/a.jsonl', projectPath: '/work', title: 'A', createdAt: '', updatedAt: '', status: 'idle', depth: 0 }
const runtime: RuntimeInfo = { runtimeId: 'a', harness: 'omp', cwd: '/work', sessionFile: session.filePath, isStreaming: false }
let latest: ReturnType<typeof useWorkspaceRuntime>
let root: Root
let container: HTMLDivElement
function Probe({ bridge = null, initialSession, sessions = [], reportError = () => {} }: { bridge?: PrimeWorkApi | null; initialSession?: SessionRecord; sessions?: SessionRecord[]; reportError?: (error: unknown) => void }) {
  latest = useWorkspaceRuntime({ bridge, harness: 'omp', initialProject: project, initialSession, sessions, initialMessages: [], reportError })
  return null
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('workspace runtime ownership', () => {
  it('does not restart history when the error callback changes and reports to the latest callback', async () => {
    let fail!: (error: unknown) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((_resolve, reject) => { fail = reject }))
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const first = vi.fn()
    const next = vi.fn()
    act(() => root.render(createElement(Probe, { bridge, initialSession: session, sessions: [session], reportError: first })))
    act(() => root.render(createElement(Probe, { bridge, initialSession: session, sessions: [session], reportError: next })))
    expect(read).toHaveBeenCalledOnce()
    await act(async () => fail(new Error('History read failed')))
    expect(first).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'History read failed' }))
  })

  it('records the started runtime session before its catalog record arrives', () => {
    act(() => root.render(createElement(Probe)))
    act(() => latest.attachRuntime(runtime, 0))
    expect(latest.workspaceRef.current.sessionFile).toBe(session.filePath)
    expect(latest.activeSessionId).toBeUndefined()
    expect(latest.runtimeSessionsRef.current.get(runtime.runtimeId)).toBe(session.filePath)
    act(() => latest.attachRuntime({ ...runtime, runtimeId: 'stale', sessionFile: '/wrong' }, -1))
    expect(latest.workspaceRef.current.sessionFile).toBe(session.filePath)
  })

  it('replaces an active inferred project without remounting its workspace or losing its queue', () => {
    act(() => root.render(createElement(Probe)))
    const replace = latest.replaceActiveProject
    const key = latest.viewKey
    act(() => { latest.queuePrompt('keep me', 'queue'); latest.replaceActiveProject(project.id, { ...project, id: 'granted' }) })
    expect(latest.activeProjectId).toBe('granted')
    expect(latest.workspaceRef.current.project?.id).toBe('granted')
    expect(latest.workspaceGeneration).toBe(0)
    expect(latest.viewKey).toBe(key)
    expect(latest.pendingQueuedPrompts[0].text).toBe('keep me')
    expect(latest.replaceActiveProject).toBe(replace)
    act(() => latest.replaceActiveProject(project.id, { ...project, id: 'stale' }))
    expect(latest.activeProjectId).toBe('granted')
  })
})
