import type { SessionStatus, TranscriptMessage } from './api'

/** Child IDs and cursors are opaque, scoped to the authorized parent and renderer. */
export interface ChildSession {
  id: string
  parentId?: string
  title: string
  status: SessionStatus
  task?: string
  updatedAt: string
}
export type ChildRoster = { supported: true; children: ChildSession[]; truncated: boolean }
  | { supported: false; reason: string }
export interface ChildHistoryOptions { cursor?: string; direction?: 'older' | 'newer' }
export interface ChildHistoryPage {
  messages: TranscriptMessage[]
  olderCursor?: string
  newerCursor: string
  reset: boolean
  truncated: boolean
}
