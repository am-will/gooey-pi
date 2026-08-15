import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
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
    if (!this.isMac()) {
      this.options.onOpen()
      return
    }
    this.backgrounded = false
    app.setActivationPolicy('regular')
    app.show()
    this.options.onOpen()
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
      { label: 'Open GooeyPi', click: () => this.open() },
      { label: 'Quit GooeyPi', click: () => this.options.onQuit() },
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
