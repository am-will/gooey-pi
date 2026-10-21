import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  Menu: { buildFromTemplate: vi.fn((_template: MenuItemConstructorOptions[]) => ({ popup: vi.fn() })) },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: {},
  Tray: class {},
}))

vi.mock('electron', () => electron)

import '../../electron/main/index'
import { isMacWindowCloseShortcut, loadInitialRenderer, mainWindowChromeOptions, windowCanvasColor } from '../../electron/main/main-window'
import { hardenRenderer, registerRendererProtocol, RENDERER_CONTENT_SECURITY_POLICY, resolveRendererAssetPath } from '../../electron/main/renderer-security'
import { ApplicationRevealQueue, activeShutdownWork, confirmAppClose, routeAllWindowsClosed, settleShutdown, shutdownPrompt, startupFailureDialog } from '../../electron/main/app-lifecycle'
import { StateMigrationError, UnsupportedStateVersionError } from '../../electron/main/store'
import type { RuntimeInfo } from '../../src/types/api'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

type Handler = (...args: never[]) => void

describe('application window lifecycle', () => {
  it('queues a second instance until startup is ready and coalesces activation events', () => {
    const reveal = vi.fn()
    const queue = new ApplicationRevealQueue(reveal, () => false)
    queue.request('activation')
    queue.request('second instance')
    queue.request('activation')
    expect(reveal).not.toHaveBeenCalled()
    queue.startupComplete()
    expect(reveal.mock.calls).toEqual([['second instance']])
    queue.request('activation')
    expect(reveal.mock.calls).toEqual([['second instance'], ['activation']])
  })

  it('drops queued activation when shutdown begins during startup', () => {
    const reveal = vi.fn()
    let shuttingDown = false
    const queue = new ApplicationRevealQueue(reveal, () => shuttingDown)
    queue.request('second instance')
    shuttingDown = true
    queue.startupComplete()
    queue.request('activation')
    expect(reveal).not.toHaveBeenCalled()
  })

  it('uses the same canvas color for the initial window and native caption background', () => {
    expect(windowCanvasColor('dark')).toBe('#171716')
    expect(windowCanvasColor('light')).toBe('#ffffff')
    expect(mainWindowChromeOptions('win32', 'dark').titleBarOverlay).toMatchObject({ color: windowCanvasColor('dark') })
  })

  it('keeps the final state drain inside the shutdown watchdog', async () => {
    const drain = vi.fn(() => new Promise<void>(() => {}))
    const log = vi.fn()
    await settleShutdown([], { watchdogMs: 5, drain, log })
    expect(drain).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not finish'))
  })

  it('gives migration failures a dedicated actionable startup dialog', () => {
    const migration = new StateMigrationError(
      'Legacy authority retirement failed.',
      'C:\\Users\\alice\\GooeyPi\\prime-work-state-v4.json',
      'C:\\Users\\alice\\GooeyPi\\prime-work-state.json',
      'C:\\Users\\alice\\GooeyPi\\prime-work-state.json.migrated-v4-backup',
    )

    expect(startupFailureDialog(migration)).toMatchObject({
      title: 'GooeyPi state migration failed',
      detail: expect.stringMatching(/startup stopped.*retry.*prime-work-state-v4\.json.*prime-work-state\.json.*migrated-v4-backup.*do not delete/i),
    })
    expect(startupFailureDialog(new UnsupportedStateVersionError(99, '/tmp/state.json'))?.title).toBe('GooeyPi update required')
    expect(startupFailureDialog(new Error('ordinary startup failure'))).toEqual({ title: 'GooeyPi could not start', detail: 'ordinary startup failure' })
  })

  it('uses one overlay title bar on Windows and Linux while preserving native macOS chrome', () => {
    expect(mainWindowChromeOptions('linux')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 52 },
      autoHideMenuBar: true,
    })
    expect(mainWindowChromeOptions('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#20201e', height: 32 },
      autoHideMenuBar: true,
    })
    expect(mainWindowChromeOptions('win32', 'dark')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#171716', symbolColor: '#f1f1ee', height: 32 },
      autoHideMenuBar: true,
    })
    expect(mainWindowChromeOptions('darwin')).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
    })
  })

  it('recognizes only an unmodified macOS Command-Q keydown as a window close', () => {
    const input = { type: 'keyDown', key: 'q', meta: true, shift: false, control: false, alt: false }

    expect(isMacWindowCloseShortcut(input, 'darwin')).toBe(true)
    expect(isMacWindowCloseShortcut({ ...input, type: 'keyUp' }, 'darwin')).toBe(false)
    expect(isMacWindowCloseShortcut({ ...input, meta: false }, 'darwin')).toBe(false)
    expect(isMacWindowCloseShortcut({ ...input, shift: true }, 'darwin')).toBe(false)
    expect(isMacWindowCloseShortcut({ ...input, key: 'w' }, 'darwin')).toBe(false)
    expect(isMacWindowCloseShortcut(input, 'win32')).toBe(false)
  })

  it('resolves packaged renderer assets with Windows path separators', () => {
    const root = 'C:\\GooeyPi\\resources\\app.asar\\out\\renderer'
    expect(resolveRendererAssetPath(root, '/index.html')).toBe(`${root}\\index.html`)
    expect(resolveRendererAssetPath(root, '/../main/index.js')).toBeNull()
    expect(resolveRendererAssetPath(root, '/assets/app.css')).toBe(`${root}\\assets\\app.css`)
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

  it('does not recreate background mode after shutdown starts', () => {
    const background = { handleAllWindowsClosed: vi.fn(() => true) }
    const quit = vi.fn()

    routeAllWindowsClosed(true, background, quit)

    expect(background.handleAllWindowsClosed).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
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
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() },
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

  it('denies guest popups and file navigation while allowing web and blank destinations', () => {
    const { handler } = hardenedWindow()
    const guestHandlers = new Map<string, Handler>()
    const guest = {
      id: 42,
      setWindowOpenHandler: vi.fn(),
      on: (name: string, listener: Handler) => { guestHandlers.set(name, listener) },
      once: vi.fn(),
    }
    handler('did-attach-webview')(...[{}, guest] as never[])
    expect(guest.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      const navigate = guestHandlers.get(name)
      if (!navigate) throw new Error(`Missing guest ${name} guard`)
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://example.test/', 'about:blank']) {
        const event = { url, preventDefault: vi.fn() }
        navigate(...[event, url] as never[])
        expect(event.preventDefault.mock.calls.length, `${name}: ${url}`).toBe(url.startsWith('file:') || url.startsWith('javascript:') ? 1 : 0)
      }
    }
  })

  it('offers native text editing and spellcheck suggestions with current edit permissions', () => {
    electron.Menu.buildFromTemplate.mockClear()
    const { handler, webContents } = hardenedWindow()
    handler('context-menu')(...[{}, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: { canUndo: false, canRedo: false, canCopy: false, canCut: false, canPaste: true } }] as never[])
    const template = electron.Menu.buildFromTemplate.mock.calls[0]?.[0]
    expect(template).toContainEqual({ role: 'paste', enabled: true })
    expect(template).toContainEqual({ role: 'cut', enabled: false })
    template?.find((item) => item.label === 'the')?.click?.(undefined as never, undefined as never, undefined as never)
    expect(webContents.replaceMisspelling).toHaveBeenCalledWith('the')
    template?.find((item) => item.label === 'Add to Dictionary')?.click?.(undefined as never, undefined as never, undefined as never)
    expect(webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('teh')
    webContents.isDestroyed.mockReturnValue(true)
    template?.find((item) => item.label === 'the')?.click?.(undefined as never, undefined as never, undefined as never)
    expect(webContents.replaceMisspelling).toHaveBeenCalledOnce()
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
    template?.[0]?.click?.(undefined as never, undefined as never, undefined as never)
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

describe('packaged renderer protocol', () => {
  it('serves packaged files with MIME/CSP headers and rejects malformed or out-of-origin requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gooeypi-renderer-protocol-'))
    try {
      const root = join(directory, 'renderer')
      await mkdir(root)
      await writeFile(join(root, 'index.html'), '<html>app</html>')
      await writeFile(join(root, 'app.js'), 'export const app = true')
      await writeFile(join(directory, 'private.txt'), 'outside')
      electron.protocol.handle.mockClear()
      registerRendererProtocol(root)
      const handle = electron.protocol.handle.mock.calls[0]?.[1] as ((request: { url: string }) => Promise<Response>) | undefined
      if (!handle) throw new Error('Renderer protocol was not registered')
      const html = await handle({ url: 'prime-work://app/' })
      expect(await html.text()).toBe('<html>app</html>')
      expect(html.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(html.headers.get('Content-Security-Policy')).toBe(RENDERER_CONTENT_SECURITY_POLICY)
      const script = await handle({ url: 'prime-work://app/app.js' })
      expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
      for (const url of [
        'prime-work://other/index.html', 'prime-work://app:123/index.html', 'https://app/index.html',
        'prime-work://user@app/index.html', 'prime-work://app/index.html?unsafe=1', 'prime-work://app/index.html#unsafe',
        'prime-work://app/%2e%2e/private.txt', 'prime-work://app/%5c..%5cprivate.txt', 'prime-work://app/%00', 'prime-work://app/%xx',
      ]) expect((await handle({ url })).status, url).toBe(404)
    } finally { await rm(directory, { recursive: true, force: true }) }
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
