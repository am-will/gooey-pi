import { tmpdir } from 'node:os'
import {
  ADVISOR_MAX_IMMUNE_TURNS,
  AGENT_MODEL_ROLES,
  type AgentAdvisorSettings,
  type AgentModelRole,
  type AgentRoleConfig,
  type AgentRoleConfigPatch,
} from '../../src/types/api'
import { parseModelRoleSelector } from '../../src/lib/model-roles'
import { harnessAgentConfigCommand, isAdvisorSyncBacklog, isAgentModelRole, UNSUPPORTED_AGENT_CONFIG, type AgentConfigProvider, type AgentConfigReadOptions } from './agent-config'
import type { ModelCatalogProvider } from './model-catalog'
import { resolveExecutable, runProcess, safeChildEnvironment, type ExecutableSource } from './process-utils'
import { isRecord } from './validation'

export const OMP_CONFIG_NOT_INSTALLED_WARNING = 'OMP is not installed. Install the omp CLI to read or change its model roles.'

const DEFAULT_CONFIG_TIMEOUT_MS = 15_000
const DEFAULT_CONFIG_MAX_OUTPUT_BYTES = 256 * 1024
/** `modelRoles` is a whole-record setting; per-leaf keys such as `modelRoles.plan` are rejected by the CLI. */
const ROLES_KEY = 'modelRoles'
const ADVISOR_KEYS = ['advisor.enabled', 'advisor.subagents', 'advisor.syncBacklog', 'advisor.immuneTurns'] as const

/** Advisor values served when the CLI answers with something GooeyPi cannot validate. */
const ADVISOR_FALLBACK: AgentAdvisorSettings = { enabled: false, subagents: false, syncBacklog: 'off', immuneTurns: 0 }

export interface OmpAgentConfigOptions {
  /** Wall-clock limit for one CLI call. */
  timeoutMs?: number
  /** Combined stdout/stderr byte cap for one CLI call. */
  maxOutputBytes?: number
}

/** A CLI argument that would be read as a flag, or split across lines, is never sent. */
function unsafeArgValue(value: string): boolean {
  return value.length === 0 || value.startsWith('-') || /[\r\n\0]/.test(value)
}

/**
 * Reads and writes OMP's own model-role and advisor configuration through
 * `omp config get|set`, the same CLI-as-source-of-truth approach
 * `OmpModelCatalogService` takes with `omp models --json`.
 *
 * Every call is spawned with an argv array, a sanitized environment, a byte
 * cap and a timeout, and every field of the untrusted JSON answer is validated
 * before use. Two harness facts, verified live against omp 17.2.9, shape the
 * design:
 *
 * - `omp config get` answers the *effective* value, merging the harness global
 *   configuration with any `.omp/config.yml` overlay owned by the working
 *   directory, while `omp config set` always writes the global file. Reading a
 *   project overlay and writing it back would silently promote project
 *   settings, so every call runs from a neutral working directory and this
 *   surface is global-only.
 * - `omp config set modelRoles <json>` *replaces* the whole record instead of
 *   merging into it. Writes therefore re-read the current record and merge the
 *   caller's roles over it, which also preserves any role key a newer OMP
 *   knows about and this build does not.
 */
export class OmpAgentConfigService implements AgentConfigProvider {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private cached: AgentRoleConfig | null = null
  private inflight: Promise<AgentRoleConfig> | null = null

  constructor(
    private readonly executable: ExecutableSource,
    private readonly catalog: ModelCatalogProvider,
    options: OmpAgentConfigOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CONFIG_MAX_OUTPUT_BYTES
  }

