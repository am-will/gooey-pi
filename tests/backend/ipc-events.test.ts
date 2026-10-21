import { harnessStub, serviceStub } from '../helpers/ipc-harness'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

vi.mock('electron', () => electronMocks)

import { registerIpc } from '../../electron/main/ipc'





describe('app:reveal-path authorization', () => {
  const expectedUrl = 'prime-work://app/'

  function revealHarness(overrides: { projects?: unknown; sessions?: unknown; plugins?: unknown }) {
    const services = {
      meta: {},
      projects: overrides.projects ?? serviceStub(),
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), ...(overrides.sessions as object | undefined) },
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: overrides.plugins ?? serviceStub(),
      settings: serviceStub(),
      heartbeats: serviceStub(),
      schedules: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()) },
      browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
      omp: harnessStub(),
      pi: harnessStub(),
    }
    electronMocks.ipcMain.handle.mockClear()
    electronMocks.shell.showItemInFolder.mockClear()
    const registration = registerIpc(services as never, expectedUrl)
    const sender = {
      id: 11,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
    }
    registration.authorize(sender as never)
    const handler = electronMocks.ipcMain.handle.mock.calls.find(([channel]) => channel === 'app:reveal-path')?.[1] as
      (event: unknown, path: unknown) => Promise<boolean>
    const invoke = (path: unknown) => handler({ sender, senderFrame: sender.mainFrame }, path)
    return { invoke, registration }
  }

  it('reveals a path through the first authorization domain that accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-'))
    try {
      const deny = async () => { throw new Error('not a project path') }
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(deny) },
        sessions: { requireSessionPath: vi.fn(async () => dir) },
      })
      await expect(invoke(dir)).resolves.toBe(true)
      expect(electronMocks.shell.showItemInFolder).toHaveBeenCalledWith(dir)
      registration.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns false without revealing when every authorization domain denies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-denied-'))
    try {
      const deny = () => { throw new Error('denied') }
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(async () => deny()) },
        sessions: { requireSessionPath: vi.fn(async () => deny()) },
        plugins: { ...serviceStub(), authorizeReveal: vi.fn(deny) },
      })
      await expect(invoke(dir)).resolves.toBe(false)
      await expect(invoke(join(dir, 'missing.txt'))).resolves.toBe(false)
      expect(electronMocks.shell.showItemInFolder).not.toHaveBeenCalled()
      registration.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('warns instead of swallowing an unexpected reveal failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-error-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(async () => dir) },
      })
      electronMocks.shell.showItemInFolder.mockImplementationOnce(() => { throw new Error('shell unavailable') })
      await expect(invoke(dir)).resolves.toBe(false)
      expect(warn).toHaveBeenCalledWith('Rejected app:reveal-path:', 'shell unavailable')
      registration.dispose()
    } finally {
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('session change IPC', () => {
  it('broadcasts only to still-trusted authorized renderers and unsubscribes on disposal', () => {
    let notify: ((event: { filePath?: string }) => void) | undefined
    const unsubscribe = vi.fn()
    const sessions = {
      ...serviceStub(),
      onDidChange: vi.fn((listener: (event: { filePath?: string }) => void) => {
        notify = listener
        return unsubscribe
      }),
    }
    const services = {
      meta: {},
      projects: serviceStub(),
      sessions,
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: serviceStub(),
      settings: serviceStub(),
      schedules: serviceStub(),
      browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
      omp: harnessStub(),
      pi: harnessStub(),
    }
    const expectedUrl = 'prime-work://app/'
    const trusted = {
      id: 1,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    let navigatedUrl = expectedUrl
    const navigated = {
      id: 2,
      getURL: () => navigatedUrl,
      mainFrame: { get url() { return navigatedUrl } },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    const unauthorized = {
      id: 3,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }

    const registration = registerIpc(services as never, expectedUrl)
    registration.authorize(trusted as never)
    registration.authorize(navigated as never)
    navigatedUrl = 'https://example.com/'
    notify?.({ filePath: '/tmp/session.jsonl' })

    expect(trusted.send).toHaveBeenCalledWith('sessions:changed', { filePath: '/tmp/session.jsonl' })
    expect(navigated.send).not.toHaveBeenCalled()
    expect(unauthorized.send).not.toHaveBeenCalled()

    registration.revoke(trusted.id)
    notify?.({})
    expect(trusted.send).toHaveBeenCalledTimes(1)

    registration.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    notify?.({ filePath: '/tmp/later.jsonl' })
    expect(trusted.send).toHaveBeenCalledTimes(1)
  })
})

describe('harness status IPC', () => {
  it('signals a main-process harness refresh to still-trusted authorized renderers until disposal', () => {
    const services = {
      meta: {},
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()) },
      schedules: serviceStub(),
      browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
      terminals: serviceStub(),
      omp: harnessStub(),
      pi: harnessStub(),
    }
    const expectedUrl = 'prime-work://app/'
    const renderer = (id: number, url: string) => ({ id, getURL: () => url, mainFrame: { url }, isDestroyed: () => false, send: vi.fn() })
    const trusted = renderer(1, expectedUrl)
    const navigated = renderer(2, 'https://example.com/')
    const unauthorized = renderer(3, expectedUrl)

    const registration = registerIpc(services as never, expectedUrl)
    registration.authorize(trusted as never)
    registration.authorize(navigated as never)
    registration.notifyHarnessesChanged()

    expect(trusted.send).toHaveBeenCalledExactlyOnceWith('app:harnesses-changed')
    expect(navigated.send).not.toHaveBeenCalled()
    expect(unauthorized.send).not.toHaveBeenCalled()

    registration.dispose()
    registration.notifyHarnessesChanged()
    expect(trusted.send).toHaveBeenCalledTimes(1)
  })
})

describe('shell-facing app handlers', () => {
  const expectedUrl = 'prime-work://app/'
  const dirs: string[] = []
  let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  let sender: { id: number; isDestroyed: () => boolean; getURL: () => string; mainFrame: { url: string } }
  let event: { sender: typeof sender; senderFrame: { url: string } }

  function register(overrides: Record<string, unknown> = {}) {
    handlers = new Map()
    electronMocks.ipcMain.handle.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    })
    const services = {
      meta: {},
      projects: serviceStub(),
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined) },
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: serviceStub(),
      settings: serviceStub(),
      schedules: serviceStub(),
      browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
      omp: harnessStub(),
      pi: harnessStub(),
      ...overrides,
    }
    const registration = registerIpc(services as never, expectedUrl)
    registration.authorize(sender as never)
    return registration
  }

  beforeEach(() => {
    const mainFrame = { url: expectedUrl }
    sender = { id: 11, isDestroyed: () => false, getURL: () => expectedUrl, mainFrame }
    event = { sender, senderFrame: mainFrame }
    electronMocks.shell.openExternal.mockReset()
    electronMocks.shell.showItemInFolder.mockReset()
    electronMocks.ipcMain.handle.mockReset()
  })

  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('opens validated web and mailto URLs through the shell', async () => {
    const registration = register()
    electronMocks.shell.openExternal.mockResolvedValue(undefined)
    await expect(handlers.get('app:open-external')!(event, 'https://example.com')).resolves.toBe(true)
    expect(electronMocks.shell.openExternal).toHaveBeenCalledWith('https://example.com/', { activate: true })
    await expect(handlers.get('app:open-external')!(event, 'mailto:team@example.com')).resolves.toBe(true)
    expect(electronMocks.shell.openExternal).toHaveBeenCalledWith('mailto:team@example.com', { activate: true })
    registration.dispose()
  })

  it('refuses disallowed URLs without ever reaching the shell', async () => {
    const registration = register()
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com/', 42, `https://example.com/${'a'.repeat(8192)}`]) {
      await expect(handlers.get('app:open-external')!(event, url), String(url)).resolves.toBe(false)
    }
    expect(electronMocks.shell.openExternal).not.toHaveBeenCalled()
    registration.dispose()
  })

  it('reports failure when the shell itself rejects the launch', async () => {
    const registration = register()
    electronMocks.shell.openExternal.mockRejectedValue(new Error('no handler'))
    await expect(handlers.get('app:open-external')!(event, 'https://example.com')).resolves.toBe(false)
    expect(electronMocks.shell.openExternal).toHaveBeenCalledTimes(1)
    registration.dispose()
  })

  it('reveals a path only after project authorization succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-')); dirs.push(dir)
    const file = join(dir, 'file.txt'); writeFileSync(file, 'data')
    const canonical = await realpath(file)
    const authorizePath = vi.fn(async (path: string) => path)
    const registration = register({ projects: { ...serviceStub(), authorizePath } })
    await expect(handlers.get('app:reveal-path')!(event, file)).resolves.toBe(true)
    expect(authorizePath).toHaveBeenCalledWith(canonical)
    expect(electronMocks.shell.showItemInFolder).toHaveBeenCalledWith(canonical)
    registration.dispose()
  })

  it('falls back to session and then plugin authorization in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-')); dirs.push(dir)
    const file = join(dir, 'file.txt'); writeFileSync(file, 'data')
    const canonical = await realpath(file)
    const authorizePath = vi.fn(async () => { throw new Error('outside projects') })
    const requireSessionPath = vi.fn(async () => { throw new Error('not a session file') })
    const authorizeReveal = vi.fn(() => canonical)
    const registration = register({
      projects: { ...serviceStub(), authorizePath },
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), requireSessionPath },
      plugins: { ...serviceStub(), authorizeReveal },
    })
    await expect(handlers.get('app:reveal-path')!(event, file)).resolves.toBe(true)
    expect(requireSessionPath).toHaveBeenCalledWith(canonical)
    expect(authorizeReveal).toHaveBeenCalledWith(canonical)
    expect(electronMocks.shell.showItemInFolder).toHaveBeenCalledWith(canonical)
    registration.dispose()
  })

  it('denies reveal when every authorizer refuses the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-')); dirs.push(dir)
    const file = join(dir, 'file.txt'); writeFileSync(file, 'data')
    const registration = register({
      projects: { ...serviceStub(), authorizePath: vi.fn(async () => { throw new Error('denied') }) },
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), requireSessionPath: vi.fn(async () => { throw new Error('denied') }) },
      plugins: { ...serviceStub(), authorizeReveal: vi.fn(() => { throw new Error('denied') }) },
    })
    await expect(handlers.get('app:reveal-path')!(event, file)).resolves.toBe(false)
    expect(electronMocks.shell.showItemInFolder).not.toHaveBeenCalled()
    registration.dispose()
  })

  it('denies reveal for nonexistent or relative paths before consulting authorizers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-')); dirs.push(dir)
    const authorizePath = vi.fn(async (path: string) => path)
    const registration = register({ projects: { ...serviceStub(), authorizePath } })
    await expect(handlers.get('app:reveal-path')!(event, join(dir, 'missing.txt'))).resolves.toBe(false)
    await expect(handlers.get('app:reveal-path')!(event, 'relative/path.txt')).resolves.toBe(false)
    await expect(handlers.get('app:reveal-path')!(event, 42)).resolves.toBe(false)
    expect(authorizePath).not.toHaveBeenCalled()
    expect(electronMocks.shell.showItemInFolder).not.toHaveBeenCalled()
    registration.dispose()
  })
})

