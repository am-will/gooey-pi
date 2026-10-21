import { formattingLocaleTag, translate } from '@/lib/i18n'
import type { ProjectScripts } from '@/types/api'

export class ProjectScriptBusyError extends Error {
  constructor() {
    // The message reaches the user twice over: `ProjectRunControl` prints it in
    // its inline error, and the App shell reports it as a toast. A plain module
    // cannot read the React context, so the app-wide locale mirror supplies the
    // language at the moment the error is constructed.
    super(translate(formattingLocaleTag(), 'error.projectScriptBusy'))
    this.name = 'ProjectScriptBusyError'
  }
}

export function activeProjectScriptKind<T extends string>(run: { projectId: string; kind: T } | undefined, projectId?: string): T | undefined {
  return run && run.projectId === projectId ? run.kind : undefined
}

export function setupNeedsRun(scripts?: ProjectScripts): boolean {
  if (!scripts?.setup.trim()) return false
  return scripts.setupLastRun !== scripts.setup
}
