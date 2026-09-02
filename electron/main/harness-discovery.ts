import { HARNESS_IDS, type AppSettings, type HarnessId, type HarnessStatus } from '../../src/types/api'
import { HARNESSES, type HarnessDescriptor } from './harness'
import { hasControlCharacter, lastNonEmptyLine, sanitizedDetail } from './lib/process-detail'
import { findHarnessExecutable, processFailureReason, runProcess, type ExecutableCandidateFailure } from './process-utils'
import type { JsonStateStore } from './store'

type RuntimePaths = Record<HarnessId, string>
type HarnessProblem = NonNullable<HarnessStatus['problem']>
export type HarnessProbeFailureKind = 'spawn' | 'exit' | 'timeout' | 'overflow'
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

export interface HarnessDiscoveryOptions {
  findExecutable?: ExecutableFinder
  probeExecutable?: ExecutableProbe
}

function processDetail(stdout: string, stderr: string): string {
  return sanitizedDetail(lastNonEmptyLine(stderr) ?? lastNonEmptyLine(stdout) ?? '')
}

function probeFailureDetail(failure: HarnessProbeFailure): string {
  const suffix = failure.detail ? `: ${failure.detail}` : ''
  if (failure.kind === 'exit') return `exited with code ${failure.code ?? 'unknown'}${suffix}`
  if (failure.kind === 'timeout') return `timed out${suffix}`
  if (failure.kind === 'overflow') return `output exceeded the probe limit${suffix}`
  return `could not start${suffix}`
}

function spawnFailure(error: unknown): HarnessProbeFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
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
    const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000, maxBytes: 16 * 1024 })
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
    const token = (result.stdout.trim() || result.stderr.trim()).split(/\s+/).at(-1) ?? ''
    const version = token && token.length <= 128 && !hasControlCharacter(token) ? token : null
    return { runnable: true, version }
  } catch (error) {
    return { runnable: false, version: null, failure: spawnFailure(error) }
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

  constructor(
    private readonly runtimePaths: () => RuntimePaths,
    options: HarnessDiscoveryOptions = {},
  ) {
    this.findExecutable = options.findExecutable ?? findHarnessExecutable
    this.probeExecutable = options.probeExecutable ?? probeHarnessExecutable
  }

  executable(harness: HarnessId): string | null {
    return this.statuses[harness].path
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
      const probe = async (candidate: string) => {
        const result = await this.probeExecutable(candidate)
        probes.set(candidate, result)
        return result.runnable
      }
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
      const result = probes.get(path) ?? await this.probeExecutable(path)
      return result.runnable
        ? { path, version: result.version }
        : { path: null, version: null, problem: { path, reason: result.failure ? probeFailureDetail(result.failure) : 'could not run' } }
    }))
    const next = emptyStatuses()
    for (const [index, harness] of HARNESS_IDS.entries()) {
      next[harness] = discovered[index]
    }
    if (revision === this.refreshRevision) this.statuses = next
    return this.snapshot()
  }
}
