import type { ProjectRecord, SessionRecord } from '../../../src/types/api'
import type { PersistedProject } from '../store'

interface SessionProjectStats {
  count: number
  earliestCreatedAt: string
  latestUpdatedAt: string
}

export function aggregateSessionProjectStats(
  sessions: readonly SessionRecord[],
  canonicalSessionPaths: ReadonlyMap<string, string>,
): Map<string, SessionProjectStats> {
  const stats = new Map<string, SessionProjectStats>()
  for (const session of sessions) {
    const projectPath = canonicalSessionPaths.get(session.projectPath)!
    const current = stats.get(projectPath)
    if (!current) {
      stats.set(projectPath, {
        count: 1,
        earliestCreatedAt: session.createdAt,
        latestUpdatedAt: session.updatedAt,
      })
      continue
    }
    current.count += 1
    if (session.createdAt < current.earliestCreatedAt) current.earliestCreatedAt = session.createdAt
    if (session.updatedAt > current.latestUpdatedAt) current.latestUpdatedAt = session.updatedAt
  }
  return stats
}

/** Renderer records contain display fields only; persisted folder identities stay in main. */
export function persistedProjectRecord(project: PersistedProject, sessionCount: number, gitBranch?: string): ProjectRecord {
  return {
    id: project.id, harness: project.harness, name: project.name, path: project.path,
    folders: [...project.folders], primaryFolder: project.primaryFolder,
    pinned: project.pinned, createdAt: project.createdAt, lastOpenedAt: project.lastOpenedAt,
    scripts: project.scripts ? { ...project.scripts } : undefined, sessionCount, gitBranch,
  }
}
