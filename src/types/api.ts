// Domain contracts are re-exported here so existing bridge imports keep one entry point.
import type { HarnessId, HarnessStatus } from './api/harness'
import type { PrimeModelDescriptor, PrimeThinkingLevel, PrimeModelCatalog, ProviderAuthEvent } from './api/models'
import type { AppSettings, ThemeMode } from './api/settings'
import type { ProjectRecord, ProjectFileListing, ProjectScripts } from './api/projects'
import type { CheckoutCatalog, CheckoutAction, CheckoutChangeResult, GitStatus, GitDiff } from './api/git'
import type { SessionRecord, TranscriptMessage, PromptDeliveryIntent, SessionChangeEvent } from './api/sessions'
import type { RuntimeInfo, PrimeEventEnvelope } from './api/runtime'
import type { PluginCatalog, ExtensionInstallInput, McpConnectionInput, McpStateInput, CapabilityMutationInput } from './api/plugins'
import type { AgentBrowserState, AgentBrowserPointerEvent, AgentBrowserActivityEvent } from './api/browser'
import type { NativeHeartbeatRecord, AutomationScheduleRecord, ScheduleTiming, SchedulePreview, ScheduleInput, SchedulePatch, ScheduleRunRecord, ScheduleChangeEvent } from './api/schedules'
import type { ChildRoster, ChildHistoryOptions, ChildHistoryPage } from './subagents'
export type { ChildSession, ChildRoster, ChildHistoryOptions, ChildHistoryPage } from './subagents'

export interface AppMeta {
  version: string
  platform: NodeJS.Platform
  homeDir: string
  harnesses: Record<HarnessId, HarnessStatus>
}

export type ApplicationMenuName = 'file' | 'edit' | 'view' | 'window' | 'help'

export type AppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'

export interface AppUpdateState {
  phase: AppUpdatePhase
  version?: string
  percent?: number
  message?: string
}

/**
 * The one result shape for subprocess-backed operations (git commit, package
 * install, MCP settings updates). `reason` classifies failures: the subprocess
 * timed out, exceeded its output limit, exited non-zero, or the operation was
 * blocked before or instead of running the subprocess.
 */
export type ProcessFailureReason = 'timeout' | 'overflow' | 'exit' | 'blocked'
export interface ProcessOutcome { ok: boolean; output: string; reason?: ProcessFailureReason }

export interface TerminalSpawnOptions { cwd: string; sessionPath?: string; shell?: string; command?: string; cols?: number; rows?: number }
export interface TerminalDataEvent { terminalId: string; data: string }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }
export interface TerminalSelectionContext { tabId: string; label: string; text: string; truncated: boolean }
export interface TerminalPromptContext extends TerminalSelectionContext { cwd?: string }
export interface TerminalActiveContext { label: string; content: string; truncated: boolean }

export interface PetDefinition {
  /** Stable settings key. Codex pets are namespaced as codex/<folder>. */
  id: string
  /** Package manifest id, used to deduplicate bundled and Codex copies. */
  petId: string
  displayName: string
  description: string
  source: 'built-in' | 'codex'
  kind: 'orb' | 'spritesheet'
}

export const VOICE_TRANSCRIPTION_PROVIDERS = ['openai-live', 'openai', 'groq', 'deepgram', 'self-hosted', 'local-whisper'] as const
export type VoiceTranscriptionProvider = typeof VOICE_TRANSCRIPTION_PROVIDERS[number]
export const VOICE_CREDENTIAL_PROVIDERS = ['openai', 'groq', 'deepgram', 'self-hosted'] as const
export type VoiceCredentialProvider = typeof VOICE_CREDENTIAL_PROVIDERS[number]

export interface VoiceCredentialStorageStatus {
  available: boolean
  message?: string
}

export interface VoiceCredentialStatus {
  configured: Record<VoiceCredentialProvider, boolean>
  source: Partial<Record<VoiceCredentialProvider, 'saved' | 'environment' | 'session'>>
  storage: VoiceCredentialStorageStatus
}

export type VoiceRealtimeCallRequest =
  | { mode: 'conversation'; sdp: string; harness: HarnessId }
  | { mode: 'transcription'; sdp: string }

export interface VoiceTranscriptionRequest {
  provider: Exclude<VoiceTranscriptionProvider, 'openai-live'>
  audio: Uint8Array
}

export interface VoiceSelfHostedTestRequest {
  url: string
  model: string
}

export interface VoiceProjectSummary {
  id: string
  harness: HarnessId
  name: string
  lastOpenedAt: string
}

