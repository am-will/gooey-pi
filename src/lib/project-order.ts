import type { ProjectRecord, ProjectSortMode } from '@/types/api'

function compareRecent(a: ProjectRecord, b: ProjectRecord): number {
  const aTime = Date.parse(a.lastOpenedAt)
  const bTime = Date.parse(b.lastOpenedAt)
  const aInvalid = Number.isNaN(aTime)
  const bInvalid = Number.isNaN(bTime)
  if (aInvalid !== bInvalid) return aInvalid ? 1 : -1
  if (!aInvalid && aTime !== bTime) return bTime - aTime
  return 0
}

export function sortProjects(projects: readonly ProjectRecord[], mode: ProjectSortMode): ProjectRecord[] {
  return [...projects].sort((a, b) => {
    const pinnedOrder = Number(b.pinned) - Number(a.pinned)
    if (pinnedOrder) return pinnedOrder
    if (mode === 'alphabetical') {
      const nameOrder = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      if (nameOrder) return nameOrder
    } else {
      const recentOrder = compareRecent(a, b)
      if (recentOrder) return recentOrder
    }
    return a.id.localeCompare(b.id)
  })
}
