// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, setFormattingLocaleForTests } from '../../src/lib/i18n'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import type { AutomationScheduleRecord, LocalePreference } from '../../src/types/api'

// The page's date helpers are plain functions, so they read the interface locale
// from the i18n mirror rather than from the React context. These cases render the
// real page instead of the helpers, so that path is exercised end to end.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mid-September UTC keeps any test time zone inside September, so the month
// assertion below does not depend on where the suite runs.
const NEXT_RUN_AT = '2031-09-24T11:00:00.000Z'

function schedule(): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: 'schedule-1',
    harness: 'prime',
    revision: 1,
    title: 'Nightly review',
    prompt: 'Review the open changes',
    target: { kind: 'project', projectId: 'project-one' },
    timing: { kind: 'once', at: NEXT_RUN_AT },
    execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    status: 'active',
    createdBy: 'user',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    nextRunAt: NEXT_RUN_AT,
    runs: [],
  }
}

const noop = async () => undefined

function renderPage(root: Root, preference: LocalePreference) {
  act(() => root.render(
    <I18nProvider preference={preference}>
      <ScheduledPage
        harness="prime"
        schedules={[schedule()]}
        nativeHeartbeats={[]}
        projects={[]}
        sessions={[]}
        models={[]}
        lastSelectedModel="auto"
        onCreate={noop}
        onUpdate={noop}
        onPause={noop}
        onResume={noop}
        onDelete={noop}
        onRunNow={noop}
        onPreview={async () => ({ timing: { kind: 'once', at: NEXT_RUN_AT }, occurrences: [] })}
        onOpenSession={() => undefined}
        onManageHeartbeat={noop}
      />
    </I18nProvider>,
  ))
}

describe('ScheduledPage date formatting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    // The mirror is module state shared with every other test file.
    setFormattingLocaleForTests('en')
  })

  // Both preferences are asserted in one case on purpose. A formatter that
  // regressed to `undefined` (the machine locale) would print the same string
  // for both interfaces, and which expectation that breaks depends on the
  // machine's default locale — a single-preference case can pass vacuously when
  // that default happens to match it.
  it('shows the next run in the interface language rather than the machine locale', () => {
    renderPage(root, 'en')
    expect(container.textContent ?? '').toContain('Sep')

    renderPage(root, 'ja')
    const text = container.textContent ?? ''
    expect(text).toContain('9月')
    expect(text).not.toContain('Sep')
  })
})
