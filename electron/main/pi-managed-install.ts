import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { isRecord } from './validation'

const BRAND = Symbol.for('gooeypi.executableValidationError')
const CODES = new Set([
  'SHIM_MISMATCH',
  'NODE_MISSING',
  'PI_MANAGED_METADATA_INVALID',
  'PI_MANAGED_VERSION_INVALID',
  'PI_MANAGED_BUNDLE_MISSING',
] as const)

export type ExecutableValidationErrorCode =
  | 'SHIM_MISMATCH'
  | 'NODE_MISSING'
  | 'PI_MANAGED_METADATA_INVALID'
  | 'PI_MANAGED_VERSION_INVALID'
  | 'PI_MANAGED_BUNDLE_MISSING'

const META_ERR: ExecutableValidationErrorCode = 'PI_MANAGED_METADATA_INVALID'
const VER_ERR: ExecutableValidationErrorCode = 'PI_MANAGED_VERSION_INVALID'
const BUNDLE_ERR: ExecutableValidationErrorCode = 'PI_MANAGED_BUNDLE_MISSING'
const PREFIX = 'Pi managed install'

export class ExecutableValidationError extends Error {
  readonly code: ExecutableValidationErrorCode
  readonly [BRAND] = true

  constructor(code: ExecutableValidationErrorCode, message: string) {
    super(message)
    this.name = 'ExecutableValidationError'
    this.code = code
  }
}

export function isExecutableValidationError(error: unknown): error is ExecutableValidationError {
  return (
    error instanceof ExecutableValidationError
    || (isRecord(error)
      && Reflect.get(error, BRAND) === true
      && typeof error.code === 'string'
      && CODES.has(error.code as ExecutableValidationErrorCode)
      && typeof error.message === 'string')
  )
}

export interface ManagedStatEntry {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
}

export interface PiManagedInstallFs {
  lstatSync(path: string): ManagedStatEntry
  realpathSync(path: string): string
  readBoundedFileSync(path: string, maxBytes: number): { content: string; truncated: boolean }
}

export interface ResolvePiManagedInstallOptions {
  canAccess?: (candidate: string, mode: number) => boolean
  fs?: PiManagedInstallFs
}

export interface PiManagedInstallResolution {
  entrypoint: string
  installRoot: string
  version: string
}

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_VERSION_BYTES = 256
const OFFICIAL_PACKAGE = '@earendil-works/pi-coding-agent'
const BUNDLE_SEGMENTS = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'] as const
const BUNDLE_REL = BUNDLE_SEGMENTS.join('/')
const BUNDLE_SUFFIX = `\\${BUNDLE_SEGMENTS.join('\\')}`.toLowerCase()
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function readBoundedRegularFileSync(path: string, maxBytes: number): { content: string; truncated: boolean } {
  const fd = openSync(path, fsConstants.O_RDONLY)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Not a regular file')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (n === 0) break
      offset += n
    }
    return { content: buffer.subarray(0, Math.min(offset, maxBytes)).toString('utf8'), truncated: offset > maxBytes }
  } finally {
    closeSync(fd)
  }
}

const DEFAULT_FS: PiManagedInstallFs = { lstatSync, realpathSync, readBoundedFileSync: readBoundedRegularFileSync }

export function isDriveOrUncWin32Path(value: string): boolean {
  return Boolean(value) && value.length <= 4096 && !value.includes('\0')
    && /^(?:[A-Za-z]:[\\/]|\\\\\?\\(?:[A-Za-z]:[\\/]|UNC\\(?!\.[\\/])[^\\/?*<>|]+[\\/][^\\/?*<>|]+)|[\\/]{2}(?!\.[\\/])[^\\/?*<>|]+[\\/][^\\/?*<>|]+)/.test(value)
}

function normalizeWin32(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return win32.normalize(`\\\\${value.slice(8)}`)
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) return win32.normalize(value.slice(4))
  return win32.normalize(value)
}

function isStrictChild(root: string, candidate: string): boolean {
  const r = normalizeWin32(root).toLowerCase()
  const c = normalizeWin32(candidate).toLowerCase()
  if (r === c) return false
  const rel = win32.relative(win32.toNamespacedPath(r), win32.toNamespacedPath(c))
  return rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel)
}

