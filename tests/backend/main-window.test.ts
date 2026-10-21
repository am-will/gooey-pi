import { EventEmitter } from 'node:events'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, Menu: {}, nativeTheme: {}, screen: {}, protocol: {}, ipcMain: {}, shell: {} }))

import { MainWindowController } from '../../electron/main/main-window'

class TestWindow extends EventEmitter {
  destroyed = false
  readonly show = vi.fn()
  private resolveLoad!: () => void
  private rejectLoad!: (error: Error) => void
  readonly loading = new Promise<void>((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject })
  readonly webContents = Object.assign(new EventEmitter(), { id: 42, setWindowOpenHandler: vi.fn(), isDestroyed: () => this.destroyed, setZoomFactor: vi.fn() })
  loadURL = vi.fn(() => this.loading)
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('closed') }
  finishLoad() { this.resolveLoad() }
  failLoad(error: Error) { this.rejectLoad(error) }
}

function fixture() {
  const created: TestWindow[] = []
  const context = {
    shuttingDown: false, shutdownApproved: false, confirmingShutdown: false, keepHidden: false,
    rendererUrl: 'prime-work://app/index.html', preloadPath: '/preload.js', theme: 'dark' as const, zoomFactor: 1.1,
    ipc: { authorize: vi.fn(), revoke: vi.fn() }, background: null,
    iconPath: () => '/icon.png', approveGuest: vi.fn(), cancelDownloads: vi.fn(), killTerminals: vi.fn(async () => {}), shutdownPrompt: () => null, requestShutdown: vi.fn(), log: vi.fn(),
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    createWindow: vi.fn((_options: BrowserWindowConstructorOptions) => {
      const window = new TestWindow()
      created.push(window)
      return window as unknown as BrowserWindow
    }),
  }
  return { context, created, controller: new MainWindowController(context) }
}

describe('main window controller', () => {
  it('coalesces creation and waits for both renderer load and ready-to-show', async () => {
    const { controller, context, created } = fixture()
    const opening = controller.ensure()
    expect(controller.ensure()).toBe(opening)
    expect(context.createWindow).toHaveBeenCalledOnce()
    expect(context.createWindow.mock.calls[0][0]).toMatchObject({ show: false, backgroundColor: '#171716', webPreferences: { preload: '/preload.js', contextIsolation: true, sandbox: true, nodeIntegration: false } })
    const window = created[0]
    window.emit('ready-to-show')
    expect(window.show).not.toHaveBeenCalled()
    window.finishLoad()
    await opening
    expect(window.show).toHaveBeenCalledOnce()
    expect(controller.current).toBe(window)
  })

  it('does not revive a window if shutdown wins while its renderer loads', async () => {
    const { controller, context, created } = fixture()
    const opening = controller.ensure()
    context.shuttingDown = true
    created[0].finishLoad()
    await expect(opening).resolves.toBeNull()
    expect(created[0].destroyed).toBe(true)
    expect(context.ipc.revoke).toHaveBeenCalledWith(42)
    await expect(controller.ensure()).resolves.toBeNull()
    expect(context.createWindow).toHaveBeenCalledOnce()
  })

  it('discards failed creation and permits a clean later retry', async () => {
    const { controller, context, created } = fixture()
    const first = controller.ensure()
    created[0].failLoad(new Error('Renderer missing'))
    await expect(first).rejects.toThrow('Renderer missing')
    expect(controller.current).toBeNull()
    expect(created[0].destroyed).toBe(true)
    const second = controller.ensure()
    created[1].finishLoad()
    await expect(second).resolves.toBe(created[1])
    expect(context.createWindow).toHaveBeenCalledTimes(2)
  })
})
