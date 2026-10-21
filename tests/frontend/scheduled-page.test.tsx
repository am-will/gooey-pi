// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScheduledPage } from '../../src/pages/ScheduledPage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })
const noop = async () => undefined
function renderPage(overrides: Partial<ComponentProps<typeof ScheduledPage>> = {}) {
  const props: ComponentProps<typeof ScheduledPage> = {
    harness: 'omp', schedules: [], nativeHeartbeats: [], projects: [], sessions: [], models: [], lastSelectedModel: '',
    onCreate: noop, onUpdate: noop, onPause: noop, onResume: noop, onDelete: noop, onRunNow: noop,
    onPreview: async (timing) => ({ timing, occurrences: [] }), onOpenSession: () => undefined, onManageHeartbeat: noop, ...overrides,
  }
  act(() => root.render(<ScheduledPage {...props} />))
  return props
}
it('renders the empty page and opens a create form', () => {
  renderPage()
  expect(host.textContent).toContain('Scheduled')
  const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('New schedule'))!
  act(() => create.click())
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
})
