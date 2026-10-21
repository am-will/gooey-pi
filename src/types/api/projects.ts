import type { HarnessId } from './harness'
export interface ProjectScripts {
  setup: string
  run: string
  /** Exact setup command most recently started for this project. */
  setupLastRun?: string
  /** Missing while the latest setup command is running or was interrupted. */
  setupLastExitCode?: number
}
export interface ProjectRecord {
  id: string
  /** Agent harness this project grant belongs to; grants never cross harnesses. */
  harness: HarnessId
  name: string
  path: string
  folders: string[]
  primaryFolder: string
  pinned: boolean
  createdAt: string
  lastOpenedAt: string
  sessionCount: number
  gitBranch?: string
  inferred?: boolean
  readOnly?: boolean
  scripts?: ProjectScripts
}
export interface ProjectFileEntry { path: string; type: 'file' | 'directory' }
export interface ProjectFileListing { entries: ProjectFileEntry[]; skipped: number; truncated: boolean }
export const PROJECT_FILE_LISTING_LIMIT = 25_000
