// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { GooeyPiMark } from '../../src/components/ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Unpackaged `electron .`, `npm run preview` and the hermetic e2e load the
// renderer over file://, where a root-absolute src points at the filesystem root.
const FILE_RENDERER_URL = 'file:///app/out/renderer/index.html'

let container: HTMLDivElement

afterEach(() => {
  container?.remove()
})

describe('renderer asset paths', () => {
  it('resolves the mark beside a file:// index.html', async () => {
    container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<GooeyPiMark size={48} />) })

    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(new URL(src, FILE_RENDERER_URL).href).toBe('file:///app/out/renderer/gooeypi-mascot.png')
    await act(async () => { root.unmount() })
  })
})
