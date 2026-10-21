import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { bindRendererNavigation } from '../../electron/main/renderer-navigation'

function fixture() {
  const renderer = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, setZoomFactor: vi.fn() })
  const options = { trustedUrl: () => 'prime-work://app/index.html', zoomFactor: () => 1.1, authorize: vi.fn(), revoke: vi.fn(), killTerminals: vi.fn(async () => {}), log: vi.fn() }
  bindRendererNavigation(renderer as unknown as WebContents, options)
  return { renderer, options }
}

describe('renderer document ownership', () => {
  it('authorizes a trusted commit before finish-load and reapplies zoom at finish', () => {
    const { renderer, options } = fixture()
    renderer.emit('did-navigate', {}, options.trustedUrl())
    expect(options.authorize).toHaveBeenCalledWith(renderer)
    expect(renderer.setZoomFactor).not.toHaveBeenCalled()
    renderer.emit('did-finish-load')
    expect(renderer.setZoomFactor).toHaveBeenCalledWith(1.1)
  })

  it('retires terminals on document replacement and preserves authority for trusted reloads', () => {
    const { renderer, options } = fixture()
    renderer.emit('did-start-navigation', { url: options.trustedUrl(), isMainFrame: true, isSameDocument: false })
    expect(options.killTerminals).toHaveBeenCalledWith(42)
    expect(options.revoke).not.toHaveBeenCalled()
    renderer.emit('did-start-navigation', { url: `${options.trustedUrl()}#anchor`, isMainFrame: true, isSameDocument: true })
    renderer.emit('did-start-navigation', { url: 'https://example.com', isMainFrame: false, isSameDocument: false })
    expect(options.killTerminals).toHaveBeenCalledOnce()
    renderer.emit('did-start-navigation', { url: 'https://example.com', isMainFrame: true, isSameDocument: false })
    expect(options.revoke).toHaveBeenCalledWith(42)
  })

  it('observes terminal cleanup failures without an unhandled rejection', async () => {
    const { renderer, options } = fixture()
    options.killTerminals.mockRejectedValue(new Error('PTY cleanup failed'))
    renderer.emit('did-start-navigation', { url: options.trustedUrl(), isMainFrame: true, isSameDocument: false })
    await vi.waitFor(() => expect(options.log).toHaveBeenCalledWith(expect.stringContaining('PTY cleanup failed')))
  })
})
