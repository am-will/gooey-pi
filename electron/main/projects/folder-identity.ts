import { lstat, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import { posix, resolve, win32 } from 'node:path'
import type { FolderIdentity } from '../store'
import { requireString } from '../validation'

/** Filesystem roots too broad to grant: volume/share roots, home, and home ancestors. */
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
  return path === root || path === home || home.startsWith(`${path}${pathApi.sep}`) || extendedUncShareRoot
}

export interface VerifiedFolderIdentity {
  path: string
  identity: FolderIdentity
}

export interface FolderIdentityFilesystem {
  lstat(path: string): Promise<BigIntStats>
  realpath(path: string): Promise<string>
}

export const defaultFolderIdentityFilesystem: FolderIdentityFilesystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
}

export function folderIdentitiesEqual(left: FolderIdentity, right: FolderIdentity): boolean {
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

export class FolderIdentityVerifier {
  private canonicalHomeRoot: Promise<string> | undefined

  constructor(private readonly filesystem: FolderIdentityFilesystem = defaultFolderIdentityFilesystem) {}

  async capture(pathValue: string): Promise<{ path: string; identity: FolderIdentity }> {
    const configured = resolve(requireString(pathValue, 'project folder', { min: 1, max: 4096 }))
    const configuredInfo = await this.filesystem.lstat(configured)
    if (!configuredInfo.isDirectory() || configuredInfo.isSymbolicLink()) throw new TypeError('Project folder must be a stable directory')
    const path = await this.filesystem.realpath(configured)
    const canonicalInfo = await this.filesystem.lstat(path)
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

  async isBroadRoot(path: string): Promise<boolean> {
    this.canonicalHomeRoot ??= this.filesystem.realpath(resolve(homedir())).catch(() => resolve(homedir()))
    return isBroadProjectRoot(path, { homePath: await this.canonicalHomeRoot })
  }

  async verify(pathValue: string, expected?: FolderIdentity, grantedAt?: string): Promise<VerifiedFolderIdentity | undefined> {
    if (!expected) return undefined
    try {
      const current = await this.capture(pathValue)
      return isSameFolderIdentity(expected, current.identity, grantedAt) ? current : undefined
    } catch { return undefined }
  }

}
