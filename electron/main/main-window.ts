import { BrowserWindow, Menu, nativeTheme, type BrowserWindowConstructorOptions, type Input, type WebContents } from 'electron'
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

