import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ApplicationMenuName, AppMeta, HarnessId, SessionChangeEvent, ThemeMode } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { CuaDriverService } from './cua-driver'
import type { ModelCatalogProvider } from './model-catalog'
import type { PluginService } from './plugins'
import type { PetService } from './pets'
import type { PrimeProviderService } from './providers'
import type { ProjectService } from './projects'
import type { SettingsService } from './settings-schedules'
import type { AutomationService } from './schedules/service'
import type { HeartbeatService } from './schedules/heartbeats'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import type { VoiceService } from './voice'
import type { UpdateService } from './updates'
import type { AgentBrowserService } from './browser/agent-service'
import { requireExistingPath, requireRecord, requireString, requireWebUrl } from './validation'

interface Services {
  meta: AppMeta
  refreshHarnesses(): Promise<{ meta: AppMeta; settings: ReturnType<SettingsService['get']> }>
  popupApplicationMenu(sender: WebContents, menu: ApplicationMenuName, x: number, y: number): boolean
  setTitleBarTheme(sender: WebContents, theme: Exclude<ThemeMode, 'system'>): boolean
  projects: ProjectService
  sessions: SessionService
  agents: AgentRpcManager
  terminals: TerminalService
  git: GitService
  plugins: PluginService
  providers: PrimeProviderService
  settings: SettingsService
  updates: UpdateService
  cuaDriver: CuaDriverService
  heartbeats: HeartbeatService
  schedules: AutomationService
  browser: AgentBrowserService
  voice: VoiceService
  pets: PetService
  /** OMP-harness counterparts; always constructed, even when the omp CLI is absent. */
  omp: HarnessServices
  /** Pi-harness counterparts; always constructed, even when the pi CLI is absent. */
  pi: HarnessServices
  /** Applies the persisted interface scale to every live app renderer. */
  applyInterfaceZoom?(scale: number): void
}

interface HarnessServices {
  projects: ProjectService
  sessions: SessionService
  agents: AgentRpcManager
  catalog: ModelCatalogProvider
  plugins: PluginService
}

/** Strict enum gate for the untrusted optional harness argument; absence means 'prime'. */
function requireHarness(value: unknown): HarnessId {
  if (value === undefined) return 'prime'
  if (value === 'prime' || value === 'omp' || value === 'pi') return value
  throw new TypeError('Invalid harness')
}

function requireApplicationMenu(value: unknown): ApplicationMenuName {
  if (value === 'file' || value === 'edit' || value === 'view' || value === 'window' || value === 'help') return value
  throw new TypeError('Invalid application menu')
}

function requireMenuCoordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) throw new TypeError('Invalid menu coordinate')
  return Math.round(value)
}

function requireResolvedTheme(value: unknown): Exclude<ThemeMode, 'system'> {
  if (value === 'light' || value === 'dark') return value
  throw new TypeError('Invalid resolved theme')
}

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function isTrustedRendererUrl(url: string, expectedRendererUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedRendererUrl)
    // Fragments never cross the document/security boundary; allow in-document anchors only.
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export interface IpcRegistration {
  authorize(webContents: WebContents): void
  revoke(webContentsId: number): void
  dispose(): void
}

let activeIpcRegistration: IpcRegistration | null = null

