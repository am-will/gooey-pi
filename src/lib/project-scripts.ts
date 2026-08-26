import type { ProjectScripts } from '@/types/api'

export class ProjectScriptBusyError extends Error {
  constructor() {
    super('Another project script is already starting or running.')
    this.name = 'ProjectScriptBusyError'
  }
}

export function setupNeedsRun(scripts?: ProjectScripts): boolean {
  if (!scripts?.setup.trim()) return false
  return scripts.setupLastRun !== scripts.setup || scripts.setupLastExitCode === undefined
}
