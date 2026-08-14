import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/prime-work'),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => false),
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  Menu: { buildFromTemplate: vi.fn((_template: Array<{ label: string; click(): void }>) => ({ popup: vi.fn() })) },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
}))

vi.mock('electron', () => electron)

import { activeShutdownWork, confirmAppClose, hardenRenderer, loadInitialRenderer, mainWindowChromeOptions, settleShutdown, shutdownPrompt } from '../../electron/main/index'
import type { RuntimeInfo } from '../../src/types/api'
import type { BrowserWindow } from 'electron'

type Handler = (...args: never[]) => void

describe('application window lifecycle', () => {
  it('uses one overlay title bar on Linux while preserving native platform chrome elsewhere', () => {
    expect(mainWindowChromeOptions('linux')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 52 },
      autoHideMenuBar: true,
    })
    expect(mainWindowChromeOptions('win32')).toEqual({ titleBarStyle: 'default' })
    expect(mainWindowChromeOptions('darwin')).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
    })
  })

  it('asks nothing when no agent run or schedule is active', () => {
    const idle: RuntimeInfo = { runtimeId: 'a', harness: 'prime', cwd: '/tmp', isStreaming: false }

    expect(activeShutdownWork([idle], false)).toEqual({ runningAgents: 0, activeSchedules: false })
    expect(shutdownPrompt(activeShutdownWork([idle], false))).toBeNull()
    expect(shutdownPrompt(activeShutdownWork([], false))).toBeNull()
  })

  it('names the work at risk for streaming, compacting, queued, and scheduled state', () => {
    const base = { harness: 'prime' as const, cwd: '/tmp', isStreaming: false }
    const actions = { queuedCount: 0, steering: [], followUps: [] }
    const runtimes: RuntimeInfo[] = [
      { ...base, runtimeId: 'a', isStreaming: true },
      { ...base, runtimeId: 'b', isCompacting: true },
      { ...base, runtimeId: 'c', sessionActions: { ...actions, active: { kind: 'turn', phase: 'running' } } },
      { ...base, runtimeId: 'd', sessionActions: { ...actions, queuedCount: 2 } },
      { ...base, runtimeId: 'e', sessionActions: actions },
    ]

    expect(activeShutdownWork(runtimes, true)).toEqual({ runningAgents: 4, activeSchedules: true })
    expect(shutdownPrompt({ runningAgents: 4, activeSchedules: true })).toEqual({
      message: 'Close GooeyPi while an agent is running?',
      detail: '4 agent runs are still in progress and will be stopped. Scheduled automations will not run while GooeyPi is closed.',
    })
    expect(shutdownPrompt({ runningAgents: 1, activeSchedules: false })).toEqual({
      message: 'Close GooeyPi while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
    })
    expect(shutdownPrompt({ runningAgents: 0, activeSchedules: true })).toEqual({
      message: 'Close GooeyPi?',
      detail: 'Scheduled automations will not run while GooeyPi is closed.',
    })
  })

  it('defaults to cancel and uses the non-blocking dialog', async () => {
    const window = { isDestroyed: () => false } as unknown as BrowserWindow
    const prompt = { message: 'Close GooeyPi?', detail: 'Scheduled automations will not run while GooeyPi is closed.' }
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })

    await expect(confirmAppClose(window, prompt)).resolves.toBe(false)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(window, {
      type: 'warning',
      buttons: ['Cancel', 'Close GooeyPi'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'GooeyPi',
      ...prompt,
    })

    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(confirmAppClose(window, prompt)).resolves.toBe(true)

    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(confirmAppClose(null, prompt)).resolves.toBe(true)
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining(prompt))
  })

  it('quits when the last window closes', () => {
    electron.app.quit.mockClear()
    const registration = electron.app.on.mock.calls.find(([event]) => event === 'window-all-closed')

    expect(registration).toBeDefined()
    registration?.[1]()
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })
})

function hardenedWindow(currentUrl = 'prime-work://app/index.html') {
  const handlers = new Map<string, Handler>()
  const webContents = {
    on: (name: string, listener: Handler) => { handlers.set(name, listener) },
    once: (name: string, listener: Handler) => { handlers.set(name, listener) },
    setWindowOpenHandler: vi.fn(),
    getURL: () => currentUrl,
    isDestroyed: vi.fn(() => false),
    copyImageAt: vi.fn(),
  }
  const window = { webContents, isDestroyed: vi.fn(() => false) }
  hardenRenderer(window as unknown as BrowserWindow, () => 'prime-work://app/index.html')
  const handler = (name: string): Handler => {
    const listener = handlers.get(name)
    if (!listener) throw new Error(`No ${name} handler was registered`)
    return listener
  }
  return { handler, webContents, window }
}

