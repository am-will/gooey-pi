import { HARNESS_IDS, type HarnessId, type HarnessStatus, type HarnessUpdateState } from '../../src/types/api'
import { readInstalledChangelog, sliceChangelog, type ChangelogSlice } from './harness-changelog'
import { runProcess } from './process-utils'

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 12_000
const CHECK_TTL_MS = 30 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 10_000
const MAX_REGISTRY_BYTES = 256 * 1024
const HARNESS_CHECK_TIMEOUT_MS = 30_000
const HARNESS_CHECK_MAX_OUTPUT_BYTES = 64 * 1024
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
const UPDATE_MAX_OUTPUT_BYTES = 1024 * 1024
const SAFE_VERSION = /^v?([0-9][0-9A-Za-z.+-]{0,63})$/

/**
 * How one harness is checked and updated. Two strategies exist: pi has no
 * check-only command, so its version is compared against its npm registry
 * entry; omp reports its own availability through `omp update --check`, so
 * the harness stays authoritative and GooeyPi only parses the answer. Either
 * way the update itself always runs the harness's own updater command, so
 * install-method detection, credentials, and file ownership stay with the
 * harness exactly as if the user had run the command in a terminal.
 */
type HarnessUpdateDescriptor =
  | { kind: 'npm-registry'; npmPackage: string; updateArgs: readonly string[] }
  | { kind: 'harness-check'; checkArgs: readonly string[]; updateArgs: readonly string[] }

const UPDATE_DESCRIPTORS: Partial<Record<HarnessId, HarnessUpdateDescriptor>> = {
  pi: { kind: 'npm-registry', npmPackage: '@earendil-works/pi-coding-agent', updateArgs: ['update', '--self'] },
  omp: { kind: 'harness-check', checkArgs: ['update', '--check'], updateArgs: ['update'] },
}

/** The pi package whose installed CHANGELOG.md backs the What's-new view. */
export const PI_CHANGELOG_PACKAGE = '@earendil-works/pi-coding-agent'

export type RegistryFetcher = (url: string, limits: { timeoutMs: number; maxBytes: number }) => Promise<string>

