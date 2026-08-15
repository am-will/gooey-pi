import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId, PluginCatalog, ProcessOutcome, SkillRecord } from '../../src/types/api'
import { HARNESSES } from './harness'
import { createAdmissionQueue, createSingleFlight } from './lib/async'
import { resolveExecutable, type ExecutableSource } from './process-utils'
import { isRecord, requireString } from './validation'
import { discoverPlugins } from './plugins/catalog'
import { readAtMost } from './plugins/file-io'
import { acquireSettingsLock, prepareProjectSettingsPath, removeMcpDefinition, settingsFingerprint, updateBuiltinMcpState, updateMcpSettings, updateMcpState, updatePackageState, validateCapabilityMutation, validateMcpConnection, validateMcpStateInput } from './plugins/mcp'
import type { ProjectSettingsPath } from './plugins/mcp'
import { executeOmpPluginAction, executeOmpPluginInstall, executePackageInstall, executePackageRemove, executePiPluginInstall, executePiPluginRemove, validatePackageSource } from './plugins/package-execution'
import { installOmpExtension, validateExtensionInstallInput } from './plugins/extension-installation'

type PluginDiscovery = typeof discoverPlugins

interface PluginServiceOptions {
  harness?: HarnessId
  agentDir?: string
  discover?: PluginDiscovery
  builtInSkills?: SkillRecord[] | (() => SkillRecord[] | Promise<SkillRecord[]>)
  removeMcpCredential?: (server: string) => Promise<void>
  protectedMcpServers?: Readonly<Record<string, string>>
}

interface PiMcpAdapterState {
  source: string
  enabled: boolean
}

const MAX_ADAPTER_SETTINGS_BYTES = 4 * 1024 * 1024

const MAX_CONCURRENT_PLUGIN_DISCOVERIES = 2
const MAX_QUEUED_PLUGIN_DISCOVERIES = 32
const MAX_KNOWN_PATH_OWNERS = 64
const MAX_KNOWN_PATHS_PER_OWNER = 4_096

function normalizedCapabilityIdentity(value: string): string {
  return value.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '')
}

function dedupeAssociatedMcpPackages(skills: SkillRecord[]): SkillRecord[] {
  const mcpByScope = new Map(skills
    .filter((skill) => skill.kind === 'mcp' && skill.location !== 'bundled' && skill.location !== 'system')
    .map((skill) => [`${skill.location}:${normalizedCapabilityIdentity(skill.name)}`, skill] as const))
  const hiddenPackages = new Set<string>()
  const packageByMcpId = new Map<string, SkillRecord>()
  for (const skill of skills) {
    if (skill.kind !== 'package') continue
    const identities = skill.associatedMcpServers?.map(normalizedCapabilityIdentity)
      ?? [normalizedCapabilityIdentity(skill.name)]
    for (const identity of identities) {
      const mcp = mcpByScope.get(`${skill.location}:${identity}`)
      if (!mcp) continue
      hiddenPackages.add(skill.id)
      packageByMcpId.set(mcp.id, skill)
      break
    }
  }
  return skills.filter((skill) => !hiddenPackages.has(skill.id)).map((skill) => {
    const associatedPackage = packageByMcpId.get(skill.id)
    return associatedPackage?.source ? { ...skill, associatedPackageSource: associatedPackage.source } : skill
  })
}

const createDiscoveryQueue = () => createAdmissionQueue({
  maxConcurrent: MAX_CONCURRENT_PLUGIN_DISCOVERIES,
  maxPending: MAX_QUEUED_PLUGIN_DISCOVERIES,
  pendingLimitError: () => new TypeError('Too many plugin discoveries are pending'),
  closedError: () => new TypeError('GooeyPi is shutting down'),
})
let discoveryQueue = createDiscoveryQueue()

export function beginPluginDiscoveryShutdown(): void {
  // Reject queued waiters; running discoveries finish normally. A fresh queue
  // keeps later callers working (only the quit path calls this in the app).
  discoveryQueue.close()
  discoveryQueue = createDiscoveryQueue()
}

