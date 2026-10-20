// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSettings } from '../../src/pages/settings/AboutSettings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('About settings', () => {
  it('names every supported harness', () => {
    act(() => root.render(<AboutSettings onOpenDocs={vi.fn()} />))

    expect(container.querySelector('header p')?.textContent).toBe('A playful desktop workspace for Pi, OMP, and Prime Agent.')
    expect(container.querySelector('.about-card p')?.textContent).toBe('Pi + OMP + Prime Agent workspace · Version 0.1.0')
  })
})