function pinEntry(
  fs: PiManagedInstallFs,
  path: string,
  expectDir: boolean,
  parentRoot: string | null,
  code: ExecutableValidationErrorCode,
  label: string,
): string {
  let stat: ManagedStatEntry
  try {
    stat = fs.lstatSync(path)
  } catch (error) {
    throw new ExecutableValidationError(code, `${PREFIX} ${label} is ${isRecord(error) && error.code === 'ENOENT' ? 'missing' : 'unreadable'}`)
  }
  if (stat.isSymbolicLink() || (expectDir ? !stat.isDirectory() : !stat.isFile())) {
    throw new ExecutableValidationError(code, `${PREFIX} ${label} must be a ${expectDir ? 'real directory' : 'regular file'}`)
  }
  let real: string
  try {
    real = normalizeWin32(fs.realpathSync(path))
  } catch {
    throw new ExecutableValidationError(code, `${PREFIX} ${label} could not be resolved`)
  }
  if (parentRoot && !isStrictChild(parentRoot, real)) {
    throw new ExecutableValidationError(code, `${PREFIX} ${label} escapes its containment root`)
  }
  return real
}

function readBoundedText(
  fs: PiManagedInstallFs,
  path: string,
  maxBytes: number,
  code: ExecutableValidationErrorCode,
  label: string,
): string {
  let raw: { content: string; truncated: boolean }
  try {
    raw = fs.readBoundedFileSync(path, maxBytes)
  } catch {
    throw new ExecutableValidationError(code, `${PREFIX} ${label} could not be read`)
  }
  if (raw.truncated) throw new ExecutableValidationError(code, `${PREFIX} ${label} exceeds the size limit`)
  return raw.content.startsWith('\uFEFF') ? raw.content.slice(1) : raw.content
}

function validEntrypointField(entrypoint: unknown, normalizedShim: string, canonicalShim: string): boolean {
  if (entrypoint === undefined) return true
  if (!isRecord(entrypoint) || (entrypoint.package !== undefined && entrypoint.package !== OFFICIAL_PACKAGE)) return false
  if (typeof entrypoint.path !== 'string' || !entrypoint.path || entrypoint.path.length > 512 || entrypoint.path.includes('\0')) return false
  const rel = entrypoint.path.replaceAll('\\', '/')
  if (rel === BUNDLE_REL || (entrypoint.package === OFFICIAL_PACKAGE && rel === 'dist/bundle/cli.js')) return true
  if (!isDriveOrUncWin32Path(entrypoint.path)) return false
  const target = normalizeWin32(entrypoint.path).toLowerCase()
  return target === normalizedShim.toLowerCase() || target === canonicalShim.toLowerCase()
}

