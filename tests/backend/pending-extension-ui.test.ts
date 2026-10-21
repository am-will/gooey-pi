import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingExtensionUi } from '../../electron/main/agent-rpc/pending-extension-ui'
import { parseExtensionUiRequest } from '../../src/lib/extension-ui'

afterEach(() => vi.useRealTimers())
const select = (id: string, extra = {}) => ({ type: 'extension_ui_request', method: 'select', id, title: 'Choose', options: ['Yes', 'No'], ...extra })

describe('pending extension dialogs', () => {
  it('retains only answerable validated fields and preserves questionnaire grouping on replay', () => {
    const pending = new PendingExtensionUi()
    pending.track(select('question', { options: ['__prime_ask_user__group:0:2', 'Yes'], ignored: 'x'.repeat(100_000) }))
    pending.track({ type: 'extension_ui_request', method: 'notify', id: 'notice', title: 'Notice' })
    const frames = pending.list()
    expect(frames).toHaveLength(1)
    expect(JSON.stringify(frames)).not.toContain('ignored')
    expect(parseExtensionUiRequest(frames[0])).toMatchObject({ questionnaire: { groupId: 'group', index: 0, total: 2 } })
    pending.track({ type: 'extension_ui_request', method: 'cancel', targetId: 'question' })
    expect(pending.list()).toEqual([])
  })

  it('bounds retained dialogs and clears all timers on explicit cleanup', () => {
    vi.useFakeTimers()
    const pending = new PendingExtensionUi(() => 0)
    for (let index = 0; index < 17; index += 1) pending.track(select(`request-${index}`, { timeout: 60_000 }))
    expect(pending.list()).toHaveLength(16)
    expect(pending.list()[0]?.id).toBe('request-1')
    expect(vi.getTimerCount()).toBe(16)
    pending.clear()
    expect(pending.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a thirty-minute timeout and replays only its remaining duration', async () => {
    vi.useFakeTimers()
    let now = 0
    const pending = new PendingExtensionUi(() => now)
    pending.track(select('question', { timeout: 30 * 60_000 }))
    now = 2 * 60_000
    await vi.advanceTimersByTimeAsync(now)
    expect(pending.list()[0]?.timeout).toBe(28 * 60_000)
    now = 30 * 60_000
    await vi.advanceTimersByTimeAsync(28 * 60_000)
    expect(pending.list()).toEqual([])
  })

  it('replaces the timer of a duplicate dialog without expiring the replacement early', async () => {
    vi.useFakeTimers()
    const pending = new PendingExtensionUi(() => 0)
    pending.track(select('same', { timeout: 10 }))
    pending.track(select('same', { timeout: 100 }))
    await vi.advanceTimersByTimeAsync(10)
    expect(pending.list()).toHaveLength(1)
    pending.resolve('same')
    expect(vi.getTimerCount()).toBe(0)
  })
})


const grouped = (id: string, index: number, group = 'group', total = 2, extra = {}) => select(id, { options: [`__prime_ask_user__${group}:${index}:${total}`, 'Yes'], ...extra })
describe('questionnaire replay membership', () => {
  it('retains a settled first index before the second question arrives', () => {
    const pending = new PendingExtensionUi()
    pending.track(grouped('q1', 0))
    pending.resolve('q1')
    expect(pending.list()).toEqual([])
    expect(pending.progress()).toEqual([{ groupId: 'group', total: 2, arrived: [0], settled: [0] }])
    pending.track(grouped('q2', 1))
    expect(pending.progress()).toEqual([{ groupId: 'group', total: 2, arrived: [0, 1], settled: [0] }])
    expect(pending.list().map((request) => parseExtensionUiRequest(request))).toEqual([expect.objectContaining({ id: 'q2', questionnaire: { groupId: 'group', total: 2, index: 1 } })])
  })

  it('replays only the unanswered question after partial settlement with complete membership', () => {
    const pending = new PendingExtensionUi()
    pending.track(grouped('q1', 0)); pending.track(grouped('q2', 1))
    pending.resolve('q1')
    expect(pending.list().map((frame) => frame.id)).toEqual(['q2'])
    expect(pending.progress()[0]).toMatchObject({ arrived: [0, 1], settled: [0], total: 2 })
    pending.resolve('q2')
    expect(pending.snapshot()).toEqual({ pendingExtensionUi: [], pendingExtensionUiGroups: [] })
    pending.track(grouped('q1', 0))
    expect(pending.list()).toEqual([])
  })

  it('keeps incomplete membership explicit across snapshots instead of inventing missing answers', () => {
    const pending = new PendingExtensionUi()
    pending.track(grouped('q2', 1, 'group', 3))
    const snapshot = pending.snapshot()
    expect(snapshot.pendingExtensionUiGroups).toEqual([{ groupId: 'group', total: 3, arrived: [1], settled: [] }])
    snapshot.pendingExtensionUiGroups[0].arrived.push(0, 2)
    expect(pending.progress()[0].arrived).toEqual([1])
  })

  it('ignores settled retransmissions and conflicting ids, indexes and totals', () => {
    const pending = new PendingExtensionUi()
    pending.track(grouped('q1', 0)); pending.resolve('q1')
    pending.track(grouped('q1', 0))
    pending.track(grouped('q1', 1))
    pending.track(grouped('other-q1', 0))
    pending.track(grouped('q3', 1, 'group', 3))
    pending.track(grouped('q1', 0, 'other-group'))
    expect(pending.list()).toEqual([])
    expect(pending.progress()).toEqual([{ groupId: 'group', total: 2, arrived: [0], settled: [0] }])
    pending.track(grouped('q2', 1))
    expect(pending.list().map((frame) => frame.id)).toEqual(['q2'])
  })

  it('closes the whole expired group before creating a consistent snapshot and rejects late arrivals', () => {
    vi.useFakeTimers()
    let now = 0
    const pending = new PendingExtensionUi(() => now)
    pending.track(grouped('q1', 0)); pending.track(grouped('q2', 1, 'group', 2, { timeout: 10 }))
    now = 10
    expect(pending.snapshot()).toEqual({ pendingExtensionUi: [], pendingExtensionUiGroups: [] })
    expect(vi.getTimerCount()).toBe(0)
    pending.track(grouped('q1', 0)); pending.track(grouped('q2', 1))
    expect(pending.list()).toEqual([])
  })

  it('cancels groups and clears timers without allowing late requests to reopen them until session reset', () => {
    vi.useFakeTimers()
    const pending = new PendingExtensionUi()
    pending.track(grouped('q1', 0, 'cancelled', 2, { timeout: 100 }))
    pending.track({ type: 'extension_ui_request', method: 'cancel', targetId: 'q1' })
    pending.track(grouped('q2', 1, 'cancelled'))
    expect(pending.progress()).toEqual([])
    pending.track(grouped('q1', 0, 'cleared', 2, { timeout: 100 }))
    pending.resolve('q1')
    pending.clear()
    pending.track(grouped('q2', 1, 'cleared'))
    expect(pending.snapshot()).toEqual({ pendingExtensionUi: [], pendingExtensionUiGroups: [] })
    expect(vi.getTimerCount()).toBe(0)
    pending.reset()
    pending.track(grouped('q1', 0, 'cleared'))
    expect(pending.progress()).toHaveLength(1)
  })

  it('bounds incomplete group bookkeeping and evicts the whole oldest group', () => {
    const pending = new PendingExtensionUi()
    for (let index = 0; index < 17; index++) {
      pending.track(grouped(`question-${index}`, 0, `group-${index}`))
      pending.resolve(`question-${index}`)
    }
    expect(pending.progress()).toHaveLength(16)
    pending.track(grouped('late', 1, 'group-0'))
    expect(pending.list()).toEqual([])
  })
})


it('closes a group when native cancellation targets a response already written locally and fans out remaining ids', () => {
  const pending = new PendingExtensionUi()
  pending.track(grouped('q1', 0)); pending.resolve('q1'); pending.track(grouped('q2', 1))
  const cancel = vi.fn()
  pending.track({ type: 'extension_ui_request', method: 'cancel', targetId: 'q1' }, cancel)
  expect(cancel).toHaveBeenCalledExactlyOnceWith('q2')
  expect(pending.snapshot()).toEqual({ pendingExtensionUi: [], pendingExtensionUiGroups: [] })
  expect(pending.track(grouped('q2', 1))).toBe(false)
})
