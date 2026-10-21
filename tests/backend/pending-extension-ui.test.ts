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
