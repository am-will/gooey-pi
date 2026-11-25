import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { isRecord } from './validation'

const VALIDATION_ERROR_BRAND = Symbol.for('gooeypi.executableValidationError')
const VALIDATION_ERROR_CODES = [
  'SHIM_MISMATCH',
  'NODE_MISSING',
  'PI_MANAGED_METADATA_INVALID',
  'PI_MANAGED_VERSION_INVALID',
  'PI_MANAGED_BUNDLE_MISSING',
] as const

export type ExecutableValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number]
const VALID_CODE_SET: ReadonlySet<string> = new Set(VALIDATION_ERROR_CODES)

export class ExecutableValidationError extends Error {
  readonly code: ExecutableValidationErrorCode
  readonly [VALIDATION_ERROR_BRAND] = true

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
      && Reflect.get(error, VALIDATION_ERROR_BRAND) === true
      && typeof error.code === 'string'
      && VALID_CODE_SET.has(error.code)
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
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

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

const stripBom = (value: string): string => (value.startsWith('\uFEFF') ? value.slice(1) : value)

export function isDriveOrUncWin32Path(value: string): boolean {
  return Boolean(value) && value.length <= 4096 && !value.includes('\0')
    && /^(?:[A-Za-z]:[\\/]|\\\\\?\\(?:[A-Za-z]:[\\/]|UNC\\[^\\/?*<>|]+[\\/][^\\/?*<>|]+)|\\\\[^\\/?*<>|]+[\\/][^\\/?*<>|]+)/.test(value)
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

function requireEntry(
  fs: PiManagedInstallFs,
  path: string,
  expectDir: boolean,
  code: ExecutableValidationErrorCode,
  label: string,
): void {
  let stat: ManagedStatEntry
  try {
    stat = fs.lstatSync(path)
  } catch (error) {
    const missing = isRecord(error) && error.code === 'ENOENT'
    throw new ExecutableValidationError(code, `${label} is ${missing ? 'missing' : 'unreadable'}`)
  }
  if (stat.isSymbolicLink() || (expectDir ? !stat.isDirectory() : !stat.isFile())) {
    throw new ExecutableValidationError(code, `${label} must be a ${expectDir ? 'real directory' : 'regular file'}`)
  }
}

function canonicalPath(fs: PiManagedInstallFs, path: string, code: ExecutableValidationErrorCode, label: string): string {
  try {
    return normalizeWin32(fs.realpathSync(path))
  } catch {
    throw new ExecutableValidationError(code, `${label} could not be resolved`)
  }
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
    throw new ExecutableValidationError(code, `${label} could not be read`)
  }
  if (raw.truncated) throw new ExecutableValidationError(code, `${label} exceeds the size limit`)
  return stripBom(raw.content)
}

function validEntrypointField(entrypoint: unknown, normalizedShim: string, canonicalShim: string): boolean {
  if (entrypoint === undefined) return true
  if (!isRecord(entrypoint)) return false
  if (entrypoint.package !== undefined && entrypoint.package !== OFFICIAL_PACKAGE) return false
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
      throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install directory is unreadable')
    }
  }

  requireEntry(fs, normalizedShim, false, 'PI_MANAGED_METADATA_INVALID', 'Pi managed-install command shim')
  requireEntry(fs, binDir, true, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install bin directory')
  requireEntry(fs, agentDir, true, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install agent directory')
  requireEntry(fs, installRoot, true, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install directory')

  const canonicalShim = canonicalPath(fs, normalizedShim, 'PI_MANAGED_METADATA_INVALID', 'Pi managed-install command shim')
  const canonicalAgentDir = canonicalPath(fs, agentDir, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install agent directory')
  const canonicalInstallRoot = canonicalPath(fs, installRoot, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install directory')
  if (!isStrictChild(canonicalAgentDir, canonicalShim) || !isStrictChild(canonicalAgentDir, canonicalInstallRoot)) {
    throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install directory escapes the Pi agent root')
  }

  const markerPath = win32.join(installRoot, 'managed-install.json')
  requireEntry(fs, markerPath, false, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata (managed-install.json)')
  if (!isStrictChild(canonicalInstallRoot, canonicalPath(fs, markerPath, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata'))) {
    throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata escapes the install root')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readBoundedText(fs, markerPath, MAX_MANIFEST_BYTES, 'PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata'))
  } catch (error) {
    if (isExecutableValidationError(error)) throw error
    throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata (managed-install.json) is invalid JSON')
  }
  if (!isRecord(manifest) || manifest.kind !== 'pi-managed-install' || manifest.schemaVersion !== 1 || manifest.layout !== 'releases-v1') {
    throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install metadata is not a supported releases-v1 layout')
  }
  if (!validEntrypointField(manifest.entrypoint, normalizedShim, canonicalShim)) {
    throw new ExecutableValidationError('PI_MANAGED_METADATA_INVALID', 'Pi managed install entrypoint metadata does not match the official Pi bundle')
  }

  const versionPath = win32.join(installRoot, 'current-version')
  requireEntry(fs, versionPath, false, 'PI_MANAGED_VERSION_INVALID', 'Pi managed install current-version')
  if (!isStrictChild(canonicalInstallRoot, canonicalPath(fs, versionPath, 'PI_MANAGED_VERSION_INVALID', 'Pi managed install current-version'))) {
    throw new ExecutableValidationError('PI_MANAGED_VERSION_INVALID', 'Pi managed install current-version escapes the install root')
  }
  const version = readBoundedText(fs, versionPath, MAX_VERSION_BYTES, 'PI_MANAGED_VERSION_INVALID', 'Pi managed install current-version').trim()
  if (!version || version.length > 128 || version.includes('..') || !RELEASE_VERSION.test(version)) {
    throw new ExecutableValidationError('PI_MANAGED_VERSION_INVALID', 'Pi managed install current-version is invalid')
  }

  const releasesDir = win32.join(installRoot, 'releases')
  requireEntry(fs, releasesDir, true, 'PI_MANAGED_BUNDLE_MISSING', 'Pi managed install releases directory')
  const releaseDir = win32.join(releasesDir, version)
  requireEntry(fs, releaseDir, true, 'PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version}`)
  const canonicalReleaseDir = canonicalPath(fs, releaseDir, 'PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version}`)
  if (!isStrictChild(canonicalInstallRoot, canonicalReleaseDir)) {
    throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version} escapes the install root`)
  }

  let cursor = releaseDir
  for (const segment of BUNDLE_SEGMENTS.slice(0, -1)) {
    cursor = win32.join(cursor, segment)
    let segStat: ManagedStatEntry
    try {
      segStat = fs.lstatSync(cursor)
    } catch (error) {
      const missing = isRecord(error) && error.code === 'ENOENT'
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', missing ? `Pi managed install release ${version} is missing the official Pi bundle` : `Pi managed install release ${version} cannot be inspected`)
    }
    if (segStat.isSymbolicLink() || !segStat.isDirectory()) {
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version} contains an unexpected link or non-directory`)
    }
  }

  const pkgPath = win32.join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')
  let hasPkg = false
  try {
    const pkgStat = fs.lstatSync(pkgPath)
    if (pkgStat.isSymbolicLink() || !pkgStat.isFile()) {
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version} package manifest must be a regular file`)
    }
    hasPkg = true
  } catch (error) {
    if (isExecutableValidationError(error)) throw error
    if (!(isRecord(error) && error.code === 'ENOENT')) {
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', `Pi managed install release ${version} package manifest is unreadable`)
    }
  }
  if (hasPkg) {
    let pkg: unknown
    try {
      pkg = JSON.parse(readBoundedText(fs, pkgPath, MAX_MANIFEST_BYTES, 'PI_MANAGED_BUNDLE_MISSING', 'Pi managed install package manifest'))
    } catch (error) {
      if (isExecutableValidationError(error)) throw error
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', 'Pi managed install package manifest is invalid JSON')
    }
    if (!isRecord(pkg) || pkg.name !== OFFICIAL_PACKAGE || (pkg.version !== undefined && pkg.version !== version)) {
      throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', 'Pi managed install package manifest does not match the official Pi package')
    }
  }

  const bundlePath = win32.join(releaseDir, ...BUNDLE_SEGMENTS)
  requireEntry(fs, bundlePath, false, 'PI_MANAGED_BUNDLE_MISSING', 'Pi managed install official bundle')
  const canonicalBundle = canonicalPath(fs, bundlePath, 'PI_MANAGED_BUNDLE_MISSING', 'Pi managed install official bundle')
  if (!isStrictChild(canonicalReleaseDir, canonicalBundle) || !canonicalBundle.toLowerCase().endsWith(BUNDLE_SUFFIX)) {
    throw new ExecutableValidationError('PI_MANAGED_BUNDLE_MISSING', 'Pi managed install official bundle escapes the release directory')
  }

  return { entrypoint: canonicalBundle, installRoot: canonicalInstallRoot, version }
}
