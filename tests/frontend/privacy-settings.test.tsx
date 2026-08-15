// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { PrivacySettings } from '../../src/pages/settings/PrivacySettings'
import { HARNESS_IDS, type HarnessId } from '../../src/types/api'

const TELEMETRY_VALUES = [false, true] as const
const HARNESS_TELEMETRY_CASES = HARNESS_IDS.flatMap((harness) => (
  TELEMETRY_VALUES.map((telemetry) => ({ harness, telemetry }))
)) satisfies Array<{ harness: HarnessId; telemetry: boolean }>

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
  it.each(HARNESS_TELEMETRY_CASES)('shows agent-neutral copy without an inert diagnostics control for $harness with telemetry=$telemetry', ({ harness, telemetry }) => {
    const onUpdate = vi.fn()
    act(() => root.render(<PrivacySettings settings={{ ...DEFAULT_SETTINGS, activeHarness: harness, telemetry }} onUpdate={onUpdate} />))

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
