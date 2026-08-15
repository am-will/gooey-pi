import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { PrimeWorkApi, RuntimeInfo, TranscriptMessage } from '../../src/types/api'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const runtime = (runtimeId: string, isStreaming = true): RuntimeInfo => ({
  runtimeId,
  harness: 'prime',
  cwd: '/project',
  sessionFile: `/sessions/${runtimeId}.jsonl`,
  isStreaming,
})

const transcript = (id: string, streaming = true): TranscriptMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  streaming,
  parts: [{ type: 'text', text: id }],
})

function stopRuntimeFixture(command: ReturnType<typeof deferred<unknown>>) {
  let currentRuntime: RuntimeInfo | null = runtime('runtime-a')
  let currentMessages = [transcript('message-a')]
  const workspaceRef = { current: { generation: 1 } }
  const runtimeIdRef = { current: 'runtime-a' as string | null }
  const runtimeOwnerRef = { current: { runtimeId: 'runtime-a', generation: 1 } as { runtimeId: string; generation: number } | null }
  const reportError = vi.fn()
  const agentCommand = vi.fn(() => command.promise)
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    setRuntime(update: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) {
      currentRuntime = typeof update === 'function' ? update(currentRuntime) : update
    },
    setMessages(update: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) {
      currentMessages = typeof update === 'function' ? update(currentMessages) : update
    },
  }
  const actions = createWorkspaceActions(() => ({
    bridge: { agent: { command: agentCommand } } as unknown as PrimeWorkApi,
    workspace,
    reportError,
  } as unknown as WorkspaceActionsDeps))

  return {
    actions,
    agentCommand,
    reportError,
    runtime: () => currentRuntime,
    messages: () => currentMessages,
    setOwner(owner: { runtimeId: string; generation: number } | null) {
      runtimeOwnerRef.current = owner
    },
    replaceWorkspace(nextRuntime: RuntimeInfo, messages: TranscriptMessage[], generation: number) {
      currentRuntime = nextRuntime
      currentMessages = messages
      workspaceRef.current = { generation }
      runtimeIdRef.current = nextRuntime.runtimeId
      runtimeOwnerRef.current = { runtimeId: nextRuntime.runtimeId, generation }
    },
  }
}

describe('workspace runtime abort ownership', () => {
  it('leaves a navigated workspace runtime and transcript unchanged when the previous abort resolves', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()
    expect(fixture.agentCommand).toHaveBeenCalledWith('runtime-a', { type: 'abort' })

    const runtimeB = runtime('runtime-b')
    const messagesB = [transcript('message-b')]
    fixture.replaceWorkspace(runtimeB, messagesB, 2)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(runtimeB)
    expect(fixture.messages()).toBe(messagesB)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-b', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-b', streaming: true }])
  })

  it('leaves a same-generation replacement runtime and transcript unchanged', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const replacement = runtime('runtime-replacement')
    const replacementMessages = [transcript('replacement-message')]
    fixture.replaceWorkspace(replacement, replacementMessages, 1)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(replacement)
    expect(fixture.messages()).toBe(replacementMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-replacement', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'replacement-message', streaming: true }])
  })

  it('rejects an earlier-generation completion when the runtime ID is reused', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const reattachedRuntime = runtime('runtime-a')
    const reattachedMessages = [transcript('reattached-message')]
    fixture.replaceWorkspace(reattachedRuntime, reattachedMessages, 2)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(reattachedRuntime)
    expect(fixture.messages()).toBe(reattachedMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'reattached-message', streaming: true }])
  })

  it.each([
    { label: 'cleared', owner: null },
    { label: 'mismatched', owner: { runtimeId: 'runtime-other', generation: 1 } },
  ])('leaves current state unchanged when its runtime owner is $label', async ({ owner }) => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()
    const ownedRuntime = fixture.runtime()
    const ownedMessages = fixture.messages()

    fixture.setOwner(owner)
    command.resolve({})
    await stopping

    expect(fixture.runtime()).toBe(ownedRuntime)
    expect(fixture.messages()).toBe(ownedMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: true }])
  })

  it('settles the captured runtime and its transcript when ownership remains current', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    command.resolve({})
    await stopping

    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-a', isStreaming: false })
    expect(fixture.messages()).toMatchObject([{ id: 'message-a', streaming: false }])
    expect(fixture.reportError).not.toHaveBeenCalled()
  })

  it('reports an abort rejection without mutating an unrelated replacement', async () => {
    const command = deferred<unknown>()
    const fixture = stopRuntimeFixture(command)
    const stopping = fixture.actions.stopRuntime()

    const replacement = runtime('runtime-b')
    const replacementMessages = [transcript('message-b')]
    fixture.replaceWorkspace(replacement, replacementMessages, 2)
    const failure = new Error('abort failed')
    command.reject(failure)
    await stopping

    expect(fixture.reportError).toHaveBeenCalledOnce()
    expect(fixture.reportError).toHaveBeenCalledWith(failure)
    expect(fixture.runtime()).toBe(replacement)
    expect(fixture.messages()).toBe(replacementMessages)
    expect(fixture.runtime()).toMatchObject({ runtimeId: 'runtime-b', isStreaming: true })
    expect(fixture.messages()).toMatchObject([{ id: 'message-b', streaming: true }])
  })
})
