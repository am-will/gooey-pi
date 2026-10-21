import { resolve } from 'node:path'
import type { SessionRecord } from '../../../src/types/api'
import type { FolderIdentity } from '../store'
import { mapLimit } from '../lib/async'
import { requireExistingDirectory } from '../validation'
import type { FolderIdentityVerifier } from './folder-identity'

/** Canonicalizes each distinct project path once with bounded filesystem concurrency. */
async function canonicalizeProjectPaths(paths: readonly string[]): Promise<Map<string, string>> {
  const entries = await mapLimit([...new Set(paths)], 8, async (path): Promise<[string, string]> => {
    try { return [path, await requireExistingDirectory(path, 'session project path')] }
    catch { return [path, resolve(path)] }
  })
  return new Map(entries)
}

export function canonicalizeSessionPaths(sessions: readonly SessionRecord[]): Promise<Map<string, string>> {
  return canonicalizeProjectPaths(sessions.map((session) => session.projectPath))
}

export async function resolveDismissedProjectPaths(paths: readonly string[]): Promise<Set<string>> {
  return new Set((await canonicalizeProjectPaths(paths)).values())
}

export async function discoverValidSessionRoots(
  canonicalSessionPaths: ReadonlyMap<string, string>,
  dismissed: ReadonlySet<string>,
  represented: ReadonlySet<string>,
  identityVerifier: FolderIdentityVerifier,
  isCurrent: () => boolean,
): Promise<Array<{ canonical: string; identity: FolderIdentity }>> {
  const discovered: Array<{ canonical: string; identity: FolderIdentity }> = []
  for (const canonical of new Set(canonicalSessionPaths.values())) {
    if (!isCurrent()) break
    if (represented.has(canonical) || dismissed.has(canonical)) continue
    try {
      if (await identityVerifier.isBroadRoot(canonical)) continue
      const { identity } = await identityVerifier.capture(canonical)
      discovered.push({ canonical, identity })
    } catch { /* Stale, unreadable, or non-directory session paths remain unauthorized. */ }
  }
  return discovered
}
