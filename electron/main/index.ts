import { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session, shell, webContents } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BROWSER_PARTITION, type AppMeta, type AppUpdateState, type HarnessId, type PrimeEventEnvelope, type ProviderAuthEvent } from '../../src/types/api'
import { AgentRpcManager, OMP_RPC_ADAPTER, PI_RPC_ADAPTER } from './agent-rpc'
import { installApplicationMenu } from './application-menu'
import { BrowserDownloadGuard } from './browser-downloads'
import { installCrashGuards } from './crash-guard'
import { CuaDriverService } from './cua-driver'
import { GitService } from './git'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { HarnessDiscoveryService, reconcileActiveHarness } from './harness-discovery'
import { beginProcessShutdown, runProcess, stopChildProcesses } from './process-utils'
import { PluginService, beginPluginDiscoveryShutdown } from './plugins'
import { PrimeProviderService } from './providers'
import { OmpModelCatalogService } from './providers-omp'
import { PiModelCatalogService } from './providers-pi'
import { PetService } from './pets'
import { ProjectService } from './projects'
import { SettingsService } from './settings-schedules'
import { ScheduledRunExecutor } from './schedules/executor'
import { HeartbeatService } from './schedules/heartbeats'
import { AutomationService } from './schedules/service'
import { AgentScheduleBridge } from './schedules/agent-bridge'
import { AgentBrowserBridge } from './browser/agent-bridge'
import { AgentBrowserService } from './browser/agent-service'
import { AgentCollaborationBridge } from './collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, loadOrCreateGooeyPiAgentMessageKey } from './collaboration/message-envelope'
import { SessionService } from './sessions'
import { ompSessionServiceOptions } from './sessions/omp'
import { piSessionServiceOptions } from './sessions/pi'
import { JsonStateStore } from './store'
import { TerminalService } from './terminal'
import { VoiceService, voiceSecretStorageStatus } from './voice'
import { isAllowedRendererAudioPermission } from './voice-permissions'
import { getAutoUpdater, manualUpdateNotification, UpdateService } from './updates'

protocol.registerSchemesAsPrivileged([{ scheme: 'prime-work', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let ompAgents: AgentRpcManager | null = null
let piAgents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let downloads: BrowserDownloadGuard | null = null
let providerService: PrimeProviderService | null = null
let updateService: UpdateService | null = null
let store: JsonStateStore | null = null
let automation: AutomationService | null = null
let agentScheduleBridges: AgentScheduleBridge[] = []
let agentBrowser: AgentBrowserService | null = null
let agentBrowserBridge: AgentBrowserBridge | null = null
let agentCollaborationBridge: AgentCollaborationBridge | null = null
let shutdownStarted = false
let trustedRendererUrl = ''
let windowCreation: Promise<BrowserWindow | null> | null = null
const keepTestWindowsHidden = process.env.PRIME_WORK_E2E_HIDE_WINDOWS === '1'

installCrashGuards({
  logPath: () => {
    try { return join(app.getPath('userData'), 'crash.log') } catch { return null }
  },
  cleanup: async () => {
    agents?.beginShutdown()
    ompAgents?.beginShutdown()
    piAgents?.beginShutdown()
    beginProcessShutdown()
    await Promise.allSettled([agents?.stopAll() ?? Promise.resolve(), ompAgents?.stopAll() ?? Promise.resolve(), piAgents?.stopAll() ?? Promise.resolve(), stopChildProcesses()])
  },
})

function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'assets', 'icon.png')
}

// One policy for every surface that serves renderer content: the app protocol
// response headers and the packaged browser-session header rewrite.
const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

const rendererContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

function registerRendererProtocol(): void {
  if (!app.isPackaged) return
  const rendererRoot = resolve(__dirname, '../renderer')
  protocol.handle('prime-work', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || url.username || url.password || url.search || url.hash) return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname)
      if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return new Response('Not found', { status: 404 })
      const candidate = resolve(rendererRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
      if (candidate !== rendererRoot) {
        const rel = relative(rendererRoot, candidate)
        if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 })
      }
      const body = await readFile(candidate)
      return new Response(body, { headers: {
        'Content-Type': rendererContentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': RENDERER_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

function resolveRendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return app.isPackaged ? 'prime-work://app/index.html' : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const parsed = new URL(developmentUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must use an uncredentialed loopback HTTP(S) origin')
  }
  return parsed.href
}

function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

export function hardenRenderer(window: BrowserWindow, trustedUrl: () => string = () => trustedRendererUrl): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) return
    const contents = window.webContents
    Menu.buildFromTemplate([{
      label: 'Copy Image',
      click: () => { if (!window.isDestroyed() && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y) },
    }]).popup({ window })
  })
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    // A guest page must never be able to attach a nested guest of its own.
    preferences.webviewTag = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== BROWSER_PARTITION || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => downloads?.cancelOwner(contents.id))
    // Guests reaching this point passed the will-attach-webview partition and
    // URL gates above, which makes them eligible for agent control.
    agentBrowser?.approveGuest(contents)
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
  // Server redirects and sub-frame navigations bypass will-navigate; hold them
  // to the same trusted-renderer predicate the IPC gate uses.
  window.webContents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
}

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

