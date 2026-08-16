import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const trays: MockTray[] = []
  const templates: Array<Array<{ label?: string, type?: string, accelerator?: string, icon?: unknown, click?: () => void }>> = []
  const trayImage = { resize: vi.fn(), setTemplateImage: vi.fn() }
  const menuImages: Array<{ setTemplateImage: ReturnType<typeof vi.fn> }> = []

  class MockTray {
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    destroy = vi.fn()

    constructor(readonly icon: unknown) {
      trays.push(this)
    }
  }

  return {
    app: {
      isPackaged: false,
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setActivationPolicy: vi.fn(),
      setLoginItemSettings: vi.fn(),
      show: vi.fn(),
    },
    trayImage,
    menuImages,
    nativeImage: {
      createFromPath: vi.fn(() => trayImage),
      createFromDataURL: vi.fn(() => {
        const image = { setTemplateImage: vi.fn() }
        menuImages.push(image)
        return image
      }),
    },
    Menu: { buildFromTemplate: vi.fn((template: Array<{ label?: string, type?: string, accelerator?: string, icon?: unknown, click?: () => void }>) => {
      templates.push(template)
      return { template }
    }) },
    MockTray,
    templates,
    trays,
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  Tray: electron.MockTray,
}))

import type { BrowserWindow } from 'electron'
import { MacBackgroundController, shouldStartInBackground } from '../../electron/main/background'
import { defaultSettings } from '../../electron/main/store'

function makeController(overrides: Partial<ConstructorParameters<typeof MacBackgroundController>[0]> = {}) {
  let settings = defaultSettings()
  const onOpen = vi.fn()
  const onSettings = vi.fn()
  const onQuit = vi.fn()
  const controller = new MacBackgroundController({
    iconPath: '/app/icon.png',
    getSettings: () => settings,
    onOpen,
    onSettings,
    onQuit,
    platform: 'darwin',
    packaged: false,
    ...overrides,
  })
  return {
    controller,
    onOpen,
    onSettings,
    onQuit,
    setSettings: (next: Partial<typeof settings>) => { settings = { ...settings, ...next } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.templates.length = 0
  electron.trays.length = 0
  electron.menuImages.length = 0
  electron.trayImage.resize.mockReturnValue(electron.trayImage)
})

describe('macOS background startup', () => {
  it('recognizes login launches and the explicit flag only on macOS', () => {
    expect(shouldStartInBackground(['/Applications/GooeyPi', '--background'], false, 'darwin')).toBe(true)
    expect(shouldStartInBackground(['/Applications/GooeyPi'], true, 'darwin')).toBe(true)
    expect(shouldStartInBackground(['/Applications/GooeyPi'], false, 'darwin')).toBe(false)
    expect(shouldStartInBackground(['GooeyPi.exe', '--background'], true, 'win32')).toBe(false)
  })

  it('starts normally without a tray or login-item mutation by default in development', () => {
    const { controller } = makeController()
    controller.start()
    expect(electron.trays).toHaveLength(0)
    expect(electron.app.setActivationPolicy).not.toHaveBeenCalled()
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('starts a login launch in the menu bar and restores the regular app on Open', () => {
    const { controller, onOpen } = makeController({ startInBackground: true })
    controller.start()
    expect(controller.isBackgrounded()).toBe(true)
    expect(electron.app.setActivationPolicy).toHaveBeenCalledWith('accessory')
    expect(electron.trays).toHaveLength(1)

    electron.templates[0][0].click?.()
    expect(controller.isBackgrounded()).toBe(false)
    expect(electron.app.setActivationPolicy).toHaveBeenLastCalledWith('regular')
    expect(electron.app.show).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(electron.trays[0].destroy).toHaveBeenCalledOnce()
  })
})

describe('MacBackgroundController', () => {
  it('keeps the process in the menu bar on close and exposes Open, Settings, and Quit', () => {
    const { controller, onOpen, onSettings, onQuit } = makeController({
      getSettings: () => ({ keepRunningInBackground: true, launchAtLogin: false }),
    })
    const window = { hide: vi.fn() } as unknown as BrowserWindow

    controller.start()
    expect(electron.trays).toHaveLength(1)
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledWith('/app/icon.png')
    expect(electron.trayImage.resize).toHaveBeenCalledWith({ width: 18, height: 18 })
    expect(electron.trayImage.setTemplateImage).toHaveBeenCalledWith(true)
    expect(electron.templates[0].map((item) => item.label ?? item.type)).toEqual(['Open GooeyPi', 'separator', 'Settings...', 'Quit'])
    expect(electron.templates[0].every((item) => item.accelerator === undefined)).toBe(true)
    expect(electron.templates[0].filter((item) => item.label).every((item) => item.icon)).toBe(true)
    expect(electron.nativeImage.createFromDataURL).toHaveBeenCalledTimes(3)
    expect(electron.menuImages.every((image) => image.setTemplateImage.mock.calls.some(([value]) => value === true))).toBe(true)

    expect(controller.handleWindowClose(window)).toBe(true)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(electron.app.setActivationPolicy).toHaveBeenCalledWith('accessory')

    electron.templates[0][0].click?.()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(electron.trays[0].destroy).not.toHaveBeenCalled()
    electron.templates[0][2].click?.()
    expect(onSettings).toHaveBeenCalledOnce()
    electron.templates[0][3].click?.()
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('does not intercept close or all-windows-closed when the setting is off', () => {
    const { controller } = makeController()
    const window = { hide: vi.fn() } as unknown as BrowserWindow
    expect(controller.handleWindowClose(window)).toBe(false)
    expect(controller.handleAllWindowsClosed()).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('registers packaged login items and ignores development and other platforms', () => {
    const packaged = makeController({ packaged: true })
    packaged.controller.start()
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled()

    const previous = defaultSettings()
    packaged.controller.applySettings(previous, { ...previous, launchAtLogin: true })
    expect(electron.app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true })

    electron.app.setLoginItemSettings.mockClear()
    makeController({ packaged: false }).controller.start()
    makeController({ packaged: true, platform: 'win32' }).controller.start()
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('removes a packaged login item when launch at login is disabled', () => {
    electron.app.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: true })
    const packaged = makeController({ packaged: true })
    const enabled = { ...defaultSettings(), launchAtLogin: true }

    packaged.controller.applySettings(enabled, { ...enabled, launchAtLogin: false })

    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })

  it('adds and removes the menu-bar item as the keep-running setting changes', () => {
    const { controller, setSettings } = makeController()
    const previous = defaultSettings()
    const enabled = { ...previous, keepRunningInBackground: true }

    setSettings(enabled)
    controller.applySettings(previous, enabled)
    expect(electron.trays).toHaveLength(1)

    setSettings(previous)
    controller.applySettings(enabled, previous)
    expect(electron.trays[0].destroy).toHaveBeenCalledOnce()
  })
})
