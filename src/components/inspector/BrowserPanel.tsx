import { ArrowLeft, ArrowRight, Bot, ExternalLink, History, MessageCirclePlus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { createElement, useEffect, useRef, useState } from 'react'
import { annotationMarkersScript, annotationPickerScript, annotationTakeScript } from '@/lib/annotation-picker'
import { MAX_BROWSER_ANNOTATIONS, sanitizeCapturedElement } from '@/lib/browser-annotations'
import { detectRendererPlatform, shortcutLabel } from '@/lib/platform-shortcuts'
import type { BrowserAnnotationsApi } from '@/hooks/useBrowserAnnotations'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import { AgentCursorOverlay, type AgentSlotRect } from '../AgentBrowserLayer'
import { BROWSER_PARTITION, type AgentBrowserTabRecord, type BrowserAnnotationElement } from '@/types/api'
import { IconButton } from '../ui'

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  executeJavaScript(code: string): Promise<unknown>
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

/**
 * Electron's webview.executeJavaScript throws synchronously (not a rejected
 * promise) until the guest emits dom-ready, so a bare call from a mount
 * effect crashes the renderer. Route every call through this guard.
 */
function runInPage(view: WebviewElement, code: string): Promise<unknown> {
  try {
    return view.executeJavaScript(code).catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('about:')) return trimmed
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

interface BrowserPanelProps {
  platform?: NodeJS.Platform
  home: string
  onOpenExternal(url: string): void
  annotations: BrowserAnnotationsApi
  /** Agent-controlled tabs for the active session; empty hides the tab strip entirely. */
  agentTabs?: AgentBrowserTabRecord[]
  activeAgentTabId?: string | null
  previewSelected?: boolean
  onSelectAgentTab?(tabId: string): void
  onCloseAgentTab?(tabId: string): void
  onShowPreview?(): void
  /** Reports the rectangle the always-mounted AgentBrowserLayer should cover, or null when hidden. */
  onAgentSlotRect?(rect: AgentSlotRect | null): void
  /** Session key of the active thread, so the agent can adopt the Preview webview as its "preview" tab. */
  agentSessionKey?: string
  /** Reports the Preview webview identity and owning session to the main process (null on teardown). */
  onPreviewContext?(webContentsId: number | null, sessionFile: string | null): void
  /** Latest agent pointer movement targeting the "preview" tab, for the cursor overlay. */
  previewPointerEvent?: StampedPointerEvent | null
  /** User navigation on an agent tab; routed through the main process to the guest. */
  onNavigateAgentTab?(tabId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string): void
  /** Test hook: how often to poll the page for a clicked element while picking. */
  pollIntervalMs?: number
}

function agentTabLabel(tab: AgentBrowserTabRecord): string {
  if (tab.title) return tab.title
  try {
    const host = new URL(tab.url).hostname
    if (host) return host
  } catch { /* about:blank and friends */ }
  return 'New tab'
}

export function BrowserPanel({ home, onOpenExternal, annotations, agentTabs = [], activeAgentTabId = null, previewSelected = true, onSelectAgentTab, onCloseAgentTab, onShowPreview, onAgentSlotRect, agentSessionKey, onPreviewContext, previewPointerEvent = null, onNavigateAgentTab, pollIntervalMs = 350, platform = detectRendererPlatform() }: BrowserPanelProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(home)
  const [currentUrl, setCurrentUrl] = useState(home)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [picking, setPicking] = useState(false)
  const [domReady, setDomReady] = useState(false)
  const [pendingElement, setPendingElement] = useState<BrowserAnnotationElement | null>(null)
  const [annotationText, setAnnotationText] = useState('')
  const [notice, setNotice] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<string[]>(() => [home])
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const noticeTimerRef = useRef<number | null>(null)
  const lastMarkersRef = useRef('')
  const activeAgentTab = agentTabs.find((tab) => tab.tabId === activeAgentTabId) ?? null
  const showAgentTab = !previewSelected && activeAgentTab !== null
  const slotRef = useRef<HTMLDivElement | null>(null)
  const onAgentSlotRectRef = useRef(onAgentSlotRect)
  onAgentSlotRectRef.current = onAgentSlotRect
  const lastAgentSlotRectRef = useRef<AgentSlotRect | null | undefined>(undefined)
  const [previewWebContentsId, setPreviewWebContentsId] = useState<number | null>(null)
  const onPreviewContextRef = useRef(onPreviewContext)
  onPreviewContextRef.current = onPreviewContext
  const [agentAddress, setAgentAddress] = useState('')
  const agentAddressEditingRef = useRef(false)

  // Keep the agent tab's address field following the page unless the user is
  // actively editing it.
  useEffect(() => {
    if (!agentAddressEditingRef.current) setAgentAddress(activeAgentTab?.url ?? '')
  }, [activeAgentTab?.url, activeAgentTabId])

  // Bind the Preview guest to the active thread so its agent can adopt it as
  // the "preview" tab; clear the binding when the panel goes away.
  useEffect(() => {
    if (previewWebContentsId === null || !agentSessionKey) return
    onPreviewContextRef.current?.(previewWebContentsId, agentSessionKey)
  }, [previewWebContentsId, agentSessionKey])
  useEffect(() => () => { onPreviewContextRef.current?.(null, null) }, [])

  // The agent webviews live in the always-mounted AgentBrowserLayer, not in
  // this panel; report where the layer should overlay while an agent tab is
  // shown. Position can shift without a resize (sidebar toggle), so a slow
  // poll backs up the observer.
  useEffect(() => {
    const publish = (next: AgentSlotRect | null) => {
      const previous = lastAgentSlotRectRef.current
      const unchanged = next === null
        ? previous === null
        : previous !== null
          && previous !== undefined
          && previous.left === next.left
          && previous.top === next.top
          && previous.width === next.width
          && previous.height === next.height
      if (unchanged) return
      lastAgentSlotRectRef.current = next
      onAgentSlotRectRef.current?.(next)
    }
    if (!showAgentTab) {
      publish(null)
      return
    }
    const report = () => {
      const slot = slotRef.current
      if (!slot) return
      const rect = slot.getBoundingClientRect()
      publish({ left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    if (observer && slotRef.current) observer.observe(slotRef.current)
    window.addEventListener('resize', report)
    const interval = window.setInterval(report, 400)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(interval)
      publish(null)
    }
  }, [showAgentTab])

  const showNotice = (text: string) => {
    setNotice(text)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice('')
    }, 5_000)
  }
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const sync = () => {
      try {
        const url = view.getURL() || home
        setCurrentUrl(url)
        setAddress(url)
        setCanBack(view.canGoBack())
        setCanForward(view.canGoForward())
        setHistory((items) => (items.at(-1) === url ? items : [...items.slice(-19), url]))
      } catch {
        /* webview not ready */
      }
    }
    const didStart = () => setLoading(true)
    const didStop = () => {
      setLoading(false)
      sync()
    }
    // A full navigation replaces the document: the injected picker and markers
    // are gone, and annotations captured on other pages become stale.
    const didNavigate = () => {
      sync()
      lastMarkersRef.current = ''
      setPicking(false)
      setPendingElement(null)
      setAnnotationText('')
      try {
        annotationsRef.current.handleNavigation(view.getURL())
      } catch {
        /* webview not ready */
      }
    }
    // dom-ready is the earliest point at which executeJavaScript is legal;
    // it fires again for every subsequent document, so markers re-apply.
    const onDomReady = () => {
      setDomReady(true)
      lastMarkersRef.current = ''
      try { setPreviewWebContentsId(view.getWebContentsId()) } catch { /* guest not attached yet */ }
    }
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-start-loading', didStart)
    view.addEventListener('did-stop-loading', didStop)
    view.addEventListener('did-navigate', didNavigate)
    view.addEventListener('did-navigate-in-page', sync)
    return () => {
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-start-loading', didStart)
      view.removeEventListener('did-stop-loading', didStop)
      view.removeEventListener('did-navigate', didNavigate)
      view.removeEventListener('did-navigate-in-page', sync)
    }
  }, [home])

  // While annotation mode is on, the picker runs inside the page; poll it for
  // the element the user clicked. Stopping cleans up the page-side listeners.
  useEffect(() => {
    const view = webviewRef.current
    if (!picking || !view || !domReady) return
    let disposed = false
    let inFlight = false
    void runInPage(view, annotationPickerScript('start'))
    const interval = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      runInPage(view, annotationTakeScript())
        .then((payload) => {
          inFlight = false
          if (disposed || typeof payload !== 'string') return
          let parsed: unknown
          try {
            parsed = JSON.parse(payload)
          } catch {
            return
          }
          const element = Array.isArray(parsed) ? sanitizeCapturedElement(parsed[0]) : null
          if (!element) return
          setPendingElement(element)
          setAnnotationText('')
          setPicking(false)
        })
        .catch(() => {
          inFlight = false
        })
    }, pollIntervalMs)
    return () => {
      disposed = true
      window.clearInterval(interval)
      void runInPage(view, annotationPickerScript('stop'))
    }
  }, [picking, pollIntervalMs, domReady])

  // Persistent numbered markers for every live annotation on the current page.
  const markers = annotations.annotations.flatMap((annotation, index) => (annotation.stale ? [] : [{ selector: annotation.element.selector, index: index + 1 }]))
  const markerSignature = `${currentUrl}|${markers.map((marker) => `${marker.index}:${marker.selector}`).join('|')}`
  useEffect(() => {
    const view = webviewRef.current
    if (!view || !domReady || loading || lastMarkersRef.current === markerSignature) return
    lastMarkersRef.current = markerSignature
    void runInPage(view, annotationMarkersScript(markers))
  }, [markerSignature, loading, domReady])

  const navigate = (value: string) => {
    const url = normalizeUrl(value)
    setAddress(url)
    setCurrentUrl(url)
    void webviewRef.current?.loadURL(url).catch((error: unknown) => {
      if (!String(error).includes('ERR_ABORTED')) console.error('Browser navigation failed', error)
    })
  }

  const toggleAnnotation = () => {
    if (picking) {
      setPicking(false)
      return
    }
    if (pendingElement) {
      setPendingElement(null)
      setAnnotationText('')
      return
    }
    if (annotationsRef.current.atCapacity) {
      showNotice(`Prime keeps at most ${MAX_BROWSER_ANNOTATIONS} annotations. Remove one from the composer attachment to add more.`)
      return
    }
    setNotice('')
    setPicking(true)
  }

  const saveAnnotation = () => {
    const view = webviewRef.current
    if (!pendingElement || !annotationText.trim()) return
    let pageTitle = ''
    let pageUrl = currentUrl
    try {
      pageTitle = view?.getTitle() ?? ''
      pageUrl = view?.getURL() || currentUrl
    } catch {
      /* webview not ready */
    }
    if (!annotationsRef.current.add({ comment: annotationText, element: pendingElement, pageUrl, pageTitle })) {
      showNotice(`Prime keeps at most ${MAX_BROWSER_ANNOTATIONS} annotations. Remove one from the composer attachment to add more.`)
      return
    }
    setPendingElement(null)
    setAnnotationText('')
  }

  const webview = createElement('webview' as never, {
    ref: (node: WebviewElement | null) => {
      webviewRef.current = node
    },
    src: home,
    className: 'browser-webview',
    partition: BROWSER_PARTITION,
    webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
  })

  const count = annotations.annotations.length
  const staleCount = annotations.annotations.filter((annotation) => annotation.stale).length

  return (
    <div className="browser-panel">
      {agentTabs.length ? (
        <div className="browser-tabstrip" role="tablist" aria-label="Browser tabs">
          <button type="button" role="tab" aria-selected={!showAgentTab} className={showAgentTab ? '' : 'is-active'} onClick={() => onShowPreview?.()}>
            Preview
          </button>
          {agentTabs.map((tab) => (
            <div
              key={tab.tabId}
              role="tab"
              tabIndex={0}
              aria-selected={showAgentTab && tab.tabId === activeAgentTabId}
              className={`browser-tabstrip__agent ${showAgentTab && tab.tabId === activeAgentTabId ? 'is-active' : ''}`}
              title={tab.url}
              onClick={() => onSelectAgentTab?.(tab.tabId)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelectAgentTab?.(tab.tabId)
              }}
            >
              <Bot size={11} aria-hidden />
              <span>{agentTabLabel(tab)}</span>
              <button
                type="button"
                aria-label={`Close agent tab ${agentTabLabel(tab)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseAgentTab?.(tab.tabId)
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`browser-preview ${showAgentTab ? 'browser-preview--hidden' : ''}`} inert={showAgentTab ? true : undefined}>
      <div className="browser-toolbar">
        <IconButton label="Back" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton label="Forward" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton label={loading ? 'Stop loading' : 'Reload'} onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())}>
          {loading ? <X size={14} /> : <RefreshCw size={14} />}
        </IconButton>
        <form
          className="address-field"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(address)
          }}
        >
          <ShieldCheck size={12} />
          <input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Browser address" spellCheck={false} />
          <button type="button" aria-label="Browser history" onClick={() => setHistoryOpen((value) => !value)}>
            <History size={13} />
          </button>
        </form>
        <IconButton className={picking || pendingElement ? 'is-active annotation-active' : ''} label={picking ? 'Stop annotating' : 'Annotate page'} aria-pressed={picking} onClick={toggleAnnotation}>
          <MessageCirclePlus size={15} />
        </IconButton>
        <IconButton label="Open in default browser" onClick={() => onOpenExternal(currentUrl)}>
          <ExternalLink size={14} />
        </IconButton>
      </div>
      {historyOpen ? (
        <div className="browser-history">
          <div>
            <strong>Recent pages</strong>
            <button type="button" onClick={() => setHistory([])}>
              Clear
            </button>
          </div>
          {history
            .slice()
            .reverse()
            .map((url, index) => (
              <button
                type="button"
                key={`${url}-${index}`}
                onClick={() => {
                  navigate(url)
                  setHistoryOpen(false)
                }}
              >
                <History size={12} />
                <span>{url}</span>
              </button>
            ))}
        </div>
      ) : null}
      <div className={`browser-viewport ${picking ? 'is-annotating' : ''}`}>
        {webview}
        {picking ? (
          <div className="annotation-hint" role="status">
            <MessageCirclePlus size={12} /> Click an element in the page to comment on it
          </div>
        ) : null}
        {pendingElement ? (
          <div className="annotation-layer">
            <div className="annotation-popover">
              <div>
                <MessageCirclePlus size={14} />
                <strong>Comment on element {count + 1}</strong>
                <button
                  type="button"
                  aria-label="Discard annotation"
                  onClick={() => {
                    setPendingElement(null)
                    setAnnotationText('')
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <textarea
                autoFocus
                value={annotationText}
                onChange={(event) => setAnnotationText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey) return
                  event.preventDefault()
                  if (!annotationText.trim()) return
                  saveAnnotation()
                  // Ctrl/Cmd+Enter also fires the composer's send with the saved annotation attached.
                  if (event.ctrlKey || event.metaKey) annotationsRef.current.requestSend()
                }}
                placeholder="Describe what should change…"
              />
              <p className="annotation-popover__hints">
                <span>
                  <kbd>{platform === 'darwin' ? '↩' : 'Enter'}</kbd> add to chat
                </span>
                <span>
                  <kbd>{shortcutLabel(platform, ['Primary', 'Enter'])}</kbd> send now
                </span>
              </p>
              <div>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setPendingElement(null)
                    setAnnotationText('')
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="button button--primary" disabled={!annotationText.trim()} onClick={saveAnnotation}>
                  Add comment
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {count ? (
          <div className="annotation-count">
            <MessageCirclePlus size={12} /> {count} of {MAX_BROWSER_ANNOTATIONS} annotation{count === 1 ? '' : 's'}
            {staleCount ? ` · ${staleCount} from earlier pages` : ''}
          </div>
        ) : null}
        {notice ? (
          <p className="annotation-notice" role="alert">
            {notice}
          </p>
        ) : null}
        <AgentCursorOverlay pointerEvent={previewPointerEvent} />
      </div>
      </div>
      {showAgentTab && activeAgentTab ? (
        <div className="browser-agent-area">
          <div className="browser-agent-urlbar">
            <IconButton label="Back" disabled={!activeAgentTab.canGoBack} onClick={() => onNavigateAgentTab?.(activeAgentTab.tabId, 'back')}>
              <ArrowLeft size={14} />
            </IconButton>
            <IconButton label="Forward" disabled={!activeAgentTab.canGoForward} onClick={() => onNavigateAgentTab?.(activeAgentTab.tabId, 'forward')}>
              <ArrowRight size={14} />
            </IconButton>
            <IconButton label="Reload" onClick={() => onNavigateAgentTab?.(activeAgentTab.tabId, 'reload')}>
              <RefreshCw size={14} />
            </IconButton>
            <form
              className="address-field"
              onSubmit={(event) => {
                event.preventDefault()
                agentAddressEditingRef.current = false
                onNavigateAgentTab?.(activeAgentTab.tabId, 'url', normalizeUrl(agentAddress))
              }}
            >
              <Bot size={12} aria-hidden />
              <input
                value={agentAddress}
                onChange={(event) => {
                  agentAddressEditingRef.current = true
                  setAgentAddress(event.target.value)
                }}
                onBlur={() => { agentAddressEditingRef.current = false }}
                aria-label="Agent tab address"
                spellCheck={false}
              />
            </form>
            {!activeAgentTab.attached ? <em>connecting…</em> : null}
          </div>
          <div className="browser-agent-slot" ref={slotRef} aria-label="Agent-controlled browser tab" />
        </div>
      ) : null}
    </div>
  )
}
