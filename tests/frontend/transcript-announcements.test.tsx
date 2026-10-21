// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../../src/components/Transcript'
import type { HarnessId, TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function renderTranscript(harness: HarnessId, streaming: boolean): string {
  const messages: TranscriptMessage[] = [
    { id: 'user', role: 'user', timestamp: 1_000, parts: [{ type: 'text', text: 'Run the tests' }] },
    { id: 'reply', role: 'assistant', timestamp: 1_001, streaming, parts: [{ type: 'text', text: 'Running them now.' }] },
  ]
  act(() => root.render(<Transcript messages={messages} git={{ isRepo: false, files: [] }} harness={harness} onOpenChanges={vi.fn()} onSuggestion={vi.fn()} />))
  return container.querySelector('.sr-only[role="status"]')?.textContent ?? ''
}

describe('transcript screen-reader announcements', () => {
  it.each([
    ['prime', 'Prime'],
    ['omp', 'OMP'],
    ['pi', 'Pi'],
  ] as const)('names the active %s harness when a response starts and completes', (harness, name) => {
    renderTranscript(harness, false)

    expect(renderTranscript(harness, true)).toBe(`${name} is working.`)
    expect(renderTranscript(harness, false)).toBe(`${name} response complete.`)
  })
})