export function confirmAppClose(window: BrowserWindow): boolean {
  return dialog.showMessageBoxSync(window, {
    type: 'warning',
    buttons: ['Cancel', 'Close GooeyPi'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'GooeyPi',
    message: 'Are you sure?',
    detail: 'Automations will not run if GooeyPi is closed.',
  }) === 1
}

export function mainWindowChromeOptions(platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
  }
  if (platform === 'linux') return {
    // Let the app's existing 52px drag regions become the one visible title
    // bar. Native controls remain managed by Electron/the window manager, and
    // the default application menu remains reachable with Alt without taking
    // a permanent second row.
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 52 },
    autoHideMenuBar: true,
  }
  return { titleBarStyle: 'default' }
}

async function createWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return null
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f5f4',
    icon: appIconPath(),
    ...mainWindowChromeOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      zoomFactor: (store?.getSettings().interfaceFontScale ?? 110) / 100,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })
  mainWindow = window
  const renderer = window.webContents
  const rendererId = renderer.id
  hardenRenderer(window)
  renderer.on('did-finish-load', () => {
    if (!renderer.isDestroyed() && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)) ipc?.authorize(renderer)
  })
  renderer.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedRendererUrl(url, trustedRendererUrl)) ipc?.revoke(rendererId)
  })
  renderer.on('render-process-gone', () => ipc?.revoke(rendererId))
  let rendererLoaded = false
  let readyToShow = false
  window.once('ready-to-show', () => {
    readyToShow = true
    if (!keepTestWindowsHidden && rendererLoaded && !shutdownStarted && !window.isDestroyed() && mainWindow === window) window.show()
  })
  window.on('close', (event) => {
    if (!shutdownStarted && !confirmAppClose(window)) event.preventDefault()
  })
  window.on('closed', () => {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
  })
  try {
    await loadInitialRenderer(window, trustedRendererUrl)
  } catch (error) {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
    throw error
  }
  if (shutdownStarted || window.isDestroyed() || mainWindow !== window) {
    ipc?.revoke(rendererId)
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    return null
  }
  rendererLoaded = true
  if (!keepTestWindowsHidden && readyToShow) window.show()
  return window
}

function ensureWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return Promise.resolve(null)
  if (mainWindow && !mainWindow.isDestroyed()) return windowCreation ?? Promise.resolve(mainWindow)
  if (windowCreation) return windowCreation
  const creation = createWindow()
  windowCreation = creation
  const clearCreation = () => { if (windowCreation === creation) windowCreation = null }
  void creation.then(clearCreation, clearCreation)
  return creation
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 512) || 'Unknown error'
}

/** Filesystem locations of the three shared capability extensions injected into extension-based harnesses. */
export interface CapabilityExtensionPaths {
  schedule: string
  browser: string
  askUser: string
}

/**
 * Runtime environment for the extension-injected harnesses (OMP and pi, which
 * share pi's ancestral extension API): the capability-broker variables from
 * the schedule and browser bridges minus the Prime-only --skill paths, plus
 * the three PRIME_WORK_*_EXTENSION_PATH variables the harness adapters turn
 * into --extension argv. Both harnesses must receive the identical surface.
 */
