import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, posix, relative, resolve, win32 } from 'node:path'
import { lstat, readdir, realpath } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import type { GitWorktree, HarnessId, ProjectFileEntry, ProjectFileListing, ProjectRecord, SessionRecord } from '../../src/types/api'
import { createGitWorktree, isNotARepositoryFailure, listGitWorktrees, validateGitBranch } from './git'
import { HARNESSES } from './harness'
import { mapLimit } from './lib/async'
import type { FolderIdentity, JsonStateStore, PersistedProject } from './store'
import { isPathWithin, requireExistingDirectory, requireExistingPath, requireId, requireString } from './validation'

const MAX_CONCURRENT_BRANCH_LOOKUPS = 4

function inferredId(path: string): string {
  return `inferred-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

/** Filesystem roots too broad to grant as a project: volume/share roots and the user's home. */
export function isBroadProjectRoot(
  pathValue: string,
  options: { platform?: NodeJS.Platform; homePath?: string } = {},
): boolean {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? win32 : posix
  const comparable = (path: string): string => {
    const normalized = pathApi.resolve(path)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const path = comparable(pathValue)
  const root = comparable(pathApi.parse(path).root)
  const home = comparable(options.homePath ?? homedir())
  // Node's win32 parser treats an extended-length UNC namespace as the root;
  // identify its server/share boundary explicitly as well.
  const extendedUncShareRoot = platform === 'win32' && /^\\\\\?\\unc\\[^\\]+\\[^\\]+\\?$/i.test(path)
  return path === root || path === home || extendedUncShareRoot
}

interface VerifiedFolderIdentity {
  path: string
  identity: FolderIdentity
}

interface FolderIdentityRefresh {
  configured: string
  canonical: string
  expected: FolderIdentity
  current: FolderIdentity
}

interface SessionProjectStats {
  count: number
  earliestCreatedAt: string
  latestUpdatedAt: string
}

function aggregateSessionProjectStats(
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

export interface FolderIdentityFilesystem {
  lstat(path: string): Promise<BigIntStats>
  realpath(path: string): Promise<string>
}

const defaultFolderIdentityFilesystem: FolderIdentityFilesystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
}

function folderIdentitiesEqual(left: FolderIdentity, right: FolderIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
}

/**
 * Device numbers can change when the same filesystem is remounted. Inode plus
 * birth time remains stable across that event and still rejects replacement.
 * Legacy grants lack birth time, so they may upgrade once when the canonical
 * path keeps its inode and the current filesystem proves that the directory
 * predates the grant. Exact device/inode matching is only enough on filesystems
 * that cannot provide a birth time.
 */
function isSameFolderIdentity(expected: FolderIdentity, current: FolderIdentity, grantedAt?: string): boolean {
  if (expected.ino !== current.ino) return false
  if (expected.birthtimeNs !== undefined) {
    if (current.birthtimeNs !== undefined) return expected.birthtimeNs === current.birthtimeNs
    return expected.dev === current.dev
  }
  if (current.birthtimeNs === undefined) return expected.dev === current.dev
  if (grantedAt === undefined) return false
  const grantedAtMs = Date.parse(grantedAt)
  if (!Number.isFinite(grantedAtMs)) return false
  try {
    // The object must predate the grant. A small allowance covers filesystems
    // whose birth time and the desktop clock have different precision.
    return BigInt(current.birthtimeNs) <= BigInt(Math.ceil(grantedAtMs + 5_000)) * 1_000_000n
  } catch { return false }
}

/**
 * One ProjectService instance exists per harness. Instances share the one
 * desktop state store but each sees, creates, and authorizes only records of
 * its own harness: a grant made for Prime never authorizes an OMP runtime's
 * cwd and vice versa. Dismissed inferred-project paths remain shared, matching
 * the single dismissedProjectPaths list in persisted state.
 */
export class ProjectService {
  // Reassigned wholesale (build-new-map-then-swap) so authorization reads are
  // never served from a partially repopulated map.
  private authorizedRoots = new Map<string, FolderIdentity>()
  private quarantinedBroadRoots = new Set<string>()
  private readonly removalRoots = new Set<string>()
  private authorizationRevision = 0
  private canonicalHomeRoot: Promise<string> | undefined
  private sessionProvider: () => Promise<SessionRecord[]> = async () => []
  private branchProvider: (cwd: string) => Promise<string | undefined> = async () => undefined
  private stopProjectProcesses: (roots: string[]) => Promise<void> = async () => undefined

  constructor(
    private readonly store: JsonStateStore,
    private readonly windowProvider: () => BrowserWindow | null,
    private readonly harness: HarnessId = 'prime',
    private readonly identityFilesystem: FolderIdentityFilesystem = defaultFolderIdentityFilesystem,
  ) {}

  private ownProjects(projects: readonly PersistedProject[]): PersistedProject[] {
    return projects.filter((project) => project.harness === this.harness)
  }

  private async captureFolderIdentity(pathValue: string): Promise<{ path: string; identity: FolderIdentity }> {
    const configured = resolve(requireString(pathValue, 'project folder', { min: 1, max: 4096 }))
    const configuredInfo = await this.identityFilesystem.lstat(configured)
    if (!configuredInfo.isDirectory() || configuredInfo.isSymbolicLink()) throw new TypeError('Project folder must be a stable directory')
    const path = await this.identityFilesystem.realpath(configured)
    const canonicalInfo = await this.identityFilesystem.lstat(path)
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw new TypeError('Project folder must be a stable directory')
    const toIdentity = (info: BigIntStats): FolderIdentity => ({
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
    })
    const configuredIdentity = toIdentity(configuredInfo)
    const canonicalIdentity = toIdentity(canonicalInfo)
    if (!folderIdentitiesEqual(configuredIdentity, canonicalIdentity)) throw new TypeError('Project folder identity changed while it was being verified')
    return { path, identity: canonicalIdentity }
  }

  private async isBroadRoot(path: string): Promise<boolean> {
    this.canonicalHomeRoot ??= this.identityFilesystem.realpath(resolve(homedir())).catch(() => resolve(homedir()))
    return isBroadProjectRoot(path, { homePath: await this.canonicalHomeRoot })
  }

  private async verifyFolderIdentity(pathValue: string, expected?: FolderIdentity, grantedAt?: string): Promise<VerifiedFolderIdentity | undefined> {
    if (!expected) return undefined
    try {
      const current = await this.captureFolderIdentity(pathValue)
      return isSameFolderIdentity(expected, current.identity, grantedAt) ? current : undefined
    } catch { return undefined }
  }

  /** Refreshes only unchanged grants so concurrent removal or re-grant wins. */
  private async persistFolderIdentityRefreshes(
    refreshes: FolderIdentityRefresh[],
    authorizationRevision: number,
  ): Promise<Set<string>> {
    if (!refreshes.length || authorizationRevision !== this.authorizationRevision) return new Set()
    return this.store.update((state) => {
      if (authorizationRevision !== this.authorizationRevision) return new Set<string>()
      const refreshed = new Set<string>()
      for (const refresh of refreshes) {
        const project = state.projects.find((item) => item.harness === this.harness && item.folders.some((folder) => resolve(folder) === refresh.configured))
        const storedKey = project?.folderIdentities?.[refresh.configured] ? refresh.configured : refresh.canonical
        const stored = project?.folderIdentities?.[storedKey]
        if (!project || !stored) continue
        if (folderIdentitiesEqual(stored, refresh.current)) {
          refreshed.add(refresh.configured)
          continue
        }
        if (!folderIdentitiesEqual(stored, refresh.expected)) continue
        project.folderIdentities = { ...project.folderIdentities, [storedKey]: refresh.current }
        refreshed.add(refresh.configured)
      }
      return refreshed
    })
  }

  /** Resolves folder paths against their persisted identity. */
  private async resolveFolderAuthorization(
    project: Pick<PersistedProject, 'folderIdentities' | 'createdAt'>,
    folder: string,
  ): Promise<{ configured: string; canonical: string; expected?: FolderIdentity; verified?: VerifiedFolderIdentity }> {
    const configured = resolve(folder)
    let canonical = configured
    try { canonical = await requireExistingDirectory(configured, 'project folder') } catch { /* Keep stale lexical path visible. */ }
    const expected = project.folderIdentities?.[configured] ?? project.folderIdentities?.[canonical]
    const verified = await this.verifyFolderIdentity(configured, expected, project.createdAt)
    return { configured, canonical, expected, verified }
  }

  bindProviders(providers: {
    sessions(): Promise<SessionRecord[]>
    branch(cwd: string): Promise<string | undefined>
    stopProjectProcesses?(roots: string[]): Promise<void>
  }): void {
    this.sessionProvider = providers.sessions
    this.branchProvider = providers.branch
    this.stopProjectProcesses = providers.stopProjectProcesses ?? (async () => undefined)
  }

  private async migrateLegacyFolderIdentities(): Promise<void> {
    const legacyProjects = this.ownProjects(this.store.snapshot().projects).filter((project) => project.folderIdentities === undefined)
    if (!legacyProjects.length) return

    const captured = new Map<string, Record<string, FolderIdentity>>()
    for (const project of legacyProjects) {
      const identities: Record<string, FolderIdentity> = {}
      for (const folder of project.folders) {
        try {
          const current = await this.captureFolderIdentity(folder)
          if (await this.isBroadRoot(current.path)) continue
          identities[current.path] = current.identity
        } catch { /* Stale and symlinked legacy grants remain unauthorized. */ }
      }
      if (Object.keys(identities).length) captured.set(project.id, identities)
    }
    if (!captured.size) return

    await this.store.update((state) => {
      for (const project of state.projects) {
        const identities = captured.get(project.id)
        if (identities && project.folderIdentities === undefined) project.folderIdentities = identities
      }
    })
  }

  async list(): Promise<ProjectRecord[]> {
    await this.migrateLegacyFolderIdentities()
    const authorizationRevision = this.authorizationRevision
    const sessions = await this.sessionProvider()
    const sessionPaths = [...new Set(sessions.map((session) => session.projectPath))]
    const canonicalSessionPaths = new Map<string, string>()
    const existingSessionPaths = new Set<string>()
    await Promise.all(sessionPaths.map(async (path) => {
      try {
        canonicalSessionPaths.set(path, await requireExistingDirectory(path, 'session project path'))
        existingSessionPaths.add(path)
      }
      catch { canonicalSessionPaths.set(path, resolve(path)) }
    }))
    const sessionStats = aggregateSessionProjectStats(sessions, canonicalSessionPaths)
    const snapshot = this.store.snapshot()
    const persisted = this.ownProjects(snapshot.projects)
    const dismissed = new Set(await Promise.all(snapshot.dismissedProjectPaths.map(async (path) => {
      try { return await requireExistingDirectory(path, 'dismissed project path') } catch { return resolve(path) }
    })))
    const records: ProjectRecord[] = []
    const represented = new Set<string>()
    const nextAuthorized = new Map<string, FolderIdentity>()
    const nextQuarantinedBroadRoots = new Set<string>()
    const identityRefreshes: FolderIdentityRefresh[] = []
    const branchTargets: Array<{ record: ProjectRecord; cwd: string }> = []

    for (const project of persisted) {
      const folderSet = new Set<string>()
      let primaryGranted = false
      for (const folder of project.folders) {
        const { configured, canonical, expected, verified } = await this.resolveFolderAuthorization(project, folder)
        folderSet.add(canonical)
        represented.add(configured)
        represented.add(canonical)
        const authorizationPath = verified?.path ?? canonical
        if (await this.isBroadRoot(authorizationPath)) {
          nextQuarantinedBroadRoots.add(authorizationPath)
          continue
        }
        if (verified && expected) {
          if (configured === resolve(project.primaryFolder)) primaryGranted = true
          nextAuthorized.set(configured, verified.identity)
          if (!folderIdentitiesEqual(expected, verified.identity)) {
            identityRefreshes.push({ configured, canonical, expected, current: verified.identity })
          }
        }
      }
      let sessionCount = 0
      for (const folder of folderSet) sessionCount += sessionStats.get(folder)?.count ?? 0
      const record: ProjectRecord = {
        id: project.id, harness: project.harness, name: project.name, path: project.path, folders: project.folders, primaryFolder: project.primaryFolder,
        pinned: project.pinned, createdAt: project.createdAt, lastOpenedAt: project.lastOpenedAt,
        sessionCount,
        gitBranch: undefined,
      }
      records.push(record)
      if (primaryGranted) branchTargets.push({ record, cwd: project.primaryFolder })
    }

    // Persist any legacy/remount identity upgrades before exposing them as
    // grants. The previous complete map keeps serving while this is in flight.
    if (authorizationRevision === this.authorizationRevision && identityRefreshes.length) {
      const refreshed = await this.persistFolderIdentityRefreshes(identityRefreshes, authorizationRevision)
      for (const refresh of identityRefreshes) if (!refreshed.has(refresh.configured)) nextAuthorized.delete(refresh.configured)
    }
    if (authorizationRevision === this.authorizationRevision) {
      this.authorizedRoots = nextAuthorized
      this.quarantinedBroadRoots = nextQuarantinedBroadRoots
    }

    for (const projectPath of sessionPaths) {
      if (!projectPath || !existingSessionPaths.has(projectPath)) continue
      const canonical = canonicalSessionPaths.get(projectPath)!
      if (represented.has(canonical) || dismissed.has(canonical)) continue
      if (await this.isBroadRoot(canonical)) continue
      represented.add(canonical)
      const stats = sessionStats.get(canonical)
      records.push({
        id: inferredId(canonical),
        harness: this.harness,
        name: basename(canonical) || canonical,
        path: canonical,
        folders: [canonical],
        primaryFolder: canonical,
        pinned: false,
        createdAt: stats?.earliestCreatedAt ?? new Date().toISOString(),
        lastOpenedAt: stats?.latestUpdatedAt ?? new Date().toISOString(),
        sessionCount: stats?.count ?? 0,
        gitBranch: undefined,
        inferred: true,
      })
    }
    // Branch enrichment runs after the swap: authorization must never wait on
    // git subprocesses.
    let branchLookupFailed = false
    await mapLimit(branchTargets, MAX_CONCURRENT_BRANCH_LOOKUPS, async (target) => {
      if (branchLookupFailed) return target
      try { target.record.gitBranch = await this.branchProvider(target.cwd) }
      catch (error) {
        // mapLimit owns all worker promises, so concurrent failures remain
        // handled. Stop admitting queued Git work once the first one fails.
        branchLookupFailed = true
        throw error
      }
      return target
    })
    return records.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
  }

  async listWorktrees(cwdValue: unknown): Promise<GitWorktree[]> {
    const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
    try { return await listGitWorktrees(cwd) }
    catch (error) {
      if (isNotARepositoryFailure(error)) return []
      throw error
    }
  }

  /** Grants a folder and reuses knownSessions when the caller already loaded them. */
  private async grantProjectFolder(path: string, identity: FolderIdentity, knownSessions?: readonly SessionRecord[]): Promise<ProjectRecord> {
    if (await this.isBroadRoot(path)) throw new TypeError('Broad filesystem roots cannot be added as projects')
    this.removalRoots.delete(path)
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
      const existing = this.ownProjects(state.projects).find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) {
        existing.lastOpenedAt = now
        existing.folderIdentities = { ...existing.folderIdentities, [path]: identity }
        return existing
      }
      const created: PersistedProject = {
        id: randomUUID(),
        harness: this.harness,
        name: basename(path) || path,
        path,
        folders: [path],
        primaryFolder: path,
        pinned: false,
        createdAt: now,
        lastOpenedAt: now,
        folderIdentities: { [path]: identity },
      }
      state.projects.push(created)
      return created
    })
    this.authorizationRevision += 1
    this.authorizedRoots.set(path, identity)
    const sessions = knownSessions ?? await this.sessionProvider()
    return { ...project, sessionCount: sessions.filter((session) => resolve(session.projectPath) === path).length, gitBranch: await this.branchProvider(path) }
  }

  private async persistWorktree(path: string, identity: FolderIdentity): Promise<ProjectRecord> {
    return this.grantProjectFolder(path, identity)
  }

  async openWorktree(cwdValue: unknown, pathValue: unknown): Promise<ProjectRecord> {
    const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
    const requested = resolve(requireString(pathValue, 'worktree path', { min: 1, max: 4096 }))
    const worktrees = await listGitWorktrees(cwd)
    const linked = worktrees.find((worktree) => resolve(worktree.path) === requested)
    if (!linked) throw new TypeError('worktree path is not linked to the authorized Git repository')
    // Only inspect the filesystem after exact membership in Git's bounded
    // worktree catalog is established; arbitrary renderer paths stay opaque.
    const { path, identity } = await this.captureFolderIdentity(linked.path)
    return this.persistWorktree(path, identity)
  }

  async createWorktree(cwdValue: unknown, branchValue: unknown): Promise<ProjectRecord | null> {
    const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
    const branch = await validateGitBranch(cwd, branchValue)
    const worktrees = await listGitWorktrees(cwd)
    const current = worktrees.find((worktree) => worktree.current)
    if (!current) throw new Error('Git worktree list did not include the current worktree')
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+|\.+$/g, '').slice(0, 120) || 'worktree'
    const defaultPath = join(dirname(current.path), `${basename(current.path)}-${safeBranch}`)
    const parent = this.windowProvider()
    const options = { title: 'Create Git worktree', buttonLabel: 'Create Worktree', defaultPath }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const targetPath = resolve(requireString(result.filePath, 'worktree path', { min: 1, max: 4096 }))
    // Keep the guard before the Git side effect as well as at the central
    // grant boundary reached by openWorktree.
    if (await this.isBroadRoot(targetPath)) throw new TypeError('Broad filesystem roots cannot be added as worktrees')
    await createGitWorktree(cwd, targetPath, branch)
    return this.openWorktree(cwd, targetPath)
  }

  async add(): Promise<ProjectRecord | null> {
    const parent = this.windowProvider()
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length !== 1) return null
    const { path, identity } = await this.captureFolderIdentity(result.filePaths[0])
    return this.grantProjectFolder(path, identity)
  }

  async grantInferred(pathValue: unknown): Promise<ProjectRecord> {
    const { path, identity } = await this.captureFolderIdentity(String(pathValue))
    if (await this.isBroadRoot(path)) throw new TypeError('Broad filesystem roots cannot be inferred as projects')
    this.removalRoots.delete(path)
    const sessions = await this.sessionProvider()
    let discovered = false
    for (const session of sessions) {
      try {
        if (await requireExistingDirectory(session.projectPath, 'session project path') === path) { discovered = true; break }
      } catch { /* Ignore stale session project paths. */ }
    }
    if (!discovered) throw new TypeError('Project path was not discovered from a Prime session')
    return this.grantProjectFolder(path, identity, sessions)
  }

  async remove(idValue: unknown): Promise<boolean> {
    const authorizationRevision = ++this.authorizationRevision
    const id = requireId(idValue, 'project id')
    const persisted = this.ownProjects(this.store.snapshot().projects).find((project) => project.id === id)
    const persistedPaths: string[] = []
    if (persisted) for (const folder of persisted.folders) {
      const configured = resolve(folder)
      persistedPaths.push(configured)
      try {
        const canonical = await requireExistingDirectory(configured, 'project folder')
        if (canonical !== configured) persistedPaths.push(canonical)
      } catch { /* Keep the lexical path dismissed even when it is stale. */ }
    }
    let inferredPath: string | undefined
    if (!persisted) {
      const sessions = await this.sessionProvider()
      for (const pathValue of [...new Set(sessions.map((session) => session.projectPath).filter(Boolean))]) {
        try {
          const path = await requireExistingDirectory(pathValue, 'session project path')
          if (inferredId(path) === id && !(await this.isBroadRoot(path))) { inferredPath = path; break }
        } catch { /* Not a removable inferred project. */ }
      }
    }
    const roots = persisted ? persistedPaths : inferredPath ? [inferredPath] : []
    try {
      if (roots.length) {
        for (const root of roots) this.removalRoots.add(root)
        for (const configured of persisted?.folders ?? []) this.authorizedRoots.delete(resolve(configured))
        await this.stopProjectProcesses([...new Set(roots)])
      }
      return await this.store.update((state) => {
        const index = state.projects.findIndex((project) => project.id === id && project.harness === this.harness)
        const paths = index >= 0 ? persistedPaths : inferredPath ? [inferredPath] : []
        if (!paths.length) return false
        if (index >= 0) state.projects.splice(index, 1)
        const dismissed = new Set(state.dismissedProjectPaths.map((path) => resolve(path)))
        for (const path of paths) dismissed.add(path)
        state.dismissedProjectPaths = [...dismissed]
        return true
      })
    } finally {
      // Removal blocks are transient: release them whether the store update
      // settled or threw, then rebuild authorization from the store. After a
      // successful removal the authoritative block is absence from
      // authorizedRoots; after a failed one the project keeps working.
      for (const root of roots) this.removalRoots.delete(root)
      if (authorizationRevision === this.authorizationRevision) await this.rebuildAuthorizedRoots(authorizationRevision)
    }
  }

  /** Rebuilds authorization into a fresh map and swaps it in one step. */
  private async rebuildAuthorizedRoots(authorizationRevision: number): Promise<void> {
    const nextAuthorized = new Map<string, FolderIdentity>()
    const nextQuarantinedBroadRoots = new Set<string>()
    const identityRefreshes: FolderIdentityRefresh[] = []
    for (const project of this.ownProjects(this.store.snapshot().projects)) {
      for (const folder of project.folders) {
        if (authorizationRevision !== this.authorizationRevision) return
        const { configured, canonical, expected, verified } = await this.resolveFolderAuthorization(project, folder)
        const authorizationPath = verified?.path ?? canonical
        if (await this.isBroadRoot(authorizationPath)) {
          nextQuarantinedBroadRoots.add(authorizationPath)
          continue
        }
        if (verified && expected) {
          nextAuthorized.set(configured, verified.identity)
          if (!folderIdentitiesEqual(expected, verified.identity)) {
            identityRefreshes.push({ configured, canonical, expected, current: verified.identity })
          }
        }
      }
    }
    if (authorizationRevision === this.authorizationRevision && identityRefreshes.length) {
      const refreshed = await this.persistFolderIdentityRefreshes(identityRefreshes, authorizationRevision)
      for (const refresh of identityRefreshes) if (!refreshed.has(refresh.configured)) nextAuthorized.delete(refresh.configured)
    }
    if (authorizationRevision === this.authorizationRevision) {
      this.authorizedRoots = nextAuthorized
      this.quarantinedBroadRoots = nextQuarantinedBroadRoots
    }
  }

  async touch(idValue: unknown): Promise<boolean> {
    const id = requireId(idValue, 'project id')
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project) return false
      project.lastOpenedAt = new Date().toISOString()
      return true
    })
  }

  async listFiles(rootValue: unknown): Promise<ProjectFileListing> {
    const root = await this.authorizeCwd(rootValue as string)
    const entries: ProjectFileEntry[] = []
    let skipped = 0
    const ignoredDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'release', 'coverage', '.next', '.venv'])
    const maxEntries = 5_000

    const visit = async (directory: string): Promise<void> => {
      if (entries.length >= maxEntries) return
      let children: Dirent[]
      try {
        children = await readdir(directory, { withFileTypes: true })
      } catch {
        // An unreadable directory (permissions, races) must not fail the whole
        // listing; report it so the UI can note the gap.
        skipped += 1
        return
      }
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const child of children) {
        if (entries.length >= maxEntries) break
        if (child.isSymbolicLink()) continue
        if (child.isDirectory() && ignoredDirectories.has(child.name)) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const absolutePath = resolve(directory, child.name)
        const relativePath = relative(root, absolutePath)
        const path = process.platform === 'win32' ? relativePath.split('\\').join('/') : relativePath
        entries.push({ path, type: child.isDirectory() ? 'directory' : 'file' })
        if (child.isDirectory()) await visit(absolutePath)
      }
    }

    await visit(root)
    return { entries, skipped }
  }

  private async authorizedRootFor(path: string): Promise<string> {
    if (!this.authorizedRoots.size) await this.list()
    const authorizationRevision = this.authorizationRevision
    const roots: string[] = []
    // Snapshot the map: a concurrent refresh may swap this.authorizedRoots
    // mid-iteration, and stale-entry eviction must target the map iterated.
    const authorized = this.authorizedRoots
    for (const [configured, expected] of authorized) {
      // An in-flight removal blocks exactly the roots being removed; a nested
      // project registered inside them keeps its own grant.
      if (this.removalRoots.has(configured)) continue
      const verified = await this.verifyFolderIdentity(configured, expected)
      if (!verified) { authorized.delete(configured); continue }
      if (!folderIdentitiesEqual(expected, verified.identity)) {
        const refreshed = await this.persistFolderIdentityRefreshes([{
          configured,
          canonical: verified.path,
          expected,
          current: verified.identity,
        }], authorizationRevision)
        if (!refreshed.has(configured)) { authorized.delete(configured); continue }
        authorized.set(configured, verified.identity)
      }
      if (this.removalRoots.has(verified.path)) continue
      roots.push(verified.path)
    }
    if (authorizationRevision !== this.authorizationRevision) throw new TypeError('project authorization changed while the request was being checked')
    const authorizedRoot = roots.filter((root) => isPathWithin(root, path)).sort((a, b) => b.length - a.length)[0]
    if (!authorizedRoot) {
      const productName = HARNESSES[this.harness].productName
      if ([...this.removalRoots].some((root) => isPathWithin(root, path))) throw new TypeError(`path is not inside an added ${productName} project because its project is being removed`)
      if ([...this.quarantinedBroadRoots].some((root) => isPathWithin(root, path))) {
        throw new TypeError(`path is covered by an unsafe broad ${productName} project grant; remove it and add a narrower project folder`)
      }
      throw new TypeError(`path is not inside an added ${productName} project or its folder identity changed`)
    }
    return authorizedRoot
  }

  async authorizePath(value: string): Promise<string> {
    const path = await requireExistingPath(value)
    await this.authorizedRootFor(path)
    return path
  }

  async authorizeProjectRoot(value: string): Promise<string> {
    const path = await requireExistingDirectory(value, 'project path')
    return await this.authorizedRootFor(path)
  }

  async authorizeCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizedRootFor(cwd)
    return cwd
  }
}
