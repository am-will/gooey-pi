import type { WebContents } from 'electron'
import { isTrustedRendererUrl } from './ipc'

interface RendererNavigationOptions {
  trustedUrl(): string
  zoomFactor(): number
  authorize(contents: WebContents): void
  revoke(ownerId: number): void
  killTerminals(ownerId: number): Promise<void>
  log(message: string): void
}

/** Bind document authority at commit, and retire PTYs when their owning document is replaced. */
export function bindRendererNavigation(renderer: WebContents, options: RendererNavigationOptions): void {
  renderer.on('did-navigate', (_event, url) => {
    if (!renderer.isDestroyed() && isTrustedRendererUrl(url, options.trustedUrl())) options.authorize(renderer)
  })
  renderer.on('did-finish-load', () => {
    if (!renderer.isDestroyed()) renderer.setZoomFactor(options.zoomFactor())
  })
  renderer.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    if (!isTrustedRendererUrl(details.url, options.trustedUrl())) options.revoke(renderer.id)
    else void options.killTerminals(renderer.id).catch((error: unknown) => {
      options.log(`GooeyPi could not close reloaded renderer terminals: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