export function extensionRuntimeEnvironment(
  scheduleBridgeEnvironment: NodeJS.ProcessEnv,
  browserBridgeEnvironment: NodeJS.ProcessEnv,
  extensionPaths: CapabilityExtensionPaths,
  askUserEnabled = true,
  browserEnabled = true,
): NodeJS.ProcessEnv {
  const { PRIME_WORK_SCHEDULE_SKILL_PATH: _scheduleSkill, ...scheduleEnvironment } = scheduleBridgeEnvironment
  const { PRIME_WORK_BROWSER_SKILL_PATH: _browserSkill, ...browserEnvironment } = browserBridgeEnvironment
  return {
    ...scheduleEnvironment,
    ...(browserEnabled ? browserEnvironment : {}),
    PRIME_WORK_SCHEDULE_EXTENSION_PATH: extensionPaths.schedule,
    PRIME_WORK_BROWSER_EXTENSION_PATH: browserEnabled ? extensionPaths.browser : undefined,
    PRIME_WORK_ASK_USER_EXTENSION_PATH: askUserEnabled ? extensionPaths.askUser : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
  }
}

export async function settleShutdown(
  steps: ReadonlyArray<PromiseLike<unknown>>,
  options: { watchdogMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message))
  const watchdogMs = options.watchdogMs ?? 10_000
  const settled = Promise.allSettled(steps).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') log(`GooeyPi shutdown step failed: ${boundedErrorMessage(result.reason)}`)
    }
  })
  let timer: NodeJS.Timeout | undefined
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`GooeyPi shutdown did not finish within ${watchdogMs} ms; quitting anyway`)
      resolve()
    }, watchdogMs)
    timer.unref?.()
  })
  try {
    await Promise.race([settled, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requestWindow(reason: 'activation' | 'second instance'): void {
  void ensureWindow().then((window) => {
    if (!window || shutdownStarted || window.isDestroyed()) return
    if (keepTestWindowsHidden) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }).catch((error: unknown) => {
    if (!shutdownStarted) console.error(`GooeyPi failed to open a window after ${reason}: ${boundedErrorMessage(error)}`)
  })
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  configureGooeyPiAgentMessageSigning(loadOrCreateGooeyPiAgentMessageKey(join(userDataPath, 'agent-message-signing.key')))
  const stateStore = new JsonStateStore(join(userDataPath, 'prime-work-state.json'))
  store = stateStore
  const discovery = new HarnessDiscoveryService(() => stateStore.getSettings().runtimePaths)
  const initialHarnesses = await discovery.refresh()
  await reconcileActiveHarness(stateStore, initialHarnesses)
  if (shutdownStarted) return
  const primeExecutable = () => discovery.executable('prime')
  const ompExecutable = () => discovery.executable('omp')
  const piExecutable = () => discovery.executable('pi')
  const sessions = new SessionService(stateStore, primeExecutable)
  // OMP has no live-CLI overlay (`omp list --json` does not exist), so the OMP
  // catalog is constructed with a null executable and JSONL-only metadata.
  const ompSessions = new SessionService(stateStore, null, undefined, ompSessionServiceOptions())
  // Pi likewise has no live-CLI overlay; its catalog is JSONL-only.
  const piSessions = new SessionService(stateStore, null, undefined, piSessionServiceOptions())
  const projects = new ProjectService(stateStore, () => mainWindow)
  const ompProjects = new ProjectService(stateStore, () => mainWindow, 'omp')
  const piProjects = new ProjectService(stateStore, () => mainWindow, 'pi')
  // Git and terminals are harness-agnostic: a cwd (or bound session) is valid
  // when any harness's own grants authorize it. Prime is consulted first so
  // Prime-only setups keep their exact behavior and error text.
  const authorizeEitherCwd = async (cwd: string): Promise<string> => {
    try { return await projects.authorizeCwd(cwd) } catch (error) {
      for (const fallback of [ompProjects, piProjects]) {
        try { return await fallback.authorizeCwd(cwd) } catch { /* try the next harness; the Prime error is rethrown */ }
      }
      throw error
    }
  }
  const requireEitherSessionPath = async (path: string): Promise<string> => {
    try { return await sessions.requireSessionPath(path) } catch (error) {
      for (const fallback of [ompSessions, piSessions]) {
        try { return await fallback.requireSessionPath(path) } catch { /* try the next harness; the Prime error is rethrown */ }
      }
      throw error
    }
  }
  const git = new GitService(authorizeEitherCwd)
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const providers = new PrimeProviderService({
    agentDir: join(homedir(), '.prime', 'agent'),
    openExternal: async (url) => { await shell.openExternal(url, { activate: true }) },
  })
  providerService = providers
  const disabledProviders = () => new Set(stateStore.getSettings().disabledProviders)
  const disabledModels = () => new Set(stateStore.getSettings().disabledModels)
  const ompDisabledProviders = () => new Set(stateStore.getSettings().ompDisabledProviders)
  const ompDisabledModels = () => new Set(stateStore.getSettings().ompDisabledModels)
  const piDisabledProviders = () => new Set(stateStore.getSettings().piDisabledProviders)
  const piDisabledModels = () => new Set(stateStore.getSettings().piDisabledModels)
  const ompCatalog = new OmpModelCatalogService(ompExecutable)
  const piCatalog = new PiModelCatalogService(piExecutable)
  agents = new AgentRpcManager(
    primeExecutable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    providers,
    disabledProviders,
  )
  agents.setDisabledModelsProvider(disabledModels)
  // The OMP manager exists whether or not the omp CLI is installed; starting a
  // runtime without it fails with the adapter's per-harness not-found error.
  // OMP provider visibility is desktop-owned and independent from both Prime's
  // provider policy and OMP's own CLI configuration.
  const ompManager = new AgentRpcManager(
    ompExecutable,
    (cwd) => ompProjects.authorizeCwd(cwd),
    (path) => ompSessions.requireSessionPath(path),
    ompCatalog,
    ompDisabledProviders,
    OMP_RPC_ADAPTER,
    () => {
      const mode = stateStore.getSettings().ompApprovalMode
      return mode === 'inherit' ? undefined : mode
    },
  )
  ompManager.setDisabledModelsProvider(ompDisabledModels)
  ompAgents = ompManager
  // Pi mirrors the OMP construction, minus the approval-mode getter: pi has no
  // permission system, so the manager keeps its default (undefined) override.
  const piManager = new AgentRpcManager(
    piExecutable,
    (cwd) => piProjects.authorizeCwd(cwd),
    (path) => piSessions.requireSessionPath(path),
    piCatalog,
    piDisabledProviders,
    PI_RPC_ADAPTER,
  )
  piManager.setDisabledModelsProvider(piDisabledModels)
  piAgents = piManager
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    all: () => agents?.list() ?? [],
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  ompSessions.bindRuntimeHooks({
    get: (path) => ompAgents?.getForSession(path),
    all: () => ompAgents?.list() ?? [],
    stop: async (path) => { await ompAgents?.stopForSession(path) },
    rename: async (path, title) => ompAgents?.renameForSession(path, title) ?? false,
  })
  piSessions.bindRuntimeHooks({
    get: (path) => piAgents?.getForSession(path),
    all: () => piAgents?.list() ?? [],
    stop: async (path) => { await piAgents?.stopForSession(path) },
    rename: async (path, title) => piAgents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService(
    authorizeEitherCwd,
    () => stateStore.getSettings().terminalShell,
    requireEitherSessionPath,
  )
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await Promise.all([agents!.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  ompProjects.bindProviders({
    sessions: () => ompSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      ompPlugins.evictProjects(roots)
      await Promise.all([ompManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  piProjects.bindProviders({
    sessions: () => piSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      piPlugins.evictProjects(roots)
      await Promise.all([piManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl, app.getPath('downloads'))
  const settings = new SettingsService(stateStore, (shell) => terminals!.validateShell(shell), () => downloads?.cancelAll(true))
  const cuaDriver = new CuaDriverService()
  await cuaDriver.status()
  const voice = new VoiceService({
    secretPath: join(app.getPath('userData'), 'voice-secrets.json'),
    secretCodec: {
      status: () => voiceSecretStorageStatus(
        process.platform,
        safeStorage.isEncryptionAvailable(),
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
      ),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    settings: () => stateStore.getSettings(),
    projects: { prime: projects, omp: ompProjects, pi: piProjects },
    agents: { prime: agents, omp: ompManager, pi: piManager },
    catalogs: { prime: providers, omp: ompCatalog, pi: piCatalog },
    runProcess,
  })
  const pets = new PetService({
    builtInRoot: app.isPackaged ? join(process.resourcesPath, 'pets') : join(app.getAppPath(), 'assets', 'pets'),
    codexRoot: join(homedir(), '.codex', 'pets'),
  })
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const scheduleSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-schedules')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-schedules')
  const browserSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-browser')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-browser')
  const computerUseSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'gooeypi-computer-use', 'SKILL.md')
    : join(app.getAppPath(), 'assets', 'skills', 'gooeypi-computer-use', 'SKILL.md')
  const ompBrowserExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'omp-work-browser.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'omp-work-browser.ts')
  const ompScheduleExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'omp-work-schedules.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'omp-work-schedules.ts')
  const ompAskUserExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'omp-work-ask-user.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'omp-work-ask-user.ts')
  const collaborationExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'omp-work-collaboration.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'omp-work-collaboration.ts')
  const piFastModeExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'pi-work-fast-mode.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'pi-work-fast-mode.ts')
  const computerUseSkill = async () => {
    const status = await cuaDriver.status()
    return {
      id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA',
      description: 'Drive native apps through a separately installed TryCUA driver. Install the driver before enabling.',
      kind: 'extension' as const, location: 'system' as const, path: computerUseSkillPath,
      enabled: stateStore.getSettings().computerUseEnabled,
      availability: { available: status.available, detail: status.detail, actionUrl: status.available ? undefined : status.installUrl },
    }
  }
  const plugins = new PluginService(primeExecutable, (path) => projects.authorizeProjectRoot(path), {
    removeMcpCredential: (server) => providers.removeMcpCredential(server),
    protectedMcpServers: providers.protectedMcpServers(),
    builtInSkills: async () => [{
      id: 'prime-work-schedules', name: 'Scheduled tasks',
      description: 'Create and manage durable project and thread schedules from an agent.',
      kind: 'skill', location: 'system', path: scheduleSkillPath, enabled: true,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'Ask focused multiple-choice questions in the GooeyPi app across Prime, OMP, and Pi.',
      kind: 'extension', location: 'system', path: ompAskUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, {
      id: 'prime-work-browser', name: 'Browser',
      description: 'Drive the in-app browser for this thread: tabs, navigation, clicks, typing, and screenshots.',
      kind: 'skill', location: 'system', path: browserSkillPath, enabled: stateStore.getSettings().browserEnabled,
    }, await computerUseSkill(), ...providers.mcpCapabilities()],
  })
  const ompPlugins = new PluginService(ompExecutable, (path) => ompProjects.authorizeProjectRoot(path), {
    harness: 'omp',
    builtInSkills: async () => [{
      id: 'omp-work-schedules', name: 'Scheduled tasks',
      description: 'OMP extension for durable project and thread schedules managed by GooeyPi.',
      kind: 'extension', location: 'system', path: ompScheduleExtensionPath, enabled: true,
    }, {
      id: 'omp-work-browser', name: 'Browser',
      description: 'OMP extension for driving this thread\'s in-app browser.',
      kind: 'extension', location: 'system', path: ompBrowserExtensionPath, enabled: stateStore.getSettings().browserEnabled,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'OMP extension for asking focused multiple-choice questions in the GooeyPi app.',
      kind: 'extension', location: 'system', path: ompAskUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, await computerUseSkill()],
  })
  // Pi's extension API is the ancestor of OMP's, so pi runtimes inject the
  // same omp-work-* extension files (accepted naming drift; never forked).
  const piPlugins = new PluginService(piExecutable, (path) => piProjects.authorizeProjectRoot(path), {
    harness: 'pi',
    builtInSkills: async () => [{
      id: 'omp-work-schedules', name: 'Scheduled tasks',
      description: 'Pi extension for durable project and thread schedules managed by GooeyPi.',
      kind: 'extension', location: 'system', path: ompScheduleExtensionPath, enabled: true,
    }, {
      id: 'omp-work-browser', name: 'Browser',
      description: 'Pi extension for driving this thread\'s in-app browser.',
      kind: 'extension', location: 'system', path: ompBrowserExtensionPath, enabled: stateStore.getSettings().browserEnabled,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'Pi extension for asking focused multiple-choice questions in the GooeyPi app.',
      kind: 'extension', location: 'system', path: ompAskUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, await computerUseSkill()],
  })
  const heartbeats = new HeartbeatService(agents, primeExecutable)
  const primeScheduledRuns = new ScheduledRunExecutor(
    projects,
    sessions,
    agents,
    providers,
    () => new Set(stateStore.getSettings().disabledProviders),
    () => new Set(stateStore.getSettings().disabledModels),
  )
  const ompScheduledRuns = new ScheduledRunExecutor(
    ompProjects,
    ompSessions,
    ompManager,
    ompCatalog,
    () => new Set(stateStore.getSettings().ompDisabledProviders),
    () => new Set(stateStore.getSettings().ompDisabledModels),
  )
  const piScheduledRuns = new ScheduledRunExecutor(
    piProjects,
    piSessions,
    piManager,
    piCatalog,
    () => new Set(stateStore.getSettings().piDisabledProviders),
    () => new Set(stateStore.getSettings().piDisabledModels),
  )
  const scheduledRuns: Record<HarnessId, ScheduledRunExecutor> = { prime: primeScheduledRuns, omp: ompScheduledRuns, pi: piScheduledRuns }
  const schedules = new AutomationService(stateStore, {
    validateTarget: (target, harness) => scheduledRuns[harness].validateTarget(target),
    validateExecution: (execution, harness) => scheduledRuns[harness].validateExecution(execution),
    run: (task) => scheduledRuns[task.harness].run(task),
  })
  automation = schedules
  await schedules.start()
  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'prime',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await projects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Prime Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const ompScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'omp',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await ompProjects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted OMP Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await ompSessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const piScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'pi',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await piProjects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Pi Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await piSessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  await Promise.all([scheduleBridge.start(), ompScheduleBridge.start(), piScheduleBridge.start()])
  agentScheduleBridges = [scheduleBridge, ompScheduleBridge, piScheduleBridge]
  const browserService = new AgentBrowserService({
    getGuest: (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      return contents && !contents.isDestroyed() ? contents : undefined
    },
  })
  agentBrowser = browserService
  const browserExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'prime-work-browser.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'prime-work-browser.ts')
  const browserBridge = new AgentBrowserBridge({ service: browserService, terminals, extensionPath: browserExtensionPath, skillPath: browserSkillPath })
  const collaborationBridge = new AgentCollaborationBridge({
    extensionPath: collaborationExtensionPath,
    sessions: { prime: sessions, omp: ompSessions, pi: piSessions },
    agents: { prime: agents, omp: ompManager, pi: piManager },
    catalogs: { prime: providers, omp: ompCatalog, pi: piCatalog },
    disabledProviders: { prime: disabledProviders, omp: ompDisabledProviders, pi: piDisabledProviders },
    disabledModels: { prime: disabledModels, omp: ompDisabledModels, pi: piDisabledModels },
  })
  await Promise.all([browserBridge.start(), collaborationBridge.start()])
  agentBrowserBridge = browserBridge
  agentCollaborationBridge = collaborationBridge
  agents.setRuntimeEnvironmentProvider((scope) => ({
    ...scheduleBridge.environmentFor(scope),
    ...(stateStore.getSettings().browserEnabled ? browserBridge.environmentFor(scope) : {}),
    ...collaborationBridge.environmentFor({ ...scope, harness: 'prime' }),
    PRIME_WORK_ASK_USER_EXTENSION_PATH: stateStore.getSettings().askUserEnabled && scope.interactive ? ompAskUserExtensionPath : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
    GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
  }))
  agents.setRuntimeStartListener((environment, info) => {
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
  })
  // OMP runtimes get the same capability-scoped brokers through OMP-flavored
  // extensions. OMP has no --skill flag, so their tool descriptions carry the
  // app-specific usage guidance while OMP's own skills stay discovery-based.
  const capabilityExtensionPaths: CapabilityExtensionPaths = {
    schedule: ompScheduleExtensionPath,
    browser: ompBrowserExtensionPath,
    askUser: ompAskUserExtensionPath,
  }
  ompManager.setRuntimeEnvironmentProvider((scope) => ({
    ...extensionRuntimeEnvironment(ompScheduleBridge.environmentFor(scope), browserBridge.environmentFor(scope), capabilityExtensionPaths, stateStore.getSettings().askUserEnabled && scope.interactive, stateStore.getSettings().browserEnabled),
    ...collaborationBridge.environmentFor({ ...scope, harness: 'omp' }),
    GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
  }))
  ompManager.setRuntimeStartListener((environment, info) => {
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
  })
  // Pi runtimes receive the identical capability surface: pi's extension API
  // is the ancestor of OMP's, so the omp-work-* files are shared by design.
  piManager.setRuntimeEnvironmentProvider((scope) => ({
    ...extensionRuntimeEnvironment(piScheduleBridge.environmentFor(scope), browserBridge.environmentFor(scope), capabilityExtensionPaths, stateStore.getSettings().askUserEnabled && scope.interactive, stateStore.getSettings().browserEnabled),
    ...collaborationBridge.environmentFor({ ...scope, harness: 'pi' }),
    GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: piFastModeExtensionPath,
    GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
  }))
  piManager.setRuntimeStartListener((environment, info) => {
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
  })
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    harnesses: initialHarnesses,
  }
  const updates = new UpdateService(getAutoUpdater(), { enabled: app.isPackaged })
  updateService = updates
  const refreshHarnesses = async () => {
    const harnesses = await discovery.refresh()
    const currentSettings = await reconcileActiveHarness(stateStore, harnesses)
    meta.harnesses = harnesses
    return { meta: structuredClone(meta), settings: currentSettings }
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({
    meta, refreshHarnesses, projects, sessions, agents, terminals, git, plugins, providers, settings, updates, cuaDriver, heartbeats, schedules, browser: browserService, voice, pets,
    omp: { projects: ompProjects, sessions: ompSessions, agents: ompManager, catalog: ompCatalog, plugins: ompPlugins },
    pi: { projects: piProjects, sessions: piSessions, agents: piManager, catalog: piCatalog, plugins: piPlugins },
  }, trustedRendererUrl)
  // Both managers share the one renderer forwarding path: envelopes carry the
  // runtimeId and RuntimeInfo carries the harness, so the renderer can route.
  const forwardAgentEvent = (envelope: PrimeEventEnvelope): void => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('agent:event', envelope)
    }
  }
  agents.setEventSink(forwardAgentEvent)
  ompManager.setEventSink(forwardAgentEvent)
  piManager.setEventSink(forwardAgentEvent)
  providers.setEventSink((event: ProviderAuthEvent) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('providers:auth-event', event)
    }
  })
  updates.setEventSink((state: AppUpdateState) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('updates:changed', state)
    }
  })
  installApplicationMenu({
    appName: 'GooeyPi',
    checkForUpdates: () => {
      void updates.check().then(async (state) => {
        const notification = manualUpdateNotification(state)
        await dialog.showMessageBox({
          type: notification.type,
          title: 'GooeyPi',
          message: notification.message,
          detail: notification.detail,
        })
      })
    },
  })
  await ensureWindow()
  updates.start()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
  registerRendererProtocol()
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath())
  const browserSession = session.defaultSession
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(permission === 'media' && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, mediaTypes))
  })
  browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => Boolean(contents && permission === 'media' && details.isMainFrame
    && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, details.mediaType ? [details.mediaType] : undefined)))
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserProfile.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  await bootstrap()
  app.on('second-instance', () => {
    if (!shutdownStarted) requestWindow('second instance')
  })
  app.on('activate', () => {
    if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) requestWindow('activation')
  })
}).catch((error: unknown) => {
  if (!shutdownStarted) console.error(`GooeyPi failed to start: ${boundedErrorMessage(error)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  updateService?.dispose()
  agents?.beginShutdown()
  ompAgents?.beginShutdown()
  piAgents?.beginShutdown()
  beginProcessShutdown()
  beginPluginDiscoveryShutdown()
  downloads?.cancelAll()
  providerService?.cancelAll()
  agentBrowser?.beginShutdown()
  void settleShutdown([
    ...agentScheduleBridges.map((bridge) => bridge.stop()),
    agentBrowserBridge?.stop() ?? Promise.resolve(),
    agentCollaborationBridge?.stop() ?? Promise.resolve(),
    automation?.stop() ?? Promise.resolve(),
    terminals?.killAll() ?? Promise.resolve(),
    agents?.stopAll() ?? Promise.resolve(),
    ompAgents?.stopAll() ?? Promise.resolve(),
    piAgents?.stopAll() ?? Promise.resolve(),
    stopChildProcesses(),
  ]).then(async () => {
    // Await the drain so the final persist lands before the process exits.
    try { await store?.beginShutdown() } catch (error) { console.error(`GooeyPi store shutdown failed: ${boundedErrorMessage(error)}`) }
  }).finally(() => app.quit())
})
