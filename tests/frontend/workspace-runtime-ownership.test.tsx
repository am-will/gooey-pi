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
  it('keeps queue and prompt identity when there are no flush failures to clear', () => {
    act(() => root.render(createElement(Probe)))
    act(() => latest.queuePrompt('queue me', 'queue'))
    const queue = latest.pendingQueuedPrompts
    const prompt = queue[0]
    act(() => latest.clearQueuedPromptFlushFailures())
    expect(latest.pendingQueuedPrompts).toBe(queue)
    expect(latest.pendingQueuedPrompts[0]).toBe(prompt)
  })

  it('detaches a background runtime without clearing the active runtime owner', () => {
    const other = { ...session, id: 'other', filePath: '/sessions/b.jsonl' }
    act(() => root.render(createElement(Probe, { initialSession: session, sessions: [session, other] })))
    const detach = latest.detachRuntime
    act(() => {
      latest.attachRuntime(runtime, 0)
      latest.activateWorkspace(project, other, { ...runtime, runtimeId: 'b', sessionFile: other.filePath })
      latest.detachRuntime('a')
    })
    expect(latest.runtime?.runtimeId).toBe('b')
    expect(latest.runtimeIdRef.current).toBe('b')
    expect(latest.runtimeOwnerRef.current?.runtimeId).toBe('b')
    expect(latest.runtimeSessionsRef.current.has('a')).toBe(false)
    expect(latest.detachRuntime).toBe(detach)
    act(() => latest.detachRuntime('b'))
    expect(latest.runtime).toBeNull()
    expect(latest.runtimeIdRef.current).toBeNull()
    expect(latest.runtimeOwnerRef.current).toBeNull()
    expect(latest.runtimeSessionsRef.current.has('b')).toBe(false)
    expect(latest.workspaceRef.current.sessionFile).toBe(other.filePath)
  })

  it('settles a delayed background steer acceptance without adding another thread’s history', () => {
    const other = { ...session, id: 'other', filePath: '/sessions/b.jsonl' }
    let id!: string
    act(() => root.render(createElement(Probe, { initialSession: session, sessions: [session, other] })))
    act(() => {
      id = latest.queuePrompt('accepted in A', 'steer')
      latest.queuePrompt('queued in A', 'queue')
      latest.activateWorkspace(project, other)
      latest.acceptSteer(id)
    })
    expect(latest.messages).toEqual([])
    expect(latest.pendingQueuedPrompts).toEqual([])
    act(() => latest.activateWorkspace(project, session))
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['queued in A'])
    act(() => latest.acceptSteer(id))
    expect(latest.messages).toEqual([])
  })

  it('drops only an exited runtime owner’s steers and retains ordinary queued prompts', () => {
    const other = { ...session, id: 'other', filePath: '/sessions/b.jsonl' }
    act(() => root.render(createElement(Probe, { initialSession: session, sessions: [session, other] })))
    act(() => {
      latest.attachRuntime(runtime, 0)
      latest.queuePrompt('A steer', 'steer')
      latest.queuePrompt('A follow-up', 'queue')
      latest.activateWorkspace(project, other, { ...runtime, runtimeId: 'b', sessionFile: other.filePath })
      latest.queuePrompt('B steer', 'steer')
      latest.dropPendingSteers('a')
    })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['B steer'])
    act(() => latest.activateWorkspace(project, session))
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['A follow-up'])
    act(() => latest.dropPendingSteers())
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['A follow-up'])
    act(() => latest.activateWorkspace(project, other))
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['B steer'])
  })

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

  it.each(['agent_start', 'turn_start'])('keeps initial history while buffering a live %s', async (type) => {
    let finish!: (messages: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { finish = resolve }))
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    act(() => root.render(createElement(Probe, { bridge, initialSession: session, sessions: [session] })))
    act(() => {
      latest.reconcileTranscriptForEvent(runtime.runtimeId, { type })
      latest.queueAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live answer' } })
    })
    await act(async () => finish([{ id: 'history', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'earlier prompt' }] }]))
    expect(read).toHaveBeenCalledOnce()
    expect(latest.loadingSession).toBe(false)
    expect(latest.messages.map((message) => message.parts)).toMatchObject([[{ type: 'text', text: 'earlier prompt' }], [{ type: 'text', text: 'live answer' }]])
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
