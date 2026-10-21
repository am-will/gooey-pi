import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '../../src/types/api'

export const DEFAULT_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 8_000

export interface UpdateAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): this
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): this
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  enabled: boolean
  checkIntervalMs?: number
  initialCheckDelayMs?: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  confirmInstall?: () => Promise<boolean>
  onInstallAborted?: () => void
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'Update check failed'
}

export interface ManualUpdateNotification {
  type: 'info' | 'error'
  message: string
  detail?: string
}

export function manualUpdateNotification(state: AppUpdateState): ManualUpdateNotification {
  if (state.phase === 'error') return {
    type: 'error',
    message: 'GooeyPi Update Check Failed',
    detail: state.message,
  }
  if (state.phase === 'unsupported') return {
    type: 'info',
    message: 'GooeyPi Updates Unavailable',
    detail: state.message ?? 'Automatic updates are available in installed builds.',
  }
  const available = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded'
  return {
    type: 'info',
    message: available ? 'GooeyPi Update Available' : 'No GooeyPi Update Available',
  }
}

/** Coalesces manual "Check for Updates…" clicks so concurrent clicks cannot queue dialogs. */
export function createManualUpdateCheck(
  check: () => Promise<AppUpdateState>,
  notify: (notification: ManualUpdateNotification) => void | Promise<void>,
): () => void {
  let inFlight = false
  return () => {
    if (inFlight) return
    inFlight = true
    void check()
      .then((state) => notify(manualUpdateNotification(state)))
      .catch((error) => notify({ type: 'error', message: 'GooeyPi Update Check Failed', detail: errorMessage(error) }))
      .finally(() => { inFlight = false })
      .catch((error: unknown) => console.error(`GooeyPi update notification failed: ${errorMessage(error)}`))
  }
}

export function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS; accessing through its default export keeps
  // the bundled Electron ESM output compatible with both Node module modes.
  return electronUpdater.autoUpdater
}

export class UpdateService {
  private state: AppUpdateState
  private sink: ((state: AppUpdateState) => void) | null = null
  private checkPromise: Promise<AppUpdateState> | null = null
  private downloadPromise: Promise<boolean> | null = null
  private installAfterDownload = false
  private installPromise: Promise<boolean> | null = null
  private installing = false
  private disposed = false
  /** Version of the discovered update, kept independent of the last published phase. */
  private discoveredVersion: string | undefined
  private interval: ReturnType<typeof globalThis.setInterval> | null = null
  private initialTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout
  private readonly setTimeoutFn: typeof globalThis.setTimeout

  constructor(private readonly updater: UpdateAdapter, private readonly options: UpdateServiceOptions) {
    this.state = options.enabled ? { phase: 'idle' } : { phase: 'unsupported', message: 'Automatic updates are available in installed builds.' }
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout
    if (!options.enabled) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => this.publish({ phase: 'checking' }))
    updater.on('update-available', (info) => {
      this.discoveredVersion = info.version
      this.publish({ phase: 'available', version: info.version })
    })
    updater.on('download-progress', (progress) => this.publish({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    }))
    updater.on('update-downloaded', (info) => {
      this.discoveredVersion = info.version
      this.stopScheduledChecks()
      this.publish({ phase: 'downloaded', version: info.version })
      if (!this.installAfterDownload) return
      this.installAfterDownload = false
      void this.installDownloaded()
    })
    updater.on('update-not-available', (info) => {
      this.discoveredVersion = undefined
      this.publish({ phase: 'not-available', version: info.version })
    })
    updater.on('error', (error) => {
      this.abortInstall()
      this.installAfterDownload = false
      this.publish({ phase: 'error', message: errorMessage(error) })
    })
  }

  start(): void {
    if (!this.options.enabled || this.interval || this.initialTimer) return
    this.initialTimer = this.setTimeoutFn(() => {
      this.initialTimer = null
      this.runScheduledCheck()
    }, this.options.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS)
    this.initialTimer.unref?.()
    this.interval = this.setIntervalFn(() => { this.runScheduledCheck() }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    this.interval.unref?.()
  }

  isEnabled(): boolean {
    return this.options.enabled
  }

  dispose(): void {
    this.disposed = true
    this.installAfterDownload = false
    this.stopScheduledChecks()
    this.sink = null
  }

  getState(): AppUpdateState {
    return structuredClone(this.state)
  }

  setEventSink(sink: ((state: AppUpdateState) => void) | null): void {
    this.sink = sink
  }

  check(): Promise<AppUpdateState> {
    if (!this.options.enabled) return Promise.resolve(this.getState())
    if (this.state.phase === 'available' || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return Promise.resolve(this.getState())
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = Promise.resolve().then(() => this.updater.checkForUpdates())
      .then(() => this.getState())
      .catch((error) => {
        this.publish({ phase: 'error', message: errorMessage(error) })
        return this.getState()
      })
      .finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  downloadAndInstall(): Promise<boolean> {
    if (!this.options.enabled) return Promise.resolve(false)
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.phase === 'downloaded') return this.installDownloaded()
    if (this.state.phase !== 'available') return Promise.resolve(false)

    this.installAfterDownload = true
    // Progress stays undefined until the first download-progress event so the
    // renderer can show a busy state instead of a stuck 0%.
    this.publish({ phase: 'downloading' })
    this.downloadPromise = this.updater.downloadUpdate()
      .then(() => true)
      .catch((error) => {
        this.installAfterDownload = false
        this.publish({ phase: 'error', message: errorMessage(error) })
        return false
      })
      .finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  private installDownloaded(): Promise<boolean> {
    if (this.installPromise) return this.installPromise
    this.installPromise = Promise.resolve().then(async () => {
      if (this.options.confirmInstall && !await this.options.confirmInstall()) return false
      if (this.disposed) return false
      this.installing = true
      this.updater.quitAndInstall(false, true)
      return this.installing
    }).catch((error: unknown) => {
      this.abortInstall()
      this.publish({ phase: 'error', message: errorMessage(error) })
      return false
    }).finally(() => { this.installPromise = null })
    return this.installPromise
  }

  private abortInstall(): void {
    if (!this.installing) return
    this.installing = false
    this.options.onInstallAborted?.()
  }

  private runScheduledCheck(): void {
    if (this.state.phase === 'downloaded') {
      this.stopScheduledChecks()
      return
    }
    void this.check().catch((error: unknown) => console.error(`GooeyPi scheduled update check failed: ${errorMessage(error)}`))
  }

  private stopScheduledChecks(): void {
    if (this.interval) this.clearIntervalFn(this.interval)
    if (this.initialTimer) this.clearTimeoutFn(this.initialTimer)
    this.interval = null
    this.initialTimer = null
  }

  private publish(state: AppUpdateState): void {
    const version = state.version ?? this.discoveredVersion
    this.state = version ? { ...state, version } : state
    this.sink?.(this.getState())
  }
}
