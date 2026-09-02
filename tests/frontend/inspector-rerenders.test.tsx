// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { useBrowserAnnotations, type BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { InspectorProps } from '../../src/components/Inspector'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const observed = vi.hoisted(() => ({ inspectorProps: [] as unknown[], changesPanelRenders: 0 }))

// Wraps the memoized Inspector, so every App render is observed even when the
// memo (correctly) skips the inspector subtree.
vi.mock('../../src/components/Inspector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/Inspector')>()
  return {
    ...actual,
    Inspector(props: InspectorProps) {
      observed.inspectorProps.push(props)
      return <actual.Inspector {...props} />
    },
  }
})

// Rendered inside the memo, so its render count is exactly the number of times
// the memo let a re-render through on the changes tab.
vi.mock('../../src/components/inspector/ChangesPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/inspector/ChangesPanel')>()
  return {
    ...actual,
    ChangesPanel(props: Parameters<typeof actual.ChangesPanel>[0]) {
      observed.changesPanelRenders += 1
      return <actual.ChangesPanel {...props} />
    },
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  observed.inspectorProps = []
  observed.changesPanelRenders = 0
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const toggleSidebar = async () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true })) })

const renderApp = async () => {
  // Resolve the lazy inspector chunk up front so its Suspense boundary settles on mount.
  await import('../../src/components/Inspector')
  await act(async () => { root.render(<App />) })
  await act(async () => {})
}

const openChangesTab = async () => {
  const changesTab = [...container.querySelectorAll<HTMLButtonElement>('.inspector__tabs button')].find((button) => button.textContent?.startsWith('Changes'))
  expect(changesTab).toBeDefined()
  await act(async () => { changesTab?.click() })
  expect(container.querySelector('#inspector-panel-changes')).not.toBeNull()
}

describe('inspector re-render containment', () => {
  it('keeps the memoized inspector subtree mounted across App re-renders on the changes tab', async () => {
    await renderApp()
    await openChangesTab()

    const rendersAfterTabChange = observed.changesPanelRenders
    const appRendersAfterTabChange = observed.inspectorProps.length
    expect(rendersAfterTabChange).toBeGreaterThan(0)

    await toggleSidebar()
    await toggleSidebar()

    // App re-rendered, the memo held: no work reached the inspector subtree.
    expect(observed.inspectorProps.length).toBeGreaterThan(appRendersAfterTabChange)
    expect(observed.changesPanelRenders).toBe(rendersAfterTabChange)
  })

  it('hands the inspector stable messages, git and annotation identities while the changes tab is active', async () => {
    await renderApp()
    const props = observed.inspectorProps as InspectorProps[]
    // The summary tab is the default and does consume the transcript.
    expect(props[props.length - 1].messages.length).toBeGreaterThan(0)

    await openChangesTab()
    const first = props[props.length - 1]
    await toggleSidebar()
    const last = props[props.length - 1]
    expect(last).not.toBe(first)
    // Off the summary tab nothing reads the transcript, so it never reaches the memo boundary.
    expect(last.messages).toHaveLength(0)
    expect(last.messages).toBe(first.messages)
    expect(last.git).toBe(first.git)
    expect(last.browserAnnotations).toBe(first.browserAnnotations)
    expect(last.automations).toBe(first.automations)
    expect(last.heartbeats).toBe(first.heartbeats)
    expect(last.onSelectAgentTab).toBe(first.onSelectAgentTab)
    expect(last.onPreviewContext).toBe(first.onPreviewContext)
    expect(last.onNavigateAgentTab).toBe(first.onNavigateAgentTab)
    expect(last.onGrantProject).toBe(first.onGrantProject)
    expect(last.onOpenAutomation).toBe(first.onOpenAutomation)
    expect(last.onShowBrowserPreview).toBe(first.onShowBrowserPreview)
  })
})

describe('useBrowserAnnotations identity', () => {
  it('keeps one container identity across re-renders and swaps it only when its data changes', async () => {
    const seen: BrowserAnnotationsApi[] = []
    let rerender = () => {}
    function Harness() {
      const [, setTick] = useState(0)
      rerender = () => setTick((tick) => tick + 1)
      seen.push(useBrowserAnnotations())
      return null
    }

    await act(async () => { root.render(<Harness />) })
    await act(async () => { rerender() })
    await act(async () => { rerender() })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(seen[0])

    const stable = seen[seen.length - 1]
    await act(async () => {
      stable.add({
        comment: 'Tighten this copy',
        element: { selector: '#cta', tagName: 'BUTTON', id: 'cta', classes: ['btn'], text: 'Join now', rect: { x: 5, y: 6, width: 100, height: 30 } },
        pageUrl: 'https://example.com/',
        pageTitle: 'Example Page',
      })
    })
    const updated = seen[seen.length - 1]
    expect(updated).not.toBe(stable)
    expect(updated.annotations).toHaveLength(1)
  })
})
