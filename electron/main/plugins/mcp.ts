import { createHash, randomUUID } from 'node:crypto'
import { renameSync, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapabilityMutationInput, HarnessId, McpConnectionInput, McpStateInput, ProcessOutcome } from '../../../src/types/api'
import { isAppManageableLocalMcpKey, isNetworkMcpDefinition, MAX_MCP_DEFINITION_KEY_LENGTH, NETWORK_MCP_UNAVAILABLE_DETAIL, PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL } from '../../../src/lib/mcp-policy'
import { errorCode, isPathWithin, isRecord, requireString } from '../validation'
import { isPackageDisabled, packageSource } from './package-entries'
import { readAtMost } from './file-io'

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const SETTINGS_LOCK_ATTEMPTS = 40
const SETTINGS_LOCK_RETRY_MS = 50
const SETTINGS_LOCK_OWNER = 'owner.json'
const SETTINGS_UPDATE_ATTEMPTS = 4
const activeSettingsLockTokens = new Set<string>()

interface SettingsLockOwner {
  application?: 'gooeypi'
  version: 1
  pid: number
  token: string
  createdAt: number
}

type FingerprintSettings = (path: string) => Promise<string>

export interface ProjectSettingsPath {
  path: string
  verify(): Promise<void>
}

async function resolveSettingsTarget(target: string | ProjectSettingsPath): Promise<ProjectSettingsPath> {
  if (typeof target !== 'string') return target
  let observed: Stats
  try { observed = await lstat(target) }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { path: target, verify: async () => undefined }
    throw error
  }
  if (!observed.isSymbolicLink()) return { path: target, verify: async () => undefined }
  const path = await realpath(target)
  return { path, verify: async () => {
    const current = await lstat(target)
    if (!current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino || await realpath(target) !== path) {
      throw new TypeError('Settings symlink changed during update')
    }
  } }
}

function parseSettingsLockOwner(value: unknown): SettingsLockOwner | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null
  if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 200) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null
  return { ...(value.application === 'gooeypi' ? { application: 'gooeypi' as const } : {}), version: 1, pid: value.pid as number, token: value.token, createdAt: value.createdAt }
}

function sameSettingsLockOwner(left: SettingsLockOwner | null, right: SettingsLockOwner): boolean {
  return left?.version === right.version && left.application === right.application && left.pid === right.pid && left.token === right.token && left.createdAt === right.createdAt
}