describe('IPC registration lifecycle', () => {
  function servicesWithUnsubscribe(unsubscribe: () => void): Record<string, unknown> {
    return {
      meta: {},
      projects: serviceStub(),
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => unsubscribe) },
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: serviceStub(),
      settings: serviceStub(),
      schedules: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()) },
      browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
      omp: harnessStub(),
      pi: harnessStub(),
    }
  }

  it('removes any prior listener before registering event channels', () => {
    electronMocks.ipcMain.on.mockClear()
    electronMocks.ipcMain.removeAllListeners.mockClear()
    const registration = registerIpc(servicesWithUnsubscribe(vi.fn()) as never, 'prime-work://app/')

    const eventChannels = electronMocks.ipcMain.on.mock.calls.map(([channel]) => channel)
    expect(eventChannels.length).toBeGreaterThan(0)
    const removed = electronMocks.ipcMain.removeAllListeners.mock.calls.map(([channel]) => channel)
    for (const channel of eventChannels) expect(removed).toContain(channel)

    registration.dispose()
  })

  it('warns and disposes a previous registration when registerIpc is called again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const firstUnsubscribe = vi.fn()
    const first = registerIpc(servicesWithUnsubscribe(firstUnsubscribe) as never, 'prime-work://app/')
    expect(firstUnsubscribe).not.toHaveBeenCalled()

    const second = registerIpc(servicesWithUnsubscribe(vi.fn()) as never, 'prime-work://app/')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('previous registration'))
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)

    // Disposing the stale handle again is a no-op.
    first.dispose()
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    second.dispose()
    warn.mockRestore()
  })
})
