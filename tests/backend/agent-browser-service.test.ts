import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { AgentBrowserService } from '../../electron/main/browser/agent-service'
import type { AgentBrowserPointerEvent, AgentBrowserState } from '../../src/types/api'

let nextGuestId = 1000

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

class FakeGuest extends EventEmitter {
  readonly id = nextGuestId++
  url = 'about:blank'
  title = ''
  destroyed = false
  loading = false
  throttling: boolean | null = null
  audioMuted = false
  closeOptions: Electron.CloseOpts | null = null
  deferClose = false
  readonly loadedUrls: string[] = []
  /** CDP commands dispatched through the debugger, flattened as {method, ...params}. */
  readonly inputEvents: Array<Record<string, unknown>> = []
  readonly insertedText: string[] = []
  readonly executedScripts: string[] = []
  debuggerAttached = false
  readonly debugger = {
    isAttached: () => this.debuggerAttached,
    attach: () => { this.debuggerAttached = true },
    detach: () => { this.debuggerAttached = false },
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      if (!this.debuggerAttached) throw new Error('Debugger is not attached')
      if (method === 'Input.insertText') { this.insertedText.push(String(params.text)); return }
      this.inputEvents.push({ method, ...params })
    },
  }
  scriptResult: (code: string) => unknown = (code) => {
    if (code.includes('readyState')) {
      return JSON.stringify({ url: this.url, title: this.title, innerWidth: 640, innerHeight: 480, scrollY: 0, scrollHeight: 900, readyState: 'complete' })
    }
    return JSON.stringify({})
  }

  isDestroyed() { return this.destroyed }
  isLoading() { return this.loading }
  getURL() { return this.url }
  getTitle() { return this.title }
  canGoBack() { return false }
  canGoForward() { return false }
  goBack() {}
  goForward() {}
  reload() {}
  stop() {}
  focus() {}
  setBackgroundThrottling(allowed: boolean) { this.throttling = allowed }
  setAudioMuted(muted: boolean) { this.audioMuted = muted }
  async loadURL(url: string) {
    this.loadedUrls.push(url)
    this.url = url
    this.emit('did-navigate')
  }
  async insertText(value: string) { this.insertedText.push(value) }
  sendInputEvent() { throw new Error('sendInputEvent does not reach webview guests; use the debugger') }
  /**
   * Mirrors Electron's real `did-start-navigation` emit: a details object
   * carrying `isSameDocument`/`isMainFrame` first, then the deprecated
   * positional arguments that still trail it.
   */
  startNavigation({ url, isSameDocument, isMainFrame }: { url: string; isSameDocument: boolean; isMainFrame: boolean }) {
    const details = { preventDefault: () => {}, defaultPrevented: false, url, isSameDocument, isMainFrame, frame: null }
    this.emit('did-start-navigation', details, url, isSameDocument, isMainFrame, 1, 2)
  }
  async executeJavaScript(code: string) {
    this.executedScripts.push(code)
    return this.scriptResult(code)
  }
  async capturePage() {
    const image = {
      getSize: () => ({ width: 1280, height: 960 }),
      resize: ({ width }: { width: number }) => ({
        getSize: () => ({ width, height: Math.round((width / 1280) * 960) }),
        resize: () => image,
        toJPEG: () => Buffer.from('resized-jpeg'),
      }),
      toJPEG: () => Buffer.from('jpeg'),
    }
    return image
  }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
  close(options: Electron.CloseOpts) {
    this.closeOptions = options
    if (!this.deferClose) this.destroy()
  }
}

