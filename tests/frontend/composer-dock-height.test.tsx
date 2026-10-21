// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useComposerDockHeight } from '../../src/hooks/useComposerDockHeight'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('reserves measured dock height across growth, navigation, and remounting', async () => {
  let measure = 100
  let resize = () => undefined
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => undefined) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height: measure }) as DOMRect)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function Probe({ shown }: { shown: boolean }) {
    const dockRef = useComposerDockHeight()
    return shown ? <main><div ref={dockRef} /></main> : null
  }
  try {
    await act(async () => root.render(<Probe shown />))
    expect(host.querySelector('main')?.style.getPropertyValue('--dock-h')).toBe('100px')
    measure = 350
    await act(async () => resize())
    expect(host.querySelector('main')?.style.getPropertyValue('--dock-h')).toBe('350px')
    await act(async () => root.render(<Probe shown={false} />))
    expect(disconnect).toHaveBeenCalledOnce()
    measure = 120
    await act(async () => root.render(<Probe shown />))
    expect(host.querySelector('main')?.style.getPropertyValue('--dock-h')).toBe('120px')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    bounds.mockRestore()
    vi.unstubAllGlobals()
  }
})
