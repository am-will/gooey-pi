import {
  ADVISOR_MAX_IMMUNE_TURNS,
  ADVISOR_SYNC_BACKLOGS,
  AGENT_MODEL_ROLES,
  type AdvisorSyncBacklog,
  type AgentModelRole,
  type AgentRoleConfig,
  type AgentRoleConfigPatch,
  type HarnessId,
} from '../../src/types/api'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER, type HarnessRpcAdapter } from './agent-rpc/harness-adapter'
import { rejectUnknownKeys, requireBoolean, requireInteger, requireRecord, requireString } from './validation'

/**
 * The agent-config surface shared by every harness that owns one.
 *
 * Only harnesses whose RPC adapter declares `agentConfigCommand` have an
 * implementation; the rest report `UNSUPPORTED_AGENT_CONFIG` and the settings
 * section renders nothing. This mirrors `ModelCatalogProvider`: one narrow
 * interface, one instance per harness that supports it, and no per-call
 * harness branching in the IPC layer.
 */
export interface AgentConfigReadOptions {
  /** Bypass any cached value and read the harness configuration from disk. */
  refresh?: boolean
}

export interface AgentConfigProvider {
  /**
   * Reads the harness's global model-role and advisor configuration. Implementations
   * may answer from a cache; `refresh` demands a live read of the harness config.
   */
  read(options?: AgentConfigReadOptions): Promise<AgentRoleConfig>
  /** Applies an explicit, already-untrusted patch and answers the re-read configuration. */
  write(patch: AgentRoleConfigPatch): Promise<AgentRoleConfig>
}

const ADAPTERS: Record<HarnessId, HarnessRpcAdapter> = { prime: PRIME_RPC_ADAPTER, omp: OMP_RPC_ADAPTER, pi: PI_RPC_ADAPTER }

/**
 * The one gate for this feature: the adapter record decides whether a harness
 * has an agent-config CLI at all, so main, IPC, and the renderer cannot drift
 * from each other or from what the harness actually supports.
 */
export function harnessAgentConfigCommand(harness: HarnessId): string | undefined {
  return ADAPTERS[harness].agentConfigCommand
}

/** Served for every harness that declares no agent-config CLI. */
export const UNSUPPORTED_AGENT_CONFIG: AgentRoleConfig = Object.freeze({
  supported: false,
  installed: false,
  roles: Object.freeze({}),
  advisor: null,
})

const MODEL_ROLES: ReadonlySet<string> = new Set(AGENT_MODEL_ROLES)
const SYNC_BACKLOGS: ReadonlySet<string> = new Set(ADVISOR_SYNC_BACKLOGS)

export function isAgentModelRole(value: string): value is AgentModelRole { return MODEL_ROLES.has(value) }
export function isAdvisorSyncBacklog(value: string): value is AdvisorSyncBacklog { return SYNC_BACKLOGS.has(value) }

/**
 * Strict gate for the untrusted renderer save payload. Model selectors are
 * only length- and shape-checked here; whether a selector names a real model
 * is decided against the harness's own catalog inside the provider, which is
 * the only place that knows the catalog.
 */
export function requireAgentRoleConfigPatch(raw: unknown): AgentRoleConfigPatch {
  const input = requireRecord(raw, 'patch')
  rejectUnknownKeys(input, ['roles', 'advisor'], 'patch')
  const patch: AgentRoleConfigPatch = {}
  if (input.roles !== undefined) {
    const roles = requireRecord(input.roles, 'patch.roles')
    rejectUnknownKeys(roles, AGENT_MODEL_ROLES, 'patch.roles')
    const validated: Partial<Record<AgentModelRole, string>> = {}
    for (const [role, value] of Object.entries(roles)) {
      if (!isAgentModelRole(role)) continue
      validated[role] = requireString(value, `patch.roles.${role}`, { min: 1, max: 512, trim: true })
    }
    patch.roles = validated
  }
  if (input.advisor !== undefined) {
    const advisor = requireRecord(input.advisor, 'patch.advisor')
    rejectUnknownKeys(advisor, ['enabled', 'subagents', 'syncBacklog', 'immuneTurns'], 'patch.advisor')
    patch.advisor = {}
    if (advisor.enabled !== undefined) patch.advisor.enabled = requireBoolean(advisor.enabled, 'patch.advisor.enabled')
    if (advisor.subagents !== undefined) patch.advisor.subagents = requireBoolean(advisor.subagents, 'patch.advisor.subagents')
    if (advisor.syncBacklog !== undefined) {
      const syncBacklog = requireString(advisor.syncBacklog, 'patch.advisor.syncBacklog', { min: 1, max: 8, trim: true })
      if (!isAdvisorSyncBacklog(syncBacklog)) throw new TypeError('patch.advisor.syncBacklog is not supported')
      patch.advisor.syncBacklog = syncBacklog
    }
    if (advisor.immuneTurns !== undefined) {
      patch.advisor.immuneTurns = requireInteger(advisor.immuneTurns, 'patch.advisor.immuneTurns', 0, ADVISOR_MAX_IMMUNE_TURNS)
    }
  }
  if (patch.roles === undefined && patch.advisor === undefined) throw new TypeError('patch must change at least one setting')
  return patch
}
