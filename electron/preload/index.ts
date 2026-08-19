import { contextBridge, ipcRenderer } from 'electron'
import type { AgentBrowserActivityEvent, AgentBrowserPointerEvent, AgentBrowserState, AppUpdateState, PrimeEventEnvelope, PrimeWorkApi, ProviderAuthEvent, ScheduleChangeEvent, SessionChangeEvent, TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (typeof payload === 'object' && payload !== null) callback(payload as T)
  }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function subscribeSignal(channel: string, callback: () => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: PrimeWorkApi = {
  app: {
    getMeta: () => ipcRenderer.invoke('app:get-meta'),
    refreshHarnesses: () => ipcRenderer.invoke('app:refresh-harnesses'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    revealPath: (path) => ipcRenderer.invoke('app:reveal-path', path),
    popupMenu: (menu, x, y) => ipcRenderer.invoke('app:popup-menu', menu, x, y),
    setTitleBarTheme: (theme) => ipcRenderer.invoke('app:set-title-bar-theme', theme),
    onOpenSettings: (callback) => subscribeSignal('app:open-settings', callback),
  },
  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    check: () => ipcRenderer.invoke('updates:check'),
    downloadAndInstall: () => ipcRenderer.invoke('updates:download-and-install'),
    onChanged: (callback) => subscribe<AppUpdateState>('updates:changed', callback),
  },
  projects: {
    list: (harness) => ipcRenderer.invoke('projects:list', harness),
    listFiles: (root, harness) => ipcRenderer.invoke('projects:list-files', root, harness),
    listWorktrees: (cwd, harness) => ipcRenderer.invoke('projects:list-worktrees', cwd, harness),
    openWorktree: (cwd, path, harness) => ipcRenderer.invoke('projects:open-worktree', cwd, path, harness),
    createWorktree: (cwd, branch, harness) => ipcRenderer.invoke('projects:create-worktree', cwd, branch, harness),
    add: (harness) => ipcRenderer.invoke('projects:add', harness),
    grantInferred: (path, harness) => ipcRenderer.invoke('projects:grant-inferred', path, harness),
    remove: (id, harness) => ipcRenderer.invoke('projects:remove', id, harness),
    touch: (id, harness) => ipcRenderer.invoke('projects:touch', id, harness),
  },
  sessions: {
    list: (projectPath, includeArchived, harness, force) => ipcRenderer.invoke('sessions:list', projectPath, includeArchived, harness, force),
    read: (filePath) => ipcRenderer.invoke('sessions:read', filePath),
    followUp: (filePath, message, intent) => ipcRenderer.invoke('sessions:follow-up', filePath, message, intent),
    rename: (filePath, title) => ipcRenderer.invoke('sessions:rename', filePath, title),
    archive: (filePath, archived) => ipcRenderer.invoke('sessions:archive', filePath, archived),
    onChanged: (callback) => subscribe<SessionChangeEvent>('sessions:changed', callback),
  },
  agent: {
    start: (options) => ipcRenderer.invoke('agent:start', options),
    command: (runtimeId, command) => ipcRenderer.invoke('agent:command', runtimeId, command),
    stop: (runtimeId) => ipcRenderer.invoke('agent:stop', runtimeId),
    list: () => ipcRenderer.invoke('agent:list'),
    onEvent: (callback) => subscribe<PrimeEventEnvelope>('agent:event', callback),
  },
  providers: {
    catalog: (force, harness) => ipcRenderer.invoke('providers:catalog', force, harness),
    saveApiKey: (providerId, apiKey) => ipcRenderer.invoke('providers:save-api-key', providerId, apiKey),
    logout: (providerId) => ipcRenderer.invoke('providers:logout', providerId),
    setEnabled: (providerId, enabled, harness) => ipcRenderer.invoke('providers:set-enabled', providerId, enabled, harness),
    setDisabled: (providerIds, harness) => ipcRenderer.invoke('providers:set-disabled', providerIds, harness),
    setModelEnabled: (modelKey, enabled, harness) => ipcRenderer.invoke('providers:set-model-enabled', modelKey, enabled, harness),
    startOAuth: (providerId) => ipcRenderer.invoke('providers:start-oauth', providerId),
    respondOAuth: (flowId, promptId, value) => ipcRenderer.invoke('providers:respond-oauth', flowId, promptId, value),
    cancelOAuth: (flowId) => ipcRenderer.invoke('providers:cancel-oauth', flowId),
    onAuthEvent: (callback) => subscribe<ProviderAuthEvent>('providers:auth-event', callback),
  },
  agentConfig: {
    get: (harness, options) => ipcRenderer.invoke('agent-config:get', harness, options),
    set: (patch, harness) => ipcRenderer.invoke('agent-config:set', patch, harness),
  },
  voice: {
    credentialStatus: () => ipcRenderer.invoke('voice:credential-status'),
    saveApiKey: (provider, apiKey) => ipcRenderer.invoke('voice:save-api-key', provider, apiKey),
    deleteApiKey: (provider) => ipcRenderer.invoke('voice:delete-api-key', provider),
    createRealtimeCall: (request) => ipcRenderer.invoke('voice:create-realtime-call', request),
    cancelRealtimeCall: (setupId) => ipcRenderer.invoke('voice:cancel-realtime-call', setupId),
    transcribe: (request) => ipcRenderer.invoke('voice:transcribe', request),
    testSelfHosted: (request) => ipcRenderer.invoke('voice:test-self-hosted', request),
    executeTool: (request, harness) => ipcRenderer.invoke('voice:execute-tool', request, harness),
  },
  pets: {
    list: () => ipcRenderer.invoke('pets:list'),
    sprite: (id) => ipcRenderer.invoke('pets:sprite', id),
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    bindSession: (terminalId, sessionPath) => ipcRenderer.invoke('terminal:bind-session', terminalId, sessionPath),
    input: (terminalId, data) => { ipcRenderer.send('terminal:input', terminalId, data) },
    resize: (terminalId, cols, rows) => { ipcRenderer.send('terminal:resize', terminalId, cols, rows) },
    setActiveContext: (terminalId, context) => { ipcRenderer.send('terminal:set-active-context', terminalId, context) },
    clearActiveContext: (terminalId) => { ipcRenderer.send('terminal:clear-active-context', terminalId) },
    kill: (terminalId) => ipcRenderer.invoke('terminal:kill', terminalId),
    onData: (callback) => subscribe<TerminalDataEvent>('terminal:data', callback),
    onExit: (callback) => subscribe<TerminalExitEvent>('terminal:exit', callback),
  },
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd, path, staged) => ipcRenderer.invoke('git:diff', cwd, path, staged),
    stage: (cwd, paths) => ipcRenderer.invoke('git:stage', cwd, paths),
    unstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
    restore: (cwd, paths) => ipcRenderer.invoke('git:restore', cwd, paths),
    commit: (cwd, message) => ipcRenderer.invoke('git:commit', cwd, message),
  },
  plugins: {
    list: (projectPath, harness) => ipcRenderer.invoke('plugins:list', projectPath, harness),
    install: (source, harness) => ipcRenderer.invoke('plugins:install', source, harness),
    installExtension: (input, harness) => ipcRenderer.invoke('plugins:install-extension', input, harness),
    setMcpSupport: (enabled, harness) => ipcRenderer.invoke('plugins:set-mcp-support', enabled, harness),
    connectMcp: (input, harness) => ipcRenderer.invoke('plugins:connect-mcp', input, harness),
    setMcpEnabled: (input, harness) => ipcRenderer.invoke('plugins:set-mcp-enabled', input, harness),
    mutateCapability: (input, harness) => ipcRenderer.invoke('plugins:mutate-capability', input, harness),
    refresh: (harness) => ipcRenderer.invoke('plugins:refresh', harness),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    resetBrowserData: () => ipcRenderer.invoke('settings:reset-browser-data'),
  },
  browser: {
    state: () => ipcRenderer.invoke('browser:state'),
    attachTab: (tabId, webContentsId) => ipcRenderer.invoke('browser:attach-tab', tabId, webContentsId),
    selectTab: (tabId) => ipcRenderer.invoke('browser:select-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('browser:close-tab', tabId),
    setPreviewContext: (webContentsId, sessionFile) => ipcRenderer.invoke('browser:set-preview-context', webContentsId, sessionFile),
    navigateTab: (tabId, action, url) => ipcRenderer.invoke('browser:navigate-tab', tabId, action, url),
    onChanged: (callback) => subscribe<AgentBrowserState>('browser:changed', callback),
    onPointer: (callback) => subscribe<AgentBrowserPointerEvent>('browser:pointer', callback),
    onActivity: (callback) => subscribe<AgentBrowserActivityEvent>('browser:activity', callback),
  },
  heartbeats: {
    list: () => ipcRenderer.invoke('heartbeats:list'),
    manage: (id, action) => ipcRenderer.invoke('heartbeats:manage', id, action),
  },
  schedules: {
    list: (harness) => ipcRenderer.invoke('schedules:list', harness),
    get: (id) => ipcRenderer.invoke('schedules:get', id),
    preview: (timing, count) => ipcRenderer.invoke('schedules:preview', timing, count),
    create: (input, harness) => ipcRenderer.invoke('schedules:create', input, harness),
    update: (id, patch) => ipcRenderer.invoke('schedules:update', id, patch),
    pause: (id) => ipcRenderer.invoke('schedules:pause', id),
    resume: (id) => ipcRenderer.invoke('schedules:resume', id),
    delete: (id) => ipcRenderer.invoke('schedules:delete', id),
    runNow: (id) => ipcRenderer.invoke('schedules:run-now', id),
    onChanged: (callback) => subscribe<ScheduleChangeEvent>('schedules:changed', callback),
  },
}

for (const domain of Object.values(api)) Object.freeze(domain)
contextBridge.exposeInMainWorld('prime', Object.freeze(api))
