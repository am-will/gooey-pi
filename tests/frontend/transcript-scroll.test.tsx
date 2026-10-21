// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useTranscriptScroll } from '../../src/components/transcript/scroll'
import type { TranscriptMessage } from '../../src/types/api'

it('follows non-streaming appended rows only while pinned to the bottom', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const scrollTo = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let scroll!: ReturnType<typeof useTranscriptScroll>
  function Probe({ messages }: { messages: TranscriptMessage[] }) {
    scroll = useTranscriptScroll(messages, 'OMP')
    return <div ref={scroll.scrollRef} />
  }
  const message = (id: string): TranscriptMessage => ({ id, role: 'user', parts: [] })
  try {
    await act(async () => root.render(<Probe messages={[message('one')]} />))
    const node = scroll.scrollRef.current
    if (!node) throw new Error('Missing transcript scroller')
    Object.defineProperties(node, { scrollTo: { value: scrollTo }, scrollHeight: { value: 1_000 }, clientHeight: { value: 500 } })
    await act(async () => root.render(<Probe messages={[message('one'), message('two')]} />))
    expect(scrollTo).toHaveBeenCalledOnce()
    node.scrollTop = 0
    scroll.updatePinnedState()
    await act(async () => root.render(<Probe messages={[message('one'), message('two'), message('three')]} />))
    expect(scrollTo).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
