import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow, NativeImage } from 'electron'
import type { AppSettings } from '../../src/types/api'

export const BACKGROUND_START_ARG = '--background'

type BackgroundSettings = Pick<AppSettings, 'keepRunningInBackground' | 'launchAtLogin'>

export function shouldStartInBackground(
  argv: readonly string[],
  wasOpenedAtLogin: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && (wasOpenedAtLogin || argv.includes(BACKGROUND_START_ARG))
}

export interface MacBackgroundControllerOptions {
  iconPath: string
  getSettings(): BackgroundSettings
  onOpen(): void
  onSettings(): void
  onQuit(): void
  startInBackground?: boolean
  platform?: NodeJS.Platform
  packaged?: boolean
}

/** Owns the macOS menu-bar lifetime without changing other platforms. */
export class MacBackgroundController {
  private tray: Tray | null = null
  private backgrounded = false
  private readonly platform: NodeJS.Platform
  private readonly packaged: boolean

  constructor(private readonly options: MacBackgroundControllerOptions) {
    this.platform = options.platform ?? process.platform
    this.packaged = options.packaged ?? app.isPackaged
  }

  start(): void {
    if (!this.isMac()) return
    const settings = this.options.getSettings()
    this.syncLoginItem(settings.launchAtLogin)
    if (this.options.startInBackground) {
      this.backgrounded = true
      this.ensureTray()
      this.enterBackgroundPresentation()
    } else if (settings.keepRunningInBackground) {
      this.ensureTray()
    }
  }

  isBackgrounded(): boolean {
    return this.backgrounded
  }

  handleWindowClose(window: BrowserWindow): boolean {
    if (!this.isMac() || !this.options.getSettings().keepRunningInBackground) return false
    this.backgrounded = true
    this.ensureTray()
    window.hide()
    this.enterBackgroundPresentation()
    return true
  }

  handleAllWindowsClosed(): boolean {
    if (!this.isMac() || (!this.backgrounded && !this.options.getSettings().keepRunningInBackground)) return false
    this.backgrounded = true
    this.ensureTray()
    this.enterBackgroundPresentation()
    return true
  }

  open(): void {
    this.reveal(this.options.onOpen)
  }

  private openSettings(): void {
    this.reveal(this.options.onSettings)
  }

  private reveal(action: () => void): void {
    if (!this.isMac()) {
      action()
      return
    }
    this.backgrounded = false
    app.setActivationPolicy('regular')
    app.show()
    action()
    if (!this.options.getSettings().keepRunningInBackground) this.destroyTray()
  }

  applySettings(previous: AppSettings, next: AppSettings): void {
    if (!this.isMac()) return
    if (previous.launchAtLogin !== next.launchAtLogin) this.syncLoginItem(next.launchAtLogin)
    if (previous.keepRunningInBackground === next.keepRunningInBackground) return
    if (next.keepRunningInBackground) {
      this.ensureTray()
    } else if (this.backgrounded) {
      this.open()
    } else {
      this.destroyTray()
    }
  }

  dispose(): void {
    this.destroyTray()
  }

  private isMac(): boolean {
    return this.platform === 'darwin'
  }

  private ensureTray(): void {
    if (this.tray) return
    const icon = nativeImage.createFromPath(this.options.iconPath).resize({ width: 18, height: 18 })
    icon.setTemplateImage(true)
    const tray = new Tray(icon)
    tray.setToolTip('GooeyPi')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open GooeyPi', icon: menuIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'), accelerator: 'CommandOrControl+N', click: () => this.open() },
      { type: 'separator' },
      { label: 'Settings...', icon: menuIcon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'), accelerator: 'CommandOrControl+,', click: () => this.openSettings() },
      { label: 'Quit', icon: menuIcon('<path d="m18 6-12 12M6 6l12 12"/>'), accelerator: 'CommandOrControl+Q', click: () => this.options.onQuit() },
    ]))
    this.tray = tray
  }

  private enterBackgroundPresentation(): void {
    app.setActivationPolicy('accessory')
  }

  private syncLoginItem(openAtLogin: boolean): void {
    if (!this.packaged) return
    try {
      if (app.getLoginItemSettings().openAtLogin === openAtLogin) return
      app.setLoginItemSettings({ openAtLogin })
    } catch (error) {
      console.error(`GooeyPi could not update its login item: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private destroyTray(): void {
    this.tray?.destroy()
    this.tray = null
  }
}

function menuIcon(body: string): NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  icon.setTemplateImage(true)
  return icon
}
