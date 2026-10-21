// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../src/components/ErrorBoundary'
import { Transcript } from '../../src/components/Transcript'
import { saveComposerDraftFromDom, readComposerDraft, clearComposerDraft } from '../../src/lib/composer-draft'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => undefined })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  window.sessionStorage.clear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('render failed')
  return <p>recovered</p>
}

describe('ErrorBoundary', () => {
  it('renders the fallback, reports the error, and can reset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onCatch = vi.fn()
    let setArmed!: (value: boolean) => void
    function Harness() {
      const [armed, setArmedState] = useState(true)
      setArmed = setArmedState
      return (
        <ErrorBoundary onCatch={onCatch} fallback={(reset) => <button type="button" onClick={reset}>retry</button>}>
          <Bomb armed={armed} />
        </ErrorBoundary>
      )
    }
    await act(async () => { root.render(<Harness />) })
    expect(container.textContent).toBe('retry')
    expect(onCatch).toHaveBeenCalledTimes(1)

    await act(async () => { setArmed(false) })
    act(() => { container.querySelector('button')!.click() })
    expect(container.textContent).toBe('recovered')
  })
})

describe('transcript per-message boundary', () => {
  it('labels an admitted steer that is waiting for a safe steering point', async () => {
    await act(async () => {
      root.render(<Transcript
        messages={[{ id: 'user-pending-steer', role: 'user', steerState: 'accepted', timestamp: 1, parts: [{ type: 'text', text: 'redirect' }] }]}
        git={{ isRepo: false, files: [] }}
        onOpenChanges={vi.fn()}
        onSuggestion={vi.fn()}
      />)
    })
    expect(container.textContent).toContain('Accepted — waiting for the next safe steering point')
  })

  it('keeps healthy messages visible when one row fails to render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const good: TranscriptMessage = { id: 'good', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'still here' }] }
    const broken = { id: 'broken', role: 'user', timestamp: 2, parts: undefined } as unknown as TranscriptMessage
    await act(async () => {
      root.render(<Transcript
        messages={[good, broken]}
        git={{ isRepo: false, files: [] }}
        onOpenChanges={vi.fn()}
        onSuggestion={vi.fn()}
      />)
    })
    expect(container.textContent).toContain('still here')
    expect(container.textContent).toContain('This message could not be displayed.')
  })
})

describe('composer draft preservation', () => {
  it('saves the composer DOM value only into its owned scope', () => {
    const composer = document.createElement('div')
    composer.className = 'composer'
    composer.dataset.draftScope = 'project:session'
    const textarea = document.createElement('textarea')
    textarea.value = 'half-written prompt'
    composer.append(textarea)
    document.body.append(composer)
    try {
      saveComposerDraftFromDom()
      expect(readComposerDraft('project:session')?.text).toBe('half-written prompt')
      expect(readComposerDraft('project:other')).toBeNull()
      clearComposerDraft('project:session')
      expect(readComposerDraft('project:session')).toBeNull()
    } finally {
      composer.remove()
    }
  })

  it('seeds a remounted Composer with the preserved draft', async () => {
    const composer = document.createElement('div')
    composer.className = 'composer'
    composer.dataset.draftScope = 'project:session'
    const source = document.createElement('textarea')
    source.value = 'draft before crash'
    composer.append(source)
    document.body.append(composer)
    saveComposerDraftFromDom()
    composer.remove()

    const { Composer } = await import('../../src/components/Composer')
    await act(async () => {
      root.render(<Composer
        draftKey="project:session"
        busy={false}
        model="auto"
        effort="medium"
        modelsByProvider={new Map()}
        providers={[]}
        reasoningLevels={['medium']}
        fast={false}
        fastSupported={false}
        fastAvailable={false}
        imageInputSupported={false}
        messageEnterAction="queue"
        skills={[]}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onFastChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />)
    })
    expect(container.querySelector('textarea')?.value).toBe('draft before crash')
    expect(readComposerDraft('project:session')?.text).toBe('draft before crash')
  })
})
