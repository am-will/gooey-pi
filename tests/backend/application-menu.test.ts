import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { name: 'GooeyPi' },
  Menu: electron,
}))

import { buildApplicationMenuTemplate, installApplicationMenu } from '../../electron/main/application-menu'

function submenu(item: ReturnType<typeof buildApplicationMenuTemplate>[number] | undefined) {
  return item && Array.isArray(item.submenu) ? item.submenu : []
}

beforeEach(() => {
  electron.buildFromTemplate.mockClear()
  electron.setApplicationMenu.mockClear()
})

describe('application update menu', () => {
  it('puts Check for Updates in the app menu on macOS', () => {
    const checkForUpdates = vi.fn()
    const template = buildApplicationMenuTemplate({ platform: 'darwin', appName: 'GooeyPi', checkForUpdates, closeWindow: vi.fn() })
    const appMenu = template[0]
    const updateItem = submenu(appMenu).find((item) => item.label === 'Check for Updates…')

    expect(appMenu?.label).toBe('GooeyPi')
    expect(updateItem).toBeDefined()
    updateItem?.click?.(undefined as never, undefined as never, undefined as never)
    expect(checkForUpdates).toHaveBeenCalledOnce()
  })

  it('puts Check for Updates in Help on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const checkForUpdates = vi.fn()
      const template = buildApplicationMenuTemplate({ platform, appName: 'GooeyPi', checkForUpdates, closeWindow: vi.fn() })
      const helpMenu = template.at(-1)
      expect(helpMenu?.role).toBe('help')
      const updateItem = submenu(helpMenu).find((item) => item.label === 'Check for Updates…')
      expect(updateItem).toBeDefined()
      updateItem?.click?.(undefined as never, undefined as never, undefined as never)
      expect(checkForUpdates).toHaveBeenCalledOnce()
    }
  })

  it('disables Check for Updates when the build has no update service', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = buildApplicationMenuTemplate({ platform, appName: 'GooeyPi', updatesEnabled: false, checkForUpdates: vi.fn(), closeWindow: vi.fn() })
      const owner = platform === 'darwin' ? template[0] : template.at(-1)
      const updateItem = submenu(owner).find((item) => item.label === 'Check for Updates…')
      expect(updateItem?.enabled).toBe(false)
    }
    const enabled = buildApplicationMenuTemplate({ platform: 'linux', appName: 'GooeyPi', checkForUpdates: vi.fn(), closeWindow: vi.fn() })
    expect(submenu(enabled.at(-1)).find((item) => item.label === 'Check for Updates…')?.enabled).toBe(true)
  })

  it('installs the native application menu', () => {
    const checkForUpdates = vi.fn()
    installApplicationMenu({ platform: 'linux', appName: 'GooeyPi', checkForUpdates, closeWindow: vi.fn() })
    expect(electron.buildFromTemplate).toHaveBeenCalledOnce()
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(electron.buildFromTemplate.mock.results[0]?.value)
  })

  it('routes macOS Command-Q through the main-window close path', () => {
    const closeWindow = vi.fn()
    const template = buildApplicationMenuTemplate({ platform: 'darwin', appName: 'GooeyPi', checkForUpdates: vi.fn(), closeWindow })
    const quitItem = submenu(template[0]).find((item) => item.label === 'Quit GooeyPi')

    expect(quitItem?.role).toBeUndefined()
    expect(quitItem?.accelerator).toBe('CommandOrControl+Q')
    quitItem?.click?.(undefined as never, undefined as never, undefined as never)
    expect(closeWindow).toHaveBeenCalledOnce()
  })
})
