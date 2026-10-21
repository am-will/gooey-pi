// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { PrivacySettings } from '../../src/pages/settings/PrivacySettings'
import { HARNESS_IDS } from '../../src/types/api'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('PrivacySettings', () => {
  it.each(HARNESS_IDS)('shows agent-neutral copy without an inert diagnostics control for %s', (harness) => {
    const onUpdate = vi.fn()
    act(() => root.render(<PrivacySettings settings={{ ...DEFAULT_SETTINGS, activeHarness: harness }} onUpdate={onUpdate} />))

    expect(container.textContent).toContain('Understand how GooeyPi stores settings and connects to agents.')
    expect(container.textContent).toContain('Settings stay on this device')
    expect(container.textContent).toContain('Project metadata and interface settings are stored locally on this device.')
    expect(container.textContent).toContain('Requests use your selected agent')
    expect(container.textContent).toContain('Session requests follow the selected agent and its provider configuration.')
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.textContent).not.toMatch(/optional diagnostics|share diagnostics|this Mac|Prime Agent/i)
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
