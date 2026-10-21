import { performance } from 'node:perf_hooks'
import { parseExtensionUiCancel, parseExtensionUiRequest } from '../../../src/lib/extension-ui'
import type { RpcObject } from './types'

interface PendingDialog { frame: RpcObject; timer?: NodeJS.Timeout; expiresAt?: number }

/** Retains only bounded, answerable dialogs so a renderer reload can recover them. */
export class PendingExtensionUi {
  private readonly pending = new Map<string, PendingDialog>()
  constructor(private readonly now: () => number = () => performance.now()) {}

  track(frame: RpcObject): void {
    const cancelled = parseExtensionUiCancel(frame)
    if (cancelled) { this.resolve(cancelled); return }
    const request = parseExtensionUiRequest(frame)
    if (!request) return
    this.resolve(request.id)
    const retained: RpcObject = { type: 'extension_ui_request', ...request }
    // The first native select option carries questionnaire grouping metadata.
    // Keep that validated marker so replay uses the same parser as live frames.
    if (request.method === 'select' && Array.isArray(frame.options)) retained.options = [...frame.options]
    const timeout = 'timeout' in request ? request.timeout : undefined
    const entry: PendingDialog = { frame: retained }
    if (timeout !== undefined) {
      entry.expiresAt = this.now() + timeout
      entry.timer = setTimeout(() => this.resolve(request.id), timeout)
      entry.timer.unref()
    }
    this.pending.set(request.id, entry)
    while (this.pending.size > 16) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.resolve(oldest)
    }
  }

  resolve(id: unknown): void {
    if (typeof id !== 'string') return
    const entry = this.pending.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    this.pending.delete(id)
  }

  clear(): void { for (const id of this.pending.keys()) this.resolve(id) }

  list(): RpcObject[] {
    const frames: RpcObject[] = []
    for (const [id, entry] of this.pending) {
      const remaining = entry.expiresAt === undefined ? undefined : Math.ceil(entry.expiresAt - this.now())
      if (remaining !== undefined && remaining <= 0) { this.resolve(id); continue }
      frames.push({ ...entry.frame, ...(Array.isArray(entry.frame.options) ? { options: [...entry.frame.options] } : {}), ...(remaining === undefined ? {} : { timeout: remaining }) })
    }
    return frames
  }
}
