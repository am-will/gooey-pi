import type { WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import type { AgentBrowserActivityEvent, AgentBrowserPointerEvent, AgentBrowserState, AgentBrowserTabRecord } from '../../../src/types/api'
import { canonicalSessionPath } from '../session-paths'
import { requireRecord, requireString } from '../validation'

/** The user's own Preview webview, adoptable by the active thread's agent. */
export const PREVIEW_TAB_ID = 'preview'
import { cursorMarkerScript, elementAtPointScript, evaluateScript, pageInfoScript, readPageScript, refPointScript, removeCursorMarkerScript, scrollByScript } from './page-scripts'

/**
 * Toolbar navigation and post-attach restoration are fire-and-forget because
 * their callers answer synchronously, so a failed load has no promise left to
 * reject into; a replaced navigation (ERR_ABORTED) is normal, anything else is
 * a real load failure worth a trace.
 */
function logNavigationFailure(url: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ERR_ABORTED')) return
  console.warn(`GooeyPi browser could not load ${url}: ${message}`)
}

const MAX_TABS_PER_SESSION = 6
const MAX_TABS_TOTAL = 24
const ATTACH_TIMEOUT_MS = 15_000
const LOAD_TIMEOUT_MS = 20_000
const SETTLE_MS = 150
const MAX_TYPE_CHARS = 8_000
const MAX_EVALUATE_CHARS = 16_000
const MAX_EVALUATE_RESULT_CHARS = 20_000
const MAX_READ_TEXT_CHARS = 40_000
const MAX_READ_ELEMENTS = 300
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024
const SCREENSHOT_JPEG_QUALITY = 70

interface CdpKey {
  key: string
  code: string
  keyCode: number
  text?: string
}

const PRESS_KEYS: Record<string, CdpKey> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}
// DevTools protocol modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const PRESS_MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 }
const CDP_BUTTON_MASKS: Record<string, number> = { left: 1, right: 2, middle: 4 }

interface TabState {
  tabId: string
  sessionKey: string
  webContentsId: number | null
  url: string
  title: string
  /** Last known pointer position in guest CSS pixels; null until the first pointer action. */
  pointer: { x: number; y: number } | null
  queue: Promise<unknown>
  attachWaiters: Array<{ resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>
  unbindGuest: (() => void) | null
}

const GLIDE_MAX_MS = 550
const GLIDE_MIN_MS = 160
const GLIDE_STEP_MS = 28

export interface PageInfo {
  url: string
  title: string
  innerWidth: number
  innerHeight: number
  scrollY: number
  scrollHeight: number
  readyState: string
}

export interface AgentBrowserServiceOptions {
  /** Resolves a webContents id to a live WebContents, or undefined. Injected so tests can fake guests. */
  getGuest(webContentsId: number): WebContents | undefined
  attachTimeoutMs?: number
  loadTimeoutMs?: number
}

function isAllowedTabUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms)
    timer.unref?.()
  })
}

function parseScriptJson(payload: unknown, label: string): Record<string, unknown> {
  if (typeof payload !== 'string') throw new Error(`The page did not respond to ${label}. It may still be loading; try again.`)
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { throw new Error(`The page returned malformed data for ${label}.`) }
  return requireRecord(parsed, label)
}

/**
 * Owns the agent-controlled browser tabs. The registry (which tabs exist, per
 * session) lives here in the main process; the renderer only hosts the
 * webview guests and mirrors this state. Every guest handed to an action has
 * already passed the will-attach-webview hardening gate and the approval set
 * maintained via approveGuest().
 */
export class AgentBrowserService {
  private readonly tabs = new Map<string, TabState>()
  private readonly activeBySession = new Map<string, string>()
  private previewTab: TabState | null = null
  private readonly approvedGuests = new Set<number>()
  private readonly changeListeners = new Set<(state: AgentBrowserState) => void>()
  private readonly pointerListeners = new Set<(event: AgentBrowserPointerEvent) => void>()
  private readonly activityListeners = new Set<(event: AgentBrowserActivityEvent) => void>()
  private readonly attachTimeoutMs: number
  private readonly loadTimeoutMs: number
  private closed = false

  constructor(private readonly options: AgentBrowserServiceOptions) {
    this.attachTimeoutMs = options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS
    this.loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS
  }

  // ---- lifecycle -----------------------------------------------------------