export function resolvePiManagedInstall(
  shimPath: string,
  options: ResolvePiManagedInstallOptions = {},
): PiManagedInstallResolution | null {
  if (!isDriveOrUncWin32Path(shimPath)) return null
  const normalizedShim = normalizeWin32(shimPath)
  if (win32.basename(normalizedShim).toLowerCase() !== 'pi.cmd') return null
  const binDir = win32.dirname(normalizedShim)
  if (win32.basename(binDir).toLowerCase() !== 'bin') return null
  const agentDir = win32.dirname(binDir)
  if (agentDir.toLowerCase() === binDir.toLowerCase()) return null

  const installRoot = win32.join(agentDir, 'install')
  if (options.canAccess && !options.canAccess(installRoot, fsConstants.F_OK)) return null

  const fs = options.fs ?? DEFAULT_FS
  if (!options.canAccess) {
    try {
      fs.lstatSync(installRoot)
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return null
      throw new ExecutableValidationError(META_ERR, `${PREFIX} directory is unreadable`)
    }
  }

  const canonicalAgentDir = pinEntry(fs, agentDir, true, null, META_ERR, 'agent directory')
  const canonicalBinDir = pinEntry(fs, binDir, true, canonicalAgentDir, META_ERR, 'bin directory')
  const canonicalShim = pinEntry(fs, normalizedShim, false, canonicalBinDir, META_ERR, 'command shim')
  const canonicalInstallRoot = pinEntry(fs, installRoot, true, canonicalAgentDir, META_ERR, 'directory')

  const markerPath = win32.join(installRoot, 'managed-install.json')
  pinEntry(fs, markerPath, false, canonicalInstallRoot, META_ERR, 'metadata')
  let manifest: unknown
  try {
    manifest = JSON.parse(readBoundedText(fs, markerPath, MAX_MANIFEST_BYTES, META_ERR, 'metadata'))
  } catch (error) {
    if (isExecutableValidationError(error)) throw error
    throw new ExecutableValidationError(META_ERR, `${PREFIX} metadata is invalid JSON`)
  }
  if (!isRecord(manifest) || manifest.kind !== 'pi-managed-install' || manifest.schemaVersion !== 1 || manifest.layout !== 'releases-v1') {
    throw new ExecutableValidationError(META_ERR, `${PREFIX} metadata is not a supported releases-v1 layout`)
  }
  if (!validEntrypointField(manifest.entrypoint, normalizedShim, canonicalShim)) {
    throw new ExecutableValidationError(META_ERR, `${PREFIX} entrypoint metadata does not match the official Pi bundle`)
  }

  const versionPath = win32.join(installRoot, 'current-version')
  pinEntry(fs, versionPath, false, canonicalInstallRoot, VER_ERR, 'current-version')
  const version = readBoundedText(fs, versionPath, MAX_VERSION_BYTES, VER_ERR, 'current-version').trim()
  if (version.length > 128 || !RELEASE_VERSION.test(version)) {
    throw new ExecutableValidationError(VER_ERR, `${PREFIX} current-version is invalid`)
  }

  const releasesDir = win32.join(installRoot, 'releases')
  const canonicalReleasesDir = pinEntry(fs, releasesDir, true, canonicalInstallRoot, BUNDLE_ERR, 'releases directory')
  const releaseDir = win32.join(releasesDir, version)
  const canonicalReleaseDir = pinEntry(fs, releaseDir, true, canonicalReleasesDir, BUNDLE_ERR, `release ${version}`)

  let cursor = releaseDir
  for (const segment of BUNDLE_SEGMENTS.slice(0, -1)) {
    cursor = win32.join(cursor, segment)
    pinEntry(fs, cursor, true, canonicalReleaseDir, BUNDLE_ERR, `release ${version} bundle directory`)
  }

  const pkgPath = win32.join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')
  let hasPkg = false
  try {
    fs.lstatSync(pkgPath)
    hasPkg = true
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT')) throw new ExecutableValidationError(BUNDLE_ERR, `${PREFIX} package manifest is unreadable`)
  }
  if (hasPkg) {
    pinEntry(fs, pkgPath, false, canonicalReleaseDir, BUNDLE_ERR, 'package manifest')
    let pkg: unknown
    try {
      pkg = JSON.parse(readBoundedText(fs, pkgPath, MAX_MANIFEST_BYTES, BUNDLE_ERR, 'package manifest'))
    } catch (error) {
      if (isExecutableValidationError(error)) throw error
      throw new ExecutableValidationError(BUNDLE_ERR, `${PREFIX} package manifest is invalid JSON`)
    }
    if (!isRecord(pkg) || pkg.name !== OFFICIAL_PACKAGE || (pkg.version !== undefined && pkg.version !== version)) {
      throw new ExecutableValidationError(BUNDLE_ERR, `${PREFIX} package manifest does not match the official Pi package`)
    }
  }

  const bundlePath = win32.join(releaseDir, ...BUNDLE_SEGMENTS)
  const canonicalBundle = pinEntry(fs, bundlePath, false, canonicalReleaseDir, BUNDLE_ERR, 'official bundle')
  if (!canonicalBundle.toLowerCase().endsWith(BUNDLE_SUFFIX)) {
    throw new ExecutableValidationError(BUNDLE_ERR, `${PREFIX} official bundle escapes the release directory`)
  }

  return { entrypoint: canonicalBundle, installRoot: canonicalInstallRoot, version }
}
