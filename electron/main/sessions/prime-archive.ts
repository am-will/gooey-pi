import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionWatchFactory, SessionWatcher } from '../sessions'
import { isPathWithin } from '../validation'
import { SessionMetadataCatalog } from './catalog'

/** Rust Prime 0.10 retires JSONL files into a sibling directory; explicit --resume paths still open them. */
export class PrimeSessionArchive {
  private watcher: SessionWatcher | undefined

  constructor(
    private readonly sessionRoot: () => string,
    readonly enabled: () => boolean,
    readonly catalog: SessionMetadataCatalog,
    private readonly watchDirectory: SessionWatchFactory,
  ) {}

  get directory(): string { return join(dirname(this.sessionRoot()), 'sessions-archive') }

  async authorizes(path: string): Promise<boolean> {
    if (!this.enabled() || !path.endsWith('.jsonl')) return false
    try { return isPathWithin(await realpath(this.directory), path) } catch { return false }
  }

  watch(onChange: () => void): void {
    if (!this.enabled() || this.watcher) return
    try {
      const watcher = this.watchDirectory(this.directory, { persistent: false }, () => {
        this.catalog.invalidateLiveCatalog()
        onChange()
      })
      this.watcher = watcher
      watcher.on('error', () => {
        if (this.watcher !== watcher) return
        this.close()
        this.catalog.invalidateLiveCatalog()
        onChange()
      })
    } catch { /* The directory appears on the first native archive; the next list retries. */ }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
  }
}