function fixture(options?: { actionTimeoutMs?: number }) {
  const guests = new Map<number, FakeGuest>()
  const service = new AgentBrowserService({
    getGuest: (id) => guests.get(id) as unknown as WebContents,
    attachTimeoutMs: 1_500,
    loadTimeoutMs: 1_500,
    actionTimeoutMs: options?.actionTimeoutMs,
  })
  const states: AgentBrowserState[] = []
  service.onDidChange((state) => states.push(state))
  const pointerEvents: AgentBrowserPointerEvent[] = []
  service.onPointer((event) => pointerEvents.push(event))
  const activityEvents: Array<{ sessionFile: string; tabId: string }> = []
  service.onActivity((event) => activityEvents.push(event))
  const newGuest = () => {
    const guest = new FakeGuest()
    guests.set(guest.id, guest)
    service.approveGuest(guest as unknown as WebContents)
    return guest
  }
  const openAttached = async (sessionKey: string, url?: string) => {
    const guest = newGuest()
    const opening = service.openTab(sessionKey, url === undefined ? {} : { url })
    // The renderer would mount a webview for the pushed pending tab and report attachment.
    await new Promise((resolveTick) => setTimeout(resolveTick, 10))
    const pending = service.state().tabs.find((tab) => !tab.attached && tab.sessionFile === sessionKey)
    expect(pending).toBeDefined()
    service.attachTab(pending!.tabId, guest.id)
    const result = await opening
    return { guest, tabId: result.tabId as string, result }
  }
  return { service, states, pointerEvents, activityEvents, guests, newGuest, openAttached }
}