/** Byte-bounded registry fetch: aborts on timeout and stops reading at the cap instead of buffering an unbounded body. */
export const fetchRegistryDocument: RegistryFetcher = async (url, limits) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(limits.timeoutMs),
    redirect: 'error',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`The package registry answered ${response.status}`)
  if (!response.body) throw new Error('The package registry answered without a body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    if (received > limits.maxBytes) {
      void reader.cancel()
      throw new Error(`The package registry response exceeded ${limits.maxBytes.toLocaleString()} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Numeric-segment comparison; prerelease/build suffixes are ignored and unparseable versions never report newer. */
export function isNewerVersion(latest: string, installed: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = value.trim().match(/^v?(\d+(?:\.\d+)*)/)
    return match ? match[1].split('.').map(Number) : null
  }
  const latestParts = parse(latest)
  const installedParts = parse(installed)
  if (!latestParts || !installedParts) return false
  for (let index = 0; index < Math.max(latestParts.length, installedParts.length); index += 1) {
    const a = latestParts[index] ?? 0
    const b = installedParts[index] ?? 0
    if (a !== b) return a > b
  }
  return false
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 240) || 'Harness update check failed'
}

export interface HarnessUpdateServiceOptions {
  /** Live settings gate; a disabled toggle stops registry traffic without restarting the service. */
  enabled: () => boolean
  /** Current discovery snapshot entry; the service never resolves executables itself. */
  harnessStatus: (harness: HarnessId) => HarnessStatus
  /** Re-runs discovery after an update so the published version reflects the new binary. */
  refreshHarnesses: () => Promise<unknown>
  fetchRegistry?: RegistryFetcher
  runUpdateProcess?: typeof runProcess
  readChangelog?: typeof readInstalledChangelog
  checkIntervalMs?: number
  initialCheckDelayMs?: number
  checkTtlMs?: number
  updateTimeoutMs?: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  setTimeout?: typeof globalThis.setTimeout
}

/**
 * Registry-backed update awareness for harness executables, currently pi
 * only. Satisfies the same publish/sink shape as UpdateService: state changes
 * flow to one renderer event channel, IPC reads a cloned snapshot.
 *
 * The npm registry is the only network endpoint and only its `latest` version
 * field is trusted (after the same safe-version gate discovery applies to
 * `--version` output). Updates run the harness's own updater with a fixed
 * argv array — never a package manager, never a shell.
 */
export class HarnessUpdateService {
  private states: Record<HarnessId, HarnessUpdateState>
  private sink: ((states: Record<HarnessId, HarnessUpdateState>) => void) | null = null
  private checkPromise: Promise<Record<HarnessId, HarnessUpdateState>> | null = null
  private updatePromise: Promise<HarnessUpdateState> | null = null
  private checkedAt = 0
  private interval: ReturnType<typeof globalThis.setInterval> | null = null
  private initialTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private readonly fetchRegistry: RegistryFetcher
  private readonly runUpdateProcess: typeof runProcess
  private readonly readChangelog: typeof readInstalledChangelog
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval
  private readonly setTimeoutFn: typeof globalThis.setTimeout

  constructor(private readonly options: HarnessUpdateServiceOptions) {
    this.fetchRegistry = options.fetchRegistry ?? fetchRegistryDocument
    this.runUpdateProcess = options.runUpdateProcess ?? runProcess
    this.readChangelog = options.readChangelog ?? readInstalledChangelog
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout
    this.states = {
      omp: { phase: 'unsupported' },
      prime: { phase: 'unsupported' },
      pi: { phase: 'idle' },
    }
  }

  start(): void {
    if (this.interval || this.initialTimer) return
    this.initialTimer = this.setTimeoutFn(() => {
      this.initialTimer = null
      void this.check().catch(() => undefined)
    }, this.options.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS)
    this.initialTimer.unref?.()
    this.interval = this.setIntervalFn(() => {
      void this.check(true).catch(() => undefined)
    }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    this.interval.unref?.()
  }

  dispose(): void {
    if (this.interval) this.clearIntervalFn(this.interval)
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.interval = null
    this.initialTimer = null
    this.sink = null
  }

  setEventSink(sink: ((states: Record<HarnessId, HarnessUpdateState>) => void) | null): void {
    this.sink = sink
  }

  getState(): Record<HarnessId, HarnessUpdateState> {
    return structuredClone(this.states)
  }

  check(force = false): Promise<Record<HarnessId, HarnessUpdateState>> {
    if (!this.options.enabled()) {
      for (const harness of HARNESS_IDS) {
        if (UPDATE_DESCRIPTORS[harness]) this.publish(harness, { phase: 'disabled' })
      }
      return Promise.resolve(this.getState())
    }
    if (this.checkPromise) return this.checkPromise
    if (!force && Date.now() - this.checkedAt < (this.options.checkTtlMs ?? CHECK_TTL_MS)) {
      return Promise.resolve(this.getState())
    }
    this.checkPromise = Promise.all(
      HARNESS_IDS.map((harness) => this.checkHarness(harness)),
    ).then((states) => {
      for (const [index, harness] of HARNESS_IDS.entries()) this.publish(harness, states[index])
      this.checkedAt = Date.now()
      return this.getState()
    }).finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  async update(harness: HarnessId): Promise<HarnessUpdateState> {
    const descriptor = UPDATE_DESCRIPTORS[harness]
    if (!descriptor) throw new Error('In-app updates are not supported for this harness')
    if (!this.options.enabled()) throw new Error('Harness update checks are disabled')
    if (this.updatePromise) return this.updatePromise
    if (this.states[harness].phase !== 'available') throw new Error('No harness update is available')
    const executable = this.options.harnessStatus(harness).path
    if (!executable) throw new Error('The harness executable was not found')
    this.publish(harness, { ...this.states[harness], phase: 'updating' })
    this.updatePromise = this.runUpdate(harness, executable, descriptor).finally(() => { this.updatePromise = null })
    return this.updatePromise
  }

  private async runUpdate(harness: HarnessId, executable: string, descriptor: HarnessUpdateDescriptor): Promise<HarnessUpdateState> {
    try {
      const result = await this.runUpdateProcess(executable, [...descriptor.updateArgs], {
        timeoutMs: this.options.updateTimeoutMs ?? UPDATE_TIMEOUT_MS,
        maxBytes: UPDATE_MAX_OUTPUT_BYTES,
      })
      if (result.timedOut) throw new Error('The harness updater timed out')
      if (result.code !== 0) {
        // Updater output is untrusted; surface only a bounded, printable tail.
        const detail = (result.stderr.trim() || result.stdout.trim()).replace(/[^\x20-\x7e]+/g, ' ').slice(-200)
        throw new Error(detail ? `The harness updater failed: ${detail}` : `The harness updater exited with status ${result.code ?? -1}`)
      }
      // Re-probe so the published installed version is the post-update binary,
      // then recompute against the registry outside the TTL window.
      await this.options.refreshHarnesses()
      this.publish(harness, await this.checkHarness(harness))
      this.checkedAt = Date.now()
    } catch (error) {
      this.publish(harness, { ...this.states[harness], phase: 'error', message: boundedMessage(error) })
    }
    return structuredClone(this.states[harness])
  }

  /**
   * Release notes for the installed harness build, read from the package's
   * own CHANGELOG.md. Only pi ships one; other harnesses answer null, as
   * does any layout where the changelog cannot be located. `sinceVersion`
   * is untrusted renderer input.
   */
  async changelog(harness: HarnessId, rawSinceVersion?: unknown): Promise<ChangelogSlice | null> {
    if (harness !== 'pi') return null
    let sinceVersion: string | undefined
    if (rawSinceVersion !== undefined) {
      const match = typeof rawSinceVersion === 'string' ? rawSinceVersion.match(SAFE_VERSION) : null
      if (!match) throw new TypeError('sinceVersion is not a valid version')
      sinceVersion = match[1]
    }
    const status = this.options.harnessStatus(harness)
    const installed = status.version?.match(SAFE_VERSION)
    if (!status.path || !installed) return null
    const markdown = await this.readChangelog(status.path, PI_CHANGELOG_PACKAGE)
    return markdown ? sliceChangelog(markdown, installed[1], sinceVersion) : null
  }

  private async checkHarness(harness: HarnessId): Promise<HarnessUpdateState> {
    const descriptor = UPDATE_DESCRIPTORS[harness]
    if (!descriptor) return { phase: 'unsupported' }
    const status = this.options.harnessStatus(harness)
    if (!status.path) return { phase: 'unsupported', message: 'The harness is not installed.' }
    if (descriptor.kind === 'harness-check') return this.checkThroughHarness(status.path, descriptor)
    if (!status.version) return { phase: 'error', message: 'The installed version could not be determined.' }
    try {
      const latest = await this.fetchLatestVersion(descriptor.npmPackage)
      return {
        phase: isNewerVersion(latest, status.version) ? 'available' : 'up-to-date',
        installedVersion: status.version,
        latestVersion: latest,
      }
    } catch (error) {
      return { phase: 'error', installedVersion: status.version, message: boundedMessage(error) }
    }
  }

  /** Runs the harness's own check command (`omp update --check`) and parses its two version lines; the output is untrusted. */
  private async checkThroughHarness(executable: string, descriptor: Extract<HarnessUpdateDescriptor, { kind: 'harness-check' }>): Promise<HarnessUpdateState> {
    try {
      const result = await this.runUpdateProcess(executable, [...descriptor.checkArgs], {
        timeoutMs: HARNESS_CHECK_TIMEOUT_MS,
        maxBytes: HARNESS_CHECK_MAX_OUTPUT_BYTES,
      })
      if (result.timedOut) throw new Error('The harness update check timed out')
      if (result.code !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).replace(/[^\x20-\x7e]+/g, ' ').slice(-200)
        throw new Error(detail ? `The harness update check failed: ${detail}` : `The harness update check exited with status ${result.code ?? -1}`)
      }
      const installed = result.stdout.match(/^Current version:\s*v?([0-9][0-9A-Za-z.+-]{0,63})\s*$/m)?.[1]
      const latest = result.stdout.match(/^New version available:\s*v?([0-9][0-9A-Za-z.+-]{0,63})\s*$/m)?.[1]
      if (latest) return { phase: 'available', installedVersion: installed, latestVersion: latest }
      if (installed) return { phase: 'up-to-date', installedVersion: installed }
      throw new Error('The harness update check answered in an unrecognized format')
    } catch (error) {
      return { phase: 'error', message: boundedMessage(error) }
    }
  }

  private async fetchLatestVersion(npmPackage: string): Promise<string> {
    const url = `https://registry.npmjs.org/${npmPackage}/latest`
    const body = await this.fetchRegistry(url, { timeoutMs: REGISTRY_TIMEOUT_MS, maxBytes: MAX_REGISTRY_BYTES })
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new Error('The package registry answered with invalid JSON') }
    const version = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).version
      : undefined
    const match = typeof version === 'string' ? version.match(SAFE_VERSION) : null
    if (!match) throw new Error('The package registry answered without a usable version')
    return match[1]
  }

  private publish(harness: HarnessId, state: HarnessUpdateState): void {
    this.states[harness] = state
    this.sink?.(this.getState())
  }
}
