import { errorCode } from './validation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { primeImplementationFromVersion } from '../../src/lib/prime-compat'
import { HARNESS_IDS, type AppSettings, type HarnessId, type HarnessStatus, type PrimeImplementation } from '../../src/types/api'
import { HARNESSES, type HarnessDescriptor } from './harness'
import { harnessVersion } from './lib/harness-version'
import { lastNonEmptyLine, sanitizedDetail } from './lib/process-detail'
import { inspectPrimeNpmBridge, PRIME_NPM_BRIDGE_UNMIGRATED_DETAIL } from './prime-npm-bridge'
import { findHarnessExecutable, processFailureReason, runProcess, type ExecutableCandidateFailure } from './process-utils'
import type { JsonStateStore } from './store'

type RuntimePaths = Record<HarnessId, string>
type HarnessProblem = NonNullable<HarnessStatus['problem']>
/** 'skipped' marks a candidate GooeyPi refused to execute; its detail is the whole reason. */
export type HarnessProbeFailureKind = 'spawn' | 'exit' | 'timeout' | 'overflow' | 'skipped'
export interface HarnessProbeFailure {
  kind: HarnessProbeFailureKind
  code?: number
  detail: string
}
export interface HarnessProbe { runnable: boolean; version: string | null; failure?: HarnessProbeFailure }
type ExecutableFinder = (
  descriptor: HarnessDescriptor,
  configuredPath?: string,
  accept?: (candidate: string) => Promise<boolean>,
  onFailure?: (failure: ExecutableCandidateFailure) => void,
) => Promise<string | null>
type ExecutableProbe = (executable: string) => Promise<HarnessProbe>
type PrimeImplementationProbe = (executable: string) => Promise<PrimeImplementation>

export interface HarnessDiscoveryOptions {
  findExecutable?: ExecutableFinder
  probeExecutable?: ExecutableProbe
  probePrimeImplementation?: PrimeImplementationProbe
}

const PROBE_LIMITS = { timeoutMs: 10_000, maxBytes: 16 * 1024 }
const UNMIGRATED_PRIME_NPM_BRIDGE: HarnessProbe = {
  runnable: false,
  version: null,
  failure: { kind: 'skipped', detail: PRIME_NPM_BRIDGE_UNMIGRATED_DETAIL },
}

function processDetail(stdout: string, stderr: string): string {
  return sanitizedDetail(lastNonEmptyLine(stderr) ?? lastNonEmptyLine(stdout) ?? '')
}

function probeFailureDetail(failure: HarnessProbeFailure): string {
  if (failure.kind === 'skipped') return failure.detail
  const suffix = failure.detail ? `: ${failure.detail}` : ''
  if (failure.kind === 'exit') return `exited with code ${failure.code ?? 'unknown'}${suffix}`
  if (failure.kind === 'timeout') return `timed out${suffix}`
  if (failure.kind === 'overflow') return `output exceeded the probe limit${suffix}`
  return `could not start${suffix}`
}

function spawnFailure(error: unknown): HarnessProbeFailure {
  const code = errorCode(error) || 'UNKNOWN'
  const detail = code === 'ENOENT'
    ? 'path does not exist'
    : code === 'EACCES' || code === 'EPERM'
      ? 'permission denied'
      : `spawn error ${code}`
  return { kind: 'spawn', detail }
}

const emptyStatuses = (): Record<HarnessId, HarnessStatus> => ({
  omp: { path: null, version: null },
  prime: { path: null, version: null },
  pi: { path: null, version: null },
})

export async function probeHarnessExecutable(executable: string): Promise<HarnessProbe> {
  try {
    const result = await runProcess(executable, ['--version'], PROBE_LIMITS)
    const failure = processFailureReason(result)
    if (failure) {
      return {
        runnable: false,
        version: null,
        failure: {
          kind: failure,
          ...(failure === 'exit' ? { code: result.code } : {}),
          detail: processDetail(result.stdout, result.stderr),
        },
      }
    }
    return { runnable: true, version: harnessVersion(result.stdout.trim() || result.stderr) }
  } catch (error) {
    return { runnable: false, version: null, failure: spawnFailure(error) }
  }
}

/**
 * Classifies a Prime build whose version string did not: TypeScript accepts
 * --extension (and loads nothing for --version) while Rust rejects the unknown
 * option. Anything inconclusive counts as Rust, because leaving out
 * --extension only drops capabilities, visibly, while passing it to Rust is
 * fatal. The extension path lives in a fresh private directory and is never
 * created.
 */
