import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveGitExecutable, restrictedGitEnvironment, runProcess } from './process-utils'

const GIT_CONFIG_OUTPUT_LIMIT = 512 * 1024

export async function readGlobalConfigValue(cwd: string, key: 'user.name' | 'user.email'): Promise<string | undefined> {
  const env = restrictedGitEnvironment()
  delete env.GIT_CONFIG_GLOBAL
  for (const name of process.platform === 'win32' ? ['USERPROFILE', 'HOME', 'XDG_CONFIG_HOME'] : ['HOME', 'XDG_CONFIG_HOME']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const result = await runProcess(resolveGitExecutable(cwd), ['--no-pager', 'config', '--global', '--no-includes', '--get', key], {
    cwd,
    timeoutMs: 5_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
    env,
  })
  if (result.code === 1 && !result.timedOut && !result.outputExceeded) return undefined
  if (result.code !== 0 || result.timedOut || result.outputExceeded) throw new Error('Git global configuration inspection failed')
  return result.stdout.trim() || undefined
}

function validExcludesFilePath(value: string): string | undefined {
  let candidate = value.trim()
  if (!candidate || candidate.length > 4096 || /[\0\r\n]/.test(candidate)) return undefined
  if (candidate === '~' || candidate.startsWith('~/')) {
    candidate = join(homedir(), candidate.slice(1))
  } else if (process.platform === 'win32' && /^%USERPROFILE%($|[/\\])/i.test(candidate)) {
    const profile = process.env.USERPROFILE
    if (!profile) return undefined
    candidate = join(profile, candidate.slice('%USERPROFILE%'.length))
  }
  return isAbsolute(candidate) ? candidate : undefined
}

export interface ProtectedScopeSettings {
  safeDirectories: string[]
  values: Map<string, string>
}

/** Reads only protected scopes; repository and command-scope entries never grant trust. */
export function parseProtectedScopeSettings(output: string): ProtectedScopeSettings {
  const settings: ProtectedScopeSettings = { safeDirectories: [], values: new Map() }
  const fields = output.split('\0')
  let safeBytes = 0
  let safeOverflow = false
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]
    if (scope !== 'system' && scope !== 'global') continue
    const record = fields[index + 1]
    const separator = record.indexOf('\n')
    const key = (separator < 0 ? record : record.slice(0, separator)).toLowerCase()
    const value = separator < 0 ? '' : record.slice(separator + 1)
    if (/[\0\r\n]/.test(value)) continue
    if (key === 'safe.directory') {
      safeBytes += Buffer.byteLength(value)
      if (value.length > 4096 || settings.safeDirectories.length >= 256 || safeBytes > 16 * 1024) safeOverflow = true
      else settings.safeDirectories.push(value)
    } else if (key === 'core.excludesfile') {
      const path = validExcludesFilePath(value)
      if (path) settings.values.set(key, path)
    } else if (key === 'core.autocrlf') {
      const normalized = value.trim().toLowerCase()
      if (['true', 'yes', 'on', '1', ''].includes(normalized)) settings.values.set(key, 'true')
      else if (['false', 'no', 'off', '0'].includes(normalized)) settings.values.set(key, 'false')
      else if (normalized === 'input') settings.values.set(key, normalized)
    } else if (key === 'core.eol') {
      const normalized = value.trim().toLowerCase()
      if (['lf', 'crlf', 'native'].includes(normalized)) settings.values.set(key, normalized)
    }
  }
  // Truncating trust entries could drop a later empty reset and broaden authority.
  if (safeOverflow) settings.safeDirectories = []
  return settings
}

const PROTECTED_CONFIG_TTL_MS = 30_000
let protectedCache: { key: string; expiresAt: number; promise: Promise<ProtectedScopeSettings> } | undefined

export function readProtectedScopeSettings(cwd: string): Promise<ProtectedScopeSettings> {
  const key = JSON.stringify([process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.USERPROFILE, process.env.PATH, process.env.Path])
  const now = Date.now()
  if (protectedCache?.key === key && protectedCache.expiresAt > now) return protectedCache.promise
  const promise = (async (): Promise<ProtectedScopeSettings> => {
    try {
      const env = restrictedGitEnvironment()
      delete env.GIT_CONFIG_NOSYSTEM
      delete env.GIT_CONFIG_SYSTEM
      delete env.GIT_CONFIG_GLOBAL
      const result = await runProcess(resolveGitExecutable(cwd), [
        '--no-pager', 'config', '--show-scope', '--null', '--no-includes', '--get-regexp',
        '^(safe\\.directory|core\\.(excludesfile|autocrlf|eol))$',
      ], { cwd, timeoutMs: 5_000, maxBytes: GIT_CONFIG_OUTPUT_LIMIT, env })
      if (result.code === 0 && !result.timedOut && !result.outputExceeded) return parseProtectedScopeSettings(result.stdout)
    } catch { /* Unavailable protected configuration never grants ownership trust. */ }
    return { safeDirectories: [], values: new Map() }
  })()
  protectedCache = { key, expiresAt: now + PROTECTED_CONFIG_TTL_MS, promise }
  return promise
}

/** Repository scalar settings retain their usual precedence over protected defaults. */
export async function protectedScopeOverrides(cwd: string, config: ReadonlyMap<string, string>): Promise<string[]> {
  const localKeys = new Set([...config.keys()].map((key) => key.toLowerCase()))
  const { values } = await readProtectedScopeSettings(cwd)
  return [...values].filter(([key]) => !localKeys.has(key)).map(([key, value]) => `${key}=${value}`)
}
