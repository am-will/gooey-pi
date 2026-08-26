import type { ProjectScripts } from '@/types/api'

export class ProjectScriptBusyError extends Error {
  constructor() {
    super('Another project script is already starting or running.')
    this.name = 'ProjectScriptBusyError'
  }
}

export function activeProjectScriptKind<T extends string>(run: { projectId: string; kind: T } | undefined, projectId?: string): T | undefined {
  return run && run.projectId === projectId ? run.kind : undefined
}

export function setupNeedsRun(scripts?: ProjectScripts): boolean {
  if (!scripts?.setup.trim()) return false
  return scripts.setupLastRun !== scripts.setup || scripts.setupLastExitCode === undefined
}
