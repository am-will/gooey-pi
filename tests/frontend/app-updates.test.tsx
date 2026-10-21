// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppUpdates } from '../../src/hooks/useAppUpdates'
import { translate, setFormattingLocaleForTests } from '../../src/lib/i18n'
import type { AppUpdateState, LocalePreference, PrimeWorkApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  // The hook reads the plain-module locale mirror; keep the English default for
  // the rest of the file even when a case fails.
  setFormattingLocaleForTests('en')
})

const reportError = () => undefined

function Probe({ bridge, locale = 'en', onAct }: { bridge: PrimeWorkApi | null; locale?: LocalePreference; onAct(act: () => Promise<void>): void }) {
  const updates = useAppUpdates(bridge, reportError, locale)
  onAct(updates.act)
  return <span data-phase={updates.state.phase}>{updates.state.message ?? updates.state.version ?? ''}</span>
}

describe('useAppUpdates', () => {
  it('lets the main-process subscription be the only writer for pushed state', async () => {
    let push!: (state: AppUpdateState) => void
    let finishCheck!: (state: AppUpdateState) => void
    const bridge = {
      updates: {
        getState: vi.fn(async (): Promise<AppUpdateState> => ({ phase: 'idle' })),
        check: vi.fn(() => new Promise<AppUpdateState>((resolve) => { finishCheck = resolve })),
        downloadAndInstall: vi.fn(async () => true),
        onChanged: (callback: (state: AppUpdateState) => void) => { push = callback; return () => undefined },
      },
    } as unknown as PrimeWorkApi
    let action!: () => Promise<void>

    await act(async () => { root.render(<Probe bridge={bridge} onAct={(next) => { action = next }} />) })
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('idle')

    const pending = action()
    // A stale check response must not overwrite the newer pushed state.
    await act(async () => { push({ phase: 'available', version: '0.2.0' }) })
    finishCheck({ phase: 'checking' })
    await act(async () => { await pending })

    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('available')
    expect(container.firstElementChild?.textContent).toBe('0.2.0')
  })

  // The update control has no bridge in a browser build; its copy is the one
  // message GooeyPi composes for this state, and it must follow a language
  // change made after mount.
  it('rebuilds the unsupported message when the interface language changes', async () => {
    await act(async () => { root.render(<Probe bridge={null} locale="en" onAct={() => undefined} />) })
    expect(container.firstElementChild?.textContent).toBe(translate('en', 'update.automaticMessage'))

    // The shell writes the locale mirror during its own render, before this
    // effect runs, so the mirror is updated first here as well.
    setFormattingLocaleForTests('ja')
    await act(async () => { root.render(<Probe bridge={null} locale="ja" onAct={() => undefined} />) })
    expect(container.firstElementChild?.textContent).toBe(translate('ja', 'update.automaticMessage'))
  })
})
