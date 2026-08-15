import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ProcessOutcome } from '../../../src/types/api'
import { processOutcome, runProcess } from '../process-utils'
import { isLoopbackHostname, requireString, stripAnsi } from '../validation'

const NPM_REGISTRY_SOURCE_PARTS = /^npm:(?:@([a-z0-9][a-z0-9_.-]*)\/)?([a-z0-9][a-z0-9_.-]*)(?:@([-a-z0-9_!~*'()+^<>=|][a-z0-9._!~*'()+^<>=| -]*))?$/i
const NPM_SEMVER_PART = String.raw`[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?`
const NPM_SEMVER_COMPARATOR = String.raw`(?:<=|>=|<|>|=|~|\^)?\s*${NPM_SEMVER_PART}`
const NPM_SEMVER_SET = String.raw`(?:${NPM_SEMVER_PART}\s+-\s+${NPM_SEMVER_PART}|${NPM_SEMVER_COMPARATOR}(?:\s+${NPM_SEMVER_COMPARATOR})*)`
const NPM_SEMVER_RANGE = new RegExp(String.raw`^${NPM_SEMVER_SET}(?:\s*\|\|\s*${NPM_SEMVER_SET})*$`, 'i')

function isNpmRegistrySource(source: string): boolean {
  const parts = NPM_REGISTRY_SOURCE_PARTS.exec(source)
  if (!parts) return false
  const selector = parts[3]
  return selector === undefined || !/[\s|]|^[<>=~^]/.test(selector) || NPM_SEMVER_RANGE.test(selector)
}

function requireSecurePackageTransport(url: URL): void {
  if (url.protocol === 'git:') throw new TypeError('git:// package sources are not allowed; use HTTPS or SSH')
  // Match the existing self-hosted voice contract: plaintext HTTP is local-only.
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) throw new TypeError('Remote package sources must use HTTPS or SSH; plain HTTP is allowed only on this computer')
}

export function validatePackageSource(value: unknown, options: { allowOmpMarketplaceTarget?: boolean } = {}): string {
  const source = requireString(value, 'package source', { min: 1, max: 2_048, trim: true })
  if (source.startsWith('-') || /[\r\n\u2028\u2029]/.test(source)) throw new TypeError('Invalid package source')
  if (options.allowOmpMarketplaceTarget && /^[a-z0-9][a-z0-9.-]{0,63}@[a-z0-9][a-z0-9.-]{0,63}$/i.test(source)) return source
  if (source.startsWith('npm:')) {
    if (!isNpmRegistrySource(source)) throw new TypeError('Invalid npm package source')
    return source
  }
  if (source.startsWith('git:') && !source.startsWith('git://')) {
    const spec = source.slice(4)
    const protocolUrl = /^(?:https?|ssh|git):\/\//i.test(spec)
    const sshShorthand = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
    const hostShorthand = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
    if (!protocolUrl && !sshShorthand && !hostShorthand) throw new TypeError('Invalid git package source')
    if (protocolUrl) {
      let url: URL
      try { url = new URL(spec) } catch { throw new TypeError('Invalid git package URL') }
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
      requireSecurePackageTransport(url)
    }
    return source
  }
  if (/^(https?|ssh|git):\/\//i.test(source)) {
    let url: URL
    try { url = new URL(source.replace(/@([^/@]+)$/, '%40$1')) } catch { throw new TypeError('Invalid package URL') }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
    requireSecurePackageTransport(url)
    return source
  }
  if (isAbsolute(source)) {
    if (!existsSync(source)) throw new TypeError('Local package path does not exist')
    return realpathSync(source)
  }
  throw new TypeError('Package source must be npm:, git:, a protocol URL, or an existing absolute path')
}

export async function executePackageInstall(primeAgentPath: string, source: string, localCwd?: string): Promise<ProcessOutcome> {
  const args = localCwd ? ['package', 'install', '--local', source] : ['package', 'install', source]
  const result = await runProcess(primeAgentPath, args, { cwd: localCwd, timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executePackageRemove(primeAgentPath: string, source: string, localCwd?: string): Promise<ProcessOutcome> {
  const args = localCwd ? ['package', 'remove', '--local', source] : ['package', 'remove', source]
  const result = await runProcess(primeAgentPath, args, { cwd: localCwd, timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executeOmpPluginInstall(ompPath: string, source: string): Promise<ProcessOutcome> {
  const target = source.startsWith('npm:') || source.startsWith('git:') ? source.slice(4) : source
  const result = await runProcess(ompPath, ['plugin', 'install', target, '--json'], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executeOmpPluginAction(ompPath: string, action: 'enable' | 'disable' | 'uninstall', source: string, project = false): Promise<ProcessOutcome> {
  const target = source.startsWith('npm:') || source.startsWith('git:') ? source.slice(4) : source
  const args = ['plugin', action, target, '--json', ...(project ? ['--scope', 'project'] : [])]
  const result = await runProcess(ompPath, args, { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

// Pi has no --json output for install/remove; stdout is untrusted, bounded by
// maxBytes, and ANSI-stripped before it reaches the renderer. The source is
// passed verbatim like Prime's `package install` (pi is Prime's ancestor CLI).
export async function executePiPluginInstall(piPath: string, source: string, localCwd?: string): Promise<ProcessOutcome> {
  const args = localCwd ? ['install', '-l', source] : ['install', source]
  const result = await runProcess(piPath, args, { cwd: localCwd, timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executePiPluginRemove(piPath: string, source: string, localCwd?: string): Promise<ProcessOutcome> {
  const args = localCwd ? ['remove', '-l', source] : ['remove', source]
  const result = await runProcess(piPath, args, { cwd: localCwd, timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}
