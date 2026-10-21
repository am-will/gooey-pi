// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useBrowserPreviewState } from '../../src/hooks/useBrowserPreviewState'

it('retains bounded deduplicated history without rerendering and resets location with generation', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let current: ReturnType<typeof useBrowserPreviewState> | undefined
  let renders = 0
  function Harness() { current = useBrowserPreviewState(); renders++; return null }
  act(() => root.render(<Harness />))
  if (!current) throw new Error('Hook did not mount')
  const preview = current
  for (let index = 0; index < 25; index++) preview.location.record(`https://example.com/${index}`)
  preview.location.record('https://example.com/24')
  expect(renders).toBe(1)
  expect(preview.location.snapshot().history).toHaveLength(20)
  expect(preview.location.snapshot().url).toBe('https://example.com/24')
  preview.location.clearHistory()
  expect(preview.location.snapshot()).toEqual({ url: 'https://example.com/24', history: [] })
  act(() => preview.reset())
  expect(current.generation).toBe(1)
  expect(current.location).toBe(preview.location)
  expect(preview.location.snapshot()).toEqual({ history: [] })
  act(() => root.unmount())
})
