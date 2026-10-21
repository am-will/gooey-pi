// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/components/inspector/BrowserPanel'
import { useBrowserAnnotations } from '../../src/hooks/useBrowserAnnotations'
import type { BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { BrowserAnnotation } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const capturedPayload = JSON.stringify([
  {
    selector: '#cta',
    tagName: 'BUTTON',
    id: 'cta',
    classes: ['btn'],
    text: 'Join now',
    href: 'https://example.com/signup',
    rect: { x: 5, y: 6, width: 100, height: 30 },
  },
])

let container: HTMLDivElement
let root: Root
let executed: string[]
let takeResult: string | null
let webviewUrl: string
let webviewDomReady: boolean

// jsdom renders <webview> as HTMLUnknownElement; give the prototype the small
// Electron surface BrowserPanel relies on.
const webviewProto = window.HTMLUnknownElement.prototype as unknown as Record<string, unknown>
const webviewMethods = {
  loadURL: async () => undefined,
  getURL: () => webviewUrl,
  getTitle: () => 'Example Page',
  goBack: () => undefined,
  goForward: () => undefined,
  canGoBack: () => false,
  canGoForward: () => false,
  reload: () => undefined,
  stop: () => undefined,
  // Electron throws SYNCHRONOUSLY (not a rejected promise) until the guest
  // emits dom-ready; the mock mirrors that so mount-time calls crash tests
  // the same way they crash the real renderer.
  executeJavaScript: (code: string) => {
    if (!webviewDomReady) throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
    executed.push(code)
    return Promise.resolve(code.includes('.take()') ? takeResult : undefined)
  },
}

let latestApi: BrowserAnnotationsApi
function Harness({ pollIntervalMs = 50 }: { pollIntervalMs?: number }) {
  latestApi = useBrowserAnnotations()
  return <BrowserPanel platform="linux" home="https://example.com/" onOpenExternal={() => undefined} annotations={latestApi} pollIntervalMs={pollIntervalMs} />
}

beforeEach(() => {
  vi.useFakeTimers()
  executed = []
  takeResult = null
  webviewUrl = 'https://example.com/'
  webviewDomReady = false
  Object.assign(webviewProto, webviewMethods)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const key of Object.keys(webviewMethods)) delete webviewProto[key]
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const webviewElement = () => container.querySelector('webview') as HTMLElement

const makeDomReady = async () => {
  webviewDomReady = true
  await act(async () => {
    webviewElement().dispatchEvent(new Event('dom-ready'))
  })
}

const toggleAnnotate = async () => {
  await act(async () => {
    ;(container.querySelector('button[aria-label="Annotate page"], button[aria-label="Stop annotating"]') as HTMLButtonElement).click()
  })
}

const setComment = async (value: string) => {
  const textarea = container.querySelector('.annotation-popover textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BrowserPanel annotation mode', () => {
  it('mounts safely before dom-ready and defers page scripts until it fires', async () => {
    // Regression: executeJavaScript throws synchronously pre-dom-ready; a
    // mount-time call escaped the effect and blanked the app behind the
    // root error boundary.
    await act(async () => root.render(<Harness />))
    expect(executed).toHaveLength(0)
    await toggleAnnotate()
    expect(executed).toHaveLength(0)

    await makeDomReady()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(executed.some((code) => code.includes('__primeAnnotator'))).toBe(true)
  })

  it('injects the picker, captures a clicked element, and stores the comment', async () => {
    await act(async () => root.render(<Harness />))
    await makeDomReady()
    await toggleAnnotate()

    expect(executed.some((code) => code.includes('__primeAnnotator.start()'))).toBe(true)
    expect(container.querySelector('.annotation-hint')).not.toBeNull()

    takeResult = capturedPayload
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
    takeResult = null

    // Selection stops picking (page listeners cleaned up) and opens the comment popover.
    expect(executed.some((code) => code.includes('__primeAnnotator.stop()'))).toBe(true)
    const popover = container.querySelector('.annotation-popover')
    expect(popover?.textContent).toContain('Comment on element 1')
    // The DOM label is intentionally not shown; the header and comment field suffice.
    expect(popover?.textContent).not.toContain('button#cta.btn')

    await setComment('Make this button blue')
    await act(async () => {
      ;(container.querySelector('.button--primary') as HTMLButtonElement).click()
    })

    expect(latestApi.annotations).toHaveLength(1)
    expect(latestApi.annotations[0].comment).toBe('Make this button blue')
    expect(latestApi.annotations[0].pageUrl).toBe('https://example.com/')
    expect(latestApi.annotations[0].pageTitle).toBe('Example Page')
    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(container.querySelector('.annotation-count')?.textContent).toContain('1 of 20')

    // The stored annotation now renders as a persistent numbered marker in the page.
    const markerCall = [...executed].reverse().find((code) => code.includes('setMarkers'))
    expect(markerCall).toContain('"selector":"#cta"')
    expect(markerCall).toContain('"index":1')
  })

  it('saves on Enter and saves-then-sends on Ctrl+Enter in the comment popover', async () => {
    await act(async () => root.render(<Harness />))
    await makeDomReady()

    const capture = async () => {
      await toggleAnnotate()
      takeResult = capturedPayload
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      takeResult = null
    }
    const keydown = async (init: KeyboardEventInit) => {
      const textarea = container.querySelector('.annotation-popover textarea') as HTMLTextAreaElement
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      })
    }

    await capture()
    // Linux uses PC keyboard labels in the annotation hints.
    const hints = container.querySelector('.annotation-popover__hints')
    expect(hints?.textContent).toContain('Enter add to chat')
    expect(hints?.textContent).toContain('Ctrl+Enter send now')
    await setComment('plain enter saves')
    const signalBefore = latestApi.sendSignal
    await keydown({ key: 'Enter' })
    expect(latestApi.annotations.map((entry) => entry.comment)).toEqual(['plain enter saves'])
    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(latestApi.sendSignal).toBe(signalBefore)

    await capture()
    await setComment('ctrl enter sends')
    await keydown({ key: 'Enter', ctrlKey: true })
    expect(latestApi.annotations.map((entry) => entry.comment)).toEqual(['plain enter saves', 'ctrl enter sends'])
    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(latestApi.sendSignal).toBe(signalBefore + 1)

    // Enter with an empty comment neither saves nor closes the popover.
    await capture()
    await keydown({ key: 'Enter' })
    expect(latestApi.annotations).toHaveLength(2)
    expect(container.querySelector('.annotation-popover')).not.toBeNull()
  })

  it('blocks entering annotation mode at the 20-annotation cap with clear feedback', async () => {
    const annotations: BrowserAnnotation[] = Array.from({ length: 20 }, (_, index) => ({
      id: `a-${index}`,
      comment: `c-${index}`,
      element: { selector: `#e-${index}`, tagName: 'div', id: '', classes: [], text: '', rect: { x: 0, y: 0, width: 0, height: 0 } },
      pageUrl: 'https://example.com/',
      pageTitle: 'Example',
      stale: false,
      createdAt: index,
    }))
    const api: BrowserAnnotationsApi = { annotations, atCapacity: true, add: vi.fn(() => false), remove: vi.fn(), clear: vi.fn(), handleNavigation: vi.fn(), sendSignal: 0, requestSend: vi.fn() }
    await act(async () => root.render(<BrowserPanel home="https://example.com/" onOpenExternal={() => undefined} annotations={api} pollIntervalMs={50} />))
    await makeDomReady()
    const injectedBefore = executed.filter((code) => code.includes('__primeAnnotator.start()')).length

    await toggleAnnotate()

    expect(container.querySelector('.annotation-notice')?.textContent).toBe('You can attach at most 20 annotations. Remove one from the composer attachment to add more.')
    expect(container.querySelector('.annotation-hint')).toBeNull()
    expect(executed.filter((code) => code.includes('__primeAnnotator.start()')).length).toBe(injectedBefore)
  })

  it('marks annotations stale on navigation and exits annotation mode', async () => {
    await act(async () => root.render(<Harness />))
    await makeDomReady()
    act(() => {
      latestApi.add({
        comment: 'Original page note',
        element: { selector: '#hero', tagName: 'div', id: 'hero', classes: [], text: '', rect: { x: 0, y: 0, width: 10, height: 10 } },
        pageUrl: 'https://example.com/',
        pageTitle: 'Example',
      })
    })
    await toggleAnnotate()
    expect(container.querySelector('.annotation-hint')).not.toBeNull()

    webviewUrl = 'https://example.com/other'
    await act(async () => {
      webviewElement().dispatchEvent(new Event('did-navigate'))
    })

    expect(latestApi.annotations[0].stale).toBe(true)
    expect(container.querySelector('.annotation-hint')).toBeNull()
    expect(container.querySelector('.annotation-count')?.textContent).toContain('1 from earlier pages')

    // Navigating back to the captured page revives the marker.
    webviewUrl = 'https://example.com/'
    await act(async () => {
      webviewElement().dispatchEvent(new Event('did-navigate'))
    })
    expect(latestApi.annotations[0].stale).toBe(false)
    const markerCall = [...executed].reverse().find((code) => code.includes('setMarkers'))
    expect(markerCall).toContain('"selector":"#hero"')
  })

  it('rejects malformed picker payloads without leaving annotation mode', async () => {
    await act(async () => root.render(<Harness />))
    await makeDomReady()
    await toggleAnnotate()

    takeResult = JSON.stringify([{ tagName: 'div' }])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
    takeResult = 'not json at all'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })

    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(container.querySelector('.annotation-hint')).not.toBeNull()
    expect(latestApi.annotations).toHaveLength(0)
  })
})
