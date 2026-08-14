import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'

const EXPECTED_URL = 'prime-work://app/'

function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

function harnessStub(): Record<string, unknown> {
  return {
    projects: { ...serviceStub(), authorizePath: vi.fn(async () => { throw new Error('denied') }) },
    sessions: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), requireSessionPath: vi.fn(async () => { throw new Error('denied') }) },
    agents: { ...serviceStub(), has: vi.fn(() => false) },
    catalog: serviceStub(),
  }
}

function services(): Record<string, unknown> {
  return {
    meta: { version: '0.0.0-test' },
    projects: serviceStub(),
    sessions: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined) },
    agents: serviceStub(),
    terminals: { ...serviceStub(), input: vi.fn(), killOwner: vi.fn(async () => undefined) },
    git: serviceStub(),
    plugins: serviceStub(),
    providers: serviceStub(),
    settings: serviceStub(),
    heartbeats: serviceStub(),
    schedules: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined) },
    browser: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
    pets: { list: vi.fn(async () => [{ id: 'orb' }]), sprite: vi.fn(async () => 'data:image/webp;base64,pet') },
    omp: harnessStub(),
    pi: harnessStub(),
    applyInterfaceZoom: vi.fn(),
  }
}

interface FakeSenderOptions {
  id?: number
  url?: string
  frameUrl?: string
  destroyed?: boolean
  subFrame?: boolean
}

function fakeEvent(options: FakeSenderOptions = {}) {
  const mainFrame = { url: options.frameUrl ?? EXPECTED_URL }
  const sender = {
    id: options.id ?? 1,
    isDestroyed: () => options.destroyed === true,
    getURL: () => options.url ?? EXPECTED_URL,
    setZoomFactor: vi.fn(),
    mainFrame,
  }
  // A sub-frame sender presents a senderFrame that is not the main frame,
  // even when that frame reports the trusted URL.
  const senderFrame = options.subFrame ? { url: options.frameUrl ?? EXPECTED_URL } : mainFrame
  return { sender, senderFrame }
}

