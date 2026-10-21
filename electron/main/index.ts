import { app, BrowserWindow, dialog, protocol, safeStorage, session, shell, webContents } from 'electron'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { activeShutdownWork, confirmAppClose, routeAllWindowsClosed, settleShutdown, shutdownPrompt, startupFailureDialog, type ShutdownPrompt } from './app-lifecycle'
import { boundedErrorMessage, firstAccepted } from './validation'
import { isAllowedBrowserUrl } from '../../src/lib/browser-url'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import { primeCapabilityRecordAvailability } from '../../src/lib/prime-compat'
import { BROWSER_PARTITION, type AppMeta, type AppUpdateState, type HarnessId, type PrimeEventEnvelope, type ProviderAuthEvent } from '../../src/types/api'
import { AgentRpcManager, OMP_RPC_ADAPTER, PI_RPC_ADAPTER, primeRpcAdapter, primeStartRecovery } from './agent-rpc'
import { installApplicationMenu } from './application-menu'
import { MainWindowController, popupApplicationMenu, setTitleBarTheme } from './main-window'
import { MacBackgroundController, shouldStartInBackground } from './background'
import { BrowserDownloadGuard } from './browser-downloads'
import { registerRendererProtocol, resolveRendererUrl, RENDERER_CONTENT_SECURITY_POLICY } from './renderer-security'
import { installCrashGuards, writeCrashLog } from './crash-guard'
import { CuaDriverService } from './cua-driver'
import { GitService } from './git'
import { CheckoutService } from './checkouts'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { HarnessDiscoveryService, reconcileActiveHarness } from './harness-discovery'
import { beginProcessShutdown, runProcess, stopChildProcesses } from './process-utils'
import { PluginService, beginPluginDiscoveryShutdown } from './plugins'
import { PrimeProviderService } from './providers'
import { bindRuntimeCapabilities, extensionHarnessRuntimeEnvironment } from './capability-runtime'
import { primeRuntimeEnvironment } from './prime-runtime-environment'
import { OmpModelCatalogService } from './providers-omp'
import { PiModelCatalogService } from './providers-pi'
import { PACKAGED_SMOKE_READY_EVENT, packagedSmokeMarker, packagedSmokeMarkerPath, serializePackagedSmokeMarker } from './packaged-smoke'
import { PetService } from './pets'
import { ProjectService } from './projects'
import { SettingsService } from './settings'
import { ScheduledRunExecutor } from './schedules/executor'
import { HeartbeatService } from './schedules/heartbeats'
import { AutomationService } from './schedules/service'
import { AgentScheduleBridge, createScheduleScopeResolver } from './schedules/agent-bridge'
import { mirrorBundledSkill } from './lib/bundled-skill-mirror'
import { AgentBrowserBridge } from './browser/agent-bridge'
import { AgentBrowserService } from './browser/agent-service'
import { closeProjectBrowserSessions } from './browser/project-cleanup'
import { AgentCollaborationBridge } from './collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, loadOrCreateGooeyPiAgentMessageKey } from './collaboration/message-envelope'
import { bundledResourcePath, extensionInjection, resolveExtensionPath, type ExtensionCapability } from './extension-manifest'
import { SessionService } from './sessions'
import { ompSessionServiceOptions } from './sessions/omp'
import { piSessionServiceOptions } from './sessions/pi'
import { type JsonStateStore, openDesktopStateStore } from './store'
import { TerminalService } from './terminal'
import { RepositoryUseGate } from './repository-use-gate'
import { VoiceService, voiceSecretStorageStatus } from './voice'
import { isAllowedRendererAudioPermission } from './voice-permissions'
import { createManualUpdateCheck, getAutoUpdater, UpdateService } from './updates'