async function readSettingsForUpdate(path: string, agentName = 'Agent'): Promise<{ settings: Record<string, unknown>; fingerprint: string; source: string | null }> {
  let content: string
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError(`${agentName} settings exceed the maximum supported size`)
    content = value.content
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { settings: {}, fingerprint: 'missing', source: null }
    if (error instanceof TypeError && error.message.includes('maximum supported size')) throw error
    throw new Error(`${agentName} settings could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new TypeError(`${agentName} settings are not valid JSON; fix them before connecting an MCP server`) }
  if (!isRecord(value)) throw new TypeError(`${agentName} settings must contain a JSON object`)
  return { settings: value, fingerprint: createHash('sha256').update(content).digest('hex'), source: content }
}

export async function settingsFingerprint(path: string): Promise<string> {
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError('Agent settings exceed the maximum supported size')
    return createHash('sha256').update(value.content).digest('hex')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

async function readSettingsLockOwner(lockPath: string): Promise<SettingsLockOwner | null> {
  try {
    const { content, truncated } = await readAtMost(join(lockPath, SETTINGS_LOCK_OWNER), 4 * 1024)
    if (truncated) return null
    return parseSettingsLockOwner(JSON.parse(content) as unknown)
  } catch { return null }
}

function isProcessProvablyDead(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

async function createSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }

  const owner: SettingsLockOwner = { application: 'gooeypi', version: 1, pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  activeSettingsLockTokens.add(owner.token)
  try {
    await writeFile(join(lockPath, SETTINGS_LOCK_OWNER), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    activeSettingsLockTokens.delete(owner.token)
    const current = await readSettingsLockOwner(lockPath)
    if (sameSettingsLockOwner(current, owner)) await rm(lockPath, { recursive: true, force: true })
    throw error
  }
  return async () => {
    try {
      const current = await readSettingsLockOwner(lockPath)
      if (sameSettingsLockOwner(current, owner)) await rm(lockPath, { recursive: true, force: true })
    } finally { activeSettingsLockTokens.delete(owner.token) }
  }
}

function isAbandonedSettingsLock(owner: SettingsLockOwner): boolean {
  // Native proper-lockfile directories have no GooeyPi owner record. Never infer abandonment from age or unknown ownership.
  return isProcessProvablyDead(owner.pid) || owner.application === 'gooeypi' && owner.pid === process.pid && !activeSettingsLockTokens.has(owner.token)
}

async function recoverStaleSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const observed = await readSettingsLockOwner(lockPath)
  if (!observed || !isAbandonedSettingsLock(observed)) return null

  // The recovery directory serializes competing reapers. The owner is checked
  // again after claiming it, so a replacement lock is never removed by token.
  const recoveryPath = `${lockPath}.recovery`
  try {
    await mkdir(recoveryPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }
  try {
    const current = await readSettingsLockOwner(lockPath)
    if (!sameSettingsLockOwner(current, observed) || !isAbandonedSettingsLock(observed)) return null
    await rm(lockPath, { recursive: true, force: true })
    return await createSettingsLock(lockPath)
  } finally {
    await rm(recoveryPath, { recursive: true, force: true })
  }
}

export async function acquireSettingsLock(settingsPath: string, verify?: () => Promise<void>): Promise<() => Promise<void>> {
  if (verify) await verify()
  else await mkdir(dirname(settingsPath), { recursive: true })
  const lockPath = `${settingsPath}.lock`
  for (let attempt = 0; attempt < SETTINGS_LOCK_ATTEMPTS; attempt += 1) {
    await verify?.()
    const acquired = await createSettingsLock(lockPath)
    if (acquired) {
      try { await verify?.(); return acquired } catch (error) { await acquired(); throw error }
    }
    const recovered = await recoverStaleSettingsLock(lockPath)
    if (recovered) {
      try { await verify?.(); return recovered } catch (error) { await recovered(); throw error }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTINGS_LOCK_RETRY_MS))
  }
  throw new Error('Agent settings are busy; try again')
}

interface FileIdentity {
  dev: string
  ino: string
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function regularFileIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('Agent settings staging file changed during update')
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function removeOwnedFile(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    if (!sameFileIdentity(await regularFileIdentity(path), expected)) return false
    await rm(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function rollbackSettingsRename(
  path: string,
  temporary: string,
  temporaryIdentity: FileIdentity,
  backup: string,
  backupIdentity: FileIdentity | null,
): Promise<void> {
  if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
    throw new Error('The staged settings file could not be located for rollback')
  }
  if (backupIdentity) {
    if (!sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new Error('The original settings backup could not be located for rollback')
    }
    await rename(backup, path)
    if (!sameFileIdentity(await regularFileIdentity(path), backupIdentity)) throw new Error('The original settings backup was not restored')
    return
  }
  await rename(path, temporary)
  if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) throw new Error('The new settings file was not removed')
}

async function writeSettingsAtomically(
  path: string,
  settings: Record<string, unknown>,
  expectedFingerprint: string,
  source: string | null,
  fingerprint: FingerprintSettings,
  verify?: () => Promise<void>,
): Promise<boolean> {
  const token = `${process.pid}.${randomUUID()}`
  const temporary = `${path}.${token}.tmp`
  const backup = `${path}.${token}.bak`
  let temporaryIdentity: FileIdentity | null = null
  let backupIdentity: FileIdentity | null = null
  let renamed = false
  try {
    await verify?.()
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    temporaryIdentity = await regularFileIdentity(temporary)
    if (source !== null) {
      await writeFile(backup, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      backupIdentity = await regularFileIdentity(backup)
    }
    // Both recovery files must have been staged in the still-pinned directory.
    await verify?.()
    if (await fingerprint(path) !== expectedFingerprint) return false
    await verify?.()
    if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) {
      throw new TypeError('Agent settings staging file changed during update')
    }
    if (backupIdentity && !sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new TypeError('Agent settings backup changed during update')
    }
    // There is no renameat-style API in Node on macOS. Await the pin re-check
    // immediately before the rename, then prove which inode won.
    await verify?.()
    // Invoke the final filesystem operation synchronously so no libuv worker-pool
    // admission window separates it from the rename syscall; the post-rename
    // identity and pin checks below remain the authority on what actually won.
    renameSync(temporary, path)
    renamed = true
    if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
      throw new TypeError('Agent settings target changed during update')
    }
    await verify?.()
    if (backupIdentity && !await removeOwnedFile(backup, backupIdentity)) {
      throw new TypeError('Agent settings backup changed during update')
    }
    backupIdentity = null
    return true
  } catch (error) {
    if (renamed && temporaryIdentity) {
      try {
        await rollbackSettingsRename(path, temporary, temporaryIdentity, backup, backupIdentity)
        renamed = false
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : 'Agent settings update failed'
        throw new AggregateError([error, rollbackError], `${message}; settings rollback could not be completed`)
      }
    }
    throw error
  } finally {
    if (!renamed && temporaryIdentity) await removeOwnedFile(temporary, temporaryIdentity).catch(() => false)
    if (backupIdentity) await removeOwnedFile(backup, backupIdentity).catch(() => false)
  }
}

export function validateMcpConnection(value: unknown, harness: HarnessId = 'prime'): McpConnectionInput {
  if (!isRecord(value)) throw new TypeError('MCP connection must be an object')
  if (isNetworkMcpDefinition(value)) throw new TypeError(NETWORK_MCP_UNAVAILABLE_DETAIL)
  const name = requireString(value.name, 'MCP server name', { min: 1, max: 64, trim: true })
  // Prime keeps its historical looser charset; OMP and pi mcp.json share the
  // stricter native map-key charset.
  const validName = harness === 'prime' ? /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) : isAppManageableLocalMcpKey(name)
  if (!validName || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('MCP server name contains unsupported characters')
  const scope = value.scope
  if (scope !== 'user' && scope !== 'project') throw new TypeError('MCP scope must be user or project')
  const projectPath = scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  if (value.type === 'stdio') {
    if (harness === 'prime') throw new TypeError(PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL)
    const command = requireString(value.command, 'MCP command', { min: 1, max: 2_048, trim: true })
    if (command.startsWith('-') || /[\0\r\n\u2028\u2029]/.test(command)) throw new TypeError('MCP command is invalid')
    if (value.args !== undefined && !Array.isArray(value.args)) throw new TypeError('MCP arguments must be a list')
    const args = (value.args ?? []).map((arg, index) => {
      const parsed = requireString(arg, `MCP argument ${index + 1}`, { max: 2_048 })
      if (/[\0\r\n\u2028\u2029]/.test(parsed)) throw new TypeError(`MCP argument ${index + 1} is invalid`)
      return parsed
    })
    if (args.length > 64) throw new TypeError('MCP arguments exceed the maximum count')
    return { name, scope, projectPath, type: 'stdio', command, args }
  }
  throw new TypeError('MCP transport must be http or stdio')
}

export function validateMcpStateInput(value: unknown, harness: HarnessId = 'prime'): McpStateInput {
  if (!isRecord(value)) throw new TypeError('MCP state must be an object')
  const name = requireString(value.name, 'MCP server name', { min: 1, max: 64, trim: true })
  const validName = harness === 'prime' ? /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) : isAppManageableLocalMcpKey(name)
  if (!validName || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('MCP server name contains unsupported characters')
  if (value.scope !== 'user' && value.scope !== 'project') throw new TypeError('MCP scope must be user or project')
  const projectPath = value.scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  if (typeof value.enabled !== 'boolean') throw new TypeError('MCP enabled state must be a boolean')
  return { name, scope: value.scope, projectPath, enabled: value.enabled }
}

type ValidatedCapabilityMutation = Omit<CapabilityMutationInput, 'kind' | 'source'> & (
  | { kind: 'package'; source: string }
  | { kind: 'mcp'; source?: string }
)

function capabilitySource(value: unknown, label: string): string {
  const source = requireString(value, label, { min: 1, max: 2_048, trim: true })
  if (source.startsWith('-') || /[\r\n\u2028\u2029]/.test(source)) throw new TypeError('Package source is invalid')
  return source
}

export function validateCapabilityMutation(value: unknown, harness: HarnessId = 'prime'): ValidatedCapabilityMutation {
  if (!isRecord(value)) throw new TypeError('Capability mutation must be an object')
  if (value.kind !== 'package' && value.kind !== 'mcp') throw new TypeError('Capability kind is invalid')
  if (value.action !== 'enable' && value.action !== 'disable' && value.action !== 'remove') throw new TypeError('Capability action is invalid')
  const name = requireString(value.name, 'Capability name', { min: 1, max: 120, trim: true })
  const scope = value.scope
  if (scope !== 'user' && scope !== 'project') throw new TypeError('Capability scope must be user or project')
  const projectPath = scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  let definitionKey: string | undefined
  if (value.kind === 'mcp' && value.action === 'remove' && value.definitionKey !== undefined) {
    if (typeof value.definitionKey !== 'string' || value.definitionKey.length > MAX_MCP_DEFINITION_KEY_LENGTH) {
      throw new TypeError('MCP definition key exceeds the supported removal limit')
    }
    definitionKey = value.definitionKey
  } else if (value.kind === 'mcp') {
    validateMcpStateInput({ name, scope, projectPath, enabled: value.action === 'enable' }, harness)
  }
  const common: Omit<ValidatedCapabilityMutation, 'kind' | 'source'> = { action: value.action, name, ...(definitionKey !== undefined ? { definitionKey } : {}), scope, projectPath }
  return value.kind === 'package'
    ? { ...common, kind: 'package', source: capabilitySource(value.source, 'Package source') }
    : { ...common, kind: 'mcp', source: value.source === undefined ? undefined : capabilitySource(value.source, 'Associated package source') }
}

export async function prepareProjectSettingsPath(
  projectPath: string,
  options: { segments?: readonly string[]; filename?: string } = {},
): Promise<ProjectSettingsPath> {
  const projectRoot = await realpath(projectPath)
  const pinnedDirectories = new Map<string, { dev: string; ino: string }>()
  const pin = async (path: string): Promise<void> => {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Project MCP configuration path must remain a real directory')
    pinnedDirectories.set(path, { dev: stat.dev.toString(), ino: stat.ino.toString() })
  }
  await pin(projectRoot)
  let directory = projectRoot
  for (const segment of options.segments ?? ['.prime', 'agent']) {
    const candidate = join(directory, segment)
    let existing: Stats | undefined
    try {
      existing = await lstat(candidate)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new TypeError(`Project ${segment} configuration path must be a real directory`)
    } else {
      await mkdir(candidate, { mode: 0o700 })
    }
    directory = await realpath(candidate)
    if (!isPathWithin(projectRoot, directory)) throw new TypeError('Project MCP configuration path escapes the project')
    await pin(directory)
  }
  const settingsPath = join(directory, options.filename ?? 'settings.json')
  const verify = async (): Promise<void> => {
    for (const [path, expected] of pinnedDirectories) {
      let stat: BigIntStats
      try { stat = await lstat(path, { bigint: true }) } catch { throw new TypeError('Project MCP configuration directory changed during update') }
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev.toString() !== expected.dev || stat.ino.toString() !== expected.ino) {
        throw new TypeError('Project MCP configuration directory changed during update')
      }
    }
    let settingsStat: Stats | undefined
    try {
      settingsStat = await lstat(settingsPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new TypeError('Project MCP settings must be a regular file')
    }
    if (settingsStat && (settingsStat.isSymbolicLink() || !settingsStat.isFile())) throw new TypeError('Project MCP settings must be a regular file')
  }
  await verify()
  return { path: settingsPath, verify }
}

interface SettingsMutation {
  changed: boolean
  outcome: ProcessOutcome
}

async function mutateSettings(
  target: string | ProjectSettingsPath,
  fingerprint: FingerprintSettings,
  agentName: string,
  kind: 'MCP' | 'package',
  mutate: (settings: Record<string, unknown>) => SettingsMutation,
): Promise<ProcessOutcome> {
  const { path, verify } = await resolveSettingsTarget(target)
  const release = await acquireSettingsLock(path, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      await verify()
      const snapshot = await readSettingsForUpdate(path, agentName)
      await verify()
      const result = mutate(snapshot.settings)
      if (!result.changed) return result.outcome
      if (await writeSettingsAtomically(path, snapshot.settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) return result.outcome
    }
    throw new Error(`${agentName} settings changed repeatedly; no ${kind === 'MCP' ? 'MCP' : 'package'} configuration was overwritten`)
  } finally { await release() }
}

export async function updateMcpSettings(
  target: string | ProjectSettingsPath,
  input: McpConnectionInput,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string; harness?: HarnessId; schema?: string; successMessage?: string; includeType?: boolean } = {},
): Promise<ProcessOutcome> {
  if (isNetworkMcpDefinition(input)) throw new TypeError(NETWORK_MCP_UNAVAILABLE_DETAIL)
  if (options.harness !== 'omp' && options.harness !== 'pi') throw new TypeError(PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL)
  if (input.type !== 'stdio') throw new TypeError(NETWORK_MCP_UNAVAILABLE_DETAIL)
  const agentName = options.agentName ?? 'Agent'
  return mutateSettings(target, fingerprint, agentName, 'MCP', (settings) => {
    if (settings.mcpServers !== undefined && !isRecord(settings.mcpServers)) throw new TypeError(`${agentName} mcpServers setting must contain a JSON object`)
    const currentServers = isRecord(settings.mcpServers) ? settings.mcpServers : {}
    if (Object.hasOwn(currentServers, input.name)) return { changed: false, outcome: { ok: false, reason: 'blocked', output: `An MCP server named “${input.name}” already exists in this scope.` } }
    const config = { ...(options.includeType !== false ? { type: 'stdio' } : {}), command: input.command, ...(input.args?.length ? { args: input.args } : {}), enabled: true }
    settings.mcpServers = { ...currentServers, [input.name]: config }
    if (options.schema && settings.$schema === undefined) settings.$schema = options.schema
    return { changed: true, outcome: { ok: true, output: options.successMessage ?? `Saved MCP server definition “${input.name}”. Start a new ${agentName} session to load it.` } }
  })
}

export async function updateMcpState(
  target: string | ProjectSettingsPath,
  input: McpStateInput,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string; harness?: HarnessId } = {},
): Promise<ProcessOutcome> {
  if (options.harness !== 'omp' && options.harness !== 'pi') return { ok: false, reason: 'blocked', output: PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL }
  const agentName = options.agentName ?? 'Agent'
  return mutateSettings(target, fingerprint, agentName, 'MCP', (settings) => {
    const current = isRecord(settings.mcpServers) ? settings.mcpServers[input.name] : undefined
    if (!isRecord(current)) return { changed: false, outcome: { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` } }
    if (isNetworkMcpDefinition(current)) return { changed: false, outcome: { ok: false, reason: 'blocked', output: NETWORK_MCP_UNAVAILABLE_DETAIL } }
    if ((current.enabled !== false) === input.enabled) return { changed: false, outcome: { ok: true, output: `MCP server “${input.name}” is already ${input.enabled ? 'enabled' : 'disabled'}.` } }
    settings.mcpServers = { ...(isRecord(settings.mcpServers) ? settings.mcpServers : {}), [input.name]: { ...current, enabled: input.enabled } }
    return { changed: true, outcome: { ok: true, output: `${input.enabled ? 'Enabled' : 'Disabled'} MCP server “${input.name}”. Start a new ${agentName} session to apply the change.` } }
  })
}

