import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TitleToolbar } from '@/components/TitleToolbar'
import type { ProjectScriptKind } from '@/components/ProjectRunControl'
import { ChangesCard } from '@/components/ChangesCard'
import { Composer } from '@/components/Composer'
import type { TerminalDrawerHandle } from '@/components/TerminalDrawer'
import { ResizeHandle } from '@/components/ResizeHandle'
import { NoHarnessPrompt } from '@/components/NoHarnessPrompt'
import { createAppKeydownHandler } from '@/lib/app-shortcuts'
import { detectRendererPlatform } from '@/lib/platform-shortcuts'
import { activityNotificationSignature, readClearedActivity, readClearedAttention, sessionCompanionNotificationSignature } from '@/app/session-attention'
import { errorMessage } from '@/lib/errors'
import { I18nProvider } from '@/lib/i18n'
import { openExternalUrl, revealPath } from '@/lib/desktop-actions'
import { createSingleFlightAdmission, findProjectForSession, gitStatusForWorkspace, shouldRefreshGitOnSessionTransition, workspaceCwd } from '@/lib/workspace'
import { waitForVoiceSession } from '@/lib/voice'
import { activeProjectScriptKind, ProjectScriptBusyError, setupNeedsRun } from '@/lib/project-scripts'
import { SAMPLE_GIT, SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS, SAMPLE_SKILLS, SAMPLE_TRANSCRIPT } from '@/lib/data'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES, HARNESS_SHORT_NAMES } from '@/lib/harness'
import { AgentBrowserLayer, type AgentSlotRect } from '@/components/AgentBrowserLayer'
import { useAgentBrowserTabs } from '@/hooks/useAgentBrowserTabs'
import { useAgentEvents } from '@/hooks/useAgentEvents'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useAppUpdates } from '@/hooks/useAppUpdates'
import { useBootstrap } from '@/hooks/useBootstrap'
import { useBrowserAnnotations } from '@/hooks/useBrowserAnnotations'
import { useExtensionUi } from '@/hooks/useExtensionUi'
import { INSPECTOR_DEFAULT, INSPECTOR_MIN, TERMINAL_DEFAULT, TERMINAL_MIN, usePanelLayout } from '@/hooks/usePanelLayout'
import { usePluginSkills } from '@/hooks/usePluginSkills'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
import { useSidebarActions } from '@/hooks/useSidebarActions'
import { useStableCallback } from '@/hooks/useStableCallback'
import { useToast } from '@/hooks/useToast'
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions'
import { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import { HARNESS_IDS, type GitStatus, type GitWorktree, type HarnessId, type NativeHeartbeatRecord, type PrimeModelDescriptor, type PrimeProviderDescriptor, type ProjectRecord, type AutomationScheduleRecord, type QueuedPrompt, type ScheduleTiming, type SessionRecord, type TerminalSelectionContext, type TranscriptMessage, type VoiceTaskStarted, type WorkspaceView } from '@/types/api'

const Transcript = lazy(() => import('@/components/Transcript').then((module) => ({ default: module.Transcript })))
const Inspector = lazy(() => import('@/components/Inspector').then((module) => ({ default: module.Inspector })))
const TerminalDrawer = lazy(() => import('@/components/TerminalDrawer').then((module) => ({ default: module.TerminalDrawer })))
const CommandPalette = lazy(() => import('@/components/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const ExtensionUiModal = lazy(() => import('@/components/ExtensionUiModal').then((module) => ({ default: module.ExtensionUiModal })))
const ProviderAuthModal = lazy(() => import('@/components/ProviderAuthModal').then((module) => ({ default: module.ProviderAuthModal })))
const VoiceOrb = lazy(() => import('@/components/VoiceOrb').then((module) => ({ default: module.VoiceOrb })))
const DesktopPet = lazy(() => import('@/components/DesktopPet').then((module) => ({ default: module.DesktopPet })))
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })))
const ActivityPage = lazy(() => import('@/pages/ActivityPage').then((module) => ({ default: module.ActivityPage })))
const ScheduledPage = lazy(() => import('@/pages/ScheduledPage').then((module) => ({ default: module.ScheduledPage })))
const PluginsPage = lazy(() => import('@/pages/PluginsPage').then((module) => ({ default: module.PluginsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))

const hasBridge = () => typeof window !== 'undefined' && typeof window.prime !== 'undefined'
// Stable fallback identities keep memoized children from re-rendering while the catalog loads.
const EMPTY_MODELS: PrimeModelDescriptor[] = []
const EMPTY_PROVIDERS: PrimeProviderDescriptor[] = []
// Stable identity for the Inspector while the Summary tab is inactive: the
// streaming transcript array must not reach the memoized inspector subtree.
const EMPTY_MESSAGES: TranscriptMessage[] = []
const HARNESS_PROVIDER_DOCS: Record<HarnessId, string> = {
  omp: 'https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md',
  prime: 'https://github.com/PrimeIntellect-ai/prime-agent',
  pi: 'https://pi.dev',
}
const LoadingPanel = ({ label }: { label: string }) => <div className="empty-state" role="status">Loading {label}…</div>
const TerminalLoadingPanel = () => <div className="terminal-drawer terminal-drawer--loading" role="status">Loading terminal…</div>

interface TerminalSessionMount {
  id: string
  workspaceKey: string
  cwd?: string
  sessionPath?: string
  initialCommand?: { id: string; command: string; label: string; onExit(exitCode: number): void }
}
interface ActiveProjectScriptRun {
  requestId: string
  projectId: string
  kind: ProjectScriptKind
  command: string
  harness: HarnessId
  drawerId?: string
  tabId?: string
  ownsDrawer: boolean
}
type ProjectScriptRunOutcome = { cancelled: true } | { exitCode: number }


export default function App() {
  const bridge = hasBridge() ? window.prime : null
  const initialProject = bridge ? undefined : SAMPLE_PROJECTS[0]
  const initialSession = bridge ? undefined : SAMPLE_SESSIONS[0]
  const [projects, setProjects] = useState<ProjectRecord[]>(() => bridge ? [] : SAMPLE_PROJECTS)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => bridge ? [] : SAMPLE_SESSIONS)
  const [clearedAttention, setClearedAttention] = useState<Record<string, string>>(() => readClearedAttention())
  const [clearedActivity, setClearedActivity] = useState<Record<string, string>>(() => readClearedActivity())
  const [schedules, setSchedules] = useState<AutomationScheduleRecord[]>(() => bridge ? [] : SAMPLE_SCHEDULES)
  const [heartbeats, setHeartbeats] = useState<NativeHeartbeatRecord[]>([])
  const [scheduleFocusId, setScheduleFocusId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [gitSnapshot, setGitSnapshot] = useState(() => ({ cwd: bridge ? undefined : SAMPLE_PROJECTS[0]?.primaryFolder, status: bridge ? { isRepo: false, files: [] } as GitStatus : SAMPLE_GIT }))
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [worktreesLoading, setWorktreesLoading] = useState(false)
  const [view, setView] = useState<WorkspaceView>('session')
  const [settingsSectionRequest, setSettingsSectionRequest] = useState<{ section: 'general' | 'agent'; id: number }>({ section: 'general', id: 0 })
  const [noHarnessPromptDismissed, setNoHarnessPromptDismissed] = useState(false)
  const [browserGeneration, setBrowserGeneration] = useState(0)
  const [browserNavigationRequest, setBrowserNavigationRequest] = useState<{ id: number; url: string }>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [voiceOrbOpen, setVoiceOrbOpen] = useState(false)
  const [focusPetVoiceControl, setFocusPetVoiceControl] = useState(false)
  const [restorePetVoiceFocus, setRestorePetVoiceFocus] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { toast, setToast } = useToast()
  const [changesCardDismissed, setChangesCardDismissed] = useState(false)
  const submissionAdmissionRef = useRef(createSingleFlightAdmission())
  const queuedFlushRef = useRef(false)
  const gitRequestRef = useRef(0)
  const worktreeRequestRef = useRef(0)
  const scheduleRequestRef = useRef(0)
  const demoTimerRef = useRef<number[]>([])
  const [activeProjectScriptRun, setActiveProjectScriptRun] = useState<ActiveProjectScriptRun>()
  const activeProjectScriptRunRef = useRef<ActiveProjectScriptRun | undefined>(undefined)
  const projectScriptStartingRef = useRef(false)
  activeProjectScriptRunRef.current = activeProjectScriptRun

  const reportError = useCallback((error: unknown) => {
    setToast(errorMessage(error))
  }, [])
  // The shell handlers answer with false instead of rejecting, so the refusal
  // reaches the user as a toast rather than disappearing into a dropped result.
  const openExternal = useCallback((url: string) => {
    if (!bridge) return
    void openExternalUrl(bridge.app, url).then((failure) => { if (failure) setToast(failure) })
  }, [bridge])
  const revealInFileManager = useCallback((path: string) => {
    if (!bridge) return
    void revealPath(bridge.app, path).then((failure) => { if (failure) setToast(failure) })
  }, [bridge])
  const appUpdates = useAppUpdates(bridge, reportError)
  useEffect(() => {
    window.localStorage.setItem('prime-work.cleared-session-attention', JSON.stringify(clearedAttention))
  }, [clearedAttention])
  useEffect(() => {
    window.localStorage.setItem('prime-work.cleared-activity', JSON.stringify(clearedActivity))
  }, [clearedActivity])
  const clearSessionAttention = useCallback((session: SessionRecord) => {
    const signature = sessionCompanionNotificationSignature(session)
    if (!signature) return
    setClearedAttention((current) => current[session.id] === signature ? current : { ...current, [session.id]: signature })
  }, [])
  const clearActivity = useCallback((activitySessions: SessionRecord[]) => {
    if (!activitySessions.length) return
    const ids = new Set(activitySessions.map((session) => session.id))
    setClearedActivity((current) => {
      const next = { ...current }
      for (const session of activitySessions) {
        const signature = activityNotificationSignature(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setClearedAttention((current) => {
      const next = { ...current }
      for (const session of activitySessions) {
        const signature = sessionCompanionNotificationSignature(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setSessions((items) => items.map((session) => ids.has(session.id) ? { ...session, unread: false } : session))
  }, [])
  const settingsState = useAppSettings({ bridge, reportError })
  const activeHarness = settingsState.settings.activeHarness
  const selectHarness = useCallback((harness: HarnessId) => {
    setVoiceOrbOpen(false)
    setFocusPetVoiceControl(false)
    setRestorePetVoiceFocus(false)
    void settingsState.updateSettings({ activeHarness: harness })
  }, [settingsState.updateSettings])
  const browserAnnotations = useBrowserAnnotations()
  const workspace = useWorkspaceRuntime({
    bridge, harness: activeHarness, initialProject, initialSession, sessions,
    initialMessages: bridge ? [] : SAMPLE_TRANSCRIPT, reportError,
  })
  const syncProviderRuntime = useCallback(async (runtimeId: string) => {
    if (!bridge) return
    const generation = workspace.workspaceRef.current.generation
    const next = (await bridge.agent.list()).find((candidate) => candidate.runtimeId === runtimeId)
    if (next && workspace.workspaceRef.current.generation === generation) workspace.attachRuntime(next, generation)
  }, [bridge, workspace.attachRuntime, workspace.workspaceRef])
  const rememberSelectedModel = useCallback((modelKey: string) => {
    void settingsState.updateSettings({
      lastSelectedModels: { ...settingsState.settings.lastSelectedModels, [activeHarness]: modelKey },
    })
  }, [activeHarness, settingsState.settings.lastSelectedModels, settingsState.updateSettings])
  const activeSession = useMemo(() => sessions.find((session) => session.id === workspace.activeSessionId), [sessions, workspace.activeSessionId])
  const provider = useProviderCatalog({
    bridge,
    ready: settingsState.initialized,
    harness: activeHarness,
    runtime: workspace.runtime,
    activeSession,
    lastSelectedModel: settingsState.settings.lastSelectedModels[activeHarness],
    rememberModel: rememberSelectedModel,
    syncRuntime: syncProviderRuntime,
    reportError,
  })
  const activeProject = useMemo(() => findProjectForSession(projects, activeSession)
    ?? projects.find((project) => project.id === workspace.activeProjectId)
    ?? projects[0], [projects, activeSession, workspace.activeProjectId])
  const activeCwd = workspaceCwd(activeProject, activeSession)
  const mentionableSessions = useMemo(() => sessions.filter((session) => !session.archived
    && session.depth === 0
    && session.id !== activeSession?.id
    && session.projectPath === activeCwd), [activeCwd, activeSession?.id, sessions])
  const terminalSessionKey = workspace.activeSessionId
    ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}`
    : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`
  const activeTerminalSessionPath = workspace.runtime?.sessionFile ?? activeSession?.filePath
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionMount[]>([])
  const [terminalDrawerRevision, setTerminalDrawerRevision] = useState(0)
  const activeTerminalSession = useMemo(() => terminalSessions.find((terminal) => terminal.workspaceKey === terminalSessionKey
    || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath)), [activeTerminalSessionPath, terminalSessionKey, terminalSessions])
  const terminalOpen = Boolean(activeTerminalSession)
  const git = gitStatusForWorkspace(gitSnapshot, activeCwd)
  useEffect(() => { setChangesCardDismissed(false) }, [activeCwd])
  useEffect(() => {
    if (!git.files.length || !settingsState.settings.showFileChangesPopup) setChangesCardDismissed(false)
  }, [git.files.length, settingsState.settings.showFileChangesPopup])
  const closeSmallestPanels = useCallback((patch: { sidebarOpen?: false; inspectorOpen?: false }) => {
    void settingsState.updateSettings(patch)
  }, [settingsState.updateSettings])
  const layout = usePanelLayout({
    sidebarOpen: settingsState.sidebarOpen,
    inspectorOpen: settingsState.inspectorOpen, setInspectorOpen: settingsState.setInspectorOpen,
    closeSmallestPanels,
    terminalOpen, view,
  })
  const sidebarVisible = settingsState.sidebarOpen && !layout.sidebarSuppressed
  const inspectorVisible = settingsState.inspectorOpen && !layout.inspectorSuppressed
  const extension = useExtensionUi({
    bridge, activeRuntimeId: workspace.runtime?.runtimeId, runtimeSessionsRef: workspace.runtimeSessionsRef,
    setSessions, setRuntime: workspace.setRuntime, reportError,
  })
  // Stable identity: the harness-switch reset lives inside the bootstrap
  // effect, and an unstable callback would re-run the whole bootstrap.
  // Shared views stay in place while their harness-scoped data refreshes.
  const onHarnessSwitch = useCallback(() => {
    setScheduleFocusId(null)
  }, [])
  const { meta, initialized, refreshHarnesses } = useBootstrap({
    bridge, ready: settingsState.initialized, harness: activeHarness, setProjects, setSessions, setSchedules, setScheduleError,
    runtimeSessionsRef: workspace.runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
    activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
    sessionHasOpenExtensionUi: extension.hasOpenRequestForSession, onHarnessSwitch, reportError,
  })
  const platform = meta?.platform ?? detectRendererPlatform()
  const detectedHarnesses = useMemo(
    () => meta ? HARNESS_IDS.filter((harness) => Boolean(meta.harnesses[harness].path)) : [],
    [meta],
  )
  const refreshDetectedHarnesses = useCallback(async () => {
    const result = await settingsState.reconcileExternalSettings(refreshHarnesses)
    if (!result) return
    if (result.settings.activeHarness === activeHarness && result.meta.harnesses[activeHarness].path) {
      await provider.refresh(true)
    }
  }, [activeHarness, provider.refresh, refreshHarnesses, settingsState.reconcileExternalSettings])
  useEffect(() => {
    if (detectedHarnesses.length) setNoHarnessPromptDismissed(false)
  }, [detectedHarnesses.length])
  useEffect(() => {
    if (view !== 'settings') {
      setSettingsSectionRequest((current) => current.section === 'general' ? current : { section: 'general', id: current.id + 1 })
    }
  }, [view])

  const refreshGit = useCallback(async () => {
    const requestId = ++gitRequestRef.current
    const cwd = activeCwd
    if (!bridge || !cwd) { setGitSnapshot({ cwd, status: { isRepo: false, files: [] } }); return }
    try {
      const next = await bridge.git.status(cwd)
      if (gitRequestRef.current === requestId && workspace.workspaceRef.current.cwd === cwd) setGitSnapshot({ cwd, status: next })
    } catch (error) { if (gitRequestRef.current === requestId && workspace.workspaceRef.current.cwd === cwd) reportError(error) }
  }, [activeCwd, bridge, reportError, workspace.workspaceRef])

  useAgentEvents({
    bridge, runtimeIdRef: workspace.runtimeIdRef, runtimeSessionsRef: workspace.runtimeSessionsRef,
    runtimeOwnerRef: workspace.runtimeOwnerRef, workspaceRef: workspace.workspaceRef,
    setSessions, setRuntime: workspace.setRuntime, reconcileQueuedPrompts: workspace.reconcileQueuedPrompts,
    clearQueuedPromptFlushFailures: workspace.clearQueuedPromptFlushFailures,
    clearQueuedPrompts: workspace.clearQueuedPrompts, queueAgentEvent: workspace.queueAgentEvent,
    reconcileTranscriptForEvent: workspace.reconcileTranscriptForEvent,
    showExtensionUi: extension.showExtensionUi, clearExtensionUi: extension.clearExtensionUi,
    refreshGit, refreshGitOnTerminalEvent: Boolean(activeCwd),
    activeSessionVisible: view === 'session',
  })

  useEffect(() => { void refreshGit(); return () => { gitRequestRef.current += 1 } }, [refreshGit])
  const refreshWorktrees = useCallback(async () => {
    const requestId = ++worktreeRequestRef.current
    const cwd = activeProject?.primaryFolder
    if (!bridge || !cwd || activeProject.inferred) { setWorktrees([]); setWorktreesLoading(false); return }
    setWorktreesLoading(true)
    try {
      const next = await bridge.projects.listWorktrees(cwd, activeProject.harness)
      if (worktreeRequestRef.current === requestId) setWorktrees(next)
    } catch (error) {
      if (worktreeRequestRef.current === requestId) { setWorktrees([]); reportError(error) }
    } finally {
      if (worktreeRequestRef.current === requestId) setWorktreesLoading(false)
    }
  }, [activeProject?.harness, activeProject?.inferred, activeProject?.primaryFolder, bridge, reportError])
  useEffect(() => { void refreshWorktrees(); return () => { worktreeRequestRef.current += 1 } }, [refreshWorktrees])
  const previousSessionStatusRef = useRef<SessionRecord['status'] | undefined>(undefined)
  const activeSessionStatus = activeSession?.status
  const locallyOwnedActiveSession = Boolean(activeSession && workspace.runtime?.sessionFile === activeSession.filePath)
  useEffect(() => {
    const previousStatus = previousSessionStatusRef.current
    previousSessionStatusRef.current = activeSessionStatus
    if (shouldRefreshGitOnSessionTransition(previousStatus, activeSessionStatus, locallyOwnedActiveSession)) void refreshGit()
  }, [activeSessionStatus, locallyOwnedActiveSession, refreshGit])
  const agentBrowser = useAgentBrowserTabs({ bridge, reportError })
  const terminalDrawerRefs = useRef(new Map<string, TerminalDrawerHandle>())
  const [terminalSelection, setTerminalSelection] = useState<TerminalSelectionContext>()
  const [agentPreviewSelected, setAgentPreviewSelected] = useState(true)
  const [agentSlotRect, setAgentSlotRect] = useState<AgentSlotRect | null>(null)
  const activeRuntimeSessionFile = workspace.runtime?.sessionFile
  const activeSessionFilePath = activeSession?.filePath
  const activeAgentTabs = useMemo(() => {
    const keys = new Set<string>()
    if (activeRuntimeSessionFile) keys.add(activeRuntimeSessionFile)
    if (activeSessionFilePath) keys.add(activeSessionFilePath)
    return agentBrowser.tabs.filter((tab) => keys.has(tab.sessionFile))
  }, [agentBrowser.tabs, activeRuntimeSessionFile, activeSessionFilePath])
  const activeAgentTabId = activeAgentTabs.find((tab) => tab.active)?.tabId ?? activeAgentTabs[0]?.tabId ?? null
  // Every agent browser action in the active thread surfaces the Browser
  // panel: open the inspector, select the Browser tab, and show the tab being
  // driven (the user's Preview or an agent tab), whatever was showing before.
  useEffect(() => {
    const activity = agentBrowser.activityEvent
    if (!activity) return
    if (activity.sessionFile !== activeRuntimeSessionFile && activity.sessionFile !== activeSessionFilePath) return
    setAgentPreviewSelected(activity.tabId === 'preview')
    settingsState.setInspectorOpen(true)
    settingsState.selectInspectorTab('browser')
  }, [agentBrowser.activityEvent, activeRuntimeSessionFile, activeSessionFilePath, settingsState.setInspectorOpen, settingsState.selectInspectorTab])
  useEffect(() => { if (!activeAgentTabs.length) setAgentPreviewSelected(true) }, [activeAgentTabs.length])
  const agentTabVisible = view === 'session' && settingsState.inspectorOpen && settingsState.inspectorTab === 'browser' && !agentPreviewSelected && activeAgentTabId !== null
  const pluginScope = activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
  const pluginSkills = usePluginSkills({ bridge, harness: activeHarness, scope: pluginScope, generation: workspace.workspaceGeneration, initialSkills: bridge ? [] : SAMPLE_SKILLS, reportError })
  useEffect(() => () => { demoTimerRef.current.forEach(window.clearTimeout) }, [])

  const refreshSchedules = useCallback(async () => {
    if (!bridge) return
    const requestId = ++scheduleRequestRef.current
    try {
      const next = await bridge.schedules.list(activeHarness)
      if (scheduleRequestRef.current === requestId) { setSchedules(next); setScheduleError('') }
    } catch (error) {
      if (scheduleRequestRef.current === requestId) setScheduleError(errorMessage(error))
      reportError(error)
    }
  }, [activeHarness, bridge, reportError])
  useEffect(() => {
    if (!bridge) return
    return bridge.schedules.onChanged(() => { void refreshSchedules() })
  }, [bridge, refreshSchedules])
  const refreshHeartbeats = useCallback(async () => {
    if (!bridge) return
    try { setHeartbeats(await bridge.heartbeats.list()) } catch (error) { reportError(error) }
  }, [bridge, reportError])
  useEffect(() => {
    if (!bridge) return
    void refreshHeartbeats()
    // Prime Agent emits this event for both /heartbeat and rlm_heartbeat
    // mutations. The 30s poll remains a recovery path for jobs created by a
    // resident daemon outside this renderer, but normal changes are immediate.
    const unsubscribe = bridge.agent.onEvent(({ event }) => {
      if (event.type === 'heartbeats_changed') void refreshHeartbeats()
    })
    const interval = window.setInterval(() => { void refreshHeartbeats() }, 30_000)
    return () => { unsubscribe(); window.clearInterval(interval) }
  }, [bridge, refreshHeartbeats])
  const patchProjectScripts = useCallback((projectId: string, scripts: NonNullable<ProjectRecord['scripts']>) => {
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, scripts } : project))
  }, [])
  const finishProjectScriptRun = useCallback((run: ActiveProjectScriptRun, outcome: ProjectScriptRunOutcome) => {
    if (activeProjectScriptRunRef.current?.requestId !== run.requestId) return
    activeProjectScriptRunRef.current = undefined
    setActiveProjectScriptRun(undefined)
    if ('cancelled' in outcome) return
    const message = outcome.exitCode === 0 ? `${run.kind === 'setup' ? 'Setup' : 'Run'} completed.` : `${run.kind === 'setup' ? 'Setup' : 'Run'} exited with code ${outcome.exitCode}.`
    if (run.kind === 'setup' && bridge) {
      void bridge.projects.finishSetup(run.projectId, run.command, outcome.exitCode, run.harness)
        .then((scripts) => {
          if (!scripts) return
          patchProjectScripts(run.projectId, scripts)
          setToast(message)
        })
        .catch(reportError)
      return
    }
    setToast(message)
  }, [bridge, patchProjectScripts, reportError])

  const {
    toggleSidebar, toggleInspector, grantProject,
    selectProject, selectSession, newSession, navigate, renameSession, setSessionArchived,
    addProject, removeProject, togglePinProject, setProjectSortMode, sendPrompt, stopRuntime, installSkill, installExtension, setMcpSupport, connectMcp, setMcpEnabled, mutateCapability,
    createSchedule, updateSchedule, mutateSchedule, manageHeartbeat, openScheduledSession,
    openBrowser, openChanges,
  } = useWorkspaceActions({
    bridge, initialized, projects, sessions, activeProject,
    workspace, settingsState, layout, provider, pluginSkills,
    submissionAdmissionRef, gitRequestRef, demoTimerRef,
    setProjects, setSessions, setGitSnapshot, setView, setPaletteOpen, setToast, setSubmitting,
    refreshSchedules, refreshHeartbeats,
    resetBrowserView: () => setBrowserGeneration((value) => value + 1),
    closeTerminalForSession: (sessionPath) => {
      const removed = terminalSessions.find((terminal) => terminal.sessionPath === sessionPath)
      const projectRun = activeProjectScriptRunRef.current
      if (removed && projectRun?.drawerId === removed.id) finishProjectScriptRun(projectRun, { cancelled: true })
      setTerminalSessions((current) => current.filter((terminal) => terminal.sessionPath !== sessionPath))
    },
    clearSessionAttention, reportError,
  })
  const openTerminalLink = useCallback((url: string, external: boolean) => {
    if (external) {
      openExternal(url)
      return
    }
    setAgentPreviewSelected(true)
    setBrowserNavigationRequest((current) => ({ id: (current?.id ?? 0) + 1, url }))
    openBrowser()
  }, [openBrowser, openExternal])
  const handleBrowserNavigationRequest = useCallback((id: number) => {
    setBrowserNavigationRequest((current) => current?.id === id ? undefined : current)
  }, [])
  useEffect(() => {
    const onOpenSettings = bridge?.app.onOpenSettings
    if (!onOpenSettings) return
    return onOpenSettings(() => {
      setSettingsSectionRequest((current) => ({ section: 'general', id: current.id + 1 }))
      navigate('settings')
    })
  }, [bridge, navigate])
  const handleVoiceTaskStarted = useCallback(async (task: VoiceTaskStarted) => {
    if (!bridge) return
    const projectCatalog = task.harness === activeHarness ? projects : await bridge.projects.list(task.harness)
    const project = projectCatalog.find((candidate) => candidate.id === task.projectId && candidate.harness === task.harness)
    if (!project) {
      const error = new Error('The voice task started, but its project is no longer available.')
      reportError(error)
      throw error
    }
    try {
      const [runtime, sessionResolution] = await Promise.all([
        bridge.agent.list().then((items) => items.find((candidate) => candidate.runtimeId === task.runtimeId)),
        waitForVoiceSession(task.sessionFile, task.sessionId, (force) => bridge.sessions.list(project.primaryFolder, true, task.harness, force)),
      ])
      if (!sessionResolution) throw new Error('The voice task started, but its saved session did not appear in the project catalog.')
      const { session, sessions: sessionCatalog } = sessionResolution
      if (task.harness !== activeHarness) await settingsState.updateSettings({ activeHarness: task.harness })
      setProjects(projectCatalog)
      setSessions(sessionCatalog)
      workspace.activateWorkspace(project, session, runtime)
      setView('session')
      setPaletteOpen(false)
      setToast(`Started “${session.title}” in ${project.name} with ${HARNESS_SHORT_NAMES[task.harness]}.`)
    } catch (error) { reportError(error); throw error }
  }, [activeHarness, bridge, projects, reportError, settingsState.updateSettings, workspace.activateWorkspace])
  const addOrReplaceProject = useCallback((project: ProjectRecord) => {
    setProjects((current) => {
      const absorbed = new Set([project.path, project.primaryFolder, ...project.folders])
      const kept = current.filter((item) => item.id === project.id || !absorbed.has(item.path) && !absorbed.has(item.primaryFolder))
      const existing = kept.findIndex((item) => item.id === project.id)
      if (existing < 0) return [...kept, project]
      return kept.map((item, index) => index === existing ? project : item)
    })
  }, [])
  const openWorktree = useCallback(async (worktree: GitWorktree) => {
    if (!bridge || !activeProject?.primaryFolder) return
    try {
      const project = await bridge.projects.openWorktree(activeProject.primaryFolder, worktree.path, activeProject.harness)
      addOrReplaceProject(project)
      newSession(project)
    } catch (error) { reportError(error); throw error }
  }, [activeProject, addOrReplaceProject, bridge, newSession, reportError])
  const createWorktree = useCallback(async (branch: string) => {
    if (!bridge || !activeProject?.primaryFolder) return
    try {
      const project = await bridge.projects.createWorktree(activeProject.primaryFolder, branch, activeProject.harness)
      if (!project) return
      addOrReplaceProject(project)
      newSession(project)
    } catch (error) { reportError(error); throw error }
  }, [activeProject, addOrReplaceProject, bridge, newSession, reportError])

  const closeTerminal = useCallback((id: string) => {
    const projectRun = activeProjectScriptRunRef.current
    if (projectRun?.drawerId === id) finishProjectScriptRun(projectRun, { cancelled: true })
    terminalDrawerRefs.current.delete(id)
    setTerminalSessions((current) => current.filter((terminal) => terminal.id !== id))
    if (activeTerminalSession?.id === id) setTerminalSelection(undefined)
  }, [activeTerminalSession?.id, finishProjectScriptRun])
  const toggleTerminal = useCallback(async () => {
    if (activeTerminalSession) {
      closeTerminal(activeTerminalSession.id)
      return
    }
    if (!activeProject || !activeCwd) return
    if (activeProject.inferred) {
      try { await grantProject(activeProject) } catch (error) { reportError(error); return }
    }
    setTerminalSessions((current) => {
      const existing = current.find((terminal) => terminal.workspaceKey === terminalSessionKey
        || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath))
      if (existing) return current
      return [...current, { id: crypto.randomUUID(), workspaceKey: terminalSessionKey, cwd: activeCwd, sessionPath: activeTerminalSessionPath }]
    })
  }, [activeCwd, activeProject, activeTerminalSession, activeTerminalSessionPath, closeTerminal, grantProject, reportError, terminalSessionKey])
  useEffect(() => {
    settingsState.setTerminalOpen(terminalOpen)
  }, [settingsState.setTerminalOpen, terminalOpen])
  useEffect(() => {
    if (!activeTerminalSession) { setTerminalSelection(undefined); return }
    setTerminalSessions((current) => current.map((terminal) => {
      if (terminal.id !== activeTerminalSession.id) return terminal
      const sessionPath = activeTerminalSessionPath ?? terminal.sessionPath
      if (terminal.cwd === activeCwd && terminal.sessionPath === sessionPath) return terminal
      return { ...terminal, cwd: activeCwd, sessionPath }
    }))
    setTerminalSelection(terminalDrawerRefs.current.get(activeTerminalSession.id)?.readSelectionContext())
  }, [activeCwd, activeTerminalSession?.id, activeTerminalSessionPath])
  // Stable identities keep the memoized Inspector and Composer from
  // re-rendering at streaming-frame rate; useStableCallback always dispatches
  // to the latest render's closures.
  const inspectorAutomations = useMemo(
    () => activeSession ? schedules.filter((task) => task.harness === activeHarness && task.target.kind === 'session' && task.target.sessionId === activeSession.id) : [],
    [activeHarness, activeSession, schedules],
  )
  const inspectorHeartbeats = useMemo(
    () => activeHarness === 'prime' && activeSession ? heartbeats.filter((heartbeat) => heartbeat.sessionId === activeSession.id || heartbeat.sessionFile === activeSession.filePath) : [],
    [activeHarness, activeSession, heartbeats],
  )
  const openAutomation = useCallback((id: string) => {
    setScheduleFocusId(id)
    setView('scheduled')
  }, [])
  const selectAgentTab = useStableCallback((tabId: string) => { setAgentPreviewSelected(false); agentBrowser.select(tabId) })
  const showBrowserPreview = useCallback(() => setAgentPreviewSelected(true), [])
  const previewContext = useStableCallback((webContentsId: number | null, sessionFile: string | null) => {
    if (bridge) void bridge.browser.setPreviewContext(webContentsId, sessionFile).catch(() => undefined)
  })
  const navigateAgentTab = useStableCallback((tabId: string, action: 'back' | 'forward' | 'reload') => {
    if (bridge) void bridge.browser.navigateTab(tabId, action).catch(reportError)
  })
  const grantActiveProject = useStableCallback(() => activeProject ? grantProject(activeProject).then(() => undefined).catch(reportError) : undefined)
  const getTerminalContext = useStableCallback(() => activeTerminalSession ? terminalDrawerRefs.current.get(activeTerminalSession.id)?.readSelectionContext() : undefined)
  const removeQueuedMessage = useStableCallback((message: QueuedPrompt) => workspace.removeQueuedPrompt(message.id))
  const clearTerminalSelection = useStableCallback(() => {
    if (activeTerminalSession) terminalDrawerRefs.current.get(activeTerminalSession.id)?.clearSelection()
  })
  const startProjectScript = useCallback(async (kind: ProjectScriptKind) => {
    if (!bridge || !activeProject || !activeCwd) throw new Error('Project scripts are available in the desktop app for an active project.')
    if (activeProjectScriptRunRef.current || projectScriptStartingRef.current) throw new ProjectScriptBusyError()
    projectScriptStartingRef.current = true
    try {
      const project = activeProject.inferred ? await grantProject(activeProject) : activeProject
      const command = project.scripts?.[kind]?.trim() ?? ''
      if (!command) throw new Error(`Configure a ${kind} command first.`)
      if (kind === 'setup') {
        const scripts = await bridge.projects.markSetupStarted(project.id, command, project.harness)
        patchProjectScripts(project.id, scripts)
      }
      const run: ActiveProjectScriptRun = { requestId: crypto.randomUUID(), projectId: project.id, harness: project.harness, kind, command, ownsDrawer: false }
      const existing = terminalSessions.find((terminal) => terminal.workspaceKey === terminalSessionKey
        || Boolean(activeTerminalSessionPath && terminal.sessionPath === activeTerminalSessionPath))
      if (existing) {
        const pending = { ...run, drawerId: existing.id, ownsDrawer: false }
        activeProjectScriptRunRef.current = pending
        setActiveProjectScriptRun(pending)
      } else {
        const drawerId = crypto.randomUUID()
        const tabId = crypto.randomUUID()
        const started = { ...run, drawerId, tabId, ownsDrawer: true }
        activeProjectScriptRunRef.current = started
        setActiveProjectScriptRun(started)
        setTerminalSessions((current) => [...current, {
          id: drawerId,
          workspaceKey: terminalSessionKey,
          cwd: activeCwd,
          sessionPath: activeTerminalSessionPath,
          initialCommand: {
            id: tabId,
            command,
            label: kind === 'setup' ? 'Setup' : 'Run',
            onExit: (exitCode) => finishProjectScriptRun(started, exitCode === undefined ? { cancelled: true } : { exitCode }),
          },
        }])
      }
    } finally {
      projectScriptStartingRef.current = false
    }
  }, [activeCwd, activeProject, activeTerminalSessionPath, bridge, finishProjectScriptRun, grantProject, patchProjectScripts, terminalSessionKey, terminalSessions])
  const saveProjectScripts = useCallback(async (scripts: { setup: string; run: string }) => {
    if (!bridge || !activeProject) throw new Error('Select a project first.')
    const project = activeProject.inferred ? await grantProject(activeProject) : activeProject
    const updated = await bridge.projects.updateScripts(project.id, scripts, project.harness)
    patchProjectScripts(project.id, updated)
  }, [activeProject, bridge, grantProject, patchProjectScripts])
  const stopProjectScript = useCallback(() => {
    const run = activeProjectScriptRunRef.current
    if (!run) return
    finishProjectScriptRun(run, { cancelled: true })
    if (!run.drawerId || !run.tabId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (drawer) drawer.stopCommand(run.tabId)
    else setTerminalSessions((current) => current.filter((terminal) => terminal.id !== run.drawerId))
  }, [finishProjectScriptRun])
  useEffect(() => {
    if (view === 'session') return
    const run = activeProjectScriptRunRef.current
    if (!run) return
    finishProjectScriptRun(run, { cancelled: true })
    if (!run.drawerId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (!run.ownsDrawer && drawer && run.tabId) drawer.stopCommand(run.tabId)
    if (run.ownsDrawer) setTerminalSessions((current) => current.filter((terminal) => terminal.id !== run.drawerId))
  }, [finishProjectScriptRun, view])
  useEffect(() => {
    const run = activeProjectScriptRun
    if (!run || run.tabId || !run.drawerId) return
    const drawer = terminalDrawerRefs.current.get(run.drawerId)
    if (!drawer) return
    try {
      const tabId = drawer.runCommand(run.command, run.kind === 'setup' ? 'Setup' : 'Run', (exitCode) => finishProjectScriptRun(run, exitCode === undefined ? { cancelled: true } : { exitCode }))
      const started = { ...run, tabId }
      activeProjectScriptRunRef.current = started
      setActiveProjectScriptRun(started)
    } catch (error) {
      finishProjectScriptRun(run, { cancelled: true })
      reportError(error)
    }
  }, [activeProjectScriptRun, finishProjectScriptRun, reportError, terminalDrawerRevision])
  useEffect(() => {
    const scripts = activeProject?.scripts
    if (!activeProject || !scripts || !setupNeedsRun(scripts) || activeProjectScriptRunRef.current) return
    void startProjectScript('setup').catch((error: unknown) => {
      if (!(error instanceof ProjectScriptBusyError)) reportError(error)
    })
  }, [activeProject?.id, activeProject?.scripts, activeProjectScriptRun, reportError, startProjectScript])
  const sidebarActions = useSidebarActions({
    onSelectProject: selectProject,
    onSelectSession: selectSession,
    onNavigate: navigate,
    onNewSession: newSession,
    onAddProject: () => { void addProject() },
    onRemoveProject: (project) => { void removeProject(project) },
    onSetProjectSortMode: setProjectSortMode,
    onTogglePinProject: (project) => { void togglePinProject(project) },
    onClose: toggleSidebar,
    onOpenPalette: () => setPaletteOpen(true),
    onRenameSession: renameSession,
    onArchiveSession: (session) => setSessionArchived(session, true),
  })

  const onAppKeyDown = useStableCallback(createAppKeydownHandler({
    'open-palette': () => setPaletteOpen(true),
    'new-session': () => newSession(),
    'open-browser': () => openBrowser(),
    'toggle-sidebar': () => toggleSidebar(),
    'toggle-terminal': () => { void toggleTerminal() },
    'open-settings': () => navigate('settings'),
    'close-palette': () => setPaletteOpen(false),
    'close-settings': () => navigate('session'),
  }, document, view === 'settings'))

  useEffect(() => {
    window.addEventListener('keydown', onAppKeyDown)
    return () => window.removeEventListener('keydown', onAppKeyDown)
  }, [onAppKeyDown])

  const harnessQueuedMessageCount = activeHarness === 'omp'
    ? workspace.runtime?.sessionActions?.queuedCount ?? 0
    : 0
  const busy = Boolean(
    workspace.runtime?.isStreaming
    || workspace.runtime?.isCompacting
    || harnessQueuedMessageCount > 0
    || workspace.messages.some((message) => message.streaming),
  )
  const externalSessionRunning = Boolean(activeSession?.status === 'running' && workspace.runtime?.sessionFile !== activeSession.filePath)
  const queuedMessages = useMemo<QueuedPrompt[]>(
    () => workspace.pendingQueuedPrompts.filter((pending) => pending.intent === 'queue'),
    [workspace.pendingQueuedPrompts],
  )
  const toggleVoice = useCallback(() => {
    const nextOpen = !voiceOrbOpen
    setFocusPetVoiceControl(nextOpen)
    setRestorePetVoiceFocus(false)
    setVoiceOrbOpen(nextOpen)
  }, [voiceOrbOpen])
  useEffect(() => {
    if (!bridge || busy || externalSessionRunning || submitting || queuedFlushRef.current || queuedMessages.length === 0) return
    const next = queuedMessages[0]
    if (next.flushAttemptFailed) return
    queuedFlushRef.current = true
    void sendPrompt(next.text, [], 'queue', next.id)
      .finally(() => { queuedFlushRef.current = false })
  }, [bridge, busy, externalSessionRunning, queuedMessages, sendPrompt, submitting])

  const page = view === 'projects' ? <ProjectsPage projects={projects} sortMode={settingsState.settings.projectSortMode} onAdd={() => void addProject()} onOpen={selectProject} onRemove={(project) => void removeProject(project)} onTogglePin={(project) => void togglePinProject(project)} />
    : view === 'activity' ? <ActivityPage sessions={sessions} projects={projects} clearedActivity={clearedActivity} onOpen={selectSession} onClear={clearActivity} />
    : view === 'scheduled' ? <ScheduledPage harness={activeHarness} schedules={schedules} nativeHeartbeats={activeHarness === 'prime' ? heartbeats : []} projects={projects} sessions={sessions} models={provider.catalog?.models ?? EMPTY_MODELS} lastSelectedModel={provider.model} error={scheduleError} initialProjectId={activeProject?.id} initialSessionId={activeSession?.id} selectedScheduleId={scheduleFocusId} onCreate={createSchedule} onUpdate={updateSchedule} onPause={(id: string) => mutateSchedule(() => bridge!.schedules.pause(id))} onResume={(id: string) => mutateSchedule(() => bridge!.schedules.resume(id))} onDelete={(id: string) => mutateSchedule(() => bridge!.schedules.delete(id))} onRunNow={(id: string) => mutateSchedule(() => bridge!.schedules.runNow(id))} onPreview={async (timing: ScheduleTiming) => bridge ? bridge.schedules.preview(timing, 3) : { timing, occurrences: [] }} onOpenSession={openScheduledSession} onManageHeartbeat={manageHeartbeat} />
    : view === 'plugins' ? <PluginsPage harness={activeHarness} skills={pluginSkills.skills} warnings={pluginSkills.warnings} loading={pluginSkills.loading} activeProjectPath={activeProject?.primaryFolder} askUserEnabled={settingsState.settings.askUserEnabled} onSetAskUserEnabled={(enabled) => settingsState.updateSettings({ askUserEnabled: enabled })} browserEnabled={settingsState.settings.browserEnabled} onSetBrowserEnabled={(enabled) => settingsState.updateSettings({ browserEnabled: enabled })} computerUseEnabled={settingsState.settings.computerUseEnabled} onSetComputerUseEnabled={(enabled) => settingsState.updateSettings({ computerUseEnabled: enabled })} onOpenExternal={openExternal} onRefresh={pluginSkills.refresh} onInstall={installSkill} onInstallExtension={installExtension} onSetMcpSupport={setMcpSupport} onConnectMcp={connectMcp} onSetMcpEnabled={setMcpEnabled} onMutateCapability={mutateCapability} />
    : view === 'settings' ? <SettingsPage initialSection={settingsSectionRequest.section} initialSectionRequestId={settingsSectionRequest.id} settings={settingsState.settings} meta={meta} providerCatalog={provider.catalog} voice={bridge?.voice ?? null} pets={bridge?.pets ?? null} onClose={() => navigate('session')} onUpdate={settingsState.updateSettings} onRefreshHarnesses={refreshDetectedHarnesses} onRefreshProviders={() => provider.refresh(true)} onSaveProviderApiKey={provider.saveApiKey} onLogoutProvider={provider.logout} onSetProviderEnabled={provider.setEnabled} onSetAllProvidersEnabled={provider.setAllEnabled} onSetAllProvidersDisabled={provider.setAllDisabled} onSetModelEnabled={provider.setModelEnabled} onStartProviderOAuth={provider.startOAuth} onResetBrowser={async () => {
        if (!bridge) throw new Error('Browser data can only be cleared in the desktop app.')
        if (!await bridge.settings.resetBrowserData()) { const error = new Error('GooeyPi could not clear all browser data. Close active downloads and try again.'); reportError(error); throw error }
        setBrowserGeneration((value) => value + 1)
      }} onOpenDocs={() => openExternal(HARNESS_PROVIDER_DOCS[activeHarness])} /> : null

  return <I18nProvider preference={settingsState.settings.locale}><div className="app-shell" aria-busy={!initialized} data-platform={platform} data-ready={initialized ? 'true' : 'false'}>
    {sidebarVisible && initialized ? <Sidebar projects={projects} sessions={sessions} clearedAttention={clearedAttention} activeProjectId={activeProject?.id} activeSessionId={workspace.activeSessionId} activeView={view} activeHarness={activeHarness} harnesses={meta?.harnesses ?? null} updateState={appUpdates.state} onUpdateAction={appUpdates.act} onSelectHarness={selectHarness} projectSortMode={settingsState.settings.projectSortMode} {...sidebarActions} overlay={layout.compactLayout} platform={platform} /> : null}
    {sidebarVisible && initialized ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label="Close sidebar" onClick={toggleSidebar} /> : null}
    <div className="workbench" inert={layout.compactLayout && sidebarVisible ? true : undefined}>
      <TitleToolbar project={view === 'session' ? activeProject : undefined} gitBranch={git.branch} view={view} productName={HARNESS_PRODUCT_NAMES[activeHarness]} sidebarOpen={sidebarVisible} inspectorOpen={inspectorVisible} terminalOpen={terminalOpen} voiceOpen={voiceOrbOpen} activeProjectScriptKind={activeProjectScriptKind(activeProjectScriptRun, activeProject?.id)} onRunProjectScript={startProjectScript} onStopProjectScript={stopProjectScript} onSaveProjectScripts={saveProjectScripts} onToggleSidebar={toggleSidebar} onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onToggleVoice={toggleVoice} onOpenBrowser={openBrowser} platform={platform} />
      <div className="workbench__content">{view === 'session' ? <div ref={layout.workspaceRowRef} className="session-workspace" style={{ '--inspector-width': `${layout.inspectorWidth}px`, '--terminal-height': `${layout.terminalHeight}px` } as CSSProperties}>
        <div ref={layout.sessionWorkspaceRef} className="conversation-column">
          <main className="conversation-pane">
            <Suspense fallback={<LoadingPanel label="conversation" />}><Transcript key={workspace.activeSessionId ?? 'new-session'} messages={workspace.messages} git={git} harness={activeHarness} loading={workspace.loadingSession} active={busy || activeSession?.status === 'running'} showReasoning={settingsState.settings.showReasoningSummaries} showTools={settingsState.settings.showToolCalls} onOpenChanges={openChanges} onSuggestion={(prompt) => { void sendPrompt(prompt).catch(() => undefined) }} suggestionsDisabled={!activeProject || workspace.loadingSession || submitting} showPinnedChanges={false} bottomDockHasChanges={Boolean(git.files.length && settingsState.settings.showFileChangesPopup && !changesCardDismissed)} queuedMessageCount={queuedMessages.length + harnessQueuedMessageCount} onOpenSessionReference={(sessionId, harness) => { const session = sessions.find((candidate) => candidate.id === sessionId && candidate.harness === harness && !candidate.archived && candidate.depth === 0); if (session) void selectSession(session); else setToast('That referenced session is archived or no longer available.') }} /></Suspense>
            <div className="conversation-bottom-dock">
              {git.files.length && settingsState.settings.showFileChangesPopup && !changesCardDismissed ? <ChangesCard git={git} onOpenChanges={openChanges} onClose={() => setChangesCardDismissed(true)} /> : null}
              <Composer key={workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`} draftKey={workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new`} busy={busy} submitting={submitting} loading={workspace.loadingSession} disabled={!activeProject} messageEnterAction={settingsState.settings.messageEnterAction} voice={bridge?.voice} transcriptionProvider={settingsState.settings.voiceTranscriptionProvider} model={provider.model} effort={provider.effort} modelsByProvider={provider.modelsByProvider} providers={provider.catalog?.providers ?? EMPTY_PROVIDERS} reasoningLevels={provider.reasoningLevels} fast={provider.fast} fastSupported={provider.selectedModel?.fastModeSupported ?? false} fastAvailable={workspace.runtime?.fastModeAvailable !== false} worktrees={worktrees} activeWorktreePath={activeProject?.primaryFolder} checkoutLabel={git.branch ?? activeProject?.gitBranch ?? activeProject?.name} worktreesLoading={worktreesLoading} onOpenWorktree={bridge && activeProject && !activeProject.inferred && worktrees.length > 0 ? openWorktree : undefined} onCreateWorktree={bridge && activeProject && !activeProject.inferred && worktrees.length > 0 ? createWorktree : undefined} agentName={HARNESS_AGENT_NAMES[activeHarness]} shortName={HARNESS_SHORT_NAMES[activeHarness]} harness={activeHarness} imageInputSupported={Boolean(provider.selectedModel?.input.includes('image'))} contextUsage={workspace.runtime?.contextUsage} sessionUsage={workspace.runtime?.sessionUsage} skills={pluginSkills.skills} sessions={mentionableSessions} annotations={browserAnnotations.annotations} terminalSelection={terminalSelection} getTerminalContext={getTerminalContext} queuedMessages={queuedMessages} harnessQueuedMessageCount={harnessQueuedMessageCount} onDeleteQueuedMessage={removeQueuedMessage} onEditQueuedMessage={removeQueuedMessage} sendSignal={browserAnnotations.sendSignal} onModelChange={provider.changeModel} onEffortChange={provider.changeEffort} onFastChange={provider.changeFast} onSend={sendPrompt} onStop={stopRuntime} onRemoveAnnotation={browserAnnotations.remove} onClearAnnotations={browserAnnotations.clear} onClearTerminalSelection={clearTerminalSelection} />
            </div>
          </main>
          {terminalSessions.map((terminal) => <Suspense key={terminal.id} fallback={terminal.id === activeTerminalSession?.id ? <TerminalLoadingPanel /> : null}><TerminalDrawer ref={(handle) => { if (handle) terminalDrawerRefs.current.set(terminal.id, handle); else terminalDrawerRefs.current.delete(terminal.id) }} visible={terminal.id === activeTerminalSession?.id} cwd={terminal.cwd} sessionPath={terminal.sessionPath} shell={settingsState.settings.terminalShell} initialCommand={terminal.initialCommand} height={layout.terminalHeight} minHeight={TERMINAL_MIN} maxHeight={layout.terminalMax} defaultHeight={TERMINAL_DEFAULT} onHeightChange={layout.setTerminalHeight} onClose={() => closeTerminal(terminal.id)} onError={reportError} onInitialCommandConsumed={() => setTerminalSessions((current) => current.map((item) => item.id === terminal.id ? { ...item, initialCommand: undefined } : item))} onOpenLink={openTerminalLink} onReady={() => setTerminalDrawerRevision((revision) => revision + 1)} onSelectionChange={(selection) => { if (terminal.id === activeTerminalSession?.id) setTerminalSelection(selection) }} /></Suspense>)}
        </div>
          {inspectorVisible ? <ResizeHandle orientation="vertical" label="Resize inspector" value={layout.inspectorWidth} min={INSPECTOR_MIN} max={layout.inspectorMax} defaultValue={INSPECTOR_DEFAULT} onChange={layout.setInspectorWidth} /> : null}
          {inspectorVisible ? <Suspense fallback={<LoadingPanel label="inspector" />}><Inspector key={`inspector-${browserGeneration}`} activeTab={settingsState.inspectorTab} onTabChange={settingsState.selectInspectorTab} onClose={toggleInspector} agentName={HARNESS_AGENT_NAMES[activeHarness]} shortName={HARNESS_SHORT_NAMES[activeHarness]} project={activeProject} cwd={activeCwd} runtime={workspace.runtime} messages={settingsState.inspectorTab === 'summary' ? workspace.messages : EMPTY_MESSAGES} git={git} automations={inspectorAutomations} heartbeats={inspectorHeartbeats} onOpenAutomation={openAutomation} browserHome={settingsState.settings.browserHome} browserNavigationRequest={browserNavigationRequest} onBrowserNavigationRequestHandled={handleBrowserNavigationRequest} browserAnnotations={browserAnnotations} agentBrowserTabs={activeAgentTabs} activeAgentTabId={activeAgentTabId} agentPreviewSelected={agentPreviewSelected} onSelectAgentTab={selectAgentTab} onCloseAgentTab={agentBrowser.close} onShowBrowserPreview={showBrowserPreview} onAgentSlotRect={setAgentSlotRect} agentSessionKey={activeRuntimeSessionFile ?? activeSessionFilePath} onPreviewContext={previewContext} previewPointerEvent={agentBrowser.pointerEvent?.tabId === 'preview' ? agentBrowser.pointerEvent : null} onNavigateAgentTab={navigateAgentTab} onRefreshGit={refreshGit} onOpenExternal={openExternal} onRevealPath={revealInFileManager} onGrantProject={grantActiveProject} overlay={layout.compactLayout} platform={platform} /></Suspense> : null}
          {inspectorVisible ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label="Close inspector" onClick={toggleInspector} /> : null}
      </div> : <Suspense fallback={<LoadingPanel label={view} />}>{page}</Suspense>}</div>
    </div>
    {voiceOrbOpen && bridge ? <Suspense fallback={null}><VoiceOrb voice={bridge.voice} harness={activeHarness} onClose={() => { setFocusPetVoiceControl(false); setVoiceOrbOpen(false); setRestorePetVoiceFocus(settingsState.settings.petEnabled) }} onTaskStarted={handleVoiceTaskStarted} pet={{ pets: bridge.pets, petId: settingsState.settings.petId, petSize: settingsState.settings.petSize, agentBusy: busy, reduceMotion: settingsState.settings.reduceMotion }} focusPetControl={focusPetVoiceControl} onPetControlFocused={() => setFocusPetVoiceControl(false)} /></Suspense> : null}
    {settingsState.settings.petEnabled && bridge && !voiceOrbOpen ? <Suspense fallback={null}><DesktopPet pets={bridge.pets} petId={settingsState.settings.petId} petSize={settingsState.settings.petSize} agentBusy={busy} voiceActive={false} reduceMotion={settingsState.settings.reduceMotion} focusVoiceControl={restorePetVoiceFocus} onVoiceControlFocused={() => setRestorePetVoiceFocus(false)} onDismiss={() => { setRestorePetVoiceFocus(false); void settingsState.updateSettings({ petEnabled: false }) }} onOpenVoice={() => { setRestorePetVoiceFocus(false); setFocusPetVoiceControl(true); setVoiceOrbOpen(true) }} /></Suspense> : null}
    {paletteOpen ? <Suspense fallback={null}><CommandPalette open onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewSession={newSession} onToggleSidebar={toggleSidebar} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} platform={platform} /></Suspense> : null}
    {extension.extensionUi ? <Suspense fallback={<LoadingPanel label="request" />}><ExtensionUiModal request={extension.extensionUi.request} onRespond={(response) => void extension.respondToExtensionUi(response)} platform={platform} /></Suspense> : null}
    {provider.authEvent ? <Suspense fallback={<LoadingPanel label="provider login" />}><ProviderAuthModal event={provider.authEvent} onOpen={openExternal} onRespond={provider.respondOAuth} onCancel={provider.cancelOAuth} /></Suspense> : null}
    {meta && !detectedHarnesses.length && !noHarnessPromptDismissed ? (
      <NoHarnessPrompt
        onClose={() => setNoHarnessPromptDismissed(true)}
        onOpenHarnessSettings={() => {
          setNoHarnessPromptDismissed(true)
          setSettingsSectionRequest((current) => ({ section: 'agent', id: current.id + 1 }))
          setView('settings')
        }}
      />
    ) : null}
    {toast ? <div className="toast" role="status">{toast}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div> : null}
    {bridge ? <AgentBrowserLayer tabs={agentBrowser.tabs} visibleTabId={agentTabVisible ? activeAgentTabId : null} rect={agentTabVisible ? agentSlotRect : null} pointerEvent={agentBrowser.pointerEvent} onAttach={agentBrowser.attach} /> : null}
  </div></I18nProvider>
}