protocol.registerSchemesAsPrivileged([{ scheme: 'prime-work', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

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
let backgroundMode: MacBackgroundController | null = null
let shutdownStarted = false
let shutdownApproved = false
let confirmingShutdown = false
let trustedRendererUrl = ''
let packagedSmokeMarkerFile: string | null = null
let startInBackground = false
const keepTestWindowsHidden = process.env.PRIME_WORK_E2E_HIDE_WINDOWS === '1'

const windows = new MainWindowController({
  get shuttingDown() { return shutdownStarted },
  get shutdownApproved() { return shutdownApproved },
  get confirmingShutdown() { return confirmingShutdown },
  keepHidden: keepTestWindowsHidden,
  get rendererUrl() { return trustedRendererUrl },
  preloadPath: join(__dirname, '../preload/index.js'),
  get theme() { return store?.getSettings().theme },
  get zoomFactor() { return interfaceZoomFactor() },
  get ipc() { return ipc },
  get background() { return backgroundMode },
  iconPath: appIconPath,
  approveGuest: (contents) => agentBrowser?.approveGuest(contents),
  cancelDownloads: (ownerId) => downloads?.cancelOwner(ownerId),
  killTerminals: async (ownerId) => { await terminals?.killOwner(ownerId) },
  shutdownPrompt: pendingShutdownPrompt,
  requestShutdown,
  log: (message) => console.error(message),
})

installCrashGuards({
  logPath: () => {
    try { return join(app.getPath('userData'), 'crash.log') } catch { return null }
  },
  cleanupTimeoutMs: 10_000,
  cleanup: async () => {
    agents?.beginShutdown()
    ompAgents?.beginShutdown()
    piAgents?.beginShutdown()
    beginProcessShutdown()
    await Promise.allSettled([terminals?.killAll() ?? Promise.resolve(), agents?.stopAll() ?? Promise.resolve(), ompAgents?.stopAll() ?? Promise.resolve(), piAgents?.stopAll() ?? Promise.resolve(), stopChildProcesses()])
  },
})

function resourcePath(...segments: string[]): string {
  return bundledResourcePath({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }, ...segments)
}

function appIconPath(): string { return resourcePath('icon.png') }

function pendingShutdownPrompt(): ShutdownPrompt | null {
  const runtimes = [...(agents?.list() ?? []), ...(ompAgents?.list() ?? []), ...(piAgents?.list() ?? [])]
  return shutdownPrompt(activeShutdownWork(runtimes, automation?.hasActiveSchedules() ?? false))
}

/**
 * The one confirmation path for both ✕ and Quit: the dialog is async so agent
 * RPC, IPC, and schedule ticks keep running while it is open, and the approved
 * flag lets the programmatic quit through without re-asking.
 */
function requestShutdown(window: BrowserWindow | null, prompt: ShutdownPrompt): void {
  confirmingShutdown = true
  void confirmAppClose(window, prompt).then((approved) => {
    if (!approved) return
    shutdownApproved = true
    app.quit()
  }).catch((error: unknown) => {
    console.error(`GooeyPi close confirmation failed: ${boundedErrorMessage(error)}`)
  }).finally(() => { confirmingShutdown = false })
}

export function interfaceZoomFactor(): number {
  return (store?.getSettings().interfaceFontScale ?? 110) / 100
}

/**
 * App windows only: embedded browser guests and their views keep their own
 * zoom, so the app scale is applied through the window list rather than to
 * every webContents in the process.
 */
function applyInterfaceZoom(scale: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const contents = window.webContents
    if (!contents.isDestroyed()) contents.setZoomFactor(scale / 100)
  }
}

function requestWindow(reason: 'activation' | 'second instance' | 'menu bar' | 'settings', afterOpen?: (window: BrowserWindow) => void): void {
  void windows.ensure().then((window) => {
    if (!window || shutdownStarted || window.isDestroyed()) return
    if (!keepTestWindowsHidden) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    afterOpen?.(window)
  }).catch((error: unknown) => {
    if (!shutdownStarted) console.error(`GooeyPi failed to open a window after ${reason}: ${boundedErrorMessage(error)}`)
  })
}

function revealApplication(reason: 'activation' | 'second instance'): void {
  if (backgroundMode) backgroundMode.open()
  else requestWindow(reason)
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  configureGooeyPiAgentMessageSigning(loadOrCreateGooeyPiAgentMessageKey(join(userDataPath, 'agent-message-signing.key')))
  const stateStore = await openDesktopStateStore(userDataPath)
  store = stateStore
  backgroundMode = new MacBackgroundController({
    iconPath: appIconPath(),
    getSettings: () => stateStore.getSettings(),
    onOpen: () => requestWindow('menu bar'),
    onSettings: () => requestWindow('settings', (window) => {
      if (!window.webContents.isDestroyed()) window.webContents.send('app:open-settings')
    }),
    onQuit: () => app.quit(),
    startInBackground,
  })
  const discovery = new HarnessDiscoveryService(() => stateStore.getSettings().runtimePaths)
  const initialHarnesses = await discovery.refresh()
  await reconcileActiveHarness(stateStore, initialHarnesses)
  if (shutdownStarted) return
  const primeExecutable = () => discovery.executable('prime')
  const ompExecutable = () => discovery.executable('omp')
  const piExecutable = () => discovery.executable('pi')
  const sessions = new SessionService(stateStore, primeExecutable, undefined, { primeImplementation: () => discovery.primeImplementation() })
  // OMP has no live-CLI overlay (`omp list --json` does not exist), so the OMP
  // catalog is constructed with a null executable and JSONL-only metadata.
  const ompSessions = new SessionService(stateStore, null, undefined, ompSessionServiceOptions())
  // Pi likewise has no live-CLI overlay; its catalog is JSONL-only.
  const piSessions = new SessionService(stateStore, null, undefined, piSessionServiceOptions())
  const projects = new ProjectService(stateStore, () => windows.current)
  const ompProjects = new ProjectService(stateStore, () => windows.current, 'omp')
  const piProjects = new ProjectService(stateStore, () => windows.current, 'pi')
  const repositoryUseGate = new RepositoryUseGate()
  const checkouts: Record<HarnessId, CheckoutService> = {
    prime: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, projects, repositoryUseGate),
    omp: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, ompProjects, repositoryUseGate),
    pi: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, piProjects, repositoryUseGate),
  }
  // Git and terminals are harness-agnostic: a cwd (or bound session) is valid
  // when any harness's own grants authorize it. Prime is consulted first so
  // Prime-only setups keep their exact behavior and error text.
  const authorizeEitherCwd = (cwd: string): Promise<string> =>
    firstAccepted([projects, ompProjects, piProjects].map((project) => () => project.authorizeCwd(cwd)))
  const authorizeEitherReadOnlyCwd = (cwd: string): Promise<string> =>
    firstAccepted([projects, ompProjects, piProjects].map((project) => () => project.authorizeReadOnlyCwd(cwd)))
  const requireEitherSessionPath = (path: string): Promise<string> =>
    firstAccepted([sessions, ompSessions, piSessions].map((service) => () => service.requireSessionPath(path)))
  const git = new GitService(authorizeEitherCwd, authorizeEitherReadOnlyCwd)
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const providers = new PrimeProviderService({
    openExternal: async (url) => { await shell.openExternal(url, { activate: true }) },
    executable: primeExecutable, implementation: () => discovery.primeImplementation(),
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
    () => primeRpcAdapter(discovery.primeImplementation()),
  )
  agents.setDisabledModelsProvider(disabledModels)
  agents.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
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
  ompManager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
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
  piManager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  piAgents = piManager
  sessions.bindRuntimeManager(agents)
  ompSessions.bindRuntimeManager(ompManager)
  piSessions.bindRuntimeManager(piManager)
  terminals = new TerminalService(
    authorizeEitherCwd,
    () => stateStore.getSettings().terminalShell,
    requireEitherSessionPath,
    (cwd, owner) => repositoryUseGate.beginWorkspaceUse(cwd, owner),
  )
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await closeProjectBrowserSessions({ roots, sessions: listCatalogSessions, runtimes: agents!.list(), browser: agentBrowser })
      await Promise.all([agents!.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  ompProjects.bindProviders({
    sessions: () => ompSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      ompPlugins.evictProjects(roots)
      await closeProjectBrowserSessions({ roots, sessions: () => ompSessions.list(undefined, true), runtimes: ompManager.list(), browser: agentBrowser })
      await Promise.all([ompManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  piProjects.bindProviders({
    sessions: () => piSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      piPlugins.evictProjects(roots)
      await closeProjectBrowserSessions({ roots, sessions: () => piSessions.list(undefined, true), runtimes: piManager.list(), browser: agentBrowser })
      await Promise.all([piManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl, app.getPath('downloads'))
  const settings = new SettingsService(
    stateStore,
    (shell) => terminals!.validateShell(shell),
    () => downloads?.cancelAll(true),
    (previous, next) => backgroundMode?.applySettings(previous, next),
  )
  const cuaDriver = new CuaDriverService()
  // The disabled-by-default integration probes PATH and may spawn a version
  // command. Defer that work until it is enabled or its settings UI is opened.
  if (stateStore.getSettings().computerUseEnabled) await cuaDriver.status()
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
    builtInRoot: resourcePath('pets'),
    codexRoot: join(homedir(), '.codex', 'pets'),
  })
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const scheduleSkillPath = app.isPackaged
    ? await mirrorBundledSkill(resourcePath('skills', 'prime-work-schedules'), join(userDataPath, 'bundled-skills'))
    : resourcePath('skills', 'prime-work-schedules')
  const browserSkillPath = resourcePath('skills', 'prime-work-browser')
  const computerUseSkillPath = resourcePath('skills', 'gooeypi-computer-use', 'SKILL.md')
  const extensionPathContext = {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  }
  const extensionPathFor = (harness: HarnessId, capability: ExtensionCapability): string =>
    resolveExtensionPath(extensionInjection(harness, capability).filename, extensionPathContext)
  const primeBrowserExtensionPath = extensionPathFor('prime', 'browser')
  const ompBrowserExtensionPath = extensionPathFor('omp', 'browser')
  const ompScheduleExtensionPath = extensionPathFor('omp', 'schedule')
  const ompAskUserExtensionPath = extensionPathFor('omp', 'askUser')
  const collaborationExtensionPath = extensionPathFor('omp', 'collaboration')
  const piFastModeExtensionPath = extensionPathFor('pi', 'piFastMode')
  const computerUseSkill = async () => {
    const enabled = stateStore.getSettings().computerUseEnabled
    const status = enabled ? await cuaDriver.status() : undefined
    return {
      id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA',
      description: 'Drive native apps through a separately installed TryCUA driver. Install the driver before enabling.',
      kind: 'extension' as const, location: 'system' as const, path: computerUseSkillPath,
      enabled,
      availability: status ? { available: status.available, detail: status.detail, actionUrl: status.available ? undefined : status.installUrl } : undefined,
    }
  }
  const plugins = new PluginService(primeExecutable, (path) => projects.authorizeProjectRoot(path), {
    capabilityAvailability: (record) => primeCapabilityRecordAvailability(record, discovery.primeImplementation()),
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
  const heartbeats = new HeartbeatService(agents, primeExecutable, () => discovery.primeImplementation())
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
    validatePrompt: assertNoMcpAuthenticationCommand,
    run: (task) => scheduledRuns[task.harness].run(task),
  })
  automation = schedules
  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'prime',
    skillPath: scheduleSkillPath,
    resolveScope: createScheduleScopeResolver({ harness: 'prime', projects: projects, sessions: sessions }),
  })
  const ompScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'omp',
    skillPath: scheduleSkillPath,
    resolveScope: createScheduleScopeResolver({ harness: 'omp', projects: ompProjects, sessions: ompSessions }),
  })
  const piScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'pi',
    skillPath: scheduleSkillPath,
    resolveScope: createScheduleScopeResolver({ harness: 'pi', projects: piProjects, sessions: piSessions }),
  })
  const browserService = new AgentBrowserService({
    getGuest: (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      return contents && !contents.isDestroyed() ? contents : undefined
    },
  })
  agentBrowser = browserService
  const browserBridge = new AgentBrowserBridge({ service: browserService, terminals, extensionPath: primeBrowserExtensionPath, skillPath: browserSkillPath })
  const collaborationBridge = new AgentCollaborationBridge({
    extensionPath: collaborationExtensionPath,
    sessions: { prime: sessions, omp: ompSessions, pi: piSessions },
    agents: { prime: agents, omp: ompManager, pi: piManager },
    catalogs: { prime: providers, omp: ompCatalog, pi: piCatalog },
    disabledProviders: { prime: disabledProviders, omp: ompDisabledProviders, pi: piDisabledProviders },
    disabledModels: { prime: disabledModels, omp: ompDisabledModels, pi: piDisabledModels },
  })
  await Promise.all([
    scheduleBridge.start(),
    ompScheduleBridge.start(),
    piScheduleBridge.start(),
    browserBridge.start(),
    collaborationBridge.start(),
  ])
  agentScheduleBridges = [scheduleBridge, ompScheduleBridge, piScheduleBridge]
  agentBrowserBridge = browserBridge
  agentCollaborationBridge = collaborationBridge
  const revokeRuntimeCapabilities = (environment: NodeJS.ProcessEnv, runtimeScheduleBridge: AgentScheduleBridge): void => {
    const claims: Array<[string, { revoke(token: string | undefined): boolean }, string | undefined]> = [
      ['schedule', runtimeScheduleBridge, environment.PRIME_WORK_SCHEDULE_TOKEN],
      ['browser', browserBridge, environment.PRIME_WORK_BROWSER_TOKEN],
      ['collaboration', collaborationBridge, environment.GOOEYPI_COLLABORATION_TOKEN],
    ]
    for (const [name, bridge, token] of claims) {
      try { bridge.revoke(token) } catch (error) {
        console.error(`GooeyPi failed to revoke ${name} runtime capability: ${boundedErrorMessage(error)}`)
      }
    }
  }
  agents.setRuntimeEnvironmentProvider((scope) => primeRuntimeEnvironment(scope, {
    settings: stateStore.getSettings(), scheduleBridge, browserBridge, collaborationBridge,
    askUserExtensionPath: ompAskUserExtensionPath, cuaDriver, computerUseSkillPath,
  }))
  agents.setRuntimeStartListener((environment, info) => bindRuntimeCapabilities(environment, info, {
    scheduleBridge: scheduleBridge, browserBridge, collaborationBridge,
  }))
  agents.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment, scheduleBridge))
  // OMP runtimes get the same capability-scoped brokers through OMP-flavored
  // extensions. OMP has no --skill flag, so their tool descriptions carry the
  // app-specific usage guidance while OMP's own skills stay discovery-based.
  const capabilityExtensionPaths = {
    schedule: ompScheduleExtensionPath,
    browser: ompBrowserExtensionPath,
    askUser: ompAskUserExtensionPath,
  }
  ompManager.setRuntimeEnvironmentProvider((scope) => extensionHarnessRuntimeEnvironment(scope, {
    harness: 'omp', settings: stateStore.getSettings(), extensionPaths: capabilityExtensionPaths,
    scheduleBridge: ompScheduleBridge, browserBridge, collaborationBridge, cuaDriver, computerUseSkillPath,
  }))
  ompManager.setRuntimeStartListener((environment, info) => bindRuntimeCapabilities(environment, info, {
    scheduleBridge: ompScheduleBridge, browserBridge, collaborationBridge,
  }))
  ompManager.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment, ompScheduleBridge))
  // Pi runtimes receive the identical capability surface: pi's extension API
  // is the ancestor of OMP's, so the omp-work-* files are shared by design.
  piManager.setRuntimeEnvironmentProvider((scope) => extensionHarnessRuntimeEnvironment(scope, {
    harness: 'pi', settings: stateStore.getSettings(), extensionPaths: capabilityExtensionPaths,
    scheduleBridge: piScheduleBridge, browserBridge, collaborationBridge, cuaDriver, computerUseSkillPath,
    piFastModeExtensionPath,
  }))
  piManager.setRuntimeStartListener((environment, info) => bindRuntimeCapabilities(environment, info, {
    scheduleBridge: piScheduleBridge, browserBridge, collaborationBridge,
  }))
  piManager.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment, piScheduleBridge))
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    harnesses: initialHarnesses,
  }
  const updates = new UpdateService(getAutoUpdater(), {
    enabled: app.isPackaged,
    confirmInstall: async () => {
      if (shutdownStarted || confirmingShutdown) return false
      confirmingShutdown = true
      try {
        const prompt = pendingShutdownPrompt()
        const window = windows.current && !windows.current.isDestroyed() && windows.current.isVisible() ? windows.current : null
        if (prompt && !await confirmAppClose(window, prompt)) return false
        if (shutdownStarted) return false
        shutdownApproved = true
        return true
      } finally { confirmingShutdown = false }
    },
    onInstallAborted: () => { shutdownApproved = false },
  })
  updateService = updates
  const refreshHarnesses = async () => {
    const harnesses = await discovery.refresh()
    const currentSettings = await reconcileActiveHarness(stateStore, harnesses)
    meta.harnesses = harnesses
    return { meta: structuredClone(meta), settings: currentSettings }
  }
  agents.setStartRecovery(primeStartRecovery(async () => { await refreshHarnesses(); ipc?.notifyHarnessesChanged(); return discovery.primeImplementation() }))
  trustedRendererUrl = resolveRendererUrl({ isPackaged: app.isPackaged, rendererRoot: resolve(__dirname, '../renderer'), developmentUrl: process.env.ELECTRON_RENDERER_URL })
  ipc = registerIpc({
    meta, refreshHarnesses, projects, checkouts, sessions, agents, terminals, git, plugins, providers, settings, updates, cuaDriver, heartbeats, schedules, browser: browserService, voice, pets,
    popupApplicationMenu, setTitleBarTheme,
    omp: { projects: ompProjects, sessions: ompSessions, agents: ompManager, catalog: ompCatalog, plugins: ompPlugins },
    pi: { projects: piProjects, sessions: piSessions, agents: piManager, catalog: piCatalog, plugins: piPlugins },
    applyInterfaceZoom,
  }, trustedRendererUrl)
  // Both managers share the one renderer forwarding path: envelopes carry the
  // runtimeId and RuntimeInfo carries the harness, so the renderer can route.
  const forwardAgentEvent = (envelope: PrimeEventEnvelope): void => {
    const renderer = windows.current?.webContents
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
    const renderer = windows.current?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('providers:auth-event', event)
    }
  })
  updates.setEventSink((state: AppUpdateState) => {
    const renderer = windows.current?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('updates:changed', state)
    }
  })
  installApplicationMenu({
    appName: 'GooeyPi',
    updatesEnabled: updates.isEnabled(),
    closeWindow: () => {
      const window = windows.current
      if (!window || window.isDestroyed()) app.quit()
      else window.close()
    },
    checkForUpdates: createManualUpdateCheck(() => updates.check(), async (notification) => {
      await dialog.showMessageBox({
        type: notification.type,
        title: 'GooeyPi',
        message: notification.message,
        detail: notification.detail,
      })
    }),
  })
  backgroundMode.start()
  const window = await windows.ensure()
  if (shutdownStarted) return
  if (packagedSmokeMarkerFile) {
    await runPackagedSmoke(window, packagedSmokeMarkerFile)
    return
  }
  updates.start()
  await schedules.start()
}