  /**
   * Serves the last known configuration immediately and refreshes behind it. One read
   * costs five `omp config get` boots, several seconds in total, which is why an
   * uncached Settings visit used to render an empty section first. A caller that needs
   * certainty (the panel's own second pass, and every write) asks for `refresh`.
   */
  async read(options: AgentConfigReadOptions = {}): Promise<AgentRoleConfig> {
    if (!options.refresh && this.cached) {
      if (!this.inflight) this.inflight = this.readFresh().finally(() => { this.inflight = null })
      return this.cached
    }
    if (!options.refresh && this.inflight) return this.inflight
    this.inflight ??= this.readFresh().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** Fills the cache before anything asks for it, so the first Settings visit is instant. */
  warm(): void {
    if (this.cached || this.inflight) return
    this.inflight = this.readFresh().catch(() => UNSUPPORTED_AGENT_CONFIG).finally(() => { this.inflight = null })
  }

  private async readFresh(): Promise<AgentRoleConfig> {
    const config = await this.readUncached()
    // An "OMP is missing" answer is a transient environment fact, never a cached truth.
    if (config.installed) this.cached = config
    return config
  }

  private async readUncached(): Promise<AgentRoleConfig> {
    const command = harnessAgentConfigCommand('omp')
    if (!command) return UNSUPPORTED_AGENT_CONFIG
    const executable = resolveExecutable(this.executable)
    if (!executable) return { supported: true, installed: false, roles: {}, advisor: null, warning: OMP_CONFIG_NOT_INSTALLED_WARNING }

    const [rawRoles, enabled, subagents, syncBacklog, immuneTurns] = await Promise.all([
      this.getSetting(executable, command, ROLES_KEY),
      ...ADVISOR_KEYS.map((key) => this.getSetting(executable, command, key)),
    ])
    return {
      supported: true,
      installed: true,
      roles: toRoles(rawRoles),
      advisor: {
        enabled: typeof enabled === 'boolean' ? enabled : ADVISOR_FALLBACK.enabled,
        subagents: typeof subagents === 'boolean' ? subagents : ADVISOR_FALLBACK.subagents,
        syncBacklog: toSyncBacklog(syncBacklog),
        immuneTurns: typeof immuneTurns === 'number' && Number.isSafeInteger(immuneTurns) && immuneTurns >= 0 && immuneTurns <= ADVISOR_MAX_IMMUNE_TURNS
          ? immuneTurns
          : ADVISOR_FALLBACK.immuneTurns,
      },
    }
  }

  async write(patch: AgentRoleConfigPatch): Promise<AgentRoleConfig> {
    const command = harnessAgentConfigCommand('omp')
    if (!command) throw new Error('OMP does not expose a configuration CLI')
    const executable = resolveExecutable(this.executable)
    if (!executable) throw new Error(OMP_CONFIG_NOT_INSTALLED_WARNING)

    // Everything is resolved and validated before anything is written:
    // `omp config set` is not transactional, so a late rejection would leave a
    // half-applied save behind.
    const writes: Array<[key: string, value: string]> = []
    if (patch.roles && Object.keys(patch.roles).length > 0) {
      const catalog = await this.catalog.catalog()
      const merged: Record<string, string> = { ...await this.readStoredRoles(executable, command) }
      for (const [role, selector] of Object.entries(patch.roles)) {
        if (!isAgentModelRole(role) || selector === undefined) continue
        if (!parseModelRoleSelector(selector, catalog)) throw new Error(`${selector} was not found in the OMP catalog`)
        merged[role] = selector
      }
      writes.push([ROLES_KEY, JSON.stringify(merged)])
    }
    if (patch.advisor) {
      const { enabled, subagents, syncBacklog, immuneTurns } = patch.advisor
      if (enabled !== undefined) writes.push(['advisor.enabled', String(enabled)])
      if (subagents !== undefined) writes.push(['advisor.subagents', String(subagents)])
      if (syncBacklog !== undefined) writes.push(['advisor.syncBacklog', syncBacklog])
      if (immuneTurns !== undefined) writes.push(['advisor.immuneTurns', String(immuneTurns)])
    }
    for (const [key, value] of writes) await this.setSetting(executable, command, key, value)
    return this.read({ refresh: true })
  }

  /** The stored record with unknown keys preserved, so a write never drops a role this build cannot name. */
  private async readStoredRoles(executable: string, command: string): Promise<Record<string, string>> {
    const raw = await this.getSetting(executable, command, ROLES_KEY)
    if (!isRecord(raw)) return {}
    const roles: Record<string, string> = {}
    for (const [role, value] of Object.entries(raw)) {
      if (role.length <= 64 && typeof value === 'string' && value.length <= 512 && !unsafeArgValue(value)) roles[role] = value
    }
    return roles
  }

  /** Reads one setting; an unknown key or a failed call answers undefined instead of failing the whole read. */
  private async getSetting(executable: string, command: string, key: string): Promise<unknown> {
    const result = await this.run(executable, [command, 'get', key, '--json'])
    if (result.code !== 0 || result.timedOut || result.outputExceeded) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { return undefined }
    // The CLI answers `{ key, value, type, description }`; any other shape is treated as absent.
    return isRecord(parsed) && parsed.key === key ? parsed.value : undefined
  }

  private async setSetting(executable: string, command: string, key: string, value: string): Promise<void> {
    if (unsafeArgValue(value)) throw new TypeError(`Invalid value for ${key}`)
    const result = await this.run(executable, [command, 'set', key, value])
    if (result.outputExceeded) throw new Error(`Saving ${key} produced more than ${this.maxOutputBytes.toLocaleString()} bytes of output`)
    if (result.timedOut) throw new Error(`Saving ${key} timed out`)
    if (result.code !== 0) throw new Error(`OMP rejected ${key}: ${cliFailureReason(result.stdout, result.stderr)}`)
  }

  private run(executable: string, args: readonly string[]) {
    return runProcess(executable, args, {
      // A neutral working directory keeps reads and writes on the harness's
      // global configuration; a project cwd would let a `.omp/config.yml`
      // overlay masquerade as the global value.
      cwd: tmpdir(),
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxOutputBytes,
      env: safeChildEnvironment(),
    })
  }
}

/** Untrusted CLI text reduced to a short, printable, single-line reason. */
function cliFailureReason(stdout: string, stderr: string): string {
  const text = `${stderr} ${stdout}`.replace(/[^ -~]+/g, ' ').trim()
  return text.length ? text.slice(0, 200) : 'unknown error'
}

function toRoles(raw: unknown): Partial<Record<AgentModelRole, string>> {
  if (!isRecord(raw)) return {}
  const roles: Partial<Record<AgentModelRole, string>> = {}
  for (const role of AGENT_MODEL_ROLES) {
    const value = raw[role]
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) roles[role] = value
  }
  return roles
}

/** The CLI reports the numeric backlog values as JSON numbers and `off` as a string. */
function toSyncBacklog(raw: unknown): AgentAdvisorSettings['syncBacklog'] {
  const value = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw
  return typeof value === 'string' && isAdvisorSyncBacklog(value) ? value : ADVISOR_FALLBACK.syncBacklog
}
