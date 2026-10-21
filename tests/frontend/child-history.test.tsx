// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChildHistory } from '../../src/hooks/useChildHistory'
import type { PrimeWorkApi, TranscriptMessage } from '../../src/types/api'
import type { ChildHistoryPage } from '../../src/types/subagents'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let state: ReturnType<typeof useChildHistory>
const message = (id: string): TranscriptMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: id }] })
const page = (ids: string[], cursor = 'new', olderCursor?: string): ChildHistoryPage => ({ messages: ids.map(message), newerCursor: cursor, olderCursor, reset: false, truncated: false })
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.useFakeTimers() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
function Probe({ api, parent = '/parent.jsonl', child }: { api: PrimeWorkApi['subagents']; parent?: string; child?: string }) {
  state = useChildHistory(api, parent, child)
  return null
}

describe('selected child history ownership', () => {
  it('ignores a late response after switching children and never sends child commands', async () => {
    let resolveFirst!: (value: ChildHistoryPage) => void
    const history = vi.fn().mockImplementationOnce(() => new Promise<ChildHistoryPage>((resolve) => { resolveFirst = resolve })).mockResolvedValue(page(['second']))
    const api = { list: vi.fn(), history }
    await act(async () => root.render(<Probe api={api} child="one" />))
    await act(async () => root.render(<Probe api={api} child="two" />))
    await act(async () => resolveFirst(page(['stale'])))
    expect(state.state.messages.map((item) => item.id)).toEqual(['second'])
    expect(history.mock.calls.map((call) => call[1])).toEqual(['one', 'two'])
    await act(async () => root.render(<Probe api={api} />))
    await act(async () => vi.advanceTimersByTime(5_000))
    expect(history).toHaveBeenCalledTimes(2)
    expect(state.state.messages).toEqual([])
  })

  it('prepends older pages without changing the append cursor, pauses polling, and can return to latest', async () => {
    const history = vi.fn().mockResolvedValueOnce(page(['b'], 'new-b', 'older-b')).mockResolvedValueOnce(page(['a', 'b'], 'rewind', undefined)).mockResolvedValueOnce(page(['c'], 'new-c', 'older-c')).mockResolvedValueOnce(page(['d'], 'new-d'))
    const api = { list: vi.fn(), history }
    await act(async () => root.render(<Probe api={api} child="one" />))
    await act(async () => state.loadEarlier())
    expect(history).toHaveBeenLastCalledWith('/parent.jsonl', 'one', { cursor: 'older-b', direction: 'older' }, 'omp')
    expect(state.state.messages.map((item) => item.id)).toEqual(['a', 'b'])
    expect(state.state.newerCursor).toBe('new-b')
    await act(async () => vi.advanceTimersByTime(5_000))
    expect(history).toHaveBeenCalledTimes(2)
    await act(async () => state.latest())
    expect(state.state.messages.map((item) => item.id)).toEqual(['c'])
    await act(async () => vi.advanceTimersByTime(1_500))
    expect(history).toHaveBeenLastCalledWith('/parent.jsonl', 'one', { cursor: 'new-c', direction: 'newer' }, 'omp')
    expect(state.state.messages.map((item) => item.id)).toEqual(['c', 'd'])
  })

  it('replaces history on reset and bounds retained messages while following', async () => {
    const history = vi.fn().mockResolvedValueOnce(page(['old'], 'old-cursor', 'older')).mockResolvedValueOnce({ ...page(Array.from({ length: 1_100 }, (_, index) => String(index)), 'reset', 'reset-older'), reset: true })
    const api = { list: vi.fn(), history }
    await act(async () => root.render(<Probe api={api} child="one" />))
    await act(async () => vi.advanceTimersByTime(1_500))
    expect(state.state.messages).toHaveLength(1_000)
    expect(state.state.messages[0].id).toBe('100')
    expect(state.state.olderCursor).toBe('reset-older')
    expect(state.state.truncated).toBe(true)
  })
})