describe('registerIpc verify gate', () => {
  let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  let listeners: Map<string, (event: unknown, ...args: unknown[]) => void>
  let registration: IpcRegistration
  let stubs: Record<string, unknown>

  beforeEach(() => {
    handlers = new Map()
    listeners = new Map()
    electronMocks.ipcMain.handle.mockReset()
    electronMocks.ipcMain.on.mockReset()
    electronMocks.ipcMain.handle.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    })
    electronMocks.ipcMain.on.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    })
    stubs = services()
    registration = registerIpc(stubs as never, EXPECTED_URL)
  })

  it('allows an authorized main-frame sender at the trusted URL', () => {
    const event = fakeEvent()
    registration.authorize(event.sender as never)
    expect(handlers.get('app:get-meta')!(event)).toEqual({ version: '0.0.0-test' })
    registration.dispose()
  })

  it('exposes fixed read-only pet discovery channels to an authorized renderer', async () => {
    const event = fakeEvent()
    registration.authorize(event.sender as never)
    await expect(handlers.get('pets:list')!(event)).resolves.toEqual([{ id: 'orb' }])
    await expect(handlers.get('pets:sprite')!(event, 'gooey-pi')).resolves.toBe('data:image/webp;base64,pet')
    registration.dispose()
  })

  it('applies a validated interface scale to every renderer only after the settings update succeeds', async () => {
    const event = fakeEvent()
    const update = vi.fn(async () => ({ interfaceFontScale: 115, askUserEnabled: true }))
    const applyInterfaceZoom = stubs.applyInterfaceZoom as ReturnType<typeof vi.fn>
    stubs.settings = { get: () => ({ interfaceFontScale: 110, askUserEnabled: true }), update }
    registration.authorize(event.sender as never)

    await expect(handlers.get('settings:update')!(event, { interfaceFontScale: 115 })).resolves.toEqual({ interfaceFontScale: 115, askUserEnabled: true })
    expect(update).toHaveBeenCalledWith({ interfaceFontScale: 115 })
    expect(applyInterfaceZoom).toHaveBeenCalledWith(115)
    expect(event.sender.setZoomFactor).not.toHaveBeenCalled()

    applyInterfaceZoom.mockClear()
    update.mockRejectedValueOnce(new TypeError('Invalid interface font scale'))
    await expect(handlers.get('settings:update')!(event, { interfaceFontScale: 125 })).rejects.toThrow('Invalid interface font scale')
    expect(applyInterfaceZoom).not.toHaveBeenCalled()
    registration.dispose()
  })

  it('leaves renderer zoom untouched for settings patches that do not change the scale', async () => {
    const event = fakeEvent()
    const applyInterfaceZoom = stubs.applyInterfaceZoom as ReturnType<typeof vi.fn>
    stubs.settings = {
      get: () => ({ interfaceFontScale: 110, askUserEnabled: true }),
      update: vi.fn(async () => ({ interfaceFontScale: 110, askUserEnabled: true })),
    }
    registration.authorize(event.sender as never)

    await handlers.get('settings:update')!(event, { theme: 'dark' })

    expect(applyInterfaceZoom).not.toHaveBeenCalled()
    registration.dispose()
  })

  it('recycles all harness runtimes when the universal ask_user toggle changes', async () => {
    const event = fakeEvent()
    const refreshPrime = vi.fn(async () => undefined)
    const refreshOmp = vi.fn(async () => undefined)
    const refreshPi = vi.fn(async () => undefined)
    stubs.settings = {
      get: () => ({ askUserEnabled: true }),
      update: vi.fn(async () => ({ interfaceFontScale: 110, askUserEnabled: false })),
    }
    stubs.agents = { ...serviceStub(), requestRuntimeEnvironmentRefresh: refreshPrime }
    ;(stubs.omp as { agents: unknown }).agents = { ...serviceStub(), requestRuntimeEnvironmentRefresh: refreshOmp }
    ;(stubs.pi as { agents: unknown }).agents = { ...serviceStub(), requestRuntimeEnvironmentRefresh: refreshPi }
    registration.authorize(event.sender as never)

    await handlers.get('settings:update')!(event, { askUserEnabled: false })

    expect(refreshPrime).toHaveBeenCalledOnce()
    expect(refreshOmp).toHaveBeenCalledOnce()
    expect(refreshPi).toHaveBeenCalledOnce()
    registration.dispose()
  })

  it('rejects a sub-frame sender even when its URL is trusted', () => {
    const event = fakeEvent({ subFrame: true })
    registration.authorize(event.sender as never)
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('rejects a destroyed sender that is still in the authorized set', () => {
    const event = fakeEvent({ destroyed: true })
    registration.authorize(event.sender as never)
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('rejects every call after dispose, including previously authorized senders', () => {
    const event = fakeEvent()
    registration.authorize(event.sender as never)
    registration.dispose()
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
  })

  it('rejects a sender id that was never authorized', () => {
    const event = fakeEvent({ id: 99 })
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('rejects a sender revoked after authorization', () => {
    const event = fakeEvent()
    registration.authorize(event.sender as never)
    registration.revoke(event.sender.id)
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('rejects a frame navigated away from the renderer URL', () => {
    const event = fakeEvent({ frameUrl: 'https://attacker.example/' , url: 'https://attacker.example/' })
    registration.authorize(event.sender as never)
    expect(() => handlers.get('app:get-meta')!(event)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('rejects when the frame URL and the WebContents URL disagree', () => {
    // Frame URL trusted, sender.getURL() not: both must match the renderer URL.
    const mismatchedContents = fakeEvent({ url: 'https://attacker.example/' })
    registration.authorize(mismatchedContents.sender as never)
    expect(() => handlers.get('app:get-meta')!(mismatchedContents)).toThrow('IPC sender is not authorized')

    const mismatchedFrame = fakeEvent({ id: 2, frameUrl: 'https://attacker.example/' })
    registration.authorize(mismatchedFrame.sender as never)
    expect(() => handlers.get('app:get-meta')!(mismatchedFrame)).toThrow('IPC sender is not authorized')
    registration.dispose()
  })

  it('drops unauthorized fire-and-forget events without invoking the service', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const input = (stubs.terminals as { input: ReturnType<typeof vi.fn> }).input
    const event = fakeEvent({ id: 7 })
    listeners.get('terminal:input')!(event, 'terminal-1', 'ls\r')
    expect(input).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal:input'), 'IPC sender is not authorized')
    warn.mockRestore()
    registration.dispose()
  })
})