/**
 * Reports packaged readiness once the trusted renderer has completed an
 * authorized IPC round trip, then quits. The launcher owns the deadline, so
 * nothing here polls or waits on a timer.
 */
async function runPackagedSmoke(window: BrowserWindow | null, markerPath: string): Promise<void> {
  if (!window || window.isDestroyed()) throw new Error('Packaged smoke mode could not open the renderer window')
  if (!ipc) throw new Error('Packaged smoke mode has no registered IPC surface to observe')
  await ipc.whenRendererReady
  const marker = serializePackagedSmokeMarker(packagedSmokeMarker(trustedRendererUrl, app.getVersion()))
  await writeFile(markerPath, marker, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  console.log(`${PACKAGED_SMOKE_READY_EVENT} ${trustedRendererUrl}`)
  shutdownApproved = true
  app.quit()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
  // Parsed from the first instance's own argv only: a second-instance command
  // line must never be able to make a running application write a marker and quit.
  const requestedSmokeMarker = packagedSmokeMarkerPath(process.argv)
  if (requestedSmokeMarker) {
    if (!app.isPackaged) throw new Error('Packaged smoke mode is only available in packaged builds')
    packagedSmokeMarkerFile = requestedSmokeMarker
  }
  if (app.isPackaged) registerRendererProtocol(resolve(__dirname, '../renderer'))
  let wasOpenedAtLogin = false
  if (process.platform === 'darwin' && app.isPackaged) {
    try { wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin } catch { /* The explicit flag remains available if the OS lookup fails. */ }
  }
  startInBackground = shouldStartInBackground(process.argv, wasOpenedAtLogin)
  if (process.platform === 'darwin') {
    app.setActivationPolicy(startInBackground ? 'accessory' : 'regular')
    if (!startInBackground) app.dock?.setIcon(appIconPath())
  }
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
    if (!shutdownStarted) revealApplication('second instance')
  })
  app.on('activate', () => {
    if (!shutdownStarted && (!windows.current || windows.current.isDestroyed() || !windows.current.isVisible())) revealApplication('activation')
  })
}).catch((error: unknown) => {
  writeCrashLog(() => join(app.getPath('userData'), 'crash.log'), 'startup', error)
  const failureDialog = startupFailureDialog(error)
  if (failureDialog) dialog.showErrorBox(failureDialog.title, failureDialog.detail)
  if (!shutdownStarted) console.error(`GooeyPi failed to start: ${boundedErrorMessage(error)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  routeAllWindowsClosed(shutdownStarted, backgroundMode, () => app.quit())
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  if (!shutdownApproved) {
    const prompt = pendingShutdownPrompt()
    if (prompt) {
      event.preventDefault()
      if (!confirmingShutdown) requestShutdown(windows.current && !windows.current.isDestroyed() && windows.current.isVisible() ? windows.current : null, prompt)
      return
    }
  }
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  backgroundMode?.dispose()
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
  ], { drain: async () => { await store?.beginShutdown() } }).finally(() => app.quit())
})