  beginShutdown(): void {
    this.closed = true
    for (const tab of this.tabs.values()) this.releaseTab(tab)
    this.tabs.clear()
    this.activeBySession.clear()
    this.changeListeners.clear()
    this.pointerListeners.clear()
    this.activityListeners.clear()
    this.previewTab = null
  }

  /** Called from the will/did-attach-webview hardening path for every guest of the trusted partition. */
  approveGuest(contents: WebContents): void {
    if (this.closed) return
    this.approvedGuests.add(contents.id)
    contents.once('destroyed', () => {
      this.approvedGuests.delete(contents.id)
      if (this.previewTab?.webContentsId === contents.id) this.previewTab = null
      for (const tab of this.tabs.values()) {
        if (tab.webContentsId === contents.id) this.detachTab(tab)
      }
    })
  }

  onDidChange(listener: (state: AgentBrowserState) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  onPointer(listener: (event: AgentBrowserPointerEvent) => void): () => void {
    this.pointerListeners.add(listener)
    return () => { this.pointerListeners.delete(listener) }
  }

  onActivity(listener: (event: AgentBrowserActivityEvent) => void): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  // ---- renderer-facing API -------------------------------------------------

  state(): AgentBrowserState {
    const tabs: AgentBrowserTabRecord[] = [...this.tabs.values()].map((tab) => {
      const guest = tab.webContentsId === null ? undefined : this.options.getGuest(tab.webContentsId)
      const alive = guest !== undefined && !guest.isDestroyed()
      return {
        tabId: tab.tabId,
        sessionFile: tab.sessionKey,
        url: tab.url,
        title: tab.title,
        attached: tab.webContentsId !== null,
        active: this.activeBySession.get(tab.sessionKey) === tab.tabId,
        canGoBack: alive && guest.canGoBack(),
        canGoForward: alive && guest.canGoForward(),
      }
    })
    return { tabs }
  }

  /** User-initiated navigation from the tab strip toolbar and address bar. */
  navigateTab(tabIdValue: unknown, actionValue: unknown, urlValue?: unknown): boolean {
    const tab = this.requireTab(tabIdValue)
    const action = requireString(actionValue, 'action', { min: 1, max: 16, trim: true })
    const guest = tab.webContentsId === null ? undefined : this.options.getGuest(tab.webContentsId)
    if (!guest || guest.isDestroyed()) return false
    if (action === 'back') { if (guest.canGoBack()) guest.goBack() }
    else if (action === 'forward') { if (guest.canGoForward()) guest.goForward() }
    else if (action === 'reload') guest.reload()
    else if (action === 'url') {
      const url = requireString(urlValue, 'url', { min: 1, max: 2048, trim: true })
      if (!isAllowedTabUrl(url)) throw new Error('Only credential-free http(s) URLs can be opened in the GooeyPi browser')
      guest.loadURL(url).catch((error: unknown) => logNavigationFailure(url, error))
    } else throw new TypeError('action must be back, forward, reload, or url')
    return true
  }

  attachTab(tabIdValue: unknown, webContentsIdValue: unknown): boolean {
    const tab = this.requireTab(tabIdValue)
    if (!Number.isSafeInteger(webContentsIdValue)) throw new TypeError('webContentsId must be an integer')
    const webContentsId = webContentsIdValue as number
    if (!this.approvedGuests.has(webContentsId)) throw new Error('The web contents is not an approved browser guest')
    const guest = this.options.getGuest(webContentsId)
    if (!guest || guest.isDestroyed()) throw new Error('The browser guest is no longer alive')
    for (const other of this.tabs.values()) {
      if (other !== tab && other.webContentsId === webContentsId) throw new Error('The browser guest is already bound to another tab')
    }
    if (tab.webContentsId === webContentsId) return true
    if (tab.unbindGuest) this.detachTab(tab, false)
    tab.webContentsId = webContentsId
    this.bindGuestEvents(tab, guest)
    guest.setBackgroundThrottling(false)
    // A recreated webview (renderer reload) starts at about:blank; restore the
    // tab's last known location so the registry stays authoritative.
    if (tab.url && tab.url !== 'about:blank' && guest.getURL() !== tab.url) {
      guest.loadURL(tab.url).catch((error: unknown) => logNavigationFailure(tab.url, error))
    }
    for (const waiter of tab.attachWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.push()
    return true
  }

  selectTab(tabIdValue: unknown): boolean {
    const tab = this.requireTab(tabIdValue)
    this.activeBySession.set(tab.sessionKey, tab.tabId)
    this.push()
    return true
  }

  /**
   * The renderer reports which session's workspace currently owns the user's
   * Preview webview (and which guest it is). Null clears the binding. Agent
   * calls resolve the binding at call time, so a session switch immediately
   * moves control.
   */
  setPreviewContext(webContentsIdValue: unknown, sessionFileValue: unknown): boolean {
    if (this.closed) return false
    if (webContentsIdValue === null || sessionFileValue === null || sessionFileValue === undefined) {
      this.previewTab = null
      return true
    }
    if (!Number.isSafeInteger(webContentsIdValue)) throw new TypeError('webContentsId must be an integer')
    const webContentsId = webContentsIdValue as number
    if (!this.approvedGuests.has(webContentsId)) throw new Error('The web contents is not an approved browser guest')
    const sessionKey = canonicalSessionPath(requireString(sessionFileValue, 'sessionFile', { min: 1, max: 4096 }))
    const previous = this.previewTab
    if (previous && previous.webContentsId === webContentsId && previous.sessionKey === sessionKey) return true
    this.previewTab = {
      tabId: PREVIEW_TAB_ID,
      sessionKey,
      webContentsId,
      url: '',
      title: '',
      pointer: previous?.webContentsId === webContentsId ? previous.pointer : null,
      queue: previous?.queue ?? Promise.resolve(),
      attachWaiters: [],
      unbindGuest: null,
    }
    return true
  }

  closeTab(tabIdValue: unknown): boolean {
    const tab = this.requireTab(tabIdValue)
    this.removeTab(tab)
    return true
  }

  /**
   * Permanently releases every browser guest owned by a session. Archiving is
   * a lifecycle boundary, so merely dropping the tab records is insufficient:
   * hidden webview guests can keep media, timers, workers, and renderer
   * processes alive after their thread disappears from the UI.
   */
  closeForSession(sessionKeyValue: unknown): boolean {
    if (this.closed) return false
    const sessionKey = canonicalSessionPath(requireString(sessionKeyValue, 'sessionFile', { min: 1, max: 4096 }))
    const guests = new Map<number, WebContents>()
    const ownedTabs = [...this.tabs.values()].filter((tab) => tab.sessionKey === sessionKey)
    for (const tab of ownedTabs) {
      const guest = tab.webContentsId === null ? undefined : this.options.getGuest(tab.webContentsId)
      if (guest && !guest.isDestroyed()) guests.set(guest.id, guest)
      this.releaseTab(tab)
      this.tabs.delete(tab.tabId)
    }
    const preview = this.previewTab?.sessionKey === sessionKey ? this.previewTab : null
    if (preview) {
      const guest = preview.webContentsId === null ? undefined : this.options.getGuest(preview.webContentsId)
      if (guest && !guest.isDestroyed()) guests.set(guest.id, guest)
      this.previewTab = null
    }
    if (!ownedTabs.length && !preview) return false
    this.activeBySession.delete(sessionKey)
    for (const guest of guests.values()) {
      // Mute first so cleanup is immediately observable even if Chromium
      // takes a moment to finish tearing down the page and its subprocesses.
      try { guest.setAudioMuted(true) } catch { /* guest raced with teardown */ }
      try { guest.close({ waitForBeforeUnload: false }) } catch { /* guest raced with teardown */ }
    }
    this.push()
    return true
  }

  // ---- agent-facing API (always scoped to a session key) -------------------

  async openTab(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireOpen()
    const url = params.url === undefined ? 'about:blank' : requireString(params.url, 'url', { min: 1, max: 2048, trim: true })
    if (!isAllowedTabUrl(url)) throw new Error('Only credential-free http(s) URLs can be opened in the GooeyPi browser')
    const sessionTabs = [...this.tabs.values()].filter((tab) => tab.sessionKey === sessionKey)
    if (sessionTabs.length >= MAX_TABS_PER_SESSION) throw new Error(`This thread already has ${MAX_TABS_PER_SESSION} browser tabs. Close one with browser_tabs before opening another.`)
    if (this.tabs.size >= MAX_TABS_TOTAL) throw new Error('GooeyPi has too many open agent browser tabs. Close unused tabs first.')
    const tab: TabState = {
      tabId: `bt-${randomBytes(6).toString('hex')}`,
      sessionKey,
      webContentsId: null,
      url,
      title: '',
      pointer: null,
      queue: Promise.resolve(),
      attachWaiters: [],
      unbindGuest: null,
    }
    this.tabs.set(tab.tabId, tab)
    this.activeBySession.set(sessionKey, tab.tabId)
    this.emitActivity(tab)
    this.push()
    try {
      const guest = await this.waitForGuest(tab)
      if (url !== 'about:blank') await this.loadAndSettle(guest, url)
      return { tabId: tab.tabId, ...await this.describe(tab, guest) }
    } catch (error) {
      this.removeTab(tab)
      throw error
    }
  }

  async listTabs(sessionKey: string): Promise<Record<string, unknown>> {
    const active = this.activeBySession.get(sessionKey)
    const tabs: Array<Record<string, unknown>> = [...this.tabs.values()].filter((tab) => tab.sessionKey === sessionKey).map((tab) => ({
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      attached: tab.webContentsId !== null,
      active: active === tab.tabId,
    }))
    const preview = this.previewFor(sessionKey)
    if (preview) {
      tabs.unshift({
        tabId: PREVIEW_TAB_ID,
        url: preview.guest.getURL(),
        title: preview.guest.getTitle(),
        attached: true,
        active: active === PREVIEW_TAB_ID || active === undefined,
        note: "The user's own Preview tab; prefer it when the page you need is already open here.",
      })
    }
    return { tabs }
  }

  async closeTabScoped(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabId = requireString(params.tabId, 'tabId', { min: 1, max: 64 })
    if (tabId === PREVIEW_TAB_ID) throw new Error('The Preview tab belongs to the user and cannot be closed by the agent')
    const tab = this.requireSessionTab(sessionKey, tabId)
    this.removeTab(tab)
    return this.listTabs(sessionKey)
  }

  async selectTabScoped(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabId = requireString(params.tabId, 'tabId', { min: 1, max: 64 })
    if (tabId === PREVIEW_TAB_ID) {
      if (!this.previewFor(sessionKey)) throw new Error("The user's Preview tab is not open for this thread right now")
      this.activeBySession.set(sessionKey, PREVIEW_TAB_ID)
    } else {
      const tab = this.requireSessionTab(sessionKey, tabId)
      this.activeBySession.set(sessionKey, tab.tabId)
    }
    this.push()
    return this.listTabs(sessionKey)
  }

  async navigate(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      if (params.url !== undefined) {
        const url = requireString(params.url, 'url', { min: 1, max: 2048, trim: true })
        if (!isAllowedTabUrl(url)) throw new Error('Only credential-free http(s) URLs can be opened in the GooeyPi browser')
        await this.loadAndSettle(guest, url)
      } else {
        const action = requireString(params.action, 'action', { min: 1, max: 16, trim: true })
        if (action === 'back') { if (!guest.canGoBack()) throw new Error('There is no page to go back to'); guest.goBack() }
        else if (action === 'forward') { if (!guest.canGoForward()) throw new Error('There is no page to go forward to'); guest.goForward() }
        else if (action === 'reload') guest.reload()
        else throw new TypeError('action must be back, forward, or reload')
        await this.waitForLoad(guest)
      }
      return this.describe(tab, guest)
    })
  }