describe('renderer hardening', () => {
  it('forces webviewTag off and locks down every attached webview preference', () => {
    const { handler } = hardenedWindow()
    const preferences: Record<string, unknown> = { preload: '/tmp/evil.js', nodeIntegration: true, webviewTag: true, sandbox: false }
    const event = { preventDefault: vi.fn() }
    handler('will-attach-webview')(...[event, preferences, { partition: 'persist:prime-work-browser', src: 'https://example.test/' }] as never[])

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
    expect('preload' in preferences).toBe(false)
  })

  it('rejects webviews outside the browser partition or with unsafe sources', () => {
    const { handler } = hardenedWindow()
    for (const params of [
      { partition: 'persist:other', src: 'https://example.test/' },
      { partition: 'persist:prime-work-browser', src: 'file:///etc/passwd' },
    ]) {
      const event = { preventDefault: vi.fn() }
      handler('will-attach-webview')(...[event, {}, params] as never[])
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('offers native image copying only for decoded images in the trusted renderer', () => {
    electron.Menu.buildFromTemplate.mockClear()
    const { handler, webContents } = hardenedWindow()

    handler('context-menu')(...[{}, { mediaType: 'none', hasImageContents: false, x: 1, y: 2 }] as never[])
    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()

    handler('context-menu')(...[{}, { mediaType: 'image', hasImageContents: true, x: 14, y: 27 }] as never[])
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledOnce()
    const template = electron.Menu.buildFromTemplate.mock.calls[0]?.[0]
    expect(template?.[0]?.label).toBe('Copy Image')
    template?.[0]?.click()
    expect(webContents.copyImageAt).toHaveBeenCalledWith(14, 27)
  })

  it('blocks main-window redirects and frame navigations away from the trusted renderer', () => {
    const { handler } = hardenedWindow()
    for (const name of ['will-redirect', 'will-frame-navigate']) {
      const blocked = { url: 'https://attacker.test/', preventDefault: vi.fn() }
      handler(name)(...[blocked] as never[])
      expect(blocked.preventDefault, name).toHaveBeenCalledOnce()

      const trusted = { url: 'prime-work://app/index.html', preventDefault: vi.fn() }
      handler(name)(...[trusted] as never[])
      expect(trusted.preventDefault, name).not.toHaveBeenCalled()
    }
  })
})

describe('initial renderer window lifecycle', () => {
  it('does not settle the initial load before navigation settles', async () => {
    let resolveLoad!: () => void
    const loadURL = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const destroy = vi.fn()
    const loading = loadInitialRenderer({ loadURL, isDestroyed: () => false, destroy }, 'prime-work://app/index.html')
    let settled = false
    void loading.then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(destroy).not.toHaveBeenCalled()

    resolveLoad()
    await loading
    expect(settled).toBe(true)
    expect(loadURL).toHaveBeenCalledWith('prime-work://app/index.html')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('destroys the hidden window and preserves the load rejection', async () => {
    const failure = new Error('renderer unavailable')
    const destroy = vi.fn()

    await expect(loadInitialRenderer({
      loadURL: vi.fn(async () => { throw failure }),
      isDestroyed: () => false,
      destroy,
    }, 'prime-work://app/index.html')).rejects.toBe(failure)

    expect(destroy).toHaveBeenCalledOnce()
  })

  it('does not destroy a window that a concurrent shutdown already destroyed', async () => {
    const destroy = vi.fn()

    await expect(loadInitialRenderer({
      loadURL: vi.fn(async () => { throw new Error('ERR_ABORTED') }),
      isDestroyed: () => true,
      destroy,
    }, 'prime-work://app/index.html')).rejects.toThrow('ERR_ABORTED')

    expect(destroy).not.toHaveBeenCalled()
  })
})

describe('shutdown settlement', () => {
  it('waits for every step and logs rejections without rejecting itself', async () => {
    const log = vi.fn()
    let finished = false

    await settleShutdown([
      Promise.resolve(),
      Promise.reject(new Error('terminal cleanup failed')),
      new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve() }, 20)),
    ], { log })

    expect(finished).toBe(true)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('terminal cleanup failed'))
  })

  it('gives up after the watchdog deadline when a step never settles', async () => {
    const log = vi.fn()

    await settleShutdown([new Promise<void>(() => undefined)], { log, watchdogMs: 25 })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('quitting anyway'))
  })
})