export async function probePrimeImplementation(executable: string): Promise<PrimeImplementation> {
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'gooeypi-prime-probe-'))
    const result = await runProcess(executable, ['--extension', join(directory, 'never-created.ts'), '--version'], PROBE_LIMITS)
    return processFailureReason(result) ? 'rust' : 'typescript'
  } catch {
    // An unwritable temporary directory leaves the probe inconclusive too.
    return 'rust'
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function detectedHarnesses(statuses: Record<HarnessId, HarnessStatus>): HarnessId[] {
  return HARNESS_IDS.filter((harness) => Boolean(statuses[harness].path))
}

/** Serializes active-harness reconciliation with every other persisted setting mutation. */
export function reconcileActiveHarness(
  store: Pick<JsonStateStore, 'update'>,
  statuses: Record<HarnessId, HarnessStatus>,
): Promise<AppSettings> {
  const detected = detectedHarnesses(statuses)
  return store.update((state) => {
    if (detected.length && !detected.includes(state.settings.activeHarness)) {
      state.settings.activeHarness = detected[0]
    }
    return structuredClone(state.settings)
  })
}

/**
 * Owns the atomically published executable snapshot used by future process
 * launches. Overlapping refreshes may probe concurrently, but only the newest
 * request is allowed to replace the live snapshot.
 */
export class HarnessDiscoveryService {
  private statuses = emptyStatuses()
  private refreshRevision = 0
  private readonly findExecutable: ExecutableFinder
  private readonly probeExecutable: ExecutableProbe
  private readonly probePrimeImplementation: PrimeImplementationProbe

  constructor(
    private readonly runtimePaths: () => RuntimePaths,
    options: HarnessDiscoveryOptions = {},
  ) {
    this.findExecutable = options.findExecutable ?? findHarnessExecutable
    this.probeExecutable = options.probeExecutable ?? probeHarnessExecutable
    this.probePrimeImplementation = options.probePrimeImplementation ?? probePrimeImplementation
  }

  executable(harness: HarnessId): string | null {
    return this.statuses[harness].path
  }

  /** Implementation of the published Prime executable; undefined while none is discovered. */
  primeImplementation(): PrimeImplementation | undefined {
    return this.statuses.prime.implementation
  }

  snapshot(): Record<HarnessId, HarnessStatus> {
    return structuredClone(this.statuses)
  }

  async refresh(): Promise<Record<HarnessId, HarnessStatus>> {
    const revision = ++this.refreshRevision
    const runtimePaths = this.runtimePaths()
    const discovered = await Promise.all(HARNESS_IDS.map(async (harness): Promise<HarnessStatus> => {
      const probes = new Map<string, HarnessProbe>()
      let lastFailure: HarnessProblem | undefined
      let overrideFailure: HarnessProblem | undefined
      const probeCandidate = async (candidate: string): Promise<HarnessProbe> => {
        // Probing an un-migrated npm bridge would run the Rust installer. It is
        // rejected unexecuted, and a rejected candidate is never published,
        // so no later CLI call can reach it either.
        const result = harness === 'prime' && await inspectPrimeNpmBridge(candidate) === 'unmigrated'
          ? UNMIGRATED_PRIME_NPM_BRIDGE
          : await this.probeExecutable(candidate)
        probes.set(candidate, result)
        return result
      }
      const probe = async (candidate: string) => (await probeCandidate(candidate)).runnable
      const onFailure = (failure: ExecutableCandidateFailure): void => {
        const probeResult = probes.get(failure.path)
        const reported: HarnessProblem = probeResult?.failure
          ? { path: failure.path, reason: probeFailureDetail(probeResult.failure) }
          : { path: failure.path, reason: failure.reason }
        if (failure.kind !== 'missing') lastFailure = reported
        const environmentOverride = process.env[HARNESSES[harness].binaryEnvVar]
        if ((runtimePaths[harness] && failure.path === runtimePaths[harness]) || (environmentOverride && failure.path === environmentOverride)) {
          overrideFailure = reported
        }
      }
      const path = await this.findExecutable(HARNESSES[harness], runtimePaths[harness], probe, onFailure)
      if (!path) {
        const lastProbe = [...probes.values()].at(-1)
        const problem = overrideFailure ?? lastFailure ?? (lastProbe?.failure
          ? { path: [...probes.keys()].at(-1) ?? '', reason: probeFailureDetail(lastProbe.failure) }
          : undefined)
        return problem ? { path: null, version: null, problem } : { path: null, version: null }
      }
      const result = probes.get(path) ?? await probeCandidate(path)
      if (!result.runnable) return { path: null, version: null, problem: { path, reason: result.failure ? probeFailureDetail(result.failure) : 'could not run' } }
      if (harness !== 'prime') return { path, version: result.version }
      // Published versions classify without another process; only an
      // unreadable version pays for the feature probe.
      return { path, version: result.version, implementation: primeImplementationFromVersion(result.version) ?? await this.probePrimeImplementation(path) }
    }))
    const next = emptyStatuses()
    for (const [index, harness] of HARNESS_IDS.entries()) {
      next[harness] = discovered[index]
    }
    if (revision === this.refreshRevision) this.statuses = next
    return this.snapshot()
  }
}