  async screenshot(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      const info = await this.pageInfo(guest)
      // Show the agent its own pointer in the capture so it can calibrate.
      if (tab.pointer) await guest.executeJavaScript(cursorMarkerScript(tab.pointer.x, tab.pointer.y)).catch(() => undefined)
      let image: Electron.NativeImage
      try {
        image = await guest.capturePage(undefined, { stayHidden: true, stayAwake: true })
      } finally {
        if (tab.pointer) void guest.executeJavaScript(removeCursorMarkerScript()).catch(() => undefined)
      }
      const size = image.getSize()
      if (!size.width || !size.height) throw new Error('The browser tab has no visible content to capture yet')
      // capturePage reports DIP dimensions but encodes at device pixels
      // (2x on Retina); always resize to the CSS viewport so screenshot
      // pixels map 1:1 onto click coordinates regardless of display scale.
      const targetWidth = info.innerWidth > 0 ? Math.min(info.innerWidth, size.width) : size.width
      const targetHeight = info.innerHeight > 0 ? Math.min(info.innerHeight, size.height) : size.height
      image = image.resize({ width: targetWidth, height: targetHeight })
      let quality = SCREENSHOT_JPEG_QUALITY
      let buffer = image.toJPEG(quality)
      while (buffer.byteLength > MAX_SCREENSHOT_BYTES && quality > 30) {
        quality -= 20
        buffer = image.toJPEG(quality)
      }
      return {
        ...await this.describe(tab, guest),
        mimeType: 'image/jpeg',
        data: buffer.toString('base64'),
        width: targetWidth,
        height: targetHeight,
      }
    })
  }

  async click(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      const point = await this.resolvePoint(guest, params, false)
      const button = params.button === undefined ? 'left' : requireString(params.button, 'button', { min: 1, max: 8 })
      if (!['left', 'right', 'middle'].includes(button)) throw new TypeError('button must be left, right, or middle')
      const clickCount = params.double === true ? 2 : 1
      guest.focus()
      await this.glidePointer(tab, guest, point, 'click')
      // Hovering along the glide can shift layout (menus, sticky headers);
      // for ref clicks re-resolve the element position before pressing.
      let target = point
      if (params.ref !== undefined) {
        try {
          target = await this.resolvePoint(guest, params, false)
          tab.pointer = { ...target }
        } catch { /* the pre-glide point remains the best estimate */ }
      }
      const hit = await this.elementAt(guest, target)
      for (let press = 0; press < clickCount; press += 1) {
        await this.dispatchInput(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button, buttons: CDP_BUTTON_MASKS[button], clickCount: press + 1 })
        await this.dispatchInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button, buttons: 0, clickCount: press + 1 })
      }
      // A click may start a navigation; give the page a moment before reporting.
      await delay(SETTLE_MS)
      await this.waitForLoad(guest, 2_000)
      return { ...await this.describe(tab, guest), clicked: hit ?? undefined }
    })
  }

  async type(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      const text = requireString(params.text, 'text', { min: 0, max: MAX_TYPE_CHARS })
      if (params.ref !== undefined) {
        const point = await this.resolvePoint(guest, params, true)
        await this.glidePointer(tab, guest, point, 'move')
      }
      guest.focus()
      try {
        await this.dispatchInput(guest, 'Input.insertText', { text })
      } catch {
        await guest.insertText(text)
      }
      if (params.submit === true) {
        await delay(50)
        await this.sendKey(guest, PRESS_KEYS.enter, [])
        await delay(SETTLE_MS)
        await this.waitForLoad(guest, 2_000)
      }
      return this.describe(tab, guest)
    })
  }

  async pressKey(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      const rawKey = requireString(params.key, 'key', { min: 1, max: 24, trim: true })
      const key = rawKey.length === 1
        ? { key: rawKey, code: '', keyCode: rawKey.toUpperCase().charCodeAt(0), text: rawKey }
        : PRESS_KEYS[rawKey.toLowerCase()]
      if (!key) throw new TypeError(`key must be a single character or one of: ${Object.keys(PRESS_KEYS).join(', ')}`)
      const modifiers: string[] = []
      if (params.modifiers !== undefined) {
        if (!Array.isArray(params.modifiers)) throw new TypeError('modifiers must be an array')
        for (const modifier of params.modifiers.slice(0, 4)) {
          const name = requireString(modifier, 'modifier', { min: 1, max: 12, trim: true }).toLowerCase()
          if (PRESS_MODIFIER_BITS[name] === undefined) throw new TypeError('modifiers may only include shift, control, alt, meta')
          modifiers.push(name)
        }
      }
      guest.focus()
      await this.sendKey(guest, key, modifiers)
      await delay(SETTLE_MS)
      await this.waitForLoad(guest, 2_000)
      return this.describe(tab, guest)
    })
  }

  async scroll(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (tab, guest) => {
      const direction = requireString(params.direction, 'direction', { min: 1, max: 8, trim: true })
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw new TypeError('direction must be up, down, left, or right')
      let amount = 600
      if (params.amount !== undefined) {
        if (!Number.isSafeInteger(params.amount) || (params.amount as number) < 1 || (params.amount as number) > 20_000) throw new TypeError('amount must be an integer between 1 and 20000 pixels')
        amount = params.amount as number
      }
      const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
      if (Number.isSafeInteger(params.x) && Number.isSafeInteger(params.y)) {
        // A wheel event at a point reaches nested scroll containers that
        // window.scrollBy cannot; CDP wheel deltas follow DOM semantics
        // (positive scrolls down/right).
        await this.glidePointer(tab, guest, { x: params.x as number, y: params.y as number }, 'scroll')
        await this.dispatchInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: params.x as number, y: params.y as number, deltaX, deltaY })
        await delay(SETTLE_MS)
        return this.describe(tab, guest)
      }
      const payload = parseScriptJson(await guest.executeJavaScript(scrollByScript(deltaX, deltaY)), 'scroll')
      return { ...await this.describe(tab, guest), ...payload }
    })
  }

  async readPage(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (_tab, guest) => {
      const mode = params.mode === undefined ? 'interactive' : requireString(params.mode, 'mode', { min: 1, max: 16, trim: true })
      if (mode !== 'interactive' && mode !== 'text') throw new TypeError('mode must be interactive or text')
      return parseScriptJson(await guest.executeJavaScript(readPageScript(mode, MAX_READ_TEXT_CHARS, MAX_READ_ELEMENTS)), 'read_page')
    })
  }

  async evaluate(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withTab(sessionKey, params, async (_tab, guest) => {
      const code = requireString(params.code, 'code', { min: 1, max: MAX_EVALUATE_CHARS })
      return parseScriptJson(await guest.executeJavaScript(evaluateScript(code, MAX_EVALUATE_RESULT_CHARS)), 'evaluate')
    })
  }

  // ---- internals -----------------------------------------------------------

  private requireOpen(): void {
    if (this.closed) throw new Error('GooeyPi is shutting down')
  }

  private requireTab(tabIdValue: unknown): TabState {
    const tabId = requireString(tabIdValue, 'tabId', { min: 1, max: 64 })
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('That browser tab no longer exists')
    return tab
  }

  private requireSessionTab(sessionKey: string, tabId: string): TabState {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.sessionKey !== sessionKey) throw new Error('That browser tab does not belong to this thread')
    return tab
  }

  private async withTab(
    sessionKey: string,
    params: Record<string, unknown>,
    action: (tab: TabState, guest: WebContents) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.requireOpen()
    let tab: TabState
    if (params.tabId !== undefined) {
      const tabId = requireString(params.tabId, 'tabId', { min: 1, max: 64 })
      if (tabId === PREVIEW_TAB_ID) {
        const preview = this.previewFor(sessionKey)
        if (!preview) throw new Error("The user's Preview tab is not open for this thread right now. Open a tab with browser_tabs instead.")
        tab = preview.tab
      } else tab = this.requireSessionTab(sessionKey, tabId)
    } else {
      const activeId = this.activeBySession.get(sessionKey)
      const active = activeId === PREVIEW_TAB_ID ? this.previewFor(sessionKey)?.tab : activeId ? this.tabs.get(activeId) : undefined
      // With no agent tab selected, fall back to the user's Preview tab: when
      // the page is already on screen the agent should act on it rather than
      // opening a duplicate.
      const fallback = active ?? this.previewFor(sessionKey)?.tab
      if (!fallback) throw new Error('This thread has no browser tab yet. Open one with browser_tabs {"action":"open"} first.')
      tab = fallback
    }
    // Every agent action announces itself so the UI can bring the Browser
    // panel and the acting tab into view.
    this.emitActivity(tab)
    // Serialize actions per tab so concurrent tool calls cannot interleave input events.
    const run = tab.queue.then(async () => {
      const guest = await this.waitForGuest(tab)
      return action(tab, guest)
    })
    tab.queue = run.catch(() => undefined)
    return run
  }

  private emitActivity(tab: TabState): void {
    const event: AgentBrowserActivityEvent = { sessionFile: tab.sessionKey, tabId: tab.tabId }
    for (const listener of this.activityListeners) {
      try { listener(event) } catch { /* one bad listener must not break the rest */ }
    }
  }

  private previewFor(sessionKey: string): { tab: TabState; guest: WebContents } | null {
    const tab = this.previewTab
    if (!tab || tab.sessionKey !== sessionKey || tab.webContentsId === null) return null
    const guest = this.options.getGuest(tab.webContentsId)
    if (!guest || guest.isDestroyed()) return null
    return { tab, guest }
  }

  private async waitForGuest(tab: TabState): Promise<WebContents> {
    const existing = tab.webContentsId === null ? undefined : this.options.getGuest(tab.webContentsId)
    if (existing && !existing.isDestroyed()) return existing
    // The Preview guest is renderer-owned and never re-attaches under the same
    // tab record; fail fast instead of waiting.
    if (tab.tabId === PREVIEW_TAB_ID) throw new Error("The user's Preview tab closed. Open a tab with browser_tabs instead.")
    await new Promise<void>((resolveAttach, reject) => {
      const waiter = {
        resolve: resolveAttach,
        reject,
        timer: setTimeout(() => {
          tab.attachWaiters = tab.attachWaiters.filter((candidate) => candidate !== waiter)
          reject(new Error('The GooeyPi browser pane did not attach this tab. Make sure the GooeyPi window is open.'))
        }, this.attachTimeoutMs),
      }
      waiter.timer.unref?.()
      tab.attachWaiters.push(waiter)
    })
    const guest = tab.webContentsId === null ? undefined : this.options.getGuest(tab.webContentsId)
    if (!guest || guest.isDestroyed()) throw new Error('The browser tab is not available')
    return guest
  }

  private bindGuestEvents(tab: TabState, guest: WebContents): void {
    const sync = () => {
      if (guest.isDestroyed()) return
      tab.url = guest.getURL() || tab.url
      tab.title = guest.getTitle() || tab.title
      this.push()
    }
    guest.on('did-navigate', sync)
    guest.on('did-navigate-in-page', sync)
    guest.on('page-title-updated', sync)
    tab.unbindGuest = () => {
      guest.removeListener('did-navigate', sync)
      guest.removeListener('did-navigate-in-page', sync)
      guest.removeListener('page-title-updated', sync)
    }
  }

  private detachTab(tab: TabState, notify = true): void {
    tab.unbindGuest?.()
    tab.unbindGuest = null
    tab.webContentsId = null
    if (notify) this.push()
  }

  private releaseTab(tab: TabState): void {
    for (const waiter of tab.attachWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('The browser tab was closed before it attached'))
    }
    tab.unbindGuest?.()
    tab.unbindGuest = null
  }

  private removeTab(tab: TabState): void {
    this.releaseTab(tab)
    this.tabs.delete(tab.tabId)
    if (this.activeBySession.get(tab.sessionKey) === tab.tabId) {
      const fallback = [...this.tabs.values()].find((candidate) => candidate.sessionKey === tab.sessionKey)
      if (fallback) this.activeBySession.set(tab.sessionKey, fallback.tabId)
      else this.activeBySession.delete(tab.sessionKey)
    }
    this.push()
  }

  private async loadAndSettle(guest: WebContents, url: string): Promise<void> {
    const loaded = this.waitForLoad(guest)
    await guest.loadURL(url).catch((error: unknown) => {
      // ERR_ABORTED covers in-flight replacement navigations; anything else is real.
      if (!String(error).includes('ERR_ABORTED')) throw new Error(`Navigation failed: ${String(error).slice(0, 300)}`)
    })
    await loaded
  }

  private waitForLoad(guest: WebContents, timeoutMs = this.loadTimeoutMs): Promise<void> {
    return new Promise((resolveLoad) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        guest.removeListener('did-stop-loading', onStop)
        clearTimeout(timer)
        void delay(SETTLE_MS).then(resolveLoad)
      }
      const onStop = () => finish()
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
      if (!guest.isLoading()) { finish(); return }
      guest.once('did-stop-loading', onStop)
    })
  }

  private async pageInfo(guest: WebContents): Promise<PageInfo> {
    const payload = parseScriptJson(await guest.executeJavaScript(pageInfoScript()), 'page info')
    return {
      url: typeof payload.url === 'string' ? payload.url : guest.getURL(),
      title: typeof payload.title === 'string' ? payload.title : '',
      innerWidth: Number.isSafeInteger(payload.innerWidth) ? payload.innerWidth as number : 0,
      innerHeight: Number.isSafeInteger(payload.innerHeight) ? payload.innerHeight as number : 0,
      scrollY: Number.isSafeInteger(payload.scrollY) ? payload.scrollY as number : 0,
      scrollHeight: Number.isSafeInteger(payload.scrollHeight) ? payload.scrollHeight as number : 0,
      readyState: typeof payload.readyState === 'string' ? payload.readyState : 'unknown',
    }
  }

  private async describe(tab: TabState, guest: WebContents): Promise<Record<string, unknown>> {
    const info = guest.isDestroyed() ? null : await this.pageInfo(guest).catch(() => null)
    tab.url = info?.url ?? tab.url
    tab.title = info?.title ?? tab.title
    this.push()
    return {
      url: tab.url,
      title: tab.title,
      viewport: info ? { width: info.innerWidth, height: info.innerHeight } : undefined,
      pointer: tab.pointer ? { ...tab.pointer } : undefined,
    }
  }

  private async elementAt(guest: WebContents, point: { x: number; y: number }): Promise<Record<string, unknown> | null> {
    try {
      const payload = parseScriptJson(await guest.executeJavaScript(elementAtPointScript(point.x, point.y)), 'element at point')
      return typeof payload.tag === 'string' ? { tag: payload.tag, name: typeof payload.name === 'string' ? payload.name : '' } : null
    } catch { return null }
  }

  private async resolvePoint(guest: WebContents, params: Record<string, unknown>, focus: boolean): Promise<{ x: number; y: number }> {
    if (params.ref !== undefined) {
      if (!Number.isSafeInteger(params.ref) || (params.ref as number) < 0 || (params.ref as number) > 999) throw new TypeError('ref must be an element number from browser_read_page')
      const payload = parseScriptJson(await guest.executeJavaScript(refPointScript(params.ref as number, focus)), 'element ref')
      if (typeof payload.error === 'string') throw new Error(payload.error.slice(0, 300))
      if (!Number.isSafeInteger(payload.x) || !Number.isSafeInteger(payload.y)) throw new Error('The element position could not be determined')
      return { x: payload.x as number, y: payload.y as number }
    }
    if (!Number.isSafeInteger(params.x) || !Number.isSafeInteger(params.y)) throw new TypeError('Provide either ref (from browser_read_page) or x and y coordinates')
    const x = params.x as number
    const y = params.y as number
    if (x < 0 || y < 0 || x > 20_000 || y > 20_000) throw new TypeError('x and y must be within the page viewport')
    return { x, y }
  }

  /**
   * Moves the pointer from its last position to the target as a smooth eased
   * glide of real mouseMove events (so pages get genuine hover states), and
   * emits a pointer event on the same clock so the renderer's synthetic
   * cursor can animate the identical path.
   */
  private async glidePointer(tab: TabState, guest: WebContents, to: { x: number; y: number }, action: AgentBrowserPointerEvent['action']): Promise<void> {
    const from = tab.pointer
    const distance = from ? Math.hypot(to.x - from.x, to.y - from.y) : 0
    const durationMs = from && distance > 2 ? Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, Math.round(distance * 0.9))) : 0
    const event: AgentBrowserPointerEvent = { tabId: tab.tabId, sessionFile: tab.sessionKey, from, to: { ...to }, action, durationMs }
    for (const listener of this.pointerListeners) {
      try { listener(event) } catch { /* one bad listener must not break the rest */ }
    }
    if (from && durationMs > 0) {
      const steps = Math.min(18, Math.max(5, Math.round(durationMs / GLIDE_STEP_MS)))
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps
        const eased = progress * progress * (3 - 2 * progress)
        await this.dispatchInput(guest, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(from.x + (to.x - from.x) * eased),
          y: Math.round(from.y + (to.y - from.y) * eased),
        })
        await delay(durationMs / steps)
      }
    } else {
      await this.dispatchInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y })
    }
    tab.pointer = { x: to.x, y: to.y }
  }

  /**
   * webContents.sendInputEvent does not reach OOPIF-based webview guests
   * (input routing happens in the embedder); the DevTools protocol Input
   * domain dispatches with real hit-testing, so all synthetic input goes
   * through the debugger instead.
   */
  private async dispatchInput(guest: WebContents, method: string, params: Record<string, unknown>): Promise<void> {
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
    await guest.debugger.sendCommand(method, params)
  }

  private async sendKey(guest: WebContents, key: CdpKey, modifiers: string[]): Promise<void> {
    const bits = modifiers.reduce((mask, name) => mask | (PRESS_MODIFIER_BITS[name] ?? 0), 0)
    const base = { modifiers: bits, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode }
    // A key with text uses keyDown so the page also receives the character;
    // keys without text (arrows, tab) and chorded shortcuts (ctrl/alt/meta
    // held) use rawKeyDown.
    const chorded = (bits & (PRESS_MODIFIER_BITS.alt | PRESS_MODIFIER_BITS.control | PRESS_MODIFIER_BITS.meta)) !== 0
    if (key.text && !chorded) await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: key.text })
    else await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
    await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  private push(): void {
    if (this.closed) return
    const snapshot = this.state()
    for (const listener of this.changeListeners) {
      try { listener(snapshot) } catch { /* one bad listener must not break the rest */ }
    }
  }
}
