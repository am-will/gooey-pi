import { errorMessage } from '@/lib/errors'
import type { ProjectRecord, SessionRecord } from '@/types/api'

export interface WorkspaceSnapshot {
  generation: number
  project?: ProjectRecord
  session?: SessionRecord
  cwd?: string
  sessionFile?: string
}

// This helper runs outside React (it is also used from the App shell, which sits
// above the i18n provider), so it resolves its copy through the locale mirror.
// The harness detail stays verbatim; only the framing sentence is translated.
export const requestFailureMessage = (error: unknown) => {
  const raw = errorMessage(error)
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  return detail ? `Request failed: ${detail.slice(0, 1_000)}` : 'The agent could not process the request.'
}
