import type { AutomationScheduleRecord, SessionRecord } from '@/types/api'

/** Older run revisions do not retain their delivery target, so only the current one proves a new chat was created. */
export function archivableScheduleSessions(schedule: AutomationScheduleRecord, sessions: SessionRecord[]): SessionRecord[] {
  if (schedule.target.kind !== 'project') return []
  const files = new Set(schedule.runs.filter((run) => run.status === 'succeeded' && run.taskRevision === schedule.revision).map((run) => run.sessionFile))
  return sessions.filter((session) => session.harness === schedule.harness && files.has(session.filePath)
    && !session.archived && session.depth === 0 && session.status !== 'running' && session.status !== 'waiting')
}
