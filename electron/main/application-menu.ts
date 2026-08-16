import { app, Menu, type MenuItemConstructorOptions } from 'electron'

interface ApplicationMenuOptions {
  checkForUpdates(): void
  closeWindow(): void
  /** Manual checks are only possible in builds where the update service runs. */
  updatesEnabled?: boolean
  platform?: NodeJS.Platform
  appName?: string
}

function updateMenuItem(checkForUpdates: () => void, enabled: boolean): MenuItemConstructorOptions {
  return {
    label: 'Check for Updates…',
    enabled,
    click: () => checkForUpdates(),
  }
}

export function buildApplicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform
  const appName = options.appName ?? app.name
  const updatesEnabled = options.updatesEnabled ?? true
  const standardMenus: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]

  if (platform === 'darwin') {
    return [{
      label: appName,
      submenu: [
        { role: 'about' },
        updateMenuItem(options.checkForUpdates, updatesEnabled),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'CommandOrControl+Q', click: () => options.closeWindow() },
      ],
    }, ...standardMenus]
  }

  return [...standardMenus, {
    role: 'help',
    submenu: [updateMenuItem(options.checkForUpdates, updatesEnabled)],
  }]
}

export function installApplicationMenu(options: ApplicationMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(options)))
}
