// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { HarnessId, PrimeWorkApi, ProjectRecord, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'prime', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}

type Workspace = ReturnType<typeof useWorkspaceRuntime>
let latest: Workspace

function Probe({
  bridge,
  harness = 'prime',
  initialProject = project,
  initialSession = session,
  sessions = [session],
}: {
  bridge: PrimeWorkApi | null
  harness?: HarnessId
  initialProject?: ProjectRecord
  initialSession?: SessionRecord
  sessions?: SessionRecord[]
}) {
  latest = useWorkspaceRuntime({
    bridge,
    harness,
    initialProject,
    initialSession,
    sessions,
    initialMessages: [],
    reportError: () => undefined,
  })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('prompt admission versus background transcript reads', () => {
  it('marks failed queued flushes across the active owner and clears them at a boundary', () => {
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => { latest.queuePrompt('retry this prompt', 'queue') })
    const queuedId = latest.pendingQueuedPrompts[0].id
    act(() => { latest.markQueuedPromptFlushFailed(queuedId) })
    expect(latest.pendingQueuedPrompts).toMatchObject([{ id: queuedId, flushAttemptFailed: true }])
    act(() => { latest.clearQueuedPromptFlushFailures() })
    expect(latest.pendingQueuedPrompts).toMatchObject([{ id: queuedId }])
    expect(latest.pendingQueuedPrompts[0].flushAttemptFailed).toBeUndefined()
  })

  it('keeps queued prompts with their thread when navigating away and back', () => {
    const ompProject: ProjectRecord = {
      ...project,
      id: 'omp-project',
      harness: 'omp',
      path: '/omp-project',
      folders: ['/omp-project'],
      primaryFolder: '/omp-project',
    }
    const ompSession: SessionRecord = {
      ...session,
      id: 'omp-session',
      harness: 'omp',
      filePath: '/omp-sessions/session.jsonl',
      projectPath: '/omp-project',
    }
    const otherSession: SessionRecord = {
      ...ompSession,
      id: 'other-session',
      filePath: '/omp-sessions/other-session.jsonl',
      title: 'Other session',
    }
    act(() => { root.render(createElement(Probe, { bridge: null, initialProject: ompProject, initialSession: ompSession, sessions: [ompSession, otherSession] })) })

    act(() => { latest.queuePrompt('keep this OMP follow-up', 'queue') })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['keep this OMP follow-up'])

    act(() => { latest.activateWorkspace(ompProject, otherSession) })
    expect(latest.pendingQueuedPrompts).toEqual([])
    act(() => { latest.queuePrompt('other thread follow-up', 'queue') })

    act(() => { latest.activateWorkspace(ompProject, ompSession) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['keep this OMP follow-up'])

    act(() => { latest.activateWorkspace(ompProject, otherSession) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['other thread follow-up'])
  })

  it.each(['prime', 'omp', 'pi'] as const)('promotes an acknowledged %s steer into history while leaving true queued prompts pending', (harness) => {
    let flushFrame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { flushFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const harnessProject = { ...project, harness }
    const harnessSession = { ...session, harness }
    act(() => { root.render(createElement(Probe, { bridge: null, harness, initialProject: harnessProject, initialSession: harnessSession })) })
    act(() => {
      latest.setMessages([{
        id: 'assistant-live', role: 'assistant', timestamp: 1, streaming: true,
        parts: [{ type: 'text', text: 'Working before the steer.' }],
      }])
      latest.queuePrompt('change direction', 'steer', [{ type: 'text', text: 'change direction' }], 2)
      latest.queuePrompt('do this next turn', 'queue')
    })

    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 1, steering: ['change direction'], followUps: [] }) })
    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.intent)).toEqual(['steer', 'queue'])

    act(() => {
      latest.reconcileQueuedPrompts({
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'preparing', label: 'change direction' },
      })
      flushFrame?.(3)
    })

    expect(latest.pendingQueuedPrompts.map((prompt) => prompt.text)).toEqual(['do this next turn'])
    expect(latest.messages).toMatchObject([
      { id: 'assistant-live', role: 'assistant', streaming: false },
      { role: 'user', steerState: 'read', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] },
      { role: 'system', kind: 'steer-read-marker', parts: [{ type: 'text', text: 'Steer read here' }] },
    ])
  })

  it('removes a cancelled steer without promoting it into transcript history', () => {
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => { latest.queuePrompt('cancel this steer', 'steer') })
    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 1, steering: ['cancel this steer'], followUps: [] }) })
    act(() => { latest.reconcileQueuedPrompts({ queuedCount: 0, steering: [], followUps: [] }) })

    expect(latest.pendingQueuedPrompts).toEqual([])
    expect(latest.messages).toEqual([])
  })

  it('settles a steer picked up before its scheduler update reaches the renderer', () => {
    let flushFrame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { flushFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    act(() => { root.render(createElement(Probe, { bridge: null })) })
    act(() => {
      latest.setMessages([{ id: 'assistant-live', role: 'assistant', timestamp: 1, streaming: true, parts: [] }])
      const id = latest.queuePrompt('fast steer', 'steer', [{ type: 'text', text: 'fast steer' }], 2)
      latest.acknowledgeSteer(id, {
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'running', label: 'fast steer' },
      })
      flushFrame?.(3)
    })

    expect(latest.pendingQueuedPrompts).toEqual([])
    expect(latest.messages).toMatchObject([
      { id: 'assistant-live', role: 'assistant', streaming: false },
      { role: 'user', steerState: 'read', timestamp: 2, parts: [{ type: 'text', text: 'fast steer' }] },
      { role: 'system', kind: 'steer-read-marker', parts: [{ type: 'text', text: 'Steer read here' }] },
    ])
  })

  it('settles a Rust Prime steer from the synthetic pickup and keeps both answers apart', () => {
    let flushFrame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { flushFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    let deliver!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
    const events = { agent: { onEvent: (listener: typeof deliver) => { deliver = listener; return () => undefined } } } as unknown as PrimeWorkApi
    function AgentEventsProbe() {
      latest = useWorkspaceRuntime({ bridge: null, harness: 'prime', initialProject: project, initialSession: session, sessions: [session], initialMessages: [], reportError: () => undefined })
      useAgentEvents({
        bridge: events,
        runtimeIdRef: latest.runtimeIdRef,
        runtimeSessionsRef: latest.runtimeSessionsRef,
        dropPendingSteers: latest.dropPendingSteers,
        detachRuntime: latest.detachRuntime,
        workspaceRef: latest.workspaceRef,
        setSessions: () => undefined,
        setRuntime: latest.setRuntime,
        reconcileQueuedPrompts: latest.reconcileQueuedPrompts,
        queueAgentEvent: latest.queueAgentEvent,
        reconcileTranscriptForEvent: latest.reconcileTranscriptForEvent,
        showExtensionUi: () => undefined,
        clearExtensionUi: () => undefined,
        refreshGit: async () => undefined,
        refreshGitOnTerminalEvent: false,
        activeSessionVisible: true,
      })
      return null
    }
    act(() => { root.render(createElement(AgentEventsProbe)) })
    latest.runtimeIdRef.current = 'runtime'
    const running = { kind: 'turn' as const, phase: 'running' as const }
    const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
    const text = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
    const send = (...sequence: Array<Record<string, unknown>>) => act(() => {
      for (const event of sequence) deliver({ runtimeId: 'runtime', event })
    })

    // The order the main process forwards a Rust Prime steer in: get_state
    // reports the queued steer, and the synthetic pickup precedes the user
    // message_start that delivers it.
    send({ type: 'agent_start' }, { type: 'turn_start' }, { type: 'message_start', message: user('go') }, text('first '))
    act(() => {
      const id = latest.queuePrompt('STEER-ME', 'steer', [{ type: 'text', text: 'STEER-ME' }], 2)
      deliver({ runtimeId: 'runtime', event: { type: 'session_action_update', synthetic: true, actions: { queuedCount: 1, steering: ['STEER-ME'], followUps: [], active: running } } })
      latest.acceptSteer(id)
      latest.acknowledgeSteer(id, { queuedCount: 1, steering: ['STEER-ME'], followUps: [], active: running })
    })
    send(
      text('answer'),
      { type: 'turn_end' },
      { type: 'turn_start' },
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } },
      { type: 'message_start', message: user('STEER-ME') },
      text('steer answer'),
      { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [] } },
    )
    act(() => { flushFrame?.(3) })

    expect(latest.pendingQueuedPrompts).toEqual([])
    const answers = latest.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''))
    expect(answers).toEqual(['first ', 'answer', 'steer answer'])
    expect(latest.messages.map((message) => message.kind ?? message.steerState ?? message.role)).toEqual(['assistant', 'read', 'assistant', 'steer-read-marker', 'assistant'])
  })

  it('keeps the optimistic user message when a pending background read resolves after the prompt', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as PrimeWorkApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    const generation = latest.workspaceRef.current.generation
    const userMessage: TranscriptMessage = {
      id: 'user-1754500000000', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'run the tests' }],
    }
    await act(async () => {
      expect(latest.prepareForPrompt(generation)).toBe(true)
      latest.setMessages((items) => [...items, userMessage])
    })

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'old answer' }] }])
    })
    await flush()

    expect(latest.messages.some((message) => message.id === 'user-1754500000000')).toBe(true)
  })

  it('applies a background read normally when no prompt raced it', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as PrimeWorkApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'persisted answer' }] }])
    })
    await flush()

    expect(latest.messages.map((message) => message.id)).toEqual(['record-1'])
    expect(latest.loadingSession).toBe(false)
  })
})
