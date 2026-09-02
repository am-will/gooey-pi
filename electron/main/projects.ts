import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, posix, relative, resolve, win32 } from 'node:path'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { sortProjects } from '../../src/lib/project-order'
import type { GitWorktree, HarnessId, ProjectFileEntry, ProjectFileListing, ProjectRecord, ProjectScripts, SessionRecord } from '../../src/types/api'
import { listGitWorktrees } from './git'
import { HARNESSES } from './harness'
import { mapLimit } from './lib/async'
import type { FolderIdentity, JsonStateStore, PersistedProject } from './store'
import { isPathWithin, rejectUnknownKeys, requireBoolean, requireExistingDirectory, requireExistingPath, requireId, requireInteger, requireRecord, requireString } from './validation'

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

interface PersistedAuthorizationContext {
  project: PersistedProject
  folders: Set<string>
  primaryGranted: boolean
}

interface AuthorizationContext {
  sessions: SessionRecord[]
  canonicalSessionPaths: Map<string, string>
  persisted: PersistedAuthorizationContext[]
  discoveredSessionRoots: Array<{ canonical: string; identity: FolderIdentity }>
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
  private readOnlyRoots = new Map<string, FolderIdentity>()
  private quarantinedBroadRoots = new Set<string>()
  private readonly removalRoots = new Set<string>()
  private readonly pendingRemovalIds = new Set<string>()
  private authorizationRevision = 0
  private authorizationRefresh: { revision: number; promise: Promise<AuthorizationContext> } | undefined
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

  /** Persisted projects visible to this instance: exactly its own harness's records. */
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

  /**
   * Refreshes only still-present grants whose persisted identity is exactly the
   * one that was verified. A concurrent removal or re-grant cannot be undone.
   */
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

  /**
   * The one verify-and-authorize resolution for a persisted project folder:
   * lexical (configured) path, canonical path when it still exists, the
   * recorded identity for either spelling, and the verified canonical path
   * when the on-disk identity still matches the grant.
   */
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

  private async discoverValidSessionRoots(
    sessions: readonly SessionRecord[],
    dismissed: ReadonlySet<string>,
    represented: ReadonlySet<string>,
    authorizationRevision: number,
  ): Promise<Array<{ canonical: string; identity: FolderIdentity }>> {
    const rawPaths = [...new Set(sessions.map((session) => session.projectPath).filter((path): path is string => Boolean(path)))]
    const discovered: Array<{ canonical: string; identity: FolderIdentity }> = []
    const seen = new Set<string>()

    for (const projectPath of rawPaths) {
      if (authorizationRevision !== this.authorizationRevision) break
      try {
        const canonical = await requireExistingDirectory(projectPath, 'session project path')
        if (seen.has(canonical) || represented.has(canonical) || dismissed.has(canonical)) continue
        if (await this.isBroadRoot(canonical)) continue
        seen.add(canonical)
        const { identity } = await this.captureFolderIdentity(canonical)
        discovered.push({ canonical, identity })
      } catch {
        // Stale, unreadable, or non-directory session paths remain unauthorized
      }
    }

    return discovered
  }

  private async resolveDismissedProjectPaths(paths: readonly string[]): Promise<Set<string>> {
    return new Set(await Promise.all(paths.map(async (path) => {
      try { return await requireExistingDirectory(path, 'dismissed project path') } catch { return resolve(path) }
    })))
  }

  private async canonicalizeSessionPaths(sessions: readonly SessionRecord[]): Promise<Map<string, string>> {
    const sessionPaths = [...new Set(sessions.map((session) => session.projectPath))]
    const canonicalSessionPaths = new Map<string, string>()
    await Promise.all(sessionPaths.map(async (path) => {
      try { canonicalSessionPaths.set(path, await requireExistingDirectory(path, 'session project path')) }
      catch { canonicalSessionPaths.set(path, resolve(path)) }
    }))
    return canonicalSessionPaths
  }

