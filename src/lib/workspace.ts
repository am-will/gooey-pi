import type { GitStatus, ProjectRecord, RuntimeInfo, SessionRecord } from '@/types/api'


export interface OwnedGitStatus {
  cwd?: string
  status: GitStatus
}

/** Stable identity for "no git status", so memoized consumers of the result keep their memo across renders. */
export const EMPTY_GIT_STATUS: GitStatus = Object.freeze({ isRepo: false, files: [] })

export function gitStatusForWorkspace(snapshot: OwnedGitStatus, cwd?: string): GitStatus {
  return cwd && snapshot.cwd === cwd ? snapshot.status : EMPTY_GIT_STATUS
}

export interface WorkspaceSelection {
  project?: ProjectRecord
  session?: SessionRecord
  runtime?: RuntimeInfo
  cwd?: string
}

export interface SingleFlightAdmission {
  readonly active: boolean
  run(task: () => Promise<void> | void): Promise<boolean>
}

export function projectContainsPath(project: ProjectRecord, path?: string): boolean {
  return Boolean(path && (project.path === path || project.folders.includes(path)))
}

export function findProjectForSession(projects: ProjectRecord[], session?: SessionRecord): ProjectRecord | undefined {
  return session ? projects.find((project) => projectContainsPath(project, session.projectPath)) : undefined
}

export function workspaceCwd(project?: ProjectRecord, session?: SessionRecord): string | undefined {
  if (!project) return undefined
  return session && projectContainsPath(project, session.projectPath) ? session.projectPath : project.primaryFolder
}

export function newSessionProject(
  requestedProject?: ProjectRecord,
  workspaceProject?: ProjectRecord,
  displayedProject?: ProjectRecord,
): ProjectRecord | undefined {
  return requestedProject ?? workspaceProject ?? displayedProject
}

/**
 * Git status refreshes on turn boundaries, never on per-append catalog ticks:
 * an externally running session triggers one refresh when it stops running.
 * Locally owned runtimes already refresh through their own agent_end events.
 */
export function shouldRefreshGitOnSessionTransition(
  previousStatus: SessionRecord['status'] | undefined,
  status: SessionRecord['status'] | undefined,
  locallyOwned: boolean,
): boolean {
  return !locallyOwned && previousStatus === 'running' && status !== undefined && status !== 'running'
}

export function runtimeMatchesWorkspace(runtime: RuntimeInfo, cwd: string, sessionFile: string): boolean {
  return runtime.cwd === cwd && runtime.sessionFile === sessionFile
}

export function findRuntimeForWorkspace(runtimes: RuntimeInfo[], cwd?: string, sessionFile?: string): RuntimeInfo | undefined {
  if (!cwd || !sessionFile) return undefined
  return runtimes.find((runtime) => runtimeMatchesWorkspace(runtime, cwd, sessionFile))
}

export function selectStartupWorkspace(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  runtimes: RuntimeInfo[],
): WorkspaceSelection {
  const session = sessions.find((candidate) => !candidate.archived && Boolean(findProjectForSession(projects, candidate)))
  const project = findProjectForSession(projects, session) ?? projects[0]
  const cwd = workspaceCwd(project, session)
  const runtime = findRuntimeForWorkspace(runtimes, cwd, session?.filePath)
  return { project, session, runtime, cwd }
}

export function createSingleFlightAdmission(): SingleFlightAdmission {
  let active = false
  return {
    get active() { return active },
    async run(task) {
      if (active) return false
      active = true
      try {
        await task()
        return true
      } finally {
        active = false
      }
    },
  }
}