export function registerIpc(services: Services, expectedRendererUrl: string): IpcRegistration {
  if (activeIpcRegistration) {
    console.warn('registerIpc called while a previous registration was still active; disposing the previous registration')
    activeIpcRegistration.dispose()
  }
  const authorized = new Map<number, WebContents>()
  const invokeChannels: string[] = []
  const eventChannels: string[] = []
  let closed = false

  const verify = (event: IpcEvent): void => {
    const trustedFrame = event.senderFrame === event.sender.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl)
      && isTrustedRendererUrl(event.sender.getURL(), expectedRendererUrl)
    if (closed || !authorized.has(event.sender.id) || event.sender.isDestroyed() || !trustedFrame) throw new Error('IPC sender is not authorized')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => { verify(event); return listener(event, ...args) })
    invokeChannels.push(channel)
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]) => {
      try { verify(event); listener(event, ...args) } catch (error) { console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : error) }
    }
    // Symmetric with handle(): these are private fixed channels, so any prior listener is stale.
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, wrapped)
    eventChannels.push(channel)
  }

  const projectServices: Record<HarnessId, ProjectService> = { prime: services.projects, omp: services.omp.projects, pi: services.pi.projects }
  const sessionServices: Record<HarnessId, SessionService> = { prime: services.sessions, omp: services.omp.sessions, pi: services.pi.sessions }
  const agentManagers: Record<HarnessId, AgentRpcManager> = { prime: services.agents, omp: services.omp.agents, pi: services.pi.agents }
  const pluginServices: Record<HarnessId, PluginService> = { prime: services.plugins, omp: services.omp.plugins, pi: services.pi.plugins }
  const projectsFor = (harness: HarnessId): ProjectService => projectServices[harness]
  const sessionsFor = (harness: HarnessId): SessionService => sessionServices[harness]
  const agentsFor = (harness: HarnessId): AgentRpcManager => agentManagers[harness]
  const pluginsFor = (harness: HarnessId): PluginService => pluginServices[harness]
  // Runtime ids route by ownership; ids no manager owns fall through to the
  // Prime manager so requireRuntime keeps its exact not-found semantics.
  const agentsForRuntime = (runtimeId: unknown): AgentRpcManager => {
    if (typeof runtimeId === 'string') {
      for (const manager of [services.omp.agents, services.pi.agents]) if (manager.has(runtimeId)) return manager
    }
    return services.agents
  }
  /**
   * Routes a session file to the harness whose validated session root contains
   * it, using each service's own canonicalizing path authorization (never
   * substring checks). Paths no root accepts rethrow the Prime error, so
   * rejection shape and text are unchanged.
   */
  const sessionsForPath = async (filePath: unknown): Promise<{ harness: HarnessId; service: SessionService }> => {
    try {
      await services.sessions.requireSessionPath(filePath)
      return { harness: 'prime', service: services.sessions }
    } catch (primeError) {
      for (const harness of ['omp', 'pi'] as const) {
        try { await sessionServices[harness].requireSessionPath(filePath) } catch { continue }
        return { harness, service: sessionServices[harness] }
      }
      throw primeError
    }
  }
  /** OMP and pi credentials stay CLI-owned; desktop-only visibility is routed separately below. */
  const cliOwnedProviderAuth: Partial<Record<HarnessId, string>> = {
    omp: 'OMP provider authentication is managed by the omp CLI',
    pi: 'Pi provider authentication is managed by the pi CLI',
  }
  const requirePrimeProviderAuth = (harness: unknown): void => {
    const rejection = cliOwnedProviderAuth[requireHarness(harness)]
    if (rejection) throw new Error(rejection)
  }

  handle('app:get-meta', () => services.meta)
  handle('app:refresh-harnesses', () => services.refreshHarnesses())
  handle('app:popup-menu', (event, menu, x, y) => services.popupApplicationMenu(event.sender, requireApplicationMenu(menu), requireMenuCoordinate(x), requireMenuCoordinate(y)))
  handle('app:set-title-bar-theme', (event, theme) => services.setTitleBarTheme(event.sender, requireResolvedTheme(theme)))
  handle('app:open-external', async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch (error) {
      console.warn('Rejected app:open-external:', error instanceof Error ? error.message : error)
      return false
    }
  })
  handle('app:reveal-path', async (_event, path) => {
    let requested: string
    try { requested = await requireExistingPath(path) } catch (error) {
      console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
      return false
    }
    const authorizations: Array<() => Promise<string> | string> = [
      () => services.projects.authorizePath(requested),
      () => services.sessions.requireSessionPath(requested),
      () => services.plugins.authorizeReveal(requested),
      () => services.omp.projects.authorizePath(requested),
      () => services.omp.sessions.requireSessionPath(requested),
      () => services.omp.plugins.authorizeReveal(requested),
      () => services.pi.projects.authorizePath(requested),
      () => services.pi.sessions.requireSessionPath(requested),
      () => services.pi.plugins.authorizeReveal(requested),
    ]
    for (const authorize of authorizations) {
      let authorized: string
      try { authorized = await authorize() } catch { continue /* denial here defers to the next authorization domain */ }
      try {
        shell.showItemInFolder(authorized)
        return true
      } catch (error) {
        console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
        return false
      }
    }
    console.warn('Rejected app:reveal-path: no authorization domain covers the path')
    return false
  })
  handle('updates:get-state', () => services.updates.getState())
  handle('updates:check', () => services.updates.check())
  handle('updates:download-and-install', () => services.updates.downloadAndInstall())

  handle('projects:list', (_event, harness) => projectsFor(requireHarness(harness)).list())
  handle('projects:list-files', (_event, root, harness) => projectsFor(requireHarness(harness)).listFiles(root))
  handle('projects:list-worktrees', (_event, cwd, harness) => projectsFor(requireHarness(harness)).listWorktrees(cwd))
  handle('projects:open-worktree', (_event, cwd, path, harness) => projectsFor(requireHarness(harness)).openWorktree(cwd, path))
  handle('projects:create-worktree', (_event, cwd, branch, harness) => projectsFor(requireHarness(harness)).createWorktree(cwd, branch))
  handle('projects:add', (_event, harness) => projectsFor(requireHarness(harness)).add())
  handle('projects:grant-inferred', (_event, path, harness) => projectsFor(requireHarness(harness)).grantInferred(path))
  handle('projects:remove', (_event, id, harness) => projectsFor(requireHarness(harness)).remove(id))
  handle('projects:touch', (_event, id, harness) => projectsFor(requireHarness(harness)).touch(id))

  handle('sessions:list', (_event, projectPath, includeArchived, harness, force) => sessionsFor(requireHarness(harness)).list(projectPath, includeArchived, force))
  handle('sessions:read', async (_event, filePath) => (await sessionsForPath(filePath)).service.read(filePath))
  handle('sessions:follow-up', async (_event, filePath, message, intent) => {
    const routed = await sessionsForPath(filePath)
    // Daemon-socket follow-up is Prime-only; an OMP or pi session answers
    // exactly like an inactive Prime session instead of a new error shape.
    if (routed.harness !== 'prime') return false
    return routed.service.followUp(filePath, message, intent)
  })
  handle('sessions:rename', async (_event, filePath, title) => (await sessionsForPath(filePath)).service.rename(filePath, title))
  handle('sessions:archive', async (_event, filePath, archived) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.archive(filePath, archived)
    if (archived === true) {
      services.browser.closeForSession(filePath)
      await services.terminals.killForSession(filePath)
    }
    return result
  })

  handle('agent:start', (_event, rawOptions) => {
    const options = requireRecord(rawOptions, 'options')
    const harness = requireHarness(options.harness)
    // The manager start schema rejects unknown keys; the routing field must
    // not reach it.
    const { harness: _harness, ...startOptions } = options
    return agentsFor(harness).start(startOptions)
  })
  handle('agent:command', (_event, runtimeId, command) => agentsForRuntime(runtimeId).command(runtimeId, command))
  handle('agent:stop', (_event, runtimeId) => agentsForRuntime(runtimeId).stop(runtimeId))
  handle('agent:list', () => [...services.agents.list(), ...services.omp.agents.list(), ...services.pi.agents.list()])

  const providerCatalog = (force = false) => services.providers.catalog(force, new Set(services.settings.get().disabledProviders), new Set(services.settings.get().disabledModels))
  const ompProviderCatalog = (force = false) => services.omp.catalog.catalog(force, new Set(services.settings.get().ompDisabledProviders), new Set(services.settings.get().ompDisabledModels))
  const piProviderCatalog = (force = false) => services.pi.catalog.catalog(force, new Set(services.settings.get().piDisabledProviders), new Set(services.settings.get().piDisabledModels))
  const providerCatalogs: Record<HarnessId, (force?: boolean) => ReturnType<ModelCatalogProvider['catalog']>> = {
    prime: providerCatalog, omp: ompProviderCatalog, pi: piProviderCatalog,
  }
  /** Desktop-owned provider/model visibility settings keys per harness. */
  const disabledProvidersKeys = { prime: 'disabledProviders', omp: 'ompDisabledProviders', pi: 'piDisabledProviders' } as const
  const disabledModelsKeys = { prime: 'disabledModels', omp: 'ompDisabledModels', pi: 'piDisabledModels' } as const
  handle('providers:catalog', (_event, force, harness) => providerCatalogs[requireHarness(harness)](force === true))
  handle('providers:save-api-key', async (_event, providerId, apiKey, harness) => {
    requirePrimeProviderAuth(harness)
    await services.providers.saveApiKey(providerId, apiKey)
    return providerCatalog(true)
  })
  handle('providers:logout', async (_event, providerId, harness) => {
    requirePrimeProviderAuth(harness)
    await services.providers.logout(providerId)
    return providerCatalog(true)
  })
  handle('providers:set-enabled', async (_event, providerId, enabled, harness) => {
    const target = requireHarness(harness)
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalogs[target]()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const settings = services.settings.get()
    const disabledProviders = new Set(settings[providerSettingsKey])
    const disabledModels = new Set(settings[modelSettingsKey])
    if (enabled) {
      disabledProviders.delete(id)
      for (const model of catalog.models) if (model.provider === id) disabledModels.delete(model.key)
    } else disabledProviders.add(id)
    await services.settings.update({
      [providerSettingsKey]: [...disabledProviders].sort(),
      [modelSettingsKey]: [...disabledModels].sort(),
    })
    return providerCatalogs[target]()
  })
  handle('providers:set-disabled', async (_event, providerIds, harness) => {
    const target = requireHarness(harness)
    if (!Array.isArray(providerIds) || providerIds.length > 256) throw new TypeError('providerIds must be a bounded array')
    const ids = [...new Set(providerIds.map((value, index) => requireString(value, `providerIds[${index}]`, { min: 1, max: 128, trim: true })))].sort()
    const catalog = await providerCatalogs[target]()
    const known = new Set(catalog.providers.map((provider) => provider.id))
    if (ids.some((id) => !known.has(id))) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const disabledModels = ids.length ? services.settings.get()[modelSettingsKey] : []
    await services.settings.update({ [providerSettingsKey]: ids, [modelSettingsKey]: disabledModels })
    return providerCatalogs[target]()
  })
  handle('providers:set-model-enabled', async (_event, modelKey, enabled, harness) => {
    const target = requireHarness(harness)
    const key = requireString(modelKey, 'modelKey', { min: 3, max: 385, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalogs[target]()
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const settings = services.settings.get()
    const disabledProviders = new Set(settings[providerSettingsKey])
    const disabledModels = new Set(settings[modelSettingsKey])
    const siblingKeys = catalog.models.filter((candidate) => candidate.provider === model.provider).map((candidate) => candidate.key)
    if (enabled) {
      if (!provider.enabled) {
        disabledProviders.delete(model.provider)
        for (const siblingKey of siblingKeys) if (siblingKey !== key) disabledModels.add(siblingKey)
      }
      disabledModels.delete(key)
    } else {
      disabledModels.add(key)
      if (!siblingKeys.some((siblingKey) => !disabledModels.has(siblingKey))) disabledProviders.add(model.provider)
    }
    await services.settings.update({
      [providerSettingsKey]: [...disabledProviders].sort(),
      [modelSettingsKey]: [...disabledModels].sort(),
    })
    return providerCatalogs[target]()
  })
  handle('providers:start-oauth', (_event, providerId, harness) => {
    requirePrimeProviderAuth(harness)
    return services.providers.startOAuth(providerId)
  })
  handle('providers:respond-oauth', (_event, flowId, promptId, value) => services.providers.respondOAuth(flowId, promptId, value))
  handle('providers:cancel-oauth', (_event, flowId) => services.providers.cancelOAuth(flowId))

  handle('voice:credential-status', () => services.voice.credentialStatus())
  handle('voice:save-api-key', (_event, provider, apiKey) => services.voice.saveApiKey(provider, apiKey))
  handle('voice:delete-api-key', (_event, provider) => services.voice.deleteApiKey(provider))
  handle('voice:create-realtime-call', (_event, request) => services.voice.createRealtimeCall(request))
  handle('voice:transcribe', (_event, request) => services.voice.transcribe(request))
  handle('voice:test-self-hosted', (_event, request) => services.voice.testSelfHosted(request))
  handle('voice:execute-tool', (_event, request, harness) => services.voice.executeTool(request, requireHarness(harness)))

  handle('pets:list', () => services.pets.list())
  handle('pets:sprite', (_event, id) => services.pets.sprite(id))

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  handle('terminal:bind-session', (event, terminalId, sessionPath) => services.terminals.bindSession(event.sender, terminalId, sessionPath))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  on('terminal:set-active-context', (event, terminalId, context) => services.terminals.setActiveContext(event.sender, terminalId, context))
  on('terminal:clear-active-context', (event, terminalId) => services.terminals.clearActiveContext(event.sender, terminalId))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath, harness) => pluginsFor(requireHarness(harness)).list(projectPath))
  handle('plugins:install', (_event, source, harness) => pluginsFor(requireHarness(harness)).install(source))
  handle('plugins:install-extension', (_event, input, harness) => pluginsFor(requireHarness(harness)).installExtension(input))
  handle('plugins:set-mcp-support', (_event, enabled, harness) => pluginsFor(requireHarness(harness)).setMcpSupport(enabled))
  handle('plugins:connect-mcp', (_event, input, harness) => pluginsFor(requireHarness(harness)).connectMcp(input))
  handle('plugins:set-mcp-enabled', (_event, input, harness) => pluginsFor(requireHarness(harness)).setMcpEnabled(input))
  handle('plugins:mutate-capability', (_event, input, harness) => pluginsFor(requireHarness(harness)).mutateCapability(input))
  handle('plugins:refresh', (_event, harness) => pluginsFor(requireHarness(harness)).refresh())

  handle('settings:get', () => services.settings.get())
  handle('settings:update', async (_event, patch) => {
    const previous = services.settings.get()
    const patchRecord = requireRecord(patch, 'settings patch')
    if (patchRecord.computerUseEnabled === true && !previous.computerUseEnabled) await services.cuaDriver.requireAvailable()
    const settings = await services.settings.update(patch)
    if (settings.interfaceFontScale !== previous.interfaceFontScale) services.applyInterfaceZoom?.(settings.interfaceFontScale)
    if (settings.askUserEnabled !== previous.askUserEnabled || settings.browserEnabled !== previous.browserEnabled || settings.computerUseEnabled !== previous.computerUseEnabled) {
      await Promise.all([
        services.agents.requestRuntimeEnvironmentRefresh(),
        services.omp.agents.requestRuntimeEnvironmentRefresh(),
        services.pi.agents.requestRuntimeEnvironmentRefresh(),
      ])
    }
    return settings
  })
  handle('settings:reset-browser-data', () => services.settings.resetBrowserData())

  handle('browser:state', () => services.browser.state())
  handle('browser:attach-tab', (_event, tabId, webContentsId) => services.browser.attachTab(tabId, webContentsId))
  handle('browser:select-tab', (_event, tabId) => services.browser.selectTab(tabId))
  handle('browser:close-tab', (_event, tabId) => services.browser.closeTab(tabId))
  handle('browser:set-preview-context', (_event, webContentsId, sessionFile) => services.browser.setPreviewContext(webContentsId, sessionFile))
  handle('browser:navigate-tab', (_event, tabId, action, url) => services.browser.navigateTab(tabId, action, url))

  handle('heartbeats:list', () => services.heartbeats.list())
  handle('heartbeats:manage', (_event, id, action) => services.heartbeats.manage(id, action))

  handle('schedules:list', (_event, harness) => services.schedules.list(requireHarness(harness)))
  handle('schedules:get', (_event, id) => services.schedules.get(id))
  handle('schedules:preview', (_event, timing, count) => services.schedules.preview(timing, count))
  handle('schedules:create', (_event, input, harness) => services.schedules.create(input, 'user', requireHarness(harness)))
  handle('schedules:update', (_event, id, patch) => services.schedules.update(id, patch))
  handle('schedules:pause', (_event, id) => services.schedules.pause(id))
  handle('schedules:resume', (_event, id) => services.schedules.resume(id))
  handle('schedules:delete', (_event, id) => services.schedules.delete(id))
  handle('schedules:run-now', (_event, id) => services.schedules.runNow(id))

  const forwardSessionChange = (change: SessionChangeEvent): void => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  }
  const unsubscribeSessionChanges = services.sessions.onDidChange(forwardSessionChange)
  const unsubscribeOmpSessionChanges = services.omp.sessions.onDidChange(forwardSessionChange)
  const unsubscribePiSessionChanges = services.pi.sessions.onDidChange(forwardSessionChange)
  const scheduleSubscription = services.schedules.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('schedules:changed', change)
    }
  })
  const unsubscribeScheduleChanges = typeof scheduleSubscription === 'function' ? scheduleSubscription : () => undefined
  const browserSubscription = services.browser.onDidChange((state) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:changed', state)
    }
  })
  const unsubscribeBrowserChanges = typeof browserSubscription === 'function' ? browserSubscription : () => undefined
  const pointerSubscription = services.browser.onPointer((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:pointer', event)
    }
  })
  const unsubscribeBrowserPointer = typeof pointerSubscription === 'function' ? pointerSubscription : () => undefined
  const activitySubscription = services.browser.onActivity((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:activity', event)
    }
  })
  const unsubscribeBrowserActivity = typeof activitySubscription === 'function' ? activitySubscription : () => undefined

  const registration: IpcRegistration = {
    authorize(webContents) { if (!closed) authorized.set(webContents.id, webContents) },
    revoke(webContentsId) { authorized.delete(webContentsId); void services.terminals.killOwner(webContentsId) },
    dispose() {
      if (closed) return
      closed = true
      if (activeIpcRegistration === registration) activeIpcRegistration = null
      authorized.clear()
      unsubscribeSessionChanges()
      unsubscribeOmpSessionChanges()
      unsubscribePiSessionChanges()
      if (typeof unsubscribeScheduleChanges === 'function') unsubscribeScheduleChanges()
      if (typeof unsubscribeBrowserChanges === 'function') unsubscribeBrowserChanges()
      if (typeof unsubscribeBrowserPointer === 'function') unsubscribeBrowserPointer()
      if (typeof unsubscribeBrowserActivity === 'function') unsubscribeBrowserActivity()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      // Event listeners are removed wholesale only for our private fixed channels.
      for (const channel of eventChannels) ipcMain.removeAllListeners(channel)
    },
  }
  activeIpcRegistration = registration
  return registration
}
