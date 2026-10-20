import { PRIME_THINKING_LEVELS, type PrimeModelDescriptor, type PrimeProviderDescriptor } from '../../src/types/api'
import { RUST_PRIME_AGENT_NAME } from '../../src/lib/prime-compat'
import type { CliModelCatalogOptions, ValidatedModelEntry } from './model-catalog-cli'
import { RpcModelCatalogService, thinkingLevelsFromMap } from './model-catalog-rpc'
import type { ExecutableSource } from './process-utils'

/**
 * Before it answers, Rust Prime's get_available_models refreshes its live
 * model catalog and the Prime Inference lists one after another: up to 5 s
 * for each catalog fetch and 10 s for a team's private models. The probe
 * waits past that budget instead of failing on a slow network.
 */
export const RUST_PRIME_CATALOG_TIMEOUT_MS = 30_000

/**
 * The second arm of Rust's `supports_thinking`: a thinking-level map with at
 * least one wired level gives a model a thinking surface even when its
 * reasoning flag is false. An all-null map does not.
 */
function wiresThinkingLevel(thinkingLevelMap: Record<string, unknown> | undefined): boolean {
  return thinkingLevelMap !== undefined
    && PRIME_THINKING_LEVELS.some((level) => Object.hasOwn(thinkingLevelMap, level) && typeof thinkingLevelMap[level] === 'string')
}

/**
 * Model catalog for Rust Prime Agent (the 0.9.9 betas and 0.10+), read with
 * the RPC probe as `prime-agent --mode rpc --no-session`. Its models come
 * from Rust's own live catalog, so 0.10 models GooeyPi's bundled TypeScript
 * registry has never heard of are listed and selectable. The probe stays
 * online, like a Prime start: Rust already gates its catalog fetch to once
 * an hour, and --offline would hide a team's private models until an online
 * run had cached them.
 *
 * get_available_models lists only models Rust has credentials for, so every
 * entry is available. Thinking levels follow Rust's rule, and no model claims
 * fast mode, which Rust Prime does not offer. Provider rows come from
 * `providerRows` when given (GooeyPi owns Prime credentials, so the caller
 * knows their auth state); without it each provider's credentials belong to
 * the CLI.
 */
export class RustPrimeModelCatalogService extends RpcModelCatalogService {
  protected readonly harnessLabel = 'Prime Agent'
  protected readonly cliName = 'prime-agent'
  protected readonly probeArgs: readonly string[] = ['--mode', 'rpc', '--no-session']
  protected readonly notInstalledWarning = 'Prime Agent is not installed. Install prime-agent to load its model catalog.'
  protected readonly credentialsLabel = `Credentials managed by ${RUST_PRIME_AGENT_NAME}`

  constructor(
    executable: ExecutableSource,
    private readonly providerRows?: (modelProviderIds: ReadonlySet<string>) => PrimeProviderDescriptor[],
    options: CliModelCatalogOptions = {},
  ) {
    super(executable, { timeoutMs: RUST_PRIME_CATALOG_TIMEOUT_MS, ...options })
  }

  protected override providerDescriptors(providerIds: readonly string[]): PrimeProviderDescriptor[] {
    return this.providerRows ? this.providerRows(new Set(providerIds)) : super.providerDescriptors(providerIds)
  }

  protected describeModel(entry: ValidatedModelEntry, thinkingLevelMap: Record<string, unknown> | undefined): PrimeModelDescriptor {
    return {
      ...entry.descriptor,
      fastModeSupported: false,
      availableThinkingLevels: thinkingLevelsFromMap(entry.reasoning || wiresThinkingLevel(thinkingLevelMap), thinkingLevelMap),
    }
  }
}
