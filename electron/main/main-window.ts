import { BrowserWindow, dialog, Menu, nativeTheme, screen, type Rectangle, type BrowserWindowConstructorOptions, type Input, type WebContents } from 'electron'
import { rendererRecovery } from './renderer-recovery'
import { mainWindowBounds } from './window-bounds'
import { bindRendererNavigation } from './renderer-navigation'
import { hardenRenderer } from './renderer-security'
import type { IpcRegistration } from './ipc'
import type { MacBackgroundController } from './background'
import type { ShutdownPrompt } from './app-lifecycle'
import type { ApplicationMenuName, ThemeMode } from '../../src/types/api'

interface InitialRendererWindow {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
}

export async function loadInitialRenderer(window: InitialRendererWindow, rendererUrl: string): Promise<void> {
  try {
    await window.loadURL(rendererUrl)
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

type ResolvedTheme = Exclude<ThemeMode, 'system'>

export function windowCanvasColor(theme: ResolvedTheme): string {
  return theme === 'dark' ? '#171716' : '#ffffff'
}

function windowsTitleBarOverlay(theme: ResolvedTheme): { color: string; symbolColor: string; height: number } {
  return theme === 'dark'
    ? { color: windowCanvasColor(theme), symbolColor: '#f1f1ee', height: 32 }
    : { color: windowCanvasColor(theme), symbolColor: '#20201e', height: 32 }
}

export function resolvedWindowTheme(theme: ThemeMode | undefined): ResolvedTheme {
  if (theme === 'dark') return 'dark'
  if (theme === 'system' && nativeTheme.shouldUseDarkColors) return 'dark'
  return 'light'
}

export function mainWindowChromeOptions(platform: NodeJS.Platform = process.platform, theme: ResolvedTheme = 'light'): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
  }
  if (platform === 'win32') return {
    // The native caption controls share a dedicated menu row. GooeyPi's own
    // 52px toolbar remains a separate application surface below it.
    titleBarStyle: 'hidden',
    titleBarOverlay: windowsTitleBarOverlay(theme),
    autoHideMenuBar: true,
  }
  if (platform === 'linux') return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 52 },
    autoHideMenuBar: true,
  }
  return { titleBarStyle: 'default' }
}

export function isMacWindowCloseShortcut(
  input: Pick<Input, 'type' | 'key' | 'shift' | 'control' | 'alt' | 'meta'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin'
    && input.type === 'keyDown'
    && input.key.toLowerCase() === 'q'
    && input.meta
    && !input.shift
    && !input.control
    && !input.alt
}

export function popupApplicationMenu(sender: WebContents, menuName: ApplicationMenuName, x: number, y: number): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  const applicationMenu = Menu.getApplicationMenu()
  const menuItem = applicationMenu?.items.find((item) => item.label.replaceAll('&', '').toLowerCase() === menuName)
  if (!window || window.isDestroyed() || !menuItem?.submenu) return false
  const zoom = sender.getZoomFactor()
  menuItem.submenu.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  return true
}

export function setTitleBarTheme(sender: WebContents, theme: ResolvedTheme): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return false
  window.setTitleBarOverlay(windowsTitleBarOverlay(theme))
  return true
}


interface MainWindowContext {
  readonly shuttingDown: boolean
  readonly shutdownApproved: boolean
  readonly confirmingShutdown: boolean
  readonly keepHidden: boolean
  readonly rendererUrl: string
  readonly preloadPath: string
  readonly theme: ThemeMode | undefined
  readonly zoomFactor: number
  readonly ipc: Pick<IpcRegistration, 'authorize' | 'revoke'> | null
  readonly background: Pick<MacBackgroundController, 'isBackgrounded' | 'handleWindowClose'> | null
  iconPath(): string
  approveGuest(contents: WebContents): void
  cancelDownloads(ownerId: number): void
  killTerminals(ownerId: number): Promise<void>
  shutdownPrompt(): ShutdownPrompt | null
  requestShutdown(window: BrowserWindow, prompt: ShutdownPrompt): void
  log(message: string): void
  createWindow?(options: BrowserWindowConstructorOptions): BrowserWindow
  workArea?(): Rectangle
}

/** Owns the one app window and its in-flight creation, independently of app bootstrap. */
export class MainWindowController {
  private window: BrowserWindow | null = null
  private creation: Promise<BrowserWindow | null> | null = null

  constructor(private readonly context: MainWindowContext) {}

  get current(): BrowserWindow | null { return this.window }

