import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { errorMessage } from '../validation'
import { comparePaths } from './async'

/**
 * Prime editable-installs a bundled Python skill from the path GooeyPi hands it
 * and imports it in every kernel, so CPython writes `__pycache__` next to the
 * source. Inside a code-signed app bundle that adds unsealed files and breaks
 * the macOS signature, and the install also follows the bundle wherever the app
 * is moved or mounted. Prime is therefore pointed at a mirror in GooeyPi's
 * writable data directory, refreshed whenever the bundled content changes.
 */

const BYTECODE_CACHE = '__pycache__'

const isBytecodeCache = (path: string): boolean => path.split(sep).includes(BYTECODE_CACHE)

/** Digest of a skill's regular files: sorted relative paths and bytes, ignoring bytecode caches. */
async function skillDigest(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !isBytecodeCache(path))
    .sort(comparePaths)
  const hash = createHash('sha256')
  for (const path of files) {
    const bytes = await readFile(join(root, path))
    hash.update(`${path}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

/**
 * Mirrors `sourceDir` to `<targetRoot>/<basename>` and returns the mirror path.
 * An up-to-date mirror is left alone so its bytecode caches survive; otherwise a
 * complete copy is staged beside it and renamed into place. Any failure is
 * logged and the bundled path is returned, so startup never depends on the mirror.
 */
export async function mirrorBundledSkill(
  sourceDir: string,
  targetRoot: string,
  log: (message: string) => void = (message) => console.error(message),
): Promise<string> {
  const target = join(targetRoot, basename(sourceDir))
  try {
    const digest = await skillDigest(sourceDir)
    if (await skillDigest(target).catch(() => null) === digest) return target
    await mkdir(targetRoot, { recursive: true })
    const staging = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await cp(sourceDir, staging, { recursive: true, filter: (path) => basename(path) !== BYTECODE_CACHE })
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    return target
  } catch (error) {
    log(`GooeyPi could not mirror the bundled ${basename(sourceDir)} skill, using the bundled copy: ${errorMessage(error)}`)
    return sourceDir
  }
}
