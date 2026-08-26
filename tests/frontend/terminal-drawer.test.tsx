// @vitest-environment jsdom

import { act, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalDrawer, type TerminalDrawerHandle } from '../../src/components/TerminalDrawer'
import type { PrimeWorkApi, TerminalExitEvent } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('TerminalDrawer project command handle', () => {
  let root: Root
  let container: HTMLDivElement
  let terminalExitListeners: Array<(event: TerminalExitEvent) => void>
  let create: ReturnType<typeof vi.fn>
  let kill: ReturnType<typeof vi.fn>
  let createdTerminalIds: string[]
  let onError: ReturnType<typeof vi.fn<(message: string) => void>>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }),
    })
    terminalExitListeners = []
    createdTerminalIds = []
    onError = vi.fn()
    let nextTerminalId = 0
    create = vi.fn(async ({ command }: { command?: string }) => {
      if (command === 'fail to spawn') throw new Error('spawn failed')
      const terminalId = `terminal-${nextTerminalId++}`
      createdTerminalIds.push(terminalId)
      return { terminalId, shell: '/bin/sh', command }
    })
    kill = vi.fn(async () => undefined)
    const bridge = {
      terminal: {
        create,
        kill,
        onData: vi.fn(() => () => undefined),
        onExit: vi.fn((callback: (event: TerminalExitEvent) => void) => {
          terminalExitListeners.push(callback)
          return () => undefined
        }),
        bindSession: vi.fn(async () => undefined),
        input: vi.fn(),
        resize: vi.fn(),
        setActiveContext: vi.fn(),
        clearActiveContext: vi.fn(),
      },
    } as unknown as PrimeWorkApi
    Object.defineProperty(window, 'prime', { configurable: true, value: bridge })
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function renderDrawer(handle: RefObject<TerminalDrawerHandle | null>) {
    act(() => root.render(<TerminalDrawer ref={handle} cwd="/repo" height={200} minHeight={100} maxHeight={500} defaultHeight={200} onHeightChange={vi.fn()} onClose={vi.fn()} onError={onError} />))
  }

  function createHandle() {
    return { current: null } as RefObject<TerminalDrawerHandle | null>
  }

  it('runs a labelled command tab and passes the command to terminal.create', async () => {
    const handle = createHandle()
    renderDrawer(handle)
    const onExit = vi.fn()
    await act(async () => {
      handle.current?.runCommand('npm run dev', 'Run', onExit)
      await Promise.resolve()
    })

    expect(Array.from(container.querySelectorAll('[role="tab"]')).some((tab) => tab.textContent?.includes('Run'))).toBe(true)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'npm run dev' }))
  })

  it('reports tab stops as cancellation without an exit code', () => {
    const handle = createHandle()
    renderDrawer(handle)
    const onExit = vi.fn()
    let tabId = ''
    act(() => { tabId = handle.current?.runCommand('npm run dev', 'Run', onExit) ?? '' })
    act(() => { handle.current?.stopCommand(tabId) })

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith()
    expect(onExit).not.toHaveBeenCalledWith(expect.any(Number))
  })

  it('reports a real terminal exit once even when the tab is closed afterwards', async () => {
    const handle = createHandle()
    renderDrawer(handle)
    const onExit = vi.fn()
    let tabId = ''
    await act(async () => {
      tabId = handle.current?.runCommand('npm run dev', 'Run', onExit) ?? ''
      await Promise.resolve()
    })
    const runTerminalId = createdTerminalIds.at(-1)
    expect(runTerminalId).toBeDefined()
    act(() => {
      terminalExitListeners.forEach((listener) => {
        listener({ terminalId: runTerminalId!, exitCode: 7 })
      })
    })
    act(() => { handle.current?.stopCommand(tabId) })

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(7)
  })

  it('reports terminal creation failures without fabricating an exit code', async () => {
    const handle = createHandle()
    renderDrawer(handle)
    const onExit = vi.fn()
    await act(async () => {
      handle.current?.runCommand('fail to spawn', 'Setup', onExit)
      await Promise.resolve()
    })

    expect(onError).toHaveBeenCalledWith('spawn failed')
    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(undefined)
  })
})