  private async create(): Promise<BrowserWindow | null> {
    if (this.context.shuttingDown) return null
    const bounds = mainWindowBounds(this.context.workArea?.() ?? screen.getPrimaryDisplay().workArea)
    const createWindow = this.context.createWindow ?? ((options: BrowserWindowConstructorOptions) => new BrowserWindow(options))
    const theme = resolvedWindowTheme(this.context.theme)
    const window = createWindow({
      ...bounds,
      show: false,
      backgroundColor: windowCanvasColor(theme),
      icon: this.context.iconPath(),
      ...mainWindowChromeOptions(process.platform, theme),
      webPreferences: {
        preload: this.context.preloadPath,
        zoomFactor: this.context.zoomFactor,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    })
    this.window = window
    const renderer = window.webContents
    const rendererId = renderer.id
    hardenRenderer(window, () => this.context.rendererUrl, {
      approveGuest: (contents) => this.context.approveGuest(contents),
      cancelDownloads: (ownerId) => this.context.cancelDownloads(ownerId),
    })
    renderer.on('before-input-event', (event, input) => {
      if (!isMacWindowCloseShortcut(input)) return
      event.preventDefault()
      if (!window.isDestroyed()) window.close()
    })
    bindRendererNavigation(renderer, {
      trustedUrl: () => this.context.rendererUrl,
      zoomFactor: () => this.context.zoomFactor,
      authorize: (contents) => this.context.ipc?.authorize(contents),
      revoke: (ownerId) => this.context.ipc?.revoke(ownerId),
      killTerminals: async (ownerId) => { await this.context.killTerminals(ownerId) },
      log: this.context.log,
    })
    let alreadyRecovered = false
    renderer.on('render-process-gone', (_event, details) => {
      this.context.ipc?.revoke(rendererId)
      if (this.context.shuttingDown || window.isDestroyed() || this.window !== window) return
      const recovery = rendererRecovery(details.reason, alreadyRecovered)
      if (recovery.kind === 'ignore') return
      if (recovery.kind === 'reload') alreadyRecovered = true
      void Promise.resolve().then(() => dialog.showMessageBox(window, {
        type: 'warning', message: recovery.message, detail: recovery.detail,
        buttons: [recovery.kind === 'reload' ? 'Reload window' : 'OK'], noLink: true,
      })).then(async () => {
        if (recovery.kind !== 'reload' || this.context.shuttingDown || window.isDestroyed() || this.window !== window) return
        await loadInitialRenderer(window, this.context.rendererUrl)
      }).catch((error: unknown) => this.context.log(`GooeyPi could not recover its app view: ${error instanceof Error ? error.message : String(error)}`))
    })
    let rendererLoaded = false
    let readyToShow = false
    window.once('ready-to-show', () => {
      readyToShow = true
      if (!this.context.keepHidden && !this.context.background?.isBackgrounded() && rendererLoaded && !this.context.shuttingDown && !window.isDestroyed() && this.window === window) window.show()
    })
    window.on('close', (event) => {
      if (this.context.shuttingDown || this.context.shutdownApproved) return
      if (this.context.background?.handleWindowClose(window)) {
        event.preventDefault()
        return
      }
      const prompt = this.context.shutdownPrompt()
      if (!prompt) return
      event.preventDefault()
      if (!this.context.confirmingShutdown) this.context.requestShutdown(window, prompt)
    })
    window.on('closed', () => {
      this.context.ipc?.revoke(rendererId)
      if (this.window === window) this.window = null
    })
    try {
      await loadInitialRenderer(window, this.context.rendererUrl)
    } catch (error) {
      this.context.ipc?.revoke(rendererId)
      if (this.window === window) this.window = null
      throw error
    }
    if (this.context.shuttingDown || window.isDestroyed() || this.window !== window) {
      this.context.ipc?.revoke(rendererId)
      if (!window.isDestroyed()) window.destroy()
      if (this.window === window) this.window = null
      return null
    }
    rendererLoaded = true
    if (!this.context.keepHidden && !this.context.background?.isBackgrounded() && readyToShow) window.show()
    return window
  }

  ensure(): Promise<BrowserWindow | null> {
    if (this.context.shuttingDown) return Promise.resolve(null)
    if (this.window && !this.window.isDestroyed()) return this.creation ?? Promise.resolve(this.window)
    if (this.creation) return this.creation
    const creation = this.create()
    this.creation = creation
    const clearCreation = () => { if (this.creation === creation) this.creation = null }
    void creation.then(clearCreation, clearCreation)
    return creation
  }
}
