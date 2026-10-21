import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveGitExecutable, restrictedGitEnvironment, runProcess } from './process-utils'

const GIT_CONFIG_OUTPUT_LIMIT = 512 * 1024

export async function readGlobalConfigValue(cwd: string, key: 'user.name' | 'user.email' | 'core.excludesFile'): Promise<string | undefined> {
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

// The value is global scope, so the cache key is the environment the read
// resolves against; the TTL bounds staleness for status polling without a
// respawn of `git config` per call.
const GLOBAL_EXCLUDES_CACHE_TTL_MS = 30_000
let globalExcludesCache: { key: string; value: string | undefined; expiresAt: number } | undefined

async function readGlobalExcludesFile(cwd: string): Promise<string | undefined> {
  const key = `${process.env.HOME ?? ''}|${process.env.XDG_CONFIG_HOME ?? ''}|${process.env.USERPROFILE ?? ''}`
  const now = Date.now()
  if (globalExcludesCache && globalExcludesCache.key === key && globalExcludesCache.expiresAt > now) {
    return globalExcludesCache.value
  }
  let value: string | undefined
  try {
    const raw = await readGlobalConfigValue(cwd, 'core.excludesFile')
    if (raw !== undefined) value = validExcludesFilePath(raw)
  } catch {
    value = undefined
  }
  globalExcludesCache = { key, value, expiresAt: now + GLOBAL_EXCLUDES_CACHE_TTL_MS }
  return value
}

/**
 * `restrictedGitEnvironment` disables the global config scope, so a user's
 * `core.excludesFile` never reaches Git on its own. Read that one key safely
 * and supply it via `-c` so status, diff, and restore match plain `git status`.
 * A repository-scope setting must still win: `-c` would otherwise override it.
 */
export async function protectedScopeOverrides(cwd: string, config: ReadonlyMap<string, string>): Promise<string[]> {
  for (const key of config.keys()) {
    if (key.toLowerCase() === 'core.excludesfile') return []
  }
  const path = await readGlobalExcludesFile(cwd)
  return path ? [`core.excludesFile=${path}`] : []
}