export class PluginService {
  private lastProjectPath: string | undefined
  private readonly knownPathsByOwner = new Map<string, Set<string>>()
  private settingsMutation = Promise.resolve()
  private readonly discoveryInFlight = createSingleFlight<string, PluginCatalog>()
  private readonly agentDir: string
  private readonly discoverCatalog: PluginDiscovery
  private readonly builtInSkills: () => SkillRecord[] | Promise<SkillRecord[]>
  private readonly harness: HarnessId
  private readonly removeMcpCredential: (server: string) => Promise<void>
  private readonly protectedMcpServers: Readonly<Record<string, string>>

  constructor(
    private readonly agentPath: ExecutableSource,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.harness = options.harness ?? 'prime'
    this.removeMcpCredential = options.removeMcpCredential ?? (async () => undefined)
    this.protectedMcpServers = options.protectedMcpServers ?? {}
    this.agentDir = options.agentDir ?? HARNESSES[this.harness].agentDir(homedir())
    this.discoverCatalog = options.discover ?? discoverPlugins
    const builtInSkills = options.builtInSkills
    this.builtInSkills = typeof builtInSkills === 'function'
      ? builtInSkills
      : () => builtInSkills ?? []
  }

  list(projectPath?: unknown): Promise<PluginCatalog> {
    if (!projectPath) return this.listCanonical()
    const requested = requireString(projectPath, 'projectPath', { min: 1, max: 4096 })
    return this.authorizeProject(requested).then((safeProjectPath) => this.listCanonical(safeProjectPath))
  }

  private listCanonical(safeProjectPath?: string): Promise<PluginCatalog> {
    const key = safeProjectPath ? `project:${safeProjectPath}` : 'user'
    return this.discoveryInFlight.run(key, () => discoveryQueue.run(() => this.discover(safeProjectPath, key)))
  }

