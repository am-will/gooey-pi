import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { HarnessId } from '../../../src/types/api'
import type { JsonStateStore } from '../store'
import { requireExistingDirectory } from '../validation'
import type { FolderIdentityFilesystem } from './folder-identity'

/**
 * Resolves the main repository of a linked Git worktree from its `.git`
 * pointer file. Returns undefined for a normal checkout, a bare repository,
 * or anything that does not parse as a bounded worktree pointer.
 */
async function linkedWorktreeMainRepository(path: string, identityFilesystem: FolderIdentityFilesystem): Promise<string | undefined> {
  const pointer = join(path, '.git')
  try {
    const info = await identityFilesystem.lstat(pointer)
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
export async function absorbLinkedWorktreeProjects(store: JsonStateStore, harness: HarnessId, identityFilesystem: FolderIdentityFilesystem): Promise<void> {
  const own = store.getProjects().filter((project) => project.harness === harness)
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
    const mainRepository = await linkedWorktreeMainRepository(canonical, identityFilesystem)
    if (!mainRepository) continue
    const parentId = ownerByFolder.get(mainRepository)
    if (!parentId || parentId === project.id) continue
    absorptions.set(project.id, parentId)
  }
  if (!absorptions.size) return

  await store.update((state) => {
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
}