  /**
   * Resolves the main repository of a linked Git worktree from its `.git`
   * pointer file. Returns undefined for a normal checkout, a bare repository,
   * or anything that does not parse as a bounded worktree pointer.
   */
  private async linkedWorktreeMainRepository(path: string): Promise<string | undefined> {
    const pointer = join(path, '.git')
    try {
      const info = await this.identityFilesystem.lstat(pointer)
      if (!info.isFile() || info.size > 4096n) return undefined
      const contents = await readFile(pointer, 'utf8')
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents)
      if (!match) return undefined
      const gitDir = resolve(dirname(pointer), match[1])
      const worktrees = dirname(gitDir)
      if (basename(worktrees) !== 'worktrees') return undefined
      const mainGitDir = dirname(worktrees)
      if (basename(mainGitDir) !== '.git') return undefined
      return await requireExistingDirectory(dirname(mainGitDir), 'worktree main repository')
    } catch { return undefined }
  }

  /**
   * Folds a linked worktree that was granted as its own project back into the
   * project holding its main repository, so a worktree keeps showing under the
   * repository it belongs to instead of as a sibling project.
   */
  private async absorbLinkedWorktreeProjects(): Promise<void> {
    const own = this.ownProjects(this.store.snapshot().projects)
    if (own.length < 2) return
    const ownerByFolder = new Map<string, string>()
    for (const project of own) {
      for (const folder of new Set([project.path, ...project.folders])) {
        try { ownerByFolder.set(await requireExistingDirectory(folder, 'project folder'), project.id) }
        catch { /* stale folders never own a worktree */ }
      }
    }

    const absorptions = new Map<string, string>()
    for (const project of own) {
      let canonical: string
      try { canonical = await requireExistingDirectory(project.primaryFolder, 'project folder') }
      catch { continue }
      if (project.folders.length !== 1) continue
      const mainRepository = await this.linkedWorktreeMainRepository(canonical)
      if (!mainRepository) continue
      const parentId = ownerByFolder.get(mainRepository)
      if (!parentId || parentId === project.id) continue
      absorptions.set(project.id, parentId)
    }
    if (!absorptions.size) return

    await this.store.update((state) => {
      const byId = new Map(state.projects.map((project) => [project.id, project]))
      const absorbed = new Set<string>()
      for (const [childId, parentId] of absorptions) {
        const child = byId.get(childId)
        const parent = byId.get(parentId)
        if (!child || !parent || parent.harness !== child.harness) continue
        const folders = new Set(parent.folders.map((folder) => resolve(folder)))
        for (const folder of child.folders) folders.add(resolve(folder))
        parent.folders = [...folders]
        parent.folderIdentities = { ...parent.folderIdentities, ...child.folderIdentities }
        absorbed.add(childId)
      }
      if (absorbed.size) state.projects = state.projects.filter((project) => !absorbed.has(project.id))
    })
    this.authorizationRevision += 1
  }

  private async buildAuthorizationContext(authorizationRevision: number): Promise<AuthorizationContext> {
    await this.migrateLegacyFolderIdentities()
    await this.absorbLinkedWorktreeProjects()
    const nextAuthorized = new Map<string, FolderIdentity>()
    const nextReadOnly = new Map<string, FolderIdentity>()
    const nextQuarantinedBroadRoots = new Set<string>()
    const identityRefreshes: FolderIdentityRefresh[] = []
    const persisted: PersistedAuthorizationContext[] = []
    const represented = new Set<string>()

    for (const project of this.ownProjects(this.store.snapshot().projects)) {
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
      persisted.push({ project, folders: folderSet, primaryGranted })
    }

    const snapshot = this.store.snapshot()
    const dismissed = await this.resolveDismissedProjectPaths(snapshot.dismissedProjectPaths)
    const sessions = await this.sessionProvider()
    const canonicalSessionPaths = await this.canonicalizeSessionPaths(sessions)
    const discoveredSessionRoots = await this.discoverValidSessionRoots(sessions, dismissed, represented, authorizationRevision)
    for (const { canonical, identity } of discoveredSessionRoots) nextReadOnly.set(canonical, identity)

    if (authorizationRevision === this.authorizationRevision && identityRefreshes.length) {
      const refreshed = await this.persistFolderIdentityRefreshes(identityRefreshes, authorizationRevision)
      for (const refresh of identityRefreshes) if (!refreshed.has(refresh.configured)) nextAuthorized.delete(refresh.configured)
    }
    if (authorizationRevision === this.authorizationRevision) {
      this.authorizedRoots = nextAuthorized
      this.readOnlyRoots = nextReadOnly
      this.quarantinedBroadRoots = nextQuarantinedBroadRoots
    }
    return { sessions, canonicalSessionPaths, persisted, discoveredSessionRoots }
  }

  private refreshAuthorization(force = false): Promise<AuthorizationContext> {
    if (force) this.authorizationRevision += 1
    const revision = this.authorizationRevision
    if (!force && this.authorizationRefresh?.revision === revision) return this.authorizationRefresh.promise
    const promise = this.buildAuthorizationContext(revision)
    const tracked = promise.then(
      (context) => {
        if (this.authorizationRefresh?.promise === tracked) this.authorizationRefresh = undefined
        return context
      },
      (error: unknown) => {
        if (this.authorizationRefresh?.promise === tracked) this.authorizationRefresh = undefined
        throw error
      },
    )
    this.authorizationRefresh = { revision, promise: tracked }
    return tracked
  }

  async list(): Promise<ProjectRecord[]> {
    const { sessions, canonicalSessionPaths, persisted, discoveredSessionRoots } = await this.refreshAuthorization()
    const sessionStats = aggregateSessionProjectStats(sessions, canonicalSessionPaths)
    const records: ProjectRecord[] = []
    const branchTargets: Array<{ record: ProjectRecord; cwd: string }> = []

    const nestedWorktreePaths = new Set<string>()
    for (const { project, folders } of persisted) {
      const root = resolve(project.path)
      for (const folder of folders) if (folder !== root) nestedWorktreePaths.add(folder)
    }

    for (const { project, folders, primaryGranted } of persisted) {
      if (nestedWorktreePaths.has(resolve(project.path))) continue
      let sessionCount = 0
      for (const folder of folders) sessionCount += sessionStats.get(folder)?.count ?? 0
      const record: ProjectRecord = {
        id: project.id, harness: project.harness, name: project.name, path: project.path, folders: project.folders, primaryFolder: project.primaryFolder,
        pinned: project.pinned, createdAt: project.createdAt, lastOpenedAt: project.lastOpenedAt, scripts: project.scripts ? { ...project.scripts } : undefined,
        sessionCount,
        gitBranch: undefined,
      }
      records.push(record)
      if (primaryGranted) branchTargets.push({ record, cwd: project.primaryFolder })
    }

    for (const { canonical } of discoveredSessionRoots) {
      const stats = sessionStats.get(canonical)
      const record: ProjectRecord = {
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
        readOnly: true,
      }
      records.push(record)
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
    return sortProjects(records, 'recent')
  }

  async resolveCheckoutProject(idValue: unknown): Promise<ProjectRecord> {
    const id = requireId(idValue, 'project id')
    const project = (await this.list()).find((record) => record.id === id && !record.inferred && !record.readOnly)
    if (!project) throw new TypeError('Project is not explicitly granted to this harness')
    const primaryFolder = await this.authorizeCwd(project.primaryFolder)
    return { ...project, primaryFolder }
  }

  async refreshCheckoutProject(idValue: unknown): Promise<ProjectRecord> {
    return this.resolveCheckoutProject(idValue)
  }

  async adoptCheckoutWorktree(idValue: unknown, parentCwdValue: unknown, pathValue: unknown): Promise<ProjectRecord> {
    const id = requireId(idValue, 'project id')
    const project = await this.resolveCheckoutProject(id)
    const parentCwd = await this.authorizeCwd(requireString(parentCwdValue, 'cwd', { min: 1, max: 4096 }))
    if (resolve(project.primaryFolder) !== parentCwd) throw new TypeError('worktree parent project is not an authorized grant')
    const requested = resolve(requireString(pathValue, 'worktree path', { min: 1, max: 4096 }))
    const linked = (await listGitWorktrees(parentCwd)).find((worktree) => resolve(worktree.path) === requested)
    if (!linked) throw new TypeError('worktree path is not linked to the authorized Git repository')
    const { path, identity } = await this.captureFolderIdentity(linked.path)
    const next = await this.persistWorktree(parentCwd, path, identity)
    if (next.id !== id) throw new TypeError('worktree belongs to a different project grant')
    return next
  }

  async chooseCheckoutWorktreePath(cwdValue: unknown, branchValue: unknown, worktrees: readonly GitWorktree[]): Promise<string | undefined> {
    const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
    const branch = requireString(branchValue, 'branch', { min: 1, max: 255, trim: true })
    const current = worktrees.find((worktree) => worktree.current) ?? worktrees.find((worktree) => resolve(worktree.path) === cwd)
    if (!current) throw new Error('Git worktree list did not include the current worktree')
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+|\.+$/g, '').slice(0, 120) || 'worktree'
    const defaultPath = join(dirname(current.path), `${basename(current.path)}-${safeBranch}`)
    const parent = this.windowProvider()
    const options = { title: 'Create Git worktree', buttonLabel: 'Create Worktree', defaultPath }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return undefined
    const targetPath = resolve(requireString(result.filePath, 'worktree path', { min: 1, max: 4096 }))
    if (await this.isBroadRoot(targetPath)) throw new TypeError('Broad filesystem roots cannot be added as worktrees')
    return targetPath
  }

  /**
   * Grants `path` to this harness: undismisses it, refreshes or creates the
   * owning persisted project, publishes the authorization, and returns the
   * enriched record. `knownSessions` reuses an already-loaded session list.
   */
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

  private async persistWorktree(parentCwd: string, path: string, identity: FolderIdentity): Promise<ProjectRecord> {
    if (await this.isBroadRoot(path)) throw new TypeError('Broad filesystem roots cannot be added as projects')
    this.removalRoots.delete(path)
    const now = new Date().toISOString()
    let parentId: string | undefined
    for (const item of this.ownProjects(this.store.snapshot().projects)) {
      for (const candidate of new Set([item.path, ...item.folders])) {
        try {
          if (await requireExistingDirectory(candidate, 'project folder') === parentCwd) {
            parentId = item.id
            break
          }
        } catch { /* missing configured folders do not identify the parent grant */ }
      }
      if (parentId) break
    }
    if (!parentId) throw new TypeError('worktree parent project is not an authorized grant')
    const project = await this.store.update((state): PersistedProject => {
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
      const own = this.ownProjects(state.projects)
      const parent = own.find((item) => item.id === parentId)
      if (!parent) throw new TypeError('worktree parent project is not an authorized grant')
      const absorbed = own.filter((item) => item.id !== parent.id && (resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path)))
      const folders = new Set(parent.folders.map((folder) => resolve(folder)))
      folders.add(path)
      const identities = { ...parent.folderIdentities, [path]: identity }
      for (const item of absorbed) {
        for (const folder of item.folders) folders.add(resolve(folder))
        Object.assign(identities, item.folderIdentities)
        identities[path] = identity
      }
      parent.folders = [...folders]
      parent.primaryFolder = path
      parent.lastOpenedAt = now
      parent.folderIdentities = identities
      if (absorbed.length) {
        const absorbedIds = new Set(absorbed.map((item) => item.id))
        state.projects = state.projects.filter((item) => !absorbedIds.has(item.id))
      }
      return parent
    })
    this.authorizationRevision += 1
    this.authorizedRoots.set(path, identity)
    const sessions = await this.sessionProvider()
    const granted = new Set(project.folders.map((folder) => resolve(folder)))
    return {
      ...project,
      sessionCount: sessions.filter((session) => granted.has(resolve(session.projectPath))).length,
      gitBranch: await this.branchProvider(project.primaryFolder),
    }
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
    if (!discovered) throw new TypeError(`Project path was not discovered from a ${HARNESSES[this.harness].productName} session`)
    return this.grantProjectFolder(path, identity, sessions)
  }

  async remove(idValue: unknown): Promise<boolean> {
    const authorizationRevision = ++this.authorizationRevision
    const id = requireId(idValue, 'project id')
    const roots: string[] = []
    try {
      this.pendingRemovalIds.add(id)

      const persisted = this.ownProjects(this.store.snapshot().projects).find((project) => project.id === id)
      const persistedPaths: string[] = []
      if (persisted) {
        for (const folder of persisted.folders) {
          const configured = resolve(folder)
          persistedPaths.push(configured)
          this.removalRoots.add(configured)
          this.authorizedRoots.delete(configured)
          this.readOnlyRoots.delete(configured)
          try {
            const canonical = await requireExistingDirectory(configured, 'project folder')
            if (canonical !== configured) {
              persistedPaths.push(canonical)
              this.removalRoots.add(canonical)
              this.authorizedRoots.delete(canonical)
              this.readOnlyRoots.delete(canonical)
            }
          } catch { /* Keep the lexical path dismissed even when it is stale. */ }
        }
      }

      let inferredPath: string | undefined
      if (!persisted) {
        // Synchronously match any known in-memory root for this inferred ID before awaiting
        for (const root of [...this.readOnlyRoots.keys(), ...this.authorizedRoots.keys()]) {
          if (inferredId(root) === id) {
            inferredPath = root
            this.removalRoots.add(root)
            this.readOnlyRoots.delete(root)
            this.authorizedRoots.delete(root)
            break
          }
        }

        if (!inferredPath) {
          const sessions = await this.sessionProvider()
          for (const pathValue of [...new Set(sessions.map((session) => session.projectPath).filter((p): p is string => Boolean(p)))]) {
            try {
              const path = await requireExistingDirectory(pathValue, 'session project path')
              if (inferredId(path) === id && !(await this.isBroadRoot(path))) {
                inferredPath = path
                this.removalRoots.add(path)
                this.readOnlyRoots.delete(path)
                this.authorizedRoots.delete(path)
                break
              }
            } catch { /* Not a removable inferred project. */ }
          }
        }
      }

      roots.push(...(persisted ? persistedPaths : inferredPath ? [inferredPath] : []))
      if (roots.length) {
        for (const root of roots) this.removalRoots.add(root)
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
      try {
        if (authorizationRevision === this.authorizationRevision) await this.rebuildAuthorizedRoots(authorizationRevision)
      } finally {
        for (const root of roots) this.removalRoots.delete(root)
        this.pendingRemovalIds.delete(id)
      }
    }
  }

  /** Rebuilds authorization into fresh maps and swaps them in one step. */
  private async rebuildAuthorizedRoots(authorizationRevision: number): Promise<void> {
    if (authorizationRevision !== this.authorizationRevision) return
    await this.refreshAuthorization(true)
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

  async setPinned(idValue: unknown, pinnedValue: unknown): Promise<boolean> {
    const id = requireId(idValue, 'project id')
    const pinned = requireBoolean(pinnedValue, 'pinned')
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project) return false
      project.pinned = pinned
      return true
    })
  }

  async updateScripts(idValue: unknown, scriptsValue: unknown): Promise<ProjectScripts> {
    const id = requireId(idValue, 'project id')
    const input = requireRecord(scriptsValue, 'project scripts')
    rejectUnknownKeys(input, ['setup', 'run'], 'project scripts')
    const setup = requireString(input.setup, 'setup script', { max: 64 * 1024, trim: true })
    const run = requireString(input.run, 'run script', { max: 64 * 1024, trim: true })
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project) throw new Error('Project is not explicitly granted to this harness')
      const previous = project.scripts
      project.scripts = {
        setup,
        run,
        setupLastRun: previous?.setupLastRun,
        setupLastExitCode: previous?.setupLastExitCode,
      }
      if (previous?.setup !== setup) {
        project.scripts.setupLastRun = undefined
        project.scripts.setupLastExitCode = undefined
      }
      return { ...project.scripts }
    })
  }

  async markSetupStarted(idValue: unknown, setupValue: unknown): Promise<ProjectScripts> {
    const id = requireId(idValue, 'project id')
    const setup = requireString(setupValue, 'setup script', { min: 1, max: 64 * 1024 })
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project?.scripts || project.scripts.setup !== setup) throw new Error('Project setup script changed before it could start')
      project.scripts.setupLastRun = setup
      project.scripts.setupLastExitCode = undefined
      return { ...project.scripts }
    })
  }

  async finishSetup(idValue: unknown, setupValue: unknown, exitCodeValue: unknown): Promise<ProjectScripts | undefined> {
    const id = requireId(idValue, 'project id')
    const setup = requireString(setupValue, 'setup script', { min: 1, max: 64 * 1024 })
    const exitCode = requireInteger(exitCodeValue, 'setup exit code', -2_147_483_648, 2_147_483_647)
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project?.scripts || project.scripts.setup !== setup || project.scripts.setupLastRun !== setup) return undefined
      project.scripts.setupLastExitCode = exitCode
      return { ...project.scripts }
    })
  }

  async listFiles(rootValue: unknown): Promise<ProjectFileListing> {
    const root = await this.authorizeReadOnlyCwd(rootValue as string)
    const entries: ProjectFileEntry[] = []
    let skipped = 0
    const ignoredDirectories = new Set([
      '.git',
      'node_modules',
      'vendor',
      'out',
      'dist',
      'build',
      'release',
      'coverage',
      '.next',
      '.venv',
    ])
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

  private async authorizedRootFor(path: string, options: { readOnly?: boolean } = {}): Promise<string> {
    const isReadOnly = options.readOnly === true
    const isPendingRemoval = this.pendingRemovalIds.has(inferredId(path)) || [...this.removalRoots].some((root) => isPathWithin(root, path))
    let refreshedAuthorization = false
    if (!isPendingRemoval && !this.authorizedRoots.size && (!isReadOnly || !this.readOnlyRoots.size)) {
      await this.refreshAuthorization()
      refreshedAuthorization = true
    }
    const authorizationRevision = this.authorizationRevision
    const snapshot = this.store.snapshot()
    const dismissed = await this.resolveDismissedProjectPaths(snapshot.dismissedProjectPaths)
    const ownPersistedFolders = new Set(this.ownProjects(snapshot.projects).flatMap((p) => p.folders.map((f) => resolve(f))))

    const checkRoots = async (map: Map<string, FolderIdentity>, isReadOnlyMap: boolean): Promise<string | undefined> => {
      const roots: string[] = []
      for (const [configured, expected] of map) {
        if (this.removalRoots.has(configured) || this.pendingRemovalIds.has(inferredId(configured))) continue
        if (isReadOnlyMap && dismissed.has(configured) && !ownPersistedFolders.has(configured)) {
          map.delete(configured)
          continue
        }
        const verified = await this.verifyFolderIdentity(configured, expected)
        if (!verified) { map.delete(configured); continue }
        if (isReadOnlyMap && dismissed.has(verified.path) && !ownPersistedFolders.has(configured)) {
          map.delete(configured)
          continue
        }
        if (!folderIdentitiesEqual(expected, verified.identity)) {
          if (!isReadOnlyMap) {
            const refreshed = await this.persistFolderIdentityRefreshes([{
              configured,
              canonical: verified.path,
              expected,
              current: verified.identity,
            }], authorizationRevision)
            if (!refreshed.has(configured)) { map.delete(configured); continue }
          }
          // Read-only roots are re-captured by the next discovery pass; refreshing in place would only hide drift.
          if (!isReadOnlyMap) map.set(configured, verified.identity)
        }
        if (this.removalRoots.has(verified.path) || this.pendingRemovalIds.has(inferredId(verified.path))) continue
        roots.push(verified.path)
      }
      return roots.filter((root) => isPathWithin(root, path)).sort((a, b) => b.length - a.length)[0]
    }

    let authorizedRoot = await checkRoots(this.authorizedRoots, false)
    if (!authorizedRoot && isReadOnly) {
      authorizedRoot = await checkRoots(this.readOnlyRoots, true)
    }

    if (authorizationRevision !== this.authorizationRevision) {
      throw new TypeError('project authorization changed while the request was being checked')
    }

    if (!authorizedRoot && isReadOnly && !isPendingRemoval && !refreshedAuthorization) {
      await this.refreshAuthorization()
      if (authorizationRevision !== this.authorizationRevision) {
        throw new TypeError('project authorization changed while the request was being checked')
      }
      authorizedRoot = await checkRoots(this.authorizedRoots, false)
      if (!authorizedRoot) {
        authorizedRoot = await checkRoots(this.readOnlyRoots, true)
      }
    }

    if (!authorizedRoot) {
      const productName = HARNESSES[this.harness].productName
      if ([...this.removalRoots].some((root) => isPathWithin(root, path)) || this.pendingRemovalIds.has(inferredId(path))) {
        throw new TypeError(`path is not inside an added ${productName} project because its project is being removed`)
      }
      if ([...this.quarantinedBroadRoots].some((root) => isPathWithin(root, path))) {
        throw new TypeError(`path is covered by an unsafe broad ${productName} project grant; remove it and add a narrower project folder`)
      }
      throw new TypeError(`path is not inside an added ${productName} project or its folder identity changed`)
    }
    return authorizedRoot
  }

  async authorizePath(value: string): Promise<string> {
    const path = await requireExistingPath(value)
    await this.authorizedRootFor(path, { readOnly: true })
    return path
  }

  async authorizeProjectRoot(value: string): Promise<string> {
    const path = await requireExistingDirectory(value, 'project path')
    return await this.authorizedRootFor(path, { readOnly: false })
  }

  async authorizeCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizedRootFor(cwd, { readOnly: false })
    return cwd
  }

  async authorizeReadOnlyCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizedRootFor(cwd, { readOnly: true })
    return cwd
  }
}
