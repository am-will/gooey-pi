import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { PROJECT_FILE_LISTING_LIMIT, type ProjectFileEntry, type ProjectFileListing } from '../../src/types/api'

const IGNORED_LISTING_DIRECTORIES = new Set([
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

/**
 * Lists files and directories under an already-authorized root for the Files
 * panel. The walk is breadth-first so the entry budget only cuts the deepest
 * levels: one large early folder cannot starve root files or later siblings.
 * The budget applies per root (one project folder), and `truncated` reports
 * whether it hid any listable entry.
 */
export async function listProjectFiles(root: string, maxEntries = PROJECT_FILE_LISTING_LIMIT): Promise<ProjectFileListing> {
  const entries: ProjectFileEntry[] = []
  let skipped = 0
  let truncated = false
  const directories = [root]

  for (let index = 0; index < directories.length && !truncated; index += 1) {
    const directory = directories[index]
    let children: Dirent[]
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      // An unreadable directory (permissions, races) must not fail the whole
      // listing; report it so the UI can note the gap.
      skipped += 1
      continue
    }
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const child of children) {
      if (child.isSymbolicLink()) continue
      if (child.isDirectory() && IGNORED_LISTING_DIRECTORIES.has(child.name)) continue
      if (!child.isDirectory() && !child.isFile()) continue
      // Only a child that would have been listed proves the listing is cut;
      // trailing symlinks, ignored trees and empty folders hide nothing.
      if (entries.length >= maxEntries) { truncated = true; break }
      const absolutePath = resolve(directory, child.name)
      const relativePath = relative(root, absolutePath)
      const path = process.platform === 'win32' ? relativePath.split('\\').join('/') : relativePath
      entries.push({ path, type: child.isDirectory() ? 'directory' : 'file' })
      if (child.isDirectory()) directories.push(absolutePath)
    }
  }

  return { entries, skipped, truncated }
}