export async function removeMcpDefinition(
  target: string | ProjectSettingsPath,
  input: Pick<CapabilityMutationInput, 'name' | 'definitionKey'>,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string } = {},
): Promise<ProcessOutcome> {
  const definitionKey = input.definitionKey ?? input.name
  if (definitionKey.length > MAX_MCP_DEFINITION_KEY_LENGTH) throw new TypeError('MCP definition key exceeds the supported removal limit')
  return mutateSettings(target, fingerprint, options.agentName ?? 'Agent', 'MCP', (settings) => {
    if (!isRecord(settings.mcpServers) || !Object.hasOwn(settings.mcpServers, definitionKey)) return { changed: false, outcome: { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` } }
    const nextServers = { ...settings.mcpServers }
    delete nextServers[definitionKey]
    settings.mcpServers = nextServers
    return { changed: true, outcome: { ok: true, output: `Removed MCP server “${input.name}”. Other server definitions were kept.` } }
  })
}

export async function updatePackageState(
  target: string | ProjectSettingsPath,
  input: { source: string; action: 'enable' | 'disable' },
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string } = {},
): Promise<ProcessOutcome> {
  const source = input.source
  return mutateSettings(target, fingerprint, options.agentName ?? 'Agent', 'package', (settings) => {
    const packages = Array.isArray(settings.packages) ? settings.packages : []
    const index = packages.findIndex((item) => packageSource(item) === source)
    if (index < 0) return { changed: false, outcome: { ok: false, reason: 'blocked', output: `Package “${source}” was not found in this scope.` } }
    const saved = isRecord(settings.gooeypiDisabledPackages) ? { ...settings.gooeypiDisabledPackages } : {}
    const next = [...packages]
    if (input.action === 'disable') {
      if (saved[source] === undefined) saved[source] = next[index]
      next[index] = { source, extensions: [], skills: [], prompts: [], themes: [] }
    } else {
      if (saved[source] === undefined && !isPackageDisabled(next[index])) return { changed: false, outcome: { ok: true, output: `Package “${source}” is already enabled.` } }
      next[index] = saved[source] ?? source
      delete saved[source]
    }
    settings.packages = next
    if (Object.keys(saved).length) settings.gooeypiDisabledPackages = saved
    else delete settings.gooeypiDisabledPackages
    return { changed: true, outcome: { ok: true, output: `${input.action === 'enable' ? 'Enabled' : 'Disabled'} package “${source}”.` } }
  })
}
