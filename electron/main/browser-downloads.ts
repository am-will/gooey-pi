import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { DownloadItem, Event, WebContents } from 'electron'
import { mt } from './localization'

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MAX_CONCURRENT_DOWNLOADS = 3
const MAX_WINDOW_BYTES = 1024 * 1024 * 1024
const WINDOW_MS = 60 * 60 * 1000

interface ActiveDownload { item: DownloadItem; ownerId: number; receivedBytes: number; outstandingDeclaredBytes: number }

export function automaticDownloadPath(downloadDirectory: string, filename: string, suffix: string = randomUUID()): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strips control characters from untrusted download filenames
  const leaf = basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'download'
  const extension = extname(leaf).slice(0, 24)
  const stem = leaf.slice(0, Math.max(1, leaf.length - extension.length)).replace(/^\.+$/, 'download')
  return join(downloadDirectory, `${stem}-${suffix}${extension}`)
}

export class BrowserDownloadGuard {
  private readonly active = new Map<DownloadItem, ActiveDownload>()
  private windowStartedAt = Date.now()
  private windowBytes = 0

  constructor(
    private readonly isAllowedUrl: (value: string) => boolean,
    private readonly downloadDirectory: string,
  ) {}

  handle(event: Event, item: DownloadItem, owner: WebContents | undefined, askForDownloads: boolean): void {
    this.refreshWindow()
    const chain = item.getURLChain()
    const declared = item.getTotalBytes()
    const safe = Boolean(owner && !owner.isDestroyed()) && chain.length > 0 && chain.every(this.isAllowedUrl) && this.isAllowedUrl(item.getURL())
    const fitsSingle = declared < 0 || declared <= MAX_DOWNLOAD_BYTES
    const fitsWindow = declared < 0 || this.windowBytes + declared <= MAX_WINDOW_BYTES
    if (!item.hasUserGesture() || !safe || !fitsSingle || !fitsWindow || this.active.size >= MAX_CONCURRENT_DOWNLOADS) {
      event.preventDefault()
      return
    }

    // Charge the declared total up front so concurrent admissions cannot
    // collectively over-commit the window; actual bytes replace the declared
    // charge as they arrive and the unreceived remainder is refunded on done.
    const active: ActiveDownload = { item, ownerId: owner!.id, receivedBytes: 0, outstandingDeclaredBytes: Math.max(0, declared) }
    this.active.set(item, active)
    this.windowBytes += active.outstandingDeclaredBytes
    if (askForDownloads) item.setSaveDialogOptions({ title: mt('dialog.saveBrowserDownload'), defaultPath: item.getFilename() })
    else item.setSavePath(automaticDownloadPath(this.downloadDirectory, item.getFilename()))
    item.on('updated', () => {
      this.refreshWindow()
      const received = Math.max(0, item.getReceivedBytes())
      const delta = Math.max(0, received - active.receivedBytes)
      active.receivedBytes = received
      const coveredByDeclaration = Math.min(delta, active.outstandingDeclaredBytes)
      active.outstandingDeclaredBytes -= coveredByDeclaration
      this.windowBytes += delta - coveredByDeclaration
      if (received > MAX_DOWNLOAD_BYTES || this.windowBytes > MAX_WINDOW_BYTES) item.cancel()
    })
    item.once('done', () => {
      this.windowBytes = Math.max(0, this.windowBytes - active.outstandingDeclaredBytes)
      active.outstandingDeclaredBytes = 0
      this.active.delete(item)
    })
  }

  cancelOwner(ownerId: number): void {
    for (const active of this.active.values()) if (active.ownerId === ownerId) active.item.cancel()
  }

  cancelAll(resetBudget = false): void {
    for (const active of this.active.values()) active.item.cancel()
    this.active.clear()
    if (resetBudget) { this.windowStartedAt = Date.now(); this.windowBytes = 0 }
  }

  get activeCount(): number { return this.active.size }

  private refreshWindow(): void {
    if (Date.now() - this.windowStartedAt < WINDOW_MS) return
    this.windowStartedAt = Date.now()
    let outstanding = 0
    for (const active of this.active.values()) outstanding += active.outstandingDeclaredBytes
    this.windowBytes = outstanding
  }
}
