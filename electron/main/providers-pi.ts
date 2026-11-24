import type { PrimeModelDescriptor } from '../../src/types/api'
import type { CliModelCatalogOptions, ValidatedModelEntry } from './model-catalog-cli'
import type { ExecutableSource } from './process-utils'
import { RpcModelCatalogService, thinkingLevelsFromMap } from './model-catalog-rpc'

export { MAX_CATALOG_PROVIDERS } from './model-catalog-cli'

export const PI_NOT_INSTALLED_WARNING = 'Pi is not installed. Install the pi CLI to load its model catalog.'

/**
 * Wall-clock limit for one pi catalog probe.
 *
 * Well above the shared 15s default on purpose: the probe has to wait for a whole `pi` process to
 * boot, and with a user's extension set installed that measured 11.4-24.0s, rising to ~25.9s when
 * another pi process starts alongside it. The 15s watchdog sat inside that band, so the first fetch
 * of a run regularly died on a healthy machine and left the model list empty. `RUST_PRIME_CATALOG_TIMEOUT_MS`
 * is the same kind of harness-specific allowance.
 */
export const PI_CATALOG_TIMEOUT_MS = 60_000

/**
 * Model catalog service for the pi harness. Pi has no CLI JSON model list
 * (`--list-models` prints a table even under `--mode json`), so the catalog
 * comes from the short-lived `get_available_models` RPC probe, spawned as
 * `pi --mode rpc --no-session --offline`. Satisfies the same
 * `ModelCatalogProvider` surface as `PrimeProviderService` and
 * `OmpModelCatalogService`, so `AgentRpcManager` and the `providers:catalog`
 * IPC path can consume any of them.
 *
 * The probe output is untrusted: it is byte-bounded, time-bounded, spawned
 * with an argv array and a sanitized environment, and every field is
 * validated before use. A null executable means pi is not installed; the
 * catalog is then empty with a clear warning.
 */
export class PiModelCatalogService extends RpcModelCatalogService {
  protected readonly harnessLabel = 'Pi'
  protected readonly cliName = 'pi'
  protected readonly probeArgs: readonly string[] = ['--mode', 'rpc', '--no-session', '--offline']
  protected readonly notInstalledWarning = PI_NOT_INSTALLED_WARNING
  protected readonly credentialsLabel = 'Credentials managed by the pi CLI'

  constructor(
    executable: ExecutableSource,
    options: Omit<CliModelCatalogOptions, 'timeoutMs'> & { timeoutMs?: number } = {}
  ) {
    super(executable, { ...options, timeoutMs: options.timeoutMs ?? PI_CATALOG_TIMEOUT_MS })
  }

  /** Mirrors pi's own `getSupportedThinkingLevels` exactly: only a reasoning model thinks. */
  protected describeModel(entry: ValidatedModelEntry, thinkingLevelMap: Record<string, unknown> | undefined): PrimeModelDescriptor {
    return { ...entry.descriptor, availableThinkingLevels: thinkingLevelsFromMap(entry.reasoning, thinkingLevelMap) }
  }
}
