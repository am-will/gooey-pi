// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GOOEYPI_MASCOT_SRC } from '../../src/lib/assets'
import { GooeyPiMark } from '../../src/components/ui'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { PetsSettings } from '../../src/pages/settings/PetsSettings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
    return src
  }

  it('uses the bundled mascot import for the app mark', async () => {
    expect(await renderedMascotUrl(<GooeyPiMark size={48} />)).toBe(GOOEYPI_MASCOT_SRC)
  })

  it('uses the same bundled mascot import for the Pets tile', async () => {
    expect(await renderedMascotUrl(<PetsSettings settings={DEFAULT_SETTINGS} onUpdate={() => {}} pets={null} />)).toBe(GOOEYPI_MASCOT_SRC)
  })
})