export interface VoiceTaskStarted {
  projectId: string
  projectName: string
  harness: HarnessId
  runtimeId: string
  sessionId?: string
  sessionFile: string
  model?: Pick<PrimeModelDescriptor, 'key' | 'provider' | 'id' | 'name'>
  reasoning?: PrimeThinkingLevel
}

export type VoiceToolRequest =
  | { name: 'list_projects'; arguments: { query?: string } }
  | { name: 'list_models'; arguments: { query?: string } }
  | { name: 'start_task'; arguments: { project_id: string; prompt: string; title?: string; model?: string; reasoning?: string } }
  | { name: 'get_local_context'; arguments: Record<string, never> }
  | { name: 'search_web'; arguments: { query: string } }

export interface VoiceToolResult {
  output: string
  task?: VoiceTaskStarted
}



































export interface PrimeWorkApi {
  app: { getMeta(): Promise<AppMeta>; refreshHarnesses(): Promise<{ meta: AppMeta; settings: AppSettings }>; openExternal(url: string): Promise<boolean>; revealPath(path: string): Promise<boolean>; popupMenu(menu: ApplicationMenuName, x: number, y: number): Promise<boolean>; setTitleBarTheme(theme: Exclude<ThemeMode, 'system'>): Promise<boolean>; onOpenSettings(callback: () => void): () => void; onHarnessesChanged(callback: () => void): () => void }
  updates: {
    getState(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    downloadAndInstall(): Promise<boolean>
    onChanged(callback: (state: AppUpdateState) => void): () => void
  }
  projects: {
    list(harness?: HarnessId): Promise<ProjectRecord[]>
    listFiles(root: string, harness?: HarnessId, mode?: 'children'): Promise<ProjectFileListing>
    listCheckouts(projectId: string, harness?: HarnessId): Promise<CheckoutCatalog>
    executeCheckout(projectId: string, action: CheckoutAction, harness?: HarnessId): Promise<CheckoutChangeResult>
    add(harness?: HarnessId): Promise<ProjectRecord | null>
    grantInferred(path: string, harness?: HarnessId): Promise<ProjectRecord>
    remove(id: string, harness?: HarnessId): Promise<boolean>
    touch(id: string, harness?: HarnessId): Promise<boolean>
    setPinned(id: string, pinned: boolean, harness?: HarnessId): Promise<boolean>
    updateScripts(id: string, scripts: Pick<ProjectScripts, 'setup' | 'run'>, harness?: HarnessId): Promise<ProjectScripts>
    markSetupStarted(id: string, setup: string, harness?: HarnessId): Promise<ProjectScripts>
    finishSetup(id: string, setup: string, exitCode: number, harness?: HarnessId): Promise<ProjectScripts | undefined>
  }
  sessions: {
    list(projectPath?: string, includeArchived?: boolean, harness?: HarnessId, force?: boolean): Promise<SessionRecord[]>
    read(filePath: string): Promise<TranscriptMessage[]>
    followUp(filePath: string, message: string, intent?: PromptDeliveryIntent): Promise<boolean>
    rename(filePath: string, title: string): Promise<boolean>
    archive(filePath: string, archived?: boolean): Promise<boolean>
    onChanged(callback: (event: SessionChangeEvent) => void): () => void
  }
  subagents: {
    list(parentSessionFile: string, harness: HarnessId): Promise<ChildRoster>
    history(parentSessionFile: string, childId: string, options?: ChildHistoryOptions, harness?: HarnessId): Promise<ChildHistoryPage>
  }
  agent: {
    start(options: { cwd: string; sessionPath?: string; model?: string; thinking?: string; fast?: boolean; harness?: HarnessId }): Promise<RuntimeInfo>
    command(runtimeId: string, command: Record<string, unknown>): Promise<Record<string, unknown>>
    stop(runtimeId: string): Promise<boolean>
    list(): Promise<RuntimeInfo[]>
    onEvent(callback: (envelope: PrimeEventEnvelope) => void): () => void
  }
  providers: {
    catalog(force?: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    saveApiKey(providerId: string, apiKey: string, harness?: HarnessId): Promise<PrimeModelCatalog>
    logout(providerId: string, harness?: HarnessId): Promise<PrimeModelCatalog>
    setEnabled(providerId: string, enabled: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    setDisabled(providerIds: string[], harness?: HarnessId): Promise<PrimeModelCatalog>
    setModelEnabled(modelKey: string, enabled: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    startOAuth(providerId: string, harness?: HarnessId): Promise<{ flowId: string }>
    respondOAuth(flowId: string, promptId: string, value?: string): Promise<boolean>
    cancelOAuth(flowId: string): Promise<boolean>
    onAuthEvent(callback: (event: ProviderAuthEvent) => void): () => void
  }
  voice: {
    credentialStatus(): Promise<VoiceCredentialStatus>
    saveApiKey(provider: VoiceCredentialProvider, apiKey: string): Promise<VoiceCredentialStatus>
    deleteApiKey(provider: VoiceCredentialProvider): Promise<VoiceCredentialStatus>
    createRealtimeCall(request: VoiceRealtimeCallRequest): Promise<string>
    transcribe(request: VoiceTranscriptionRequest): Promise<string>
    testSelfHosted(request: VoiceSelfHostedTestRequest): Promise<boolean>
    executeTool(request: VoiceToolRequest, harness: HarnessId): Promise<VoiceToolResult>
  }
  pets: {
    list(): Promise<PetDefinition[]>
    sprite(id: string): Promise<string | null>
  }
  terminal: {
    create(options: TerminalSpawnOptions): Promise<{ terminalId: string; shell: string }>
    bindSession(terminalId: string, sessionPath: string): Promise<boolean>
    input(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    setActiveContext(terminalId: string, context: TerminalActiveContext): void
    clearActiveContext(terminalId: string): void
    kill(terminalId: string): Promise<boolean>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  git: { status(cwd: string): Promise<GitStatus>; diff(cwd: string, path?: string, staged?: boolean): Promise<GitDiff>; stage(cwd: string, paths: string[]): Promise<boolean>; unstage(cwd: string, paths: string[]): Promise<boolean>; restore(cwd: string, paths: string[]): Promise<boolean>; commit(cwd: string, message: string): Promise<ProcessOutcome> }
  plugins: {
    list(projectPath?: string, harness?: HarnessId): Promise<PluginCatalog>
    install(source: string, harness?: HarnessId): Promise<ProcessOutcome>
    installExtension(input: ExtensionInstallInput, harness?: HarnessId): Promise<ProcessOutcome>
    setMcpSupport(enabled: boolean, harness?: HarnessId): Promise<ProcessOutcome>
    connectMcp(input: McpConnectionInput, harness?: HarnessId): Promise<ProcessOutcome>
    setMcpEnabled(input: McpStateInput, harness?: HarnessId): Promise<ProcessOutcome>
    mutateCapability(input: CapabilityMutationInput, harness?: HarnessId): Promise<ProcessOutcome>
  }
  settings: { get(): Promise<AppSettings>; update(patch: Partial<AppSettings>): Promise<AppSettings>; resetBrowserData(): Promise<boolean> }
  browser: {
    state(): Promise<AgentBrowserState>
    attachTab(tabId: string, webContentsId: number): Promise<boolean>
    selectTab(tabId: string): Promise<boolean>
    closeTab(tabId: string): Promise<boolean>
    setPreviewContext(webContentsId: number | null, sessionFile: string | null): Promise<boolean>
    navigateTab(tabId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string): Promise<boolean>
    onChanged(callback: (state: AgentBrowserState) => void): () => void
    onPointer(callback: (event: AgentBrowserPointerEvent) => void): () => void
    onActivity(callback: (event: AgentBrowserActivityEvent) => void): () => void
  }
  heartbeats: {
    list(): Promise<NativeHeartbeatRecord[]>
    manage(id: string, action: 'pause' | 'resume' | 'stop'): Promise<NativeHeartbeatRecord | null>
  }
  schedules: {
    list(harness?: HarnessId): Promise<AutomationScheduleRecord[]>
    preview(timing: ScheduleTiming, count?: number): Promise<SchedulePreview>
    create(input: ScheduleInput, harness?: HarnessId): Promise<AutomationScheduleRecord>
    update(id: string, patch: SchedulePatch): Promise<AutomationScheduleRecord>
    pause(id: string): Promise<AutomationScheduleRecord>
    resume(id: string): Promise<AutomationScheduleRecord>
    delete(id: string): Promise<boolean>
    runNow(id: string): Promise<ScheduleRunRecord>
    onChanged(callback: (event: ScheduleChangeEvent) => void): () => void
  }
}

declare global { interface Window { prime: PrimeWorkApi } }

export * from './api/harness'

export * from './api/models'

export * from './api/browser'

export * from './api/plugins'

export * from './api/schedules'

export * from './api/projects'

export * from './api/git'

export * from './api/sessions'

export * from './api/runtime'

export * from './api/settings'
