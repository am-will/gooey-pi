// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GooeyPiMark } from '../../src/components/ui'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { PetsSettings } from '../../src/pages/settings/PetsSettings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Unpackaged `electron .`, `npm run preview` and the hermetic e2e load the
// renderer over file://, where a root-absolute src points at the filesystem root.
const FILE_RENDERER_URL = 'file:///app/out/renderer/index.html'
const FILE_RENDERER_MASCOT_URL = 'file:///app/out/renderer/gooeypi-mascot.png'

describe('renderer asset paths', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  async function renderedMascotUrl(element: ReactElement): Promise<string> {
    await act(async () => { root.render(element) })
    const src = container.querySelector('img[src$="gooeypi-mascot.png"]')?.getAttribute('src') ?? ''
    return new URL(src, FILE_RENDERER_URL).href
  }

  it('resolves the mark beside a file:// index.html', async () => {
    expect(await renderedMascotUrl(<GooeyPiMark size={48} />)).toBe(FILE_RENDERER_MASCOT_URL)
  })

  it('resolves the Pets settings tile beside a file:// index.html', async () => {
    expect(await renderedMascotUrl(<PetsSettings settings={DEFAULT_SETTINGS} onUpdate={() => {}} pets={null} />)).toBe(FILE_RENDERER_MASCOT_URL)
  })
})
