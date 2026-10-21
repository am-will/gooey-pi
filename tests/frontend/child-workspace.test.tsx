// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChildSessionRows, childDepth } from '../../src/components/ChildSessionRows'
import { useChildWorkspace } from '../../src/hooks/useChildWorkspace'
import type { HarnessId, PrimeWorkApi, SessionRecord } from '../../src/types/api'
import type { ChildRoster, ChildSession } from '../../src/types/subagents'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const parent: SessionRecord = { id: 'parent', harness: 'omp', filePath: '/parent.jsonl', projectPath: '/project', title: 'Parent', status: 'running', depth: 0, createdAt: '', updatedAt: '' }
const child: ChildSession = { id: 'child', title: 'Check Git', status: 'running', updatedAt: '' }
let root: Root
let host: HTMLDivElement
let state: ReturnType<typeof useChildWorkspace>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.useFakeTimers() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
function Probe({ bridge, harness = 'omp', visible = true, rosterVisible = true }: { bridge: PrimeWorkApi; harness?: HarnessId; visible?: boolean; rosterVisible?: boolean }) {
  state = useChildWorkspace({ bridge, parent, harness, visible, rosterVisible, compact: false, setSidebarOpen: () => undefined })
  return state.roster ? <ChildSessionRows roster={state.roster} /> : null
}

it('makes unavailable harness support explicit without requesting Prime child data', async () => {
  const list = vi.fn()
  const bridge = { subagents: { list, history: vi.fn() } } as unknown as PrimeWorkApi
  await act(async () => root.render(<Probe bridge={bridge} harness="prime" />))
  expect(host.textContent).toContain('Child chat history is available with OMP.')
  expect(list).not.toHaveBeenCalled()
})

it('ignores in-flight roster responses after switching away and stops polling', async () => {
  let resolve!: (roster: ChildRoster) => void
  const list = vi.fn(() => new Promise<ChildRoster>((accept) => { resolve = accept }))
  const bridge = { subagents: { list, history: vi.fn() } } as unknown as PrimeWorkApi
  await act(async () => root.render(<Probe bridge={bridge} />))
  await act(async () => vi.advanceTimersByTime(9_000))
  expect(list).toHaveBeenCalledOnce()
  await act(async () => root.render(<Probe bridge={bridge} visible={false} />))
  await act(async () => resolve({ supported: true, children: [child], truncated: false }))
  await act(async () => vi.advanceTimersByTime(9_000))
  expect(host.textContent).toBe('')
  expect(state.isOpen).toBe(false)
  expect(list).toHaveBeenCalledOnce()
})

it('bounds ancestry even if roster relationships contain a cycle', () => {
  const second = { ...child, id: 'second', parentId: child.id }
  expect(childDepth({ ...child, parentId: second.id }, [{ ...child, parentId: second.id }, second])).toBe(1)
})

it('polls only while the roster or its selected child is visible', async () => {
  const list = vi.fn().mockResolvedValue({ supported: true, children: [child], truncated: false })
  const bridge = { subagents: { list, history: vi.fn().mockResolvedValue({ messages: [], newerCursor: 'tail', reset: false, truncated: false }) } } as unknown as PrimeWorkApi
  await act(async () => root.render(<Probe bridge={bridge} rosterVisible={false} />))
  await act(async () => vi.advanceTimersByTime(9_000))
  expect(list).not.toHaveBeenCalled()
  await act(async () => root.render(<Probe bridge={bridge} />))
  await act(async () => host.querySelector<HTMLButtonElement>('.child-session-row')!.click())
  await act(async () => root.render(<Probe bridge={bridge} rosterVisible={false} />))
  const viewedCalls = list.mock.calls.length
  await act(async () => vi.advanceTimersByTime(3_000))
  expect(list).toHaveBeenCalledTimes(viewedCalls + 1)
})