  private async discover(safeProjectPath: string | undefined, ownerKey: string): Promise<PluginCatalog> {
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const result = await this.discoverCatalog(this.agentDir, safeProjectPath, resolveExecutable(this.agentPath), this.harness)
    const builtInSkills = await this.builtInSkills()
    const piMcpState = this.harness === 'pi' ? await this.piMcpAdapterState() : undefined
    const harnessCapabilities: SkillRecord[] = this.harness === 'pi' ? [{
      id: 'gooeypi-pi-mcp',
      name: 'Pi MCP Adapter',
      description: piMcpState
        ? `MCP support is installed through Pi’s pi-mcp-adapter extension package${piMcpState.enabled ? '.' : ' and is currently disabled.'}`
        : 'Install Pi’s supported MCP adapter extension, then add and authenticate MCP servers.',
      kind: 'extension',
      location: 'system',
      enabled: piMcpState?.enabled ?? false,
      source: piMcpState?.source ?? 'npm:pi-mcp-adapter',
    }] : []
    const discovered = this.harness === 'pi'
      ? result.skills.filter((item) => !(item.kind === 'package' && /(?:^|[:/@])pi-mcp-adapter(?:$|[#@])/i.test(`${item.name} ${item.source ?? ''}`)))
      : result.skills
    const protectedOverrides = new Map(discovered.filter((skill) => skill.kind === 'mcp' && skill.location === 'user' && this.protectedMcpServers[skill.name] && skill.source === new URL(this.protectedMcpServers[skill.name]).origin).map((skill) => [skill.name, skill.enabled]))
    const fixed = [...builtInSkills, ...harnessCapabilities].map((skill) => {
      const server = skill.id.startsWith('prime-mcp-') ? skill.id.slice('prime-mcp-'.length) : ''
      return protectedOverrides.has(server) ? { ...skill, enabled: protectedOverrides.get(server)! } : skill
    })
    const visibleDiscovered = discovered.filter((item) => !protectedOverrides.has(item.name))
    const combined = dedupeAssociatedMcpPackages([...fixed, ...visibleDiscovered.filter((item) => !fixed.some((builtIn) => builtIn.id === item.id))])
    const knownPaths = combined.flatMap((item) => item.path ? [item.path] : []).slice(0, MAX_KNOWN_PATHS_PER_OWNER)
    // Delete-then-set keeps insertion order as LRU order for owner eviction.
    this.knownPathsByOwner.delete(ownerKey)
    this.knownPathsByOwner.set(ownerKey, new Set(knownPaths))
    while (this.knownPathsByOwner.size > MAX_KNOWN_PATH_OWNERS) {
      const oldest = this.knownPathsByOwner.keys().next().value
      if (oldest === undefined) break
      this.knownPathsByOwner.delete(oldest)
    }
    return { skills: combined, warnings: result.warnings }
  }

  authorizeReveal(pathValue: unknown): string {
    const requested = requireString(pathValue, 'plugin path', { min: 1, max: 4096 })
    let path: string
    try { path = realpathSync(requested) } catch { throw new TypeError('plugin path does not exist') }
    if (![...this.knownPathsByOwner.values()].some((knownPaths) => knownPaths.has(path))) {
      throw new TypeError('plugin path was not discovered')
    }
    return path
  }

  async install(sourceValue: unknown): Promise<ProcessOutcome> {
    const agentPath = resolveExecutable(this.agentPath)
    if (!agentPath) return { ok: false, reason: 'blocked', output: `${HARNESSES[this.harness].agentName} executable was not found` }
    const source = validatePackageSource(sourceValue, { allowOmpMarketplaceTarget: this.harness === 'omp' })
    // Pi and Prime record installed sources in the agent settings.json; OMP
    // tracks installs through its plugin lock file.
    const settingsPath = this.harness === 'omp' ? join(this.agentDir, '..', 'plugins', 'omp-plugins.lock.json') : join(this.agentDir, 'settings.json')
    const operation: Promise<ProcessOutcome> = this.settingsMutation.then(async () => {
      // Prime and Pi own the settings.json lock while their package commands are
      // running. Taking that same lock here makes the child fail or deadlock
      // against GooeyPi. Keep a separate app coordination lock so multiple
      // GooeyPi windows serialize package mutations while the CLI remains free
      // to protect its own settings file.
      const lockPath = this.harness === 'omp' ? settingsPath : `${settingsPath}.gooeypi`
      const release = await acquireSettingsLock(lockPath)
      try {
        return this.harness === 'omp'
          ? await executeOmpPluginInstall(agentPath, source)
          : this.harness === 'pi'
            ? await executePiPluginInstall(agentPath, source)
            : await executePackageInstall(agentPath, source)
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async installExtension(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateExtensionInstallInput(inputValue)
    const safeProjectPath = input.scope === 'project'
      ? await this.authorizeProject(input.projectPath!)
      : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    if (this.harness === 'omp') return await installOmpExtension(input, this.agentDir, safeProjectPath)

    const agentPath = resolveExecutable(this.agentPath)
    if (!agentPath) return { ok: false, reason: 'blocked', output: `${HARNESSES[this.harness].agentName} executable was not found` }
    const projectSettings = safeProjectPath
      ? await prepareProjectSettingsPath(safeProjectPath, {
          segments: this.harness === 'prime' ? ['.prime', 'agent'] : ['.pi'],
          filename: 'settings.json',
        })
      : undefined
    const settingsPath = projectSettings?.path ?? join(this.agentDir, 'settings.json')
    const operation = this.settingsMutation.then(async () => {
      const lockPath = `${settingsPath}.gooeypi`
      const release = await acquireSettingsLock(lockPath, projectSettings?.verify)
      try {
        return this.harness === 'pi'
          ? await executePiPluginInstall(agentPath, input.source, safeProjectPath)
          : await executePackageInstall(agentPath, input.source, safeProjectPath)
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async setMcpSupport(enabledValue: unknown): Promise<ProcessOutcome> {
    if (this.harness !== 'pi') return { ok: false, reason: 'blocked', output: `${HARNESSES[this.harness].agentName} does not use an MCP support toggle.` }
    if (typeof enabledValue !== 'boolean') throw new TypeError('MCP support state must be a boolean')
    const adapter = await this.piMcpAdapterState()
    if (enabledValue) {
      if (adapter?.enabled) return { ok: true, output: 'Pi MCP Adapter is already enabled.' }
      if (!adapter) return await this.install('npm:pi-mcp-adapter')
    } else {
      if (!adapter?.enabled) return { ok: true, output: 'Pi MCP Adapter is already disabled.' }
    }
    const settingsPath = join(this.agentDir, 'settings.json')
    const operation = this.settingsMutation.then(async () => {
      const release = await acquireSettingsLock(`${settingsPath}.gooeypi`)
      try {
        return await updatePackageState(settingsPath, {
          source: adapter!.source,
          action: enabledValue ? 'enable' : 'disable',
        }, (path) => this.settingsFingerprint(path), { agentName: 'Pi' })
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async connectMcp(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpConnection(inputValue, this.harness)
    if (this.harness === 'pi' && !await this.piMcpAdapterInstalled()) {
      return {
        ok: false,
        reason: 'blocked',
        output: 'Pi core does not include MCP. Install GooeyPi\'s supported adapter first: pi install npm:pi-mcp-adapter',
      }
    }
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath, this.harness === 'prime'
        ? undefined
        : { segments: [this.harness === 'omp' ? '.omp' : '.pi'], filename: 'mcp.json' })
    } else {
      settingsTarget = join(this.agentDir, this.harness === 'prime' ? 'settings.json' : 'mcp.json')
    }

    const options = this.harness === 'omp' ? {
      agentName: 'OMP',
      harness: this.harness,
      schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json',
    } : this.harness === 'pi' ? {
      agentName: 'Pi',
      harness: this.harness,
      includeType: false,
      successMessage: `Saved MCP server definition “${input.name}”. Start a new Pi session to load it through pi-mcp-adapter.`,
    } : { harness: this.harness }
    const settingsPath = typeof settingsTarget === 'string' ? settingsTarget : settingsTarget.path
    const verify = typeof settingsTarget === 'string' ? undefined : settingsTarget.verify
    const mutation = this.settingsMutation.then(async () => {
      const release = await acquireSettingsLock(`${settingsPath}.gooeypi`, verify)
      try {
        return await updateMcpSettings(
          settingsTarget,
          input,
          (path) => this.settingsFingerprint(path),
          options,
        )
      } finally {
        await release()
      }
    })
    this.settingsMutation = mutation.then(() => undefined, () => undefined)
    return await mutation
  }

  async setMcpEnabled(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpStateInput(inputValue, this.harness)
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath, this.harness === 'prime'
        ? undefined
        : { segments: [this.harness === 'omp' ? '.omp' : '.pi'], filename: 'mcp.json' })
    } else {
      settingsTarget = join(this.agentDir, this.harness === 'prime' ? 'settings.json' : 'mcp.json')
    }
    const agentName = HARNESSES[this.harness].agentName
    const settingsPath = typeof settingsTarget === 'string' ? settingsTarget : settingsTarget.path
    const verify = typeof settingsTarget === 'string' ? undefined : settingsTarget.verify
    const mutation = this.settingsMutation.then(async () => {
      const release = await acquireSettingsLock(`${settingsPath}.gooeypi`, verify)
      try {
        return await updateMcpState(
          settingsTarget,
          input,
          (path) => this.settingsFingerprint(path),
          { agentName },
        )
      } finally {
        await release()
      }
    })
    this.settingsMutation = mutation.then(() => undefined, () => undefined)
    return await mutation
  }

  async mutateCapability(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateCapabilityMutation(inputValue, this.harness)
    const safeProjectPath = input.scope === 'project'
      ? await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const projectSettings = safeProjectPath
      ? await prepareProjectSettingsPath(safeProjectPath, this.harness === 'prime'
          ? undefined
          : { segments: [this.harness === 'omp' ? '.omp' : '.pi'], filename: input.kind === 'mcp' ? 'mcp.json' : 'settings.json' })
      : undefined
    const settingsPath = projectSettings?.path ?? join(this.agentDir, input.kind === 'mcp' && this.harness !== 'prime' ? 'mcp.json' : 'settings.json')
    const agentName = HARNESSES[this.harness].agentName
    const operation: Promise<ProcessOutcome> = this.settingsMutation.then(async () => {
      const release = await acquireSettingsLock(`${settingsPath}.gooeypi`, projectSettings?.verify)
      try {
        if (input.kind === 'mcp') {
          const protectedUrl = this.protectedMcpServers[input.name]
          if (protectedUrl) return await updateBuiltinMcpState(settingsPath, { ...input, url: protectedUrl }, (path) => this.settingsFingerprint(path))
          if (input.action !== 'remove') return await updateMcpState(projectSettings ?? settingsPath, { ...input, enabled: input.action === 'enable' }, (path) => this.settingsFingerprint(path), { agentName })
          if (input.source) {
            const agentPath = resolveExecutable(this.agentPath)
            if (!agentPath) return { ok: false, reason: 'blocked', output: `${agentName} executable was not found` }
            const packageRemoval = this.harness === 'omp'
              ? await executeOmpPluginAction(agentPath, 'uninstall', input.source, input.scope === 'project')
              : this.harness === 'pi'
                ? await executePiPluginRemove(agentPath, input.source, safeProjectPath)
                : await executePackageRemove(agentPath, input.source, safeProjectPath)
            if (!packageRemoval.ok) return packageRemoval
          }
          const removal = await removeMcpDefinition(projectSettings ?? settingsPath, input, (path) => this.settingsFingerprint(path), { agentName })
          if (removal.ok && this.harness === 'prime') await this.removeMcpCredential(input.name)
          return removal
        }

        if (this.harness === 'omp') {
          const agentPath = resolveExecutable(this.agentPath)
          if (!agentPath) return { ok: false, reason: 'blocked', output: `${agentName} executable was not found` }
          return await executeOmpPluginAction(agentPath, input.action === 'remove' ? 'uninstall' : input.action, input.source!, input.scope === 'project')
        }
        if (input.action !== 'remove') return await updatePackageState(projectSettings ?? settingsPath, input, (path) => this.settingsFingerprint(path), { agentName })
        const agentPath = resolveExecutable(this.agentPath)
        if (!agentPath) return { ok: false, reason: 'blocked', output: `${agentName} executable was not found` }
        return this.harness === 'pi'
          ? await executePiPluginRemove(agentPath, input.source!, safeProjectPath)
          : await executePackageRemove(agentPath, input.source!, safeProjectPath)
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  /** Pi core has no MCP. Do not write adapter configuration until its package is actually installed. */
  private async piMcpAdapterState(): Promise<PiMcpAdapterState | undefined> {
    try {
      const { content, truncated } = await readAtMost(join(this.agentDir, 'settings.json'), MAX_ADAPTER_SETTINGS_BYTES)
      if (truncated) return undefined
      const value = JSON.parse(content) as unknown
      if (!isRecord(value) || !Array.isArray(value.packages)) return undefined
      for (const raw of value.packages) {
        const source = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.source === 'string' ? raw.source : ''
        if (!/(?:^|[:/@])pi-mcp-adapter(?:$|[#@])/i.test(source)) continue
        const enabled = typeof raw === 'string' || !['extensions', 'skills', 'prompts', 'themes']
          .every((key) => Array.isArray(raw[key]) && raw[key].length === 0)
        return { source, enabled }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async piMcpAdapterInstalled(): Promise<boolean> { return (await this.piMcpAdapterState())?.enabled === true }

  refresh(): Promise<PluginCatalog> {
    const projectPath = this.lastProjectPath
    if (!projectPath) return this.listCanonical()
    // Re-authorize on every refresh: the remembered project may have been
    // removed (or replaced) since the scope was last used.
    return this.authorizeProject(projectPath).then(
      (safeProjectPath) => this.listCanonical(safeProjectPath),
      (error) => {
        // Surface the failure once, then forget the stale scope so later
        // refreshes fall back to the user catalog.
        if (this.lastProjectPath === projectPath) this.lastProjectPath = undefined
        this.knownPathsByOwner.delete(`project:${projectPath}`)
        throw error
      },
    )
  }

  /** Revokes a removed project's revealable paths. */
  evictProjects(roots: readonly string[]): void {
    for (const root of roots) this.knownPathsByOwner.delete(`project:${root}`)
  }

  private settingsFingerprint(path: string): Promise<string> {
    return settingsFingerprint(path)
  }
}
