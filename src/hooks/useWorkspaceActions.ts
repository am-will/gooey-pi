import { useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { requestFailureMessage } from '@/app/workspace'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { parseSessionActionSnapshot } from '@/lib/session-actions'
import type { DEFAULT_SETTINGS } from '@/lib/data'
import { type createSingleFlightAdmission, findProjectForSession, findRuntimeForWorkspace, newSessionProject, projectContainsPath, workspaceCwd } from '@/lib/workspace'
import type { CapabilityMutationInput, ExtensionInstallInput, GitStatus, McpConnectionInput, McpStateInput, PrimeWorkApi, ProjectRecord, PromptDeliveryIntent, PromptImage, ScheduleInput, SchedulePatch, SessionRecord, TranscriptMessage, WorkspaceView } from '@/types/api'
import type { useAppSettings } from '@/hooks/useAppSettings'
import type { usePanelLayout } from '@/hooks/usePanelLayout'
import type { usePluginSkills } from '@/hooks/usePluginSkills'
import type { useProviderCatalog } from '@/hooks/useProviderCatalog'
import type { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import { mergeSessionCatalog } from '@/hooks/useBootstrap'

export interface WorkspaceActionsDeps {
  bridge: PrimeWorkApi | null
  initialized: boolean
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProject: ProjectRecord | undefined
  workspace: ReturnType<typeof useWorkspaceRuntime>
  settingsState: ReturnType<typeof useAppSettings>
  layout: ReturnType<typeof usePanelLayout>
  provider: ReturnType<typeof useProviderCatalog>
  pluginSkills: ReturnType<typeof usePluginSkills>
  submissionAdmissionRef: MutableRefObject<ReturnType<typeof createSingleFlightAdmission>>
  gitRequestRef: MutableRefObject<number>
  demoTimerRef: MutableRefObject<number[]>
  setProjects: Dispatch<SetStateAction<ProjectRecord[]>>
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>
  setGitSnapshot: Dispatch<SetStateAction<{ cwd: string | undefined; status: GitStatus }>>
  setView: Dispatch<SetStateAction<WorkspaceView>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setToast: Dispatch<SetStateAction<string | null>>
  setSubmitting: Dispatch<SetStateAction<boolean>>
  refreshSchedules(): Promise<void>
  refreshHeartbeats(): Promise<void>
  resetBrowserView(): void
  closeTerminalForSession(sessionPath: string): void
  clearSessionAttention(session: SessionRecord): void
  reportError(error: unknown): void
}

export type PrimeMcpCommand = { type: 'open' } | { type: 'login'; server: string }

interface StartedSessionIndexInput {
  bridge: PrimeWorkApi
  harness: ProjectRecord['harness']
  sessionFile: string | undefined
  setSessions: Dispatch<SetStateAction<SessionRecord[]>>
  fallbackTitle?: string
  isCurrent?(): boolean
}

export async function indexStartedSession({ bridge, harness, sessionFile, setSessions, fallbackTitle, isCurrent }: StartedSessionIndexInput): Promise<SessionRecord | undefined> {
  if (!sessionFile) return
  // Runtime creation and filesystem watch delivery are separate async paths.
  // Make the created file part of the renderer catalog before prompt admission
  // continues, so navigating away cannot expose a watch-timing visibility gap.
  const catalog = await bridge.sessions.list(undefined, true, harness, true)
  const indexedSession = catalog.find((session) => session.filePath === sessionFile)
  if (isCurrent && !isCurrent()) return indexedSession
  setSessions((current) => mergeSessionCatalog(current, catalog, sessionFile, new Map(), 0).map((session) => (
    fallbackTitle && session.filePath === sessionFile && session.title === 'Untitled session'
      ? { ...session, title: fallbackTitle }
      : session
  )))
  return indexedSession
}

export function sessionTitleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine
}

interface StartedSessionTitleInput extends StartedSessionIndexInput {
  runtimeId: string
  prompt: string
}

export async function titleStartedSession({ bridge, harness, runtimeId, sessionFile, prompt, setSessions, isCurrent }: StartedSessionTitleInput): Promise<void> {
  if (!sessionFile) return
  const title = sessionTitleFromPrompt(prompt)
  if (!title) return

  // Prompt admission is the first point where this is a real user task. Show
  // its prompt-derived title immediately, then persist it through the harness.
  // Both persistence and the forced read are best-effort because a delivered
  // prompt must never be reported as failed solely due to title bookkeeping.
  if (!isCurrent || isCurrent()) {
    setSessions((current) => current.map((session) => session.filePath === sessionFile && session.title === 'Untitled session'
      ? { ...session, title }
      : session))
  }
  await bridge.agent.command(runtimeId, { type: 'set_session_name', name: title }).catch(() => undefined)
  await indexStartedSession({ bridge, harness, sessionFile, setSessions, fallbackTitle: title, isCurrent }).catch(() => undefined)
}

export function parsePrimeMcpCommand(prompt: string): PrimeMcpCommand | undefined {
  const value = prompt.trim()
  if (value === '/mcp') return { type: 'open' }
  const match = /^\/mcp\s+login\s+([A-Za-z0-9][A-Za-z0-9._ -]{0,63})\s*$/.exec(value)
  if (!match || ['__proto__', 'prototype', 'constructor'].includes(match[1])) return undefined
  return { type: 'login', server: match[1] }
}

/**
 * The workspace mutation handlers, extracted from App. Every callback has a
 * stable identity (created once) and dispatches against the latest render's
 * dependencies, mirroring useStableCallback/useSidebarActions semantics.
 */
export function createWorkspaceActions(getDeps: () => WorkspaceActionsDeps) {
  const grantProject = async (project: ProjectRecord): Promise<ProjectRecord> => {
    const { bridge, workspace, setProjects, gitRequestRef, setGitSnapshot } = getDeps()
    if (!bridge || !project.inferred) return project
    const granted = await bridge.projects.grantInferred(project.primaryFolder, project.harness)
    setProjects((items) => items.map((item) => item.id === project.id ? granted : item))
    const selected = workspace.workspaceRef.current
    if (selected.project?.id !== project.id) return granted
    workspace.workspaceRef.current = { ...selected, project: granted, cwd: workspaceCwd(granted, selected.session) }
    const requestId = ++gitRequestRef.current
    const cwd = workspaceCwd(granted, selected.session)
    if (!cwd) return granted
    const nextGit = await bridge.git.status(cwd)
    if (gitRequestRef.current === requestId && workspace.workspaceRef.current.generation === selected.generation && workspace.workspaceRef.current.cwd === cwd) setGitSnapshot({ cwd, status: nextGit })
    return granted
  }
  const persistPanel = (patch: Partial<typeof DEFAULT_SETTINGS>) => { void getDeps().settingsState.updateSettings(patch) }
  const toggleSidebar = () => {
    const { settingsState, layout } = getDeps()
    const next = !(settingsState.sidebarOpen && !layout.sidebarSuppressed)
    layout.setSmallestSidebarAllowed(next)
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.inspectorOpen) {
      layout.setSmallestInspectorAllowed(false)
      settingsState.setInspectorOpen(false)
    }
    persistPanel({ sidebarOpen: next })
  }
  const toggleInspector = () => {
    const { settingsState, layout } = getDeps()
    const next = !(settingsState.inspectorOpen && !layout.inspectorSuppressed)
    layout.setSmallestInspectorAllowed(next)
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.sidebarOpen) {
      layout.setSmallestSidebarAllowed(false)
      settingsState.setSidebarOpen(false)
    }
    persistPanel({ inspectorOpen: next })
  }
  const toggleTerminal = async () => {
    const { settingsState, activeProject, reportError } = getDeps()
    if (!settingsState.terminalOpen && activeProject?.inferred) {
      try { await grantProject(activeProject) } catch (error) { reportError(error); return }
    }
    persistPanel({ terminalOpen: !settingsState.terminalOpen })
  }
  const selectProject = async (project: ProjectRecord) => {
    const { bridge, layout, settingsState, sessions, workspace, setSessions, setView, clearSessionAttention, reportError } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    const session = sessions.find((candidate) => !candidate.archived && projectContainsPath(project, candidate.projectPath))
    if (session) {
      clearSessionAttention(session)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try {
      // Inferred projects come from the harness's global session history and
      // remain display-only until the user performs an action that needs a
      // filesystem grant (starting work or opening a terminal).
      if (bridge && !project.inferred) await bridge.projects.touch(project.id, project.harness)
      await workspace.reconcileRuntime(generation)
    } catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const selectSession = async (session: SessionRecord) => {
    const { layout, settingsState, projects, workspace, setSessions, setView, clearSessionAttention, reportError } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    clearSessionAttention(session)
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    const project = findProjectForSession(projects, session)
    if (!project) { reportError('This session is not contained by an available project.'); return }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try { await workspace.reconcileRuntime(generation) }
    catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const newSession = (requestedProject?: ProjectRecord) => {
    const { bridge, initialized, layout, settingsState, activeProject, workspace, setView, setPaletteOpen } = getDeps()
    if (!initialized) return
    const project = newSessionProject(requestedProject, workspace.workspaceRef.current.project, activeProject)
    if (!project) return
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    workspace.activateWorkspace(project)
    if (!bridge) workspace.setMessages([])
    setView('session'); setPaletteOpen(false)
  }
  const navigate = (nextView: WorkspaceView) => {
    const { layout, settingsState, setView, setPaletteOpen } = getDeps()
    if (layout.compactLayout) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    setView(nextView); setPaletteOpen(false)
  }
  const renameSession = async (session: SessionRecord, title: string) => {
    const { bridge, settingsState, setSessions, setToast, reportError } = getDeps()
    if (!bridge) return
    try {
      if (!await bridge.sessions.rename(session.filePath, title)) throw new Error(`${HARNESS_AGENT_NAMES[settingsState.settings.activeHarness]} could not rename this session.`)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, title } : item)); setToast('Session renamed.')
    } catch (error) { reportError(error) }
  }
  const setSessionArchived = async (session: SessionRecord, archived: boolean) => {
    const { bridge, workspace, setSessions, setToast, resetBrowserView, closeTerminalForSession, clearSessionAttention, reportError } = getDeps()
    if (!bridge) return
    try {
      await bridge.sessions.archive(session.filePath, archived)
      if (archived) {
        clearSessionAttention(session)
        closeTerminalForSession(session.filePath)
      }
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, archived, unread: archived ? false : item.unread } : item))
      if (archived && workspace.workspaceRef.current.session?.id === session.id) {
        resetBrowserView()
        newSession()
      }
      setToast(archived ? 'Session archived.' : 'Session restored.')
    } catch (error) { reportError(error) }
  }
  const addProject = async () => {
    const { bridge, workspace, setProjects, setView, setToast, settingsState, reportError } = getDeps()
    if (!bridge) { setToast('Project picker is available in the desktop app.'); return }
    try {
      const project = await bridge.projects.add(settingsState.settings.activeHarness)
      if (project) { setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)]); workspace.activateWorkspace(project); setView('session') }
    } catch (error) { reportError(error) }
  }
  const removeProject = async (project: ProjectRecord) => {
    const { bridge, projects, sessions, workspace, setProjects, setToast, reportError } = getDeps()
    try {
      if (bridge && !await bridge.projects.remove(project.id, project.harness)) throw new Error('This project could not be removed.')
      setProjects((items) => items.filter((item) => item.id !== project.id))
      if (workspace.workspaceRef.current.project?.id === project.id) {
        const fallback = projects.find((item) => item.id !== project.id)
        const session = fallback ? sessions.find((candidate) => !candidate.archived && projectContainsPath(fallback, candidate.projectPath)) : undefined
        workspace.activateWorkspace(fallback, session)
      }
      setToast('Project removed. Files and saved sessions were kept.')
    } catch (error) { reportError(error) }
  }

  const sendPrompt = async (prompt: string, images: PromptImage[] = [], intent: PromptDeliveryIntent = 'queue') => {
    const { bridge, sessions, workspace, provider, settingsState, submissionAdmissionRef, demoTimerRef, setSessions, setSubmitting, setView, setToast, reportError } = getDeps()
    const mcpCommand = images.length === 0 && settingsState.settings.activeHarness === 'prime' ? parsePrimeMcpCommand(prompt) : undefined
    if (mcpCommand?.type === 'open') {
      setView('plugins')
      setToast('Manage MCP integrations in Capabilities.')
      return
    }
    if (mcpCommand?.type === 'login') {
      try {
        await provider.startMcpOAuth(mcpCommand.server)
        setToast(`Opening ${mcpCommand.server} sign-in…`)
      } catch (error) {
        reportError(error)
        throw error
      }
      return
    }
    const currentWorkspace = workspace.workspaceRef.current
    const currentRuntime = workspace.runtime
    const currentOwner = workspace.runtimeOwnerRef.current
    const ownsStreamingRuntime = Boolean(
      bridge && currentRuntime && (currentRuntime.isStreaming || submissionAdmissionRef.current.active)
      && workspace.runtimeIdRef.current === currentRuntime.runtimeId
      && currentOwner?.runtimeId === currentRuntime.runtimeId
      && currentOwner.generation === currentWorkspace.generation,
    )
    if (ownsStreamingRuntime && currentRuntime && bridge) {
      if (intent === 'queue' && images.length === 0) {
        workspace.queuePrompt(prompt, intent)
        return
      }
      if (intent === 'steer') {
        const sentAt = Date.now()
        const pendingSteerId = workspace.queuePrompt(prompt, intent, [{ type: 'text', text: prompt }, ...images], sentAt)
        if (currentWorkspace.sessionFile) {
          const sentAtIso = new Date(sentAt).toISOString()
          setSessions((items) => items.map((session) => session.filePath === currentWorkspace.sessionFile ? { ...session, lastUserMessageAt: sentAtIso } : session))
        }
        try {
          const response = await bridge.agent.command(currentRuntime.runtimeId, { type: 'steer', message: prompt, ...(images.length ? { images } : {}) })
          workspace.acceptSteer(pendingSteerId)
          const actions = parseSessionActionSnapshot(response.sessionActions)
          if (actions) workspace.acknowledgeSteer(pendingSteerId, actions)
          return
        } catch (error) {
          workspace.removeQueuedPrompt(pendingSteerId)
          if (workspace.workspaceRef.current.generation === currentWorkspace.generation) {
            // Keep a durable failure row: a toast alone is easy to miss, and a
            // silently vanishing steer reads as "sent but ignored".
            workspace.setMessages((items) => [
              ...items,
              { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Steer was not delivered: ${requestFailureMessage(error)} Your draft was restored.` }] },
            ])
          }
          reportError(error)
          throw error
        }
      }
    }
    const admittedSubmission = await submissionAdmissionRef.current.run(async () => {
      setSubmitting(true)
      const admitted = workspace.workspaceRef.current
      const generation = admitted.generation
      let startedPrompt = false
      let queuedPromptId: string | undefined
      const followUpExternalSession = async (sessionFile: string): Promise<boolean> => {
        if (!bridge) return false
        // The daemon owns the message once accepted; queuing it locally as
        // well would deliver it a second time via the idle flush.
        return bridge.sessions.followUp(sessionFile, prompt, intent)
      }
      try {
        if (!admitted.project || !admitted.cwd) { reportError('Add a project before starting a session.'); return }
        // The harness comes from the workspace's own project, never global
        // settings: a prompt landing between a harness switch and the
        // bootstrap effect's workspace reset would otherwise start the new
        // harness against the old workspace's cwd and session.
        const activeHarness = admitted.project.harness
        if (images.length > 0 && provider.model !== 'auto' && !provider.selectedModel?.input.includes('image')) {
          reportError('This model does not accept images. Remove the attachment or choose a vision model.')
          return
        }
        if (!workspace.prepareForPrompt(generation)) return
        const sentAt = Date.now()
        const sentAtIso = new Date(sentAt).toISOString()
        const userMessage: TranscriptMessage = { id: `user-${sentAt}`, role: 'user', timestamp: sentAt, parts: [{ type: 'text', text: prompt }, ...images] }
        let userMessageAppended = false
        const appendUserMessage = () => {
          if (userMessageAppended) return
          // The workspace may have switched while a command was in flight;
          // an optimistic append would land in the wrong transcript.
          if (workspace.workspaceRef.current.generation !== generation) return
          userMessageAppended = true
          workspace.setMessages((items) => [...items, userMessage])
          if (admitted.sessionFile) setSessions((items) => items.map((session) => session.filePath === admitted.sessionFile ? { ...session, lastUserMessageAt: sentAtIso } : session))
        }
        if (!bridge) {
          appendUserMessage()
          const assistantId = `assistant-${Date.now()}`
          workspace.setMessages((items) => [...items, { id: assistantId, role: 'assistant', timestamp: Date.now(), startedAt: Date.now(), streaming: true, parts: [{ type: 'thinking', text: 'Reviewing the request and current workspace context.' }] }])
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, parts: [...item.parts, { type: 'toolCall', id: 'demo-tool', name: 'Inspect project', args: { cwd: admitted.cwd } }] } : item)), 450))
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, streaming: false, completedAt: Date.now(), parts: [...item.parts, { type: 'toolResult', name: 'Inspect project', text: 'Project context loaded' }, { type: 'text', text: 'I’ve reviewed the project context and prepared the workspace. Connect the desktop bridge to run this request with Prime Agent.' }] } : item)), 1_250))
          return
        }
        await grantProject(admitted.project)
        if (workspace.workspaceRef.current.generation !== generation) return
        const selected = workspace.workspaceRef.current
        if (!selected.cwd) throw new Error('The selected workspace has no working directory.')
        const liveRuntimes = (await bridge.agent.list()).filter((candidate) => candidate.harness === activeHarness)
        if (workspace.workspaceRef.current.generation !== generation) return
        const owner = workspace.runtimeOwnerRef.current
        const tracked = workspace.runtimeIdRef.current ? liveRuntimes.find((item) => item.runtimeId === workspace.runtimeIdRef.current) : undefined
        const belongsHere = Boolean(tracked && owner?.runtimeId === tracked.runtimeId && owner.generation === generation && tracked.cwd === selected.cwd && (!selected.sessionFile || tracked.sessionFile === selected.sessionFile))
        let activeRuntime = belongsHere ? tracked : findRuntimeForWorkspace(liveRuntimes, selected.cwd, selected.sessionFile)
        const selectedSession = selected.sessionFile ? sessions.find((session) => session.filePath === selected.sessionFile) : undefined
        if (intent === 'queue' && images.length === 0 && (activeRuntime?.isStreaming || selectedSession?.status === 'running')) {
          queuedPromptId = workspace.queuePrompt(prompt, intent)
          return
        }
        let startedRuntime = false
        let startedSessionNeedsTitle = false
        if (!activeRuntime) {
          workspace.attachRuntime(undefined, generation)
          if (images.length > 0 && selected.sessionFile && selectedSession?.status === 'running') {
            throw new Error('Image attachments cannot be queued while this session is active outside GooeyPi. Wait for it to finish, then try again.')
          }
          if (images.length === 0 && selected.sessionFile && selectedSession?.status === 'running'
            && await followUpExternalSession(selected.sessionFile)) {
            if (intent === 'steer') appendUserMessage()
            return
          }
          try {
            activeRuntime = await bridge.agent.start({ cwd: selected.cwd, sessionPath: selected.sessionFile, model: provider.model === 'auto' ? undefined : provider.model, thinking: provider.effort, fast: provider.fast, harness: activeHarness })
          } catch (startError) {
            if (images.length === 0 && selected.sessionFile && await followUpExternalSession(selected.sessionFile)) {
              if (intent === 'steer') appendUserMessage()
              return
            }
            throw startError
          }
          startedRuntime = true
          if (workspace.workspaceRef.current.generation !== generation) { await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false); return }
          const indexedSession = await indexStartedSession({
            bridge,
            harness: activeHarness,
            sessionFile: activeRuntime.sessionFile,
            setSessions,
            isCurrent: () => workspace.workspaceRef.current.generation === generation,
          })
          if (workspace.workspaceRef.current.generation !== generation) {
            await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
            return
          }
          startedSessionNeedsTitle = !indexedSession || indexedSession.title === 'Untitled session'
        }
        if (activeRuntime.cwd !== selected.cwd || (selected.sessionFile && activeRuntime.sessionFile !== selected.sessionFile)) {
          if (startedRuntime) await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
          throw new Error(`${HARNESS_AGENT_NAMES[activeHarness]} returned a runtime for a different workspace or session.`)
        }
        workspace.attachRuntime(activeRuntime, generation)
        if (activeRuntime.isStreaming) {
          // Follow-ups are daemon-owned. Steers get a renderer-only pending
          // row so pickup can move them into history without redelivery.
          if (intent === 'steer') queuedPromptId = workspace.queuePrompt(prompt, intent, userMessage.parts, sentAt)
          const response = await bridge.agent.command(activeRuntime.runtimeId, { type: intent === 'steer' ? 'steer' : 'follow_up', message: prompt, ...(images.length ? { images } : {}) })
          if (intent === 'steer' && queuedPromptId) {
            workspace.acceptSteer(queuedPromptId)
            const actions = parseSessionActionSnapshot(response.sessionActions)
            if (actions) workspace.acknowledgeSteer(queuedPromptId, actions)
          }
        } else {
          startedPrompt = true
          appendUserMessage()
          workspace.setRuntime({ ...activeRuntime, isStreaming: true })
          workspace.setMessages((items) => [...items, { id: `assistant-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] }])
          await bridge.agent.command(activeRuntime.runtimeId, { type: 'prompt', message: prompt, ...(images.length ? { images } : {}) })
          if (startedRuntime && startedSessionNeedsTitle) {
            void titleStartedSession({
              bridge,
              harness: activeHarness,
              runtimeId: activeRuntime.runtimeId,
              sessionFile: activeRuntime.sessionFile,
              prompt,
              setSessions,
              isCurrent: () => workspace.workspaceRef.current.generation === generation,
            })
          }
        }
      } catch (error) {
        if (queuedPromptId) workspace.removeQueuedPrompt(queuedPromptId)
        if (workspace.workspaceRef.current.generation !== generation) return
        const failure = requestFailureMessage(error)
        if (startedPrompt) workspace.setRuntime((current) => current ? { ...current, isStreaming: false } : current)
        workspace.setMessages((items) => {
          const finalized = startedPrompt
            ? items.flatMap((item) => item.streaming && item.role === 'assistant' && item.parts.length === 0 ? [] : [{ ...item, streaming: false }])
            : items
          return finalized.at(-1)?.role === 'system' ? finalized : [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: failure }] }]
        })
        throw error
      } finally { setSubmitting(false) }
    })
    if (!admittedSubmission) {
      const error = new Error('Another message is still being admitted. Try steering again.')
      reportError(error)
      throw error
    }
  }
  const stopRuntime = async () => {
    const { bridge, workspace, reportError } = getDeps()
    const stoppedRuntime = workspace.runtime
    if (!stoppedRuntime) return
    if (!bridge) { workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); workspace.setRuntime(null); return }
    const stoppedRuntimeId = stoppedRuntime.runtimeId
    const stoppedGeneration = workspace.workspaceRef.current.generation
    const stoppedOwner = workspace.runtimeOwnerRef.current
    const stoppedOwnerRuntimeId = stoppedOwner?.runtimeId
    const stoppedOwnerGeneration = stoppedOwner?.generation
    try {
      await bridge.agent.command(stoppedRuntimeId, { type: 'abort' })
      const currentOwner = workspace.runtimeOwnerRef.current
      if (
        workspace.workspaceRef.current.generation !== stoppedGeneration
        || workspace.runtimeIdRef.current !== stoppedRuntimeId
        || stoppedOwnerRuntimeId !== stoppedRuntimeId
        || stoppedOwnerGeneration !== stoppedGeneration
        || currentOwner?.runtimeId !== stoppedOwnerRuntimeId
        || currentOwner?.generation !== stoppedOwnerGeneration
      ) return
      workspace.setRuntime((current) => current?.runtimeId === stoppedRuntimeId ? { ...current, isStreaming: false } : current)
      workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item))
    } catch (error) { reportError(error) }
  }

  const installSkill = async (source: string) => {
    const { bridge, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Package installation is available in the desktop app.' }
    try { return await bridge.plugins.install(source, settingsState.settings.activeHarness) } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const installExtension = async (input: ExtensionInstallInput) => {
    const { activeProject, bridge, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Extension installation is available in the desktop app.' }
    try {
      let installation = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before adding a project extension.' }
        const project = await grantProject(activeProject)
        installation = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.installExtension(installation, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const setMcpSupport = async (enabled: boolean) => {
    const { bridge, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'MCP support can only be changed in the desktop app.' }
    try {
      const response = await bridge.plugins.setMcpSupport(enabled, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const connectMcp = async (input: McpConnectionInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'MCP connections are available in the desktop app.' }
    try {
      let connection = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before adding a project MCP server.' }
        const project = await grantProject(activeProject); connection = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.connectMcp(connection, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const setMcpEnabled = async (input: McpStateInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'MCP connections are available in the desktop app.' }
    try {
      let update = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before changing a project MCP server.' }
        const project = await grantProject(activeProject); update = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.setMcpEnabled(update, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const mutateCapability = async (input: CapabilityMutationInput) => {
    const { bridge, activeProject, pluginSkills, reportError, settingsState } = getDeps()
    if (!bridge) return { ok: false as const, reason: 'blocked' as const, output: 'Capabilities can only be changed in the desktop app.' }
    try {
      let update = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false as const, reason: 'blocked' as const, output: 'Open a project before changing a project capability.' }
        const project = await grantProject(activeProject); update = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.mutateCapability(update, settingsState.settings.activeHarness)
      if (response.ok) await pluginSkills.refresh()
      return response
    } catch (error) { reportError(error); return { ok: false, output: errorMessage(error) } }
  }
  const createSchedule = async (input: ScheduleInput) => {
    const { bridge, refreshSchedules, reportError, settingsState } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await bridge.schedules.create(input, settingsState.settings.activeHarness); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const updateSchedule = async (id: string, patch: SchedulePatch) => {
    const { bridge, refreshSchedules, reportError } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await bridge.schedules.update(id, patch); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const mutateSchedule = async (operation: () => Promise<unknown>) => {
    const { bridge, refreshSchedules, reportError } = getDeps()
    if (!bridge) throw new Error('Scheduled tasks are available in the desktop app.')
    try { await operation(); await refreshSchedules() } catch (error) { reportError(error); throw error }
  }
  const manageHeartbeat = async (id: string, action: 'pause' | 'resume' | 'stop') => {
    const { bridge, refreshHeartbeats, reportError } = getDeps()
    if (!bridge) throw new Error('Heartbeats are available in the desktop app.')
    try { await bridge.heartbeats.manage(id, action); await refreshHeartbeats() } catch (error) { reportError(error); throw error }
  }
  const openScheduledSession = (sessionFile: string) => {
    const { bridge, sessions, settingsState, setSessions, reportError } = getDeps()
    const known = sessions.find((session) => session.filePath === sessionFile)
    if (known) { void selectSession(known); return }
    if (!bridge) return
    void bridge.sessions.list(undefined, true, settingsState.settings.activeHarness).then((catalog) => {
      setSessions(catalog)
      const found = catalog.find((session) => session.filePath === sessionFile)
      if (found) void selectSession(found)
    }).catch(reportError)
  }
  const openBrowser = () => {
    const { layout, settingsState, setView } = getDeps()
    if (layout.compactLayout && settingsState.sidebarOpen) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    setView('session')
    settingsState.selectInspectorTab('browser')
    if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true })
  }
  const openChanges = () => {
    const { layout, settingsState } = getDeps()
    if (layout.compactLayout && settingsState.sidebarOpen) { layout.setSmallestSidebarAllowed(false); settingsState.setSidebarOpen(false) }
    settingsState.selectInspectorTab('changes')
    if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true })
  }

  return {
    grantProject, persistPanel, toggleSidebar, toggleInspector, toggleTerminal,
    selectProject, selectSession, newSession, navigate, renameSession, setSessionArchived,
    addProject, removeProject, sendPrompt, stopRuntime, installSkill, installExtension, setMcpSupport, connectMcp, setMcpEnabled, mutateCapability,
    createSchedule, updateSchedule, mutateSchedule, manageHeartbeat, openScheduledSession,
    openBrowser, openChanges,
  }
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>

/** Memoized workspace mutation handlers: one stable object for the app's lifetime. */
export function useWorkspaceActions(deps: WorkspaceActionsDeps): WorkspaceActions {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [actions] = useState(() => createWorkspaceActions(() => depsRef.current))
  return actions
}
