// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ChildHistoryPane from '../../src/components/ChildHistoryPane'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('exposes only history navigation and keeps the selected child task readable', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const close = vi.fn()
  const load = vi.fn()
  const latest = vi.fn()
  try {
    await act(async () => root.render(<ChildHistoryPane child={{ id: 'git', title: 'Review Git', task: 'Check the staged changes.', status: 'complete', updatedAt: '' }} state={{ messages: [], loading: false, truncated: false, following: false, olderCursor: 'older' }} onClose={close} onLoadEarlier={load} onLatest={latest} onRefresh={() => undefined} />))
    expect(host.textContent).toContain('Read-only history')
    expect(host.textContent).toContain('Check the staged changes.')
    expect(host.textContent).toContain('No messages have been recorded yet.')
    expect(host.querySelector('textarea, input')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.child-history-earlier')!.click())
    expect(load).toHaveBeenCalledOnce()
    await act(async () => host.querySelector<HTMLButtonElement>('.child-history-latest')!.click())
    expect(latest).toHaveBeenCalledOnce()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close child history"]')!.click())
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