describe('AgentBrowserService', () => {
  it('opens a tab once the renderer attaches an approved guest and navigates it', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId, result } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    expect(guest.loadedUrls).toContain('https://example.com/')
    expect(guest.throttling).toBe(false)
    expect(result.url).toBe('https://example.com/')
    const snapshot = service.state()
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.tabs[0]).toMatchObject({ tabId, sessionFile: '/sessions/a.jsonl', attached: true, active: true })
  })

  it('rejects unapproved guests and guests already bound to another tab', async () => {
    const { service, guests, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl')
    const rogue = new FakeGuest()
    guests.set(rogue.id, rogue)
    const opening = service.openTab('/sessions/a.jsonl', {})
    await new Promise((resolveTick) => setTimeout(resolveTick, 10))
    const pending = service.state().tabs.find((tab) => !tab.attached)!
    expect(() => service.attachTab(pending.tabId, rogue.id)).toThrow(/not an approved browser guest/)
    expect(() => service.attachTab(pending.tabId, guest.id)).toThrow(/already bound/)
    service.closeTab(pending.tabId)
    await expect(opening).rejects.toThrow()
  })

  it('promptly rejects actions waiting for attachment when their session is revoked', async () => {
    const { service } = fixture()
    const opening = service.openTab('/sessions/a.jsonl', {})
    const pending = service.state().tabs.find((tab) => tab.sessionFile === '/sessions/a.jsonl')
    expect(pending).toBeDefined()
    const action = service.evaluate('/sessions/a.jsonl', { tabId: pending!.tabId, code: "'never-executed'" })
    const openingOutcome = opening.then(() => null, (error: unknown) => error)
    const actionOutcome = action.then(() => null, (error: unknown) => error)
    await Promise.resolve()

    expect(service.closeForSession('/sessions/a.jsonl')).toBe(true)
    const [openingError, actionError] = await Promise.all([openingOutcome, actionOutcome])
    expect(String(openingError)).toMatch(/browser tab access changed/i)
    expect(String(actionError)).toMatch(/browser tab access changed/i)
    expect(service.state().tabs).toEqual([])
  })

  it('scopes agent actions to the owning session', async () => {
    const { service, openAttached } = fixture()
    const { tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    await openAttached('/sessions/b.jsonl', 'https://other.example/')
    await expect(service.closeTabScoped('/sessions/b.jsonl', { tabId })).rejects.toThrow(/does not belong to this thread/)
    await expect(service.readPage('/sessions/b.jsonl', { tabId })).rejects.toThrow(/does not belong to this thread/)
    const mine = await service.listTabs('/sessions/a.jsonl')
    expect(mine.tabs).toHaveLength(1)
  })

  it('enforces the per-session tab cap', async () => {
    const { service, openAttached } = fixture()
    for (let index = 0; index < 6; index += 1) await openAttached('/sessions/a.jsonl')
    await expect(service.openTab('/sessions/a.jsonl', {})).rejects.toThrow(/already has 6 browser tabs/)
  })

  it('refuses non-http(s) navigation targets', async () => {
    const { service, openAttached } = fixture()
    await openAttached('/sessions/a.jsonl')
    await expect(service.navigate('/sessions/a.jsonl', { url: 'file:///etc/passwd' })).rejects.toThrow(/credential-free http/)
    await expect(service.navigate('/sessions/a.jsonl', { url: 'https://user:pw@example.com/' })).rejects.toThrow(/credential-free http/)
    await expect(service.openTab('/sessions/a.jsonl', { url: 'javascript:alert(1)' })).rejects.toThrow(/credential-free http/)
  })

  it('clicks element refs through injected geometry and trusted input events', async () => {
    const { service, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    guest.scriptResult = (code) => {
      if (code.includes('__primeWorkAgentRefs')) return JSON.stringify({ x: 12, y: 34 })
      return JSON.stringify({ url: guest.url, title: guest.title, innerWidth: 640, innerHeight: 480, scrollY: 0, scrollHeight: 900, readyState: 'complete' })
    }
    await service.click('/sessions/a.jsonl', { ref: 3 })
    const types = guest.inputEvents.map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(['mouseMoved', 'mousePressed', 'mouseReleased']))
    expect(guest.inputEvents.every((event) => event.method === 'Input.dispatchMouseEvent')).toBe(true)
    expect(guest.inputEvents.find((event) => event.type === 'mousePressed')).toMatchObject({ x: 12, y: 34, button: 'left', buttons: 1, clickCount: 1 })
  })

  it('glides the pointer between clicks and emits synchronized pointer events', async () => {
    const { service, pointerEvents, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    await service.click('/sessions/a.jsonl', { x: 20, y: 30 })
    // First action: cursor appears in place, no glide.
    expect(pointerEvents.at(-1)).toMatchObject({ from: null, to: { x: 20, y: 30 }, action: 'click', durationMs: 0 })
    guest.inputEvents.length = 0
    await service.click('/sessions/a.jsonl', { x: 320, y: 230 })
    const glide = pointerEvents.at(-1)!
    expect(glide).toMatchObject({ from: { x: 20, y: 30 }, to: { x: 320, y: 230 }, action: 'click' })
    expect(glide.durationMs).toBeGreaterThan(0)
    expect(glide.sessionFile).toBe('/sessions/a.jsonl')
    // The glide sends a trail of intermediate mouseMoved events ending at the target.
    const moves = guest.inputEvents.filter((event) => event.type === 'mouseMoved')
    expect(moves.length).toBeGreaterThanOrEqual(5)
    expect(moves.at(-1)).toMatchObject({ x: 320, y: 230 })
    expect(moves[0]).not.toMatchObject({ x: 320, y: 230 })
    const beforeDown = guest.inputEvents.findIndex((event) => event.type === 'mousePressed')
    expect(guest.inputEvents.slice(0, beforeDown).every((event) => event.type === 'mouseMoved')).toBe(true)
    // Focusing a field for typing also moves the cursor there.
    guest.scriptResult = (code) => {
      if (code.includes('__primeWorkAgentRefs')) return JSON.stringify({ x: 40, y: 50 })
      return JSON.stringify({ url: guest.url, title: guest.title, innerWidth: 640, innerHeight: 480, scrollY: 0, scrollHeight: 900, readyState: 'complete' })
    }
    await service.type('/sessions/a.jsonl', { text: 'hi', ref: 1 })
    expect(pointerEvents.at(-1)).toMatchObject({ to: { x: 40, y: 50 }, action: 'move' })
  })

  it('types into the page and submits with Enter', async () => {
    const { service, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    await service.type('/sessions/a.jsonl', { text: 'hello world', submit: true })
    expect(guest.insertedText).toEqual(['hello world'])
    const enterEvents = guest.inputEvents.filter((event) => event.method === 'Input.dispatchKeyEvent' && event.key === 'Enter')
    expect(enterEvents.map((event) => event.type)).toEqual(['keyDown', 'keyUp'])
    expect(enterEvents[0]).toMatchObject({ text: '\r', windowsVirtualKeyCode: 13 })
  })

  it('captures screenshots at CSS pixel scale with the pointer marker drawn in', async () => {
    const { service, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const shot = await service.screenshot('/sessions/a.jsonl', {})
    // Retina captures report DIP size but encode 2x pixels; the resize to the
    // CSS viewport must happen unconditionally.
    expect(shot.mimeType).toBe('image/jpeg')
    expect(shot.width).toBe(640)
    expect(shot.height).toBe(480)
    expect(Buffer.from(shot.data as string, 'base64').toString()).toBe('resized-jpeg')
    // With a pointer, the capture brackets an in-page cursor marker.
    await service.click('/sessions/a.jsonl', { x: 10, y: 10 })
    guest.executedScripts.length = 0
    await service.screenshot('/sessions/a.jsonl', {})
    expect(guest.executedScripts.some((code) => code.includes('__primeWorkAgentCursorMarker') && code.includes("style.left = '10px'"))).toBe(true)
    expect(guest.executedScripts.some((code) => code.includes('marker.remove()'))).toBe(true)
  })

  it('rejects a guest call that never answers after actionTimeoutMs', async () => {
    const { service, openAttached } = fixture({ actionTimeoutMs: 50 })
    const { guest, tabId } = await openAttached('/sessions/a.jsonl')
    guest.scriptResult = (code) => code.includes('hangs') ? new Promise(() => {}) : JSON.stringify({})

    await expect(service.evaluate('/sessions/a.jsonl', { tabId, code: "'hangs'" })).rejects.toThrow(/did not answer this action in time/)
  })

  it('releases the per-tab queue after the timeout grace even if the action is still pending', async () => {
    const { service, openAttached } = fixture({ actionTimeoutMs: 50 })
    const { guest, tabId } = await openAttached('/sessions/a.jsonl')
    vi.useFakeTimers()
    try {
      guest.loadURL = () => new Promise<void>(() => {})
      const hung = service.navigate('/sessions/a.jsonl', { tabId, url: 'https://example.org/' })
      void hung.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(50 + 5_000 + 10)
      await expect(service.evaluate('/sessions/a.jsonl', { tabId, code: "'after'" })).resolves.toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a screenshot when navigation strands capturePage', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl')
    const started = deferred<void>()
    guest.capturePage = () => {
      started.resolve()
      return new Promise<never>(() => {})
    }

    const stranded = service.screenshot('/sessions/a.jsonl', { tabId })
    await started.promise
    guest.startNavigation({ url: 'https://example.org/', isSameDocument: false, isMainFrame: true })

    await expect(stranded).rejects.toThrow(/page navigated while this action was running/i)
  })

  it('marks tabs detached when their guest is destroyed and reactivates a sibling on close', async () => {
    const { service, openAttached } = fixture()
    const first = await openAttached('/sessions/a.jsonl')
    const second = await openAttached('/sessions/a.jsonl')
    expect(service.state().tabs.find((tab) => tab.tabId === second.tabId)?.active).toBe(true)
    second.guest.destroy()
    expect(service.state().tabs.find((tab) => tab.tabId === second.tabId)).toMatchObject({ attached: false })
    service.closeTab(second.tabId)
    expect(service.state().tabs.find((tab) => tab.tabId === first.tabId)?.active).toBe(true)
  })

  it('rejects work queued for a destroyed guest while fresh work follows reattachment', async () => {
    const { service, newGuest, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const started = deferred<void>()
    const release = deferred<string>()
    guest.scriptResult = (code) => {
      if (code.includes('running-before-destroy')) {
        started.resolve()
        return release.promise
      }
      return JSON.stringify({ executed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { tabId, code: "'running-before-destroy'" })
    await started.promise
    const stale = service.evaluate('/sessions/a.jsonl', { tabId, code: "'queued-before-destroy'" })
    guest.destroy()
    const fresh = service.evaluate('/sessions/a.jsonl', { tabId, code: "'queued-after-destroy'" })
    const replacement = newGuest()
    service.attachTab(tabId, replacement.id)
    const staleRejected = expect(stale).rejects.toThrow(/browser tab access changed/i)
    await Promise.resolve()
    expect(replacement.executedScripts).toEqual([])
    release.resolve(JSON.stringify({ completed: true }))

    await expect(running).resolves.toEqual({ completed: true })
    await staleRejected
    await expect(fresh).resolves.toEqual({})
    expect(replacement.executedScripts.some((code) => code.includes('queued-before-destroy'))).toBe(false)
    expect(replacement.executedScripts.some((code) => code.includes('queued-after-destroy'))).toBe(true)
  })

  it('closes every browser guest owned by a session without disturbing other sessions', async () => {
    const { service, newGuest, openAttached } = fixture()
    const first = await openAttached('/sessions/a.jsonl', 'https://game.example/one')
    const second = await openAttached('/sessions/a.jsonl', 'https://game.example/two')
    const other = await openAttached('/sessions/b.jsonl', 'https://other.example/')
    const preview = newGuest()
    preview.url = 'https://game.example/preview'
    service.setPreviewContext(preview.id, '/sessions/a.jsonl')

    expect(service.closeForSession('/sessions/./a.jsonl')).toBe(true)

    for (const guest of [first.guest, second.guest, preview]) {
      expect(guest.audioMuted).toBe(true)
      expect(guest.closeOptions).toEqual({ waitForBeforeUnload: false })
      expect(guest.destroyed).toBe(true)
    }
    expect(other.guest.destroyed).toBe(false)
    expect(service.state().tabs).toEqual([
      expect.objectContaining({ tabId: other.tabId, sessionFile: '/sessions/b.jsonl', attached: true }),
    ])
    expect((await service.listTabs('/sessions/a.jsonl')).tabs).toEqual([])
    expect(service.closeForSession('/sessions/a.jsonl')).toBe(false)
  })

  it('adopts the user preview tab as the default target for its session', async () => {
    const { service, newGuest } = fixture()
    const preview = newGuest()
    preview.url = 'https://dev.local/app'
    expect(service.setPreviewContext(preview.id, '/sessions/a.jsonl')).toBe(true)
    const listed = await service.listTabs('/sessions/a.jsonl')
    expect(listed.tabs).toEqual([expect.objectContaining({ tabId: 'preview', url: 'https://dev.local/app', attached: true, active: true })])
    // With no agent tab open, actions land on the preview guest.
    await service.click('/sessions/a.jsonl', { x: 15, y: 25 })
    expect(preview.inputEvents.find((event) => event.type === 'mousePressed')).toMatchObject({ x: 15, y: 25 })
    // Other sessions cannot see or use it.
    expect((await service.listTabs('/sessions/b.jsonl')).tabs).toEqual([])
    await expect(service.click('/sessions/b.jsonl', { x: 1, y: 1 })).rejects.toThrow(/no browser tab yet/)
    await expect(service.click('/sessions/b.jsonl', { tabId: 'preview', x: 1, y: 1 })).rejects.toThrow(/not open for this thread/)
    // Agents cannot close the user's tab; clearing the context revokes access.
    await expect(service.closeTabScoped('/sessions/a.jsonl', { tabId: 'preview' })).rejects.toThrow(/belongs to the user/)
    expect(service.setPreviewContext(null, null)).toBe(true)
    await expect(service.click('/sessions/a.jsonl', { x: 1, y: 1 })).rejects.toThrow(/no browser tab yet/)
  })

  it('rejects queued Preview work after the user clears the binding', async () => {
    const { service, newGuest } = fixture()
    const preview = newGuest()
    service.setPreviewContext(preview.id, '/sessions/a.jsonl')
    const started = deferred<void>()
    const release = deferred<string>()
    preview.scriptResult = (code) => {
      if (code.includes('running-before-clear')) {
        started.resolve()
        return release.promise
      }
      return JSON.stringify({ executed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { code: "'running-before-clear'" })
    await started.promise
    const queued = service.evaluate('/sessions/a.jsonl', { code: "'queued-after-clear'" })
    expect(service.setPreviewContext(null, null)).toBe(true)
    const queuedRejected = expect(queued).rejects.toThrow(/browser tab access changed/i)
    release.resolve(JSON.stringify({ completed: true }))

    await expect(running).resolves.toEqual({ completed: true })
    await queuedRejected
    expect(preview.executedScripts.some((code) => code.includes('queued-after-clear'))).toBe(false)
  })

  it('revokes the old owner while preserving Preview serialization across reassignment', async () => {
    const { service, newGuest } = fixture()
    const preview = newGuest()
    service.setPreviewContext(preview.id, '/sessions/a.jsonl')
    const started = deferred<void>()
    const release = deferred<string>()
    const executionOrder: string[] = []
    preview.scriptResult = (code) => {
      if (code.includes('running-owner-a')) {
        executionOrder.push('running-owner-a')
        started.resolve()
        return release.promise
      }
      if (code.includes('queued-owner-a')) executionOrder.push('queued-owner-a')
      if (code.includes('next-owner-b')) executionOrder.push('next-owner-b')
      return JSON.stringify({ completed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { code: "'running-owner-a'" })
    await started.promise
    const stale = service.evaluate('/sessions/a.jsonl', { code: "'queued-owner-a'" })
    expect(service.setPreviewContext(preview.id, '/sessions/b.jsonl')).toBe(true)
    const nextOwner = service.evaluate('/sessions/b.jsonl', { code: "'next-owner-b'" })
    const staleRejected = expect(stale).rejects.toThrow(/browser tab access changed/i)
    await Promise.resolve()
    expect(executionOrder).toEqual(['running-owner-a'])
    release.resolve(JSON.stringify({ completed: true }))

    // Already-running work is not retroactively cancelled, but all work that
    // was still queued under the previous owner loses authority.
    await expect(running).resolves.toEqual({ completed: true })
    await staleRejected
    await expect(nextOwner).resolves.toEqual({ completed: true })
    expect(executionOrder).toEqual(['running-owner-a', 'next-owner-b'])
  })

  it('rejects queued work when its session closes before guest teardown completes', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    guest.deferClose = true
    const started = deferred<void>()
    const release = deferred<string>()
    guest.scriptResult = (code) => {
      if (code.includes('running-before-session-close')) {
        started.resolve()
        return release.promise
      }
      return JSON.stringify({ executed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { tabId, code: "'running-before-session-close'" })
    await started.promise
    const queued = service.evaluate('/sessions/a.jsonl', { tabId, code: "'queued-after-session-close'" })
    expect(service.closeForSession('/sessions/a.jsonl')).toBe(true)
    const queuedRejected = expect(queued).rejects.toThrow(/browser tab access changed/i)
    release.resolve(JSON.stringify({ completed: true }))

    await expect(running).resolves.toEqual({ completed: true })
    await queuedRejected
    expect(guest.executedScripts.some((code) => code.includes('queued-after-session-close'))).toBe(false)
    guest.destroy()
  })

  it('rejects queued work when an ordinary attached tab is closed', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const started = deferred<void>()
    const release = deferred<string>()
    guest.scriptResult = (code) => {
      if (code.includes('running-before-tab-close')) {
        started.resolve()
        return release.promise
      }
      return JSON.stringify({ executed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { tabId, code: "'running-before-tab-close'" })
    await started.promise
    const queued = service.evaluate('/sessions/a.jsonl', { tabId, code: "'queued-after-tab-close'" })
    expect(service.closeTab(tabId)).toBe(true)
    const queuedRejected = expect(queued).rejects.toThrow(/browser tab access changed/i)
    release.resolve(JSON.stringify({ completed: true }))

    await expect(running).resolves.toEqual({ completed: true })
    await queuedRejected
    expect(guest.executedScripts.some((code) => code.includes('queued-after-tab-close'))).toBe(false)
  })

  it('announces every agent action so the UI can surface the Browser panel', async () => {
    const { service, activityEvents, newGuest, openAttached } = fixture()
    const { tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    expect(activityEvents).toEqual([{ sessionFile: '/sessions/a.jsonl', tabId }])
    await service.readPage('/sessions/a.jsonl', {})
    expect(activityEvents.at(-1)).toEqual({ sessionFile: '/sessions/a.jsonl', tabId })
    // Actions on the adopted preview tab announce with the preview id.
    const preview = newGuest()
    service.setPreviewContext(preview.id, '/sessions/b.jsonl')
    await service.readPage('/sessions/b.jsonl', {})
    expect(activityEvents.at(-1)).toEqual({ sessionFile: '/sessions/b.jsonl', tabId: 'preview' })
  })

  it('rejects unapproved preview guests and clears the binding when the guest dies', async () => {
    const { service, guests, newGuest } = fixture()
    const rogue = new FakeGuest()
    guests.set(rogue.id, rogue)
    expect(() => service.setPreviewContext(rogue.id, '/sessions/a.jsonl')).toThrow(/not an approved browser guest/)
    const preview = newGuest()
    service.setPreviewContext(preview.id, '/sessions/a.jsonl')
    preview.destroy()
    expect((await service.listTabs('/sessions/a.jsonl')).tabs).toEqual([])
  })

  it('rejects malformed keys, scroll directions, and coordinates', async () => {
    const { service, openAttached } = fixture()
    await openAttached('/sessions/a.jsonl')
    await expect(service.pressKey('/sessions/a.jsonl', { key: 'definitely-not-a-key' })).rejects.toThrow(/key must be/)
    await expect(service.scroll('/sessions/a.jsonl', { direction: 'sideways' })).rejects.toThrow(/direction must be/)
    await expect(service.click('/sessions/a.jsonl', {})).rejects.toThrow(/ref .*or x and y/)
    await expect(service.click('/sessions/a.jsonl', { x: -5, y: 10 })).rejects.toThrow(/within the page viewport/)
  })

  it('rejects an in-flight page script when the document is replaced', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const started = deferred<void>()
    // Chromium discards the execution context that owns the promise, so the
    // script never settles; a never-resolving promise models exactly that.
    guest.scriptResult = (code) => {
      if (code.includes('navigates-away')) {
        started.resolve()
        return new Promise<string>(() => {})
      }
      return JSON.stringify({ executed: true })
    }

    const stranded = service.evaluate('/sessions/a.jsonl', { tabId, code: "'navigates-away'" })
    await started.promise
    guest.startNavigation({ url: 'https://example.org/', isSameDocument: false, isMainFrame: true })

    await expect(stranded).rejects.toThrow(/page navigated while this action was running/i)
  })

  it('keeps the tab usable after a navigation strands a page script', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const started = deferred<void>()
    guest.scriptResult = (code) => {
      if (code.includes('navigates-away')) {
        started.resolve()
        return new Promise<string>(() => {})
      }
      return JSON.stringify({ recovered: true })
    }

    const stranded = service.evaluate('/sessions/a.jsonl', { tabId, code: "'navigates-away'" })
    await started.promise
    guest.startNavigation({ url: 'https://example.org/', isSameDocument: false, isMainFrame: true })
    await expect(stranded).rejects.toThrow(/page navigated while this action was running/i)

    // Before the fix the per-tab queue stayed chained to the stranded promise,
    // so every later action on this tab hung instead of running.
    await expect(service.evaluate('/sessions/a.jsonl', { tabId, code: "'after-navigation'" })).resolves.toEqual({ recovered: true })
  })

  it('ignores same-document navigations while a page script runs', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const started = deferred<void>()
    const release = deferred<string>()
    guest.scriptResult = (code) => {
      if (code.includes('same-document')) {
        started.resolve()
        return release.promise
      }
      return JSON.stringify({ executed: true })
    }

    const running = service.evaluate('/sessions/a.jsonl', { tabId, code: "'same-document'" })
    await started.promise
    // pushState and hash changes keep the execution context alive.
    guest.startNavigation({ url: 'https://example.com/#section', isSameDocument: true, isMainFrame: true })
    guest.startNavigation({ url: 'https://example.com/frame', isSameDocument: false, isMainFrame: false })
    release.resolve(JSON.stringify({ completed: true }))

    await expect(running).resolves.toEqual({ completed: true })
  })
})
