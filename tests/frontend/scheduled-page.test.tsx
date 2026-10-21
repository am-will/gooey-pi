// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutomationScheduleRecord, PrimeModelDescriptor, ProjectRecord, ScheduleTiming } from '../../src/types/api'
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


const task: AutomationScheduleRecord = {
  schemaVersion: 1, id: 'task', harness: 'omp', revision: 3, title: 'Task', prompt: 'Do work', target: { kind: 'project', projectId: 'project' },
  timing: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstartLocal: '2027-01-01T09:00:00', timeZone: 'UTC' },
  execution: { model: 'provider/model', thinking: 'auto', speed: 'normal' }, status: 'active', createdBy: 'user', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', runs: [],
}
const project: ProjectRecord = { id: 'project', harness: 'omp', name: 'Project', path: '/project', primaryFolder: '/project', folders: ['/project'], pinned: false, createdAt: '', lastOpenedAt: '', sessionCount: 0 }
const model: PrimeModelDescriptor = { key: 'provider/model', provider: 'provider', id: 'model', name: 'Model', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 1000, availableThinkingLevels: ['medium'], fastModeSupported: false, available: true }

it.each(['updated', 'deleted'])('keeps the edit revision and never creates when the catalog is %s', async (change) => {
  const onCreate = vi.fn(noop)
  const onUpdate = vi.fn(noop)
  const props = renderPage({ schedules: [task], projects: [project], models: [model], onCreate, onUpdate })
  act(() => host.querySelector<HTMLButtonElement>('.schedule-row')!.click())
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Edit')!.click())
  renderPage({ ...props, schedules: change === 'deleted' ? [] : [{ ...task, revision: 4 }] })
  await act(async () => document.querySelector('#schedule-editor-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(onCreate).not.toHaveBeenCalled()
  expect(onUpdate).toHaveBeenCalledWith('task', expect.objectContaining({ revision: 3 }))
})


it('consumes a focus request once so catalog refresh cannot reopen it after Back', () => {
  const onFocusHandled = vi.fn()
  const props = renderPage({ schedules: [task], selectedScheduleId: 'task', onFocusHandled })
  expect(host.querySelector('.schedule-page--detail')).not.toBeNull()
  expect(onFocusHandled).toHaveBeenCalledExactlyOnceWith('task')
  act(() => host.querySelector<HTMLButtonElement>('.schedule-back')!.click())
  renderPage({ ...props, schedules: [{ ...task }] })
  expect(host.querySelector('.schedule-page--detail')).toBeNull()
  expect(onFocusHandled).toHaveBeenCalledTimes(1)
})


it('does not postpone preview when the parent supplies fresh callback identities', async () => {
  vi.useFakeTimers()
  try {
    const initial = vi.fn(async (timing: ScheduleTiming) => ({ timing, occurrences: [] }))
    const latest = vi.fn(async (timing: ScheduleTiming) => ({ timing, occurrences: [] }))
    const props = renderPage({ onPreview: initial })
    act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('New schedule'))!.click())
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => vi.advanceTimersByTimeAsync(100))
      renderPage({ ...props, onPreview: (timing) => latest(timing) })
    }
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(initial).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})


it('reports one-time date errors independently of the hidden advanced recurrence editor', async () => {
  renderPage({ schedules: [task], projects: [project], models: [model] })
  act(() => host.querySelector<HTMLButtonElement>('.schedule-row')!.click())
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Edit')!.click())
  act(() => [...document.querySelectorAll<HTMLButtonElement>('.schedule-frequency button')].find((button) => button.textContent === 'Advanced')!.click())
  act(() => document.querySelector<HTMLInputElement>('input[name="timing"]')!.click())
  const date = document.querySelector<HTMLInputElement>('input[type="date"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(date, '')
    date.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector('#schedule-editor-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(document.body.textContent).toContain('Choose a valid date and time.')
  expect(document.body.textContent).not.toContain('Enter a valid RRULE')
})


it('keeps unsaved edits when discarding is cancelled and discards only after in-app confirmation', () => {
  renderPage({ schedules: [task], projects: [project], models: [model] })
  act(() => host.querySelector<HTMLButtonElement>('.schedule-row')!.click())
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Edit')!.click())
  const input = document.querySelector<HTMLInputElement>('#schedule-editor-form input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed title')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const cancelEditor = document.querySelector<HTMLButtonElement>('.modal__footer button')!
  act(() => cancelEditor.click())
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
  const confirmation = [...document.querySelectorAll('.modal')].at(-1)!
  act(() => confirmation.querySelector<HTMLButtonElement>('.modal__footer button')!.click())
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(input.value).toBe('Changed title')
  act(() => cancelEditor.click())
  act(() => document.querySelector<HTMLButtonElement>('.modal__footer .button--danger')!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
