import { PRIME_THINKING_LEVELS, type PrimeModelDescriptor, type PrimeThinkingLevel } from '../../src/types/api'
import { CliModelCatalogService, validateModelEntry, type CliModelCatalogOptions } from './model-catalog-cli'
import { runProcess, safeChildEnvironment } from './process-utils'

export { MAX_CATALOG_PROVIDERS } from './model-catalog-cli'

export const OMP_NOT_INSTALLED_WARNING = 'OMP is not installed. Install the omp CLI to load its model catalog.'

/**
 * OMP reports the per-model thinking vocabulary as `thinking: string[] | null`
 * using the same level names as Prime, except `off` is implicit (never listed
 * by `omp models --json`). Mirror Prime's `getSupportedThinkingLevels`
 * convention: non-reasoning models expose exactly `['off']`, and reasoning
 * models expose `off` plus the reported levels in canonical order. Unknown or
 * non-string reported levels are dropped.
 */
function toThinkingLevels(reasoning: boolean, thinking: unknown): PrimeThinkingLevel[] {
  if (!reasoning) return ['off']
  const reported = new Set(Array.isArray(thinking) ? thinking.filter((level): level is string => typeof level === 'string') : [])
  return PRIME_THINKING_LEVELS.filter((level) => level === 'off' || reported.has(level))
}

export type OmpModelCatalogOptions = CliModelCatalogOptions

/**
 * Model catalog service for the OMP harness, backed by the `omp models --json`
 * CLI instead of in-process npm modules. Satisfies the same
 * `ModelCatalogProvider` surface as `PrimeProviderService`, so
 * `AgentRpcManager` and the `providers:catalog` IPC path can consume either.
 *
 * The CLI output is untrusted: it is byte-bounded, time-bounded, spawned with
 * an argv array and a sanitized environment, and every field is validated
 * before use. A null executable means OMP is not installed; the catalog is
 * then empty with a clear warning.
 */
export class OmpModelCatalogService extends CliModelCatalogService {
  protected readonly harnessLabel = 'OMP'
  protected readonly notInstalledWarning = OMP_NOT_INSTALLED_WARNING
  protected readonly credentialsLabel = 'Credentials managed by the omp CLI'

  protected override versionEnvironment(): NodeJS.ProcessEnv {
    return safeChildEnvironment()
  }

  /** The CLI prints `omp/<semver>`. */
  protected parseVersion(stdout: string): string | null {
    return stdout.match(/^omp\/([0-9A-Za-z.+-]{1,64})$/)?.[1] ?? null
  }

  protected async fetchModelEntries(executable: string): Promise<unknown[]> {
    const result = await runProcess(executable, ['models', '--json'], {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxOutputBytes,
      env: safeChildEnvironment(),
    })
    if (result.outputExceeded) throw new Error(`OMP model catalog output exceeded ${this.maxOutputBytes.toLocaleString()} bytes`)
    if (result.timedOut) throw new Error('The OMP model catalog request timed out')
    if (result.code !== 0) throw new Error(`omp models exited with status ${result.code}`)
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('OMP returned malformed model catalog JSON') }
    return this.requireModelEntries(parsed)
  }

  protected toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
    const entry = validateModelEntry(value)
    if (!entry) return null
    const { thinking } = entry.record
    if (thinking !== undefined && thinking !== null && !Array.isArray(thinking)) return null
    return { ...entry.descriptor, availableThinkingLevels: toThinkingLevels(entry.reasoning, thinking) }
  }
}
