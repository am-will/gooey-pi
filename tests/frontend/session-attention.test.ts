import { describe, expect, it } from 'vitest'
import { activityNotificationSignature, applySessionLifecycleEvent, readClearedActivity, readClearedAttention, sessionAttentionSignature, sessionCompanionNotificationSignature, sessionShowsCompanionNotification } from '../../src/app/session-attention'
import { mergeSessionCatalog } from '../../src/hooks/useBootstrap'
import type { SessionRecord } from '../../src/types/api'

const session = (): SessionRecord => ({
  id: 'session',
  harness: 'prime',
  filePath: '/sessions/session.jsonl',
  projectPath: '/project',
  title: 'Session',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const catalogSnapshot = (record: SessionRecord, status = record.status): SessionRecord => {
  const { eventRevision: _eventRevision, statusEventRevision: _statusEventRevision, ...snapshot } = record
  return { ...snapshot, status }
}

describe('session lifecycle attention', () => {
  it('does not mark a visible completion unread', () => {
    const completed = applySessionLifecycleEvent(session(), { type: 'agent_end' }, true, Date.parse('2025-01-01T00:00:01.000Z'))
    expect(completed).toMatchObject({ status: 'complete', unread: false, eventRevision: 1, statusEventRevision: 1 })
    expect(completed.updatedAt).toBe('2025-01-01T00:00:01.000Z')
    expect(sessionAttentionSignature(completed)).toBeUndefined()
    expect(sessionShowsCompanionNotification(completed)).toBe(true)
    expect(sessionShowsCompanionNotification(completed, sessionCompanionNotificationSignature(completed))).toBe(false)
  })

  it('gives repeated background waits and completions distinct attention revisions', () => {
    const waiting = applySessionLifecycleEvent(session(), { type: 'extension_ui_request' }, false, 1)
    const waitingAgain = applySessionLifecycleEvent(waiting, { type: 'extension_ui_request' }, false, 1)
    const completed = applySessionLifecycleEvent(waitingAgain, { type: 'agent_end' }, false, 1)
    const completedAgain = applySessionLifecycleEvent(completed, { type: 'agent_end' }, false, 1)

    expect(sessionAttentionSignature(waiting)).toBe('waiting:1')
    expect(sessionAttentionSignature(waitingAgain)).toBe('waiting:2')
    expect(sessionAttentionSignature(completed)).toBe('complete:3')
    expect(sessionAttentionSignature(completedAgain)).toBe('complete:4')
    expect(Date.parse(waitingAgain.updatedAt)).toBeGreaterThan(Date.parse(waiting.updatedAt))
  })

  it('advances lifecycle revision without changing attention for failures', () => {
    const failed = applySessionLifecycleEvent(session(), { type: 'transport_error' }, false, 1)
    expect(failed).toMatchObject({ status: 'failed', eventRevision: 1 })
    expect(sessionAttentionSignature(failed)).toBe('failed:1')
    expect(sessionShowsCompanionNotification(failed)).toBe(true)
  })

  it('shows the companion badge only for new terminal turns or attention states', () => {
    expect(sessionShowsCompanionNotification(session())).toBe(false)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'complete' })).toBe(false)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'complete', unread: true })).toBe(true)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'waiting' })).toBe(true)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'waiting' }, `waiting:${session().updatedAt}`)).toBe(false)
  })

  it('makes settled activity dismissible until a new revision and keeps running work visible', () => {
    const completed = { ...session(), status: 'complete' as const, eventRevision: 3 }
    expect(activityNotificationSignature(completed)).toBe('complete:3')
    expect(activityNotificationSignature({ ...completed, eventRevision: 4 })).toBe('complete:4')
    expect(activityNotificationSignature({ ...completed, status: 'running' })).toBeUndefined()
    expect(activityNotificationSignature({ ...completed, archived: true })).toBeUndefined()
  })

  it('ignores desktop rate-limit drops: the agent is still running', () => {
    const running = applySessionLifecycleEvent(session(), { type: 'agent_start' }, true, 1)
    const afterLimit = applySessionLifecycleEvent(running, { type: 'transport_limit', kind: 'count' }, true, 2)
    expect(afterLimit).toBe(running)
  })

  it('finishes a manual compaction when no continuation is scheduled', () => {
    const running = applySessionLifecycleEvent(session(), { type: 'compaction_start', reason: 'manual' }, true, 1)
    const completed = applySessionLifecycleEvent(running, { type: 'compaction_end', reason: 'manual', willRetry: false }, true, 2)
    expect(running.status).toBe('running')
    expect(completed).toMatchObject({ status: 'complete', unread: false, eventRevision: 2 })
  })
})

describe('catalog merges over live session state', () => {
  it.each([
    ['running', { type: 'agent_start' }],
    ['waiting', { type: 'extension_ui_request' }],
    ['complete', { type: 'agent_end' }],
    ['failed', { type: 'transport_error' }],
  ] as const)('does not downgrade renderer-owned %s state with a stale idle catalog record', (expectedStatus, event) => {
    const live = applySessionLifecycleEvent(session(), event, false, 1)
    const diskRecord = catalogSnapshot(live, 'idle')

    const [merged] = mergeSessionCatalog([live], [diskRecord], undefined, new Map(), 0)

    expect(merged.status).toBe(expectedStatus)
    expect(merged.eventRevision).toBe(1)
    expect(merged.statusEventRevision).toBe(1)
    expect(merged.unread).toBe(live.unread)
  })

  it('keeps catalog idle authoritative without a renderer revision', () => {
    const restarted: SessionRecord = { ...session(), status: 'complete' }
    const [idleAfterRestart] = mergeSessionCatalog(
      [restarted],
      [{ ...restarted, status: 'idle' }],
      undefined,
      new Map(),
      0,
    )
    expect(idleAfterRestart.status).toBe('idle')

    const revisionWithoutStatusOwnership: SessionRecord = { ...restarted, eventRevision: 3 }
    const [externalIdle] = mergeSessionCatalog(
      [revisionWithoutStatusOwnership],
      [catalogSnapshot(revisionWithoutStatusOwnership, 'idle')],
      undefined,
      new Map(),
      0,
    )
    expect(externalIdle.status).toBe('idle')
  })

  it.each(['unknown', 'running', 'waiting', 'failed'] as const)(
    'keeps an authoritative non-idle catalog transition to %s',
    (catalogStatus) => {
      const rendererComplete = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
      const [merged] = mergeSessionCatalog(
        [rendererComplete],
        [catalogSnapshot(rendererComplete, catalogStatus)],
        undefined,
        new Map(),
        0,
      )
      expect(merged.status).toBe(catalogStatus)
      expect(merged.eventRevision).toBe(1)
      expect(merged.statusEventRevision).toBeUndefined()
    },
  )

  it('keeps renderer status provenance when the catalog corroborates the same status', () => {
    const rendererComplete = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
    const [merged] = mergeSessionCatalog([rendererComplete], [catalogSnapshot(rendererComplete)], undefined, new Map(), 0)

    expect(merged).toBe(rendererComplete)
    expect(merged).toMatchObject({ status: 'complete', eventRevision: 1, statusEventRevision: 1 })
  })

  it('accepts idle after an authoritative catalog transition takes status ownership', () => {
    const rendererComplete = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
    const [catalogRunning] = mergeSessionCatalog(
      [rendererComplete],
      [catalogSnapshot(rendererComplete, 'running')],
      undefined,
      new Map(),
      0,
    )
    const [catalogIdle] = mergeSessionCatalog(
      [catalogRunning],
      [catalogSnapshot(catalogRunning, 'idle')],
      undefined,
      new Map(),
      0,
    )
    const rendererFailed = applySessionLifecycleEvent(catalogIdle, { type: 'transport_error' }, false, 2)

    expect(catalogRunning).toMatchObject({ status: 'running', eventRevision: 1, statusEventRevision: undefined })
    expect(catalogIdle).toMatchObject({ status: 'idle', eventRevision: 1, statusEventRevision: undefined })
    expect(rendererFailed).toMatchObject({ status: 'failed', eventRevision: 2, statusEventRevision: 2 })
  })

  it('preserves identity for a status-only stale snapshot but still applies real catalog changes and revisions', () => {
    const live = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
    const staleIdle = catalogSnapshot(live, 'idle')

    const [unchanged] = mergeSessionCatalog([live], [staleIdle], undefined, new Map(), 7)
    expect(unchanged).toBe(live)

    const [archived] = mergeSessionCatalog(
      [live],
      [{ ...staleIdle, archived: true }],
      live.filePath,
      new Map([[live.filePath, 8]]),
      7,
    )
    expect(archived).toMatchObject({
      status: 'complete',
      archived: true,
      unread: false,
      eventRevision: 1,
      statusEventRevision: 1,
      syncRevision: 8,
    })
    expect(archived).not.toBe(live)
  })

  it('lets the next renderer lifecycle event advance normally after a stale idle merge', () => {
    const completed = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
    const [merged] = mergeSessionCatalog(
      [completed],
      [catalogSnapshot(completed, 'idle')],
      undefined,
      new Map(),
      0,
    )

    const running = applySessionLifecycleEvent(merged, { type: 'agent_start' }, false, 2)
    expect(running).toMatchObject({ status: 'running', eventRevision: 2, statusEventRevision: 2, unread: false })
  })

  it('keeps a waiting badge while its extension-UI request is still open', () => {
    const waiting = applySessionLifecycleEvent(session(), { type: 'extension_ui_request' }, false, 1)
    expect(sessionAttentionSignature(waiting)).toBe('waiting:1')

    const diskRecord: SessionRecord = { ...session(), status: 'running', updatedAt: '2025-01-01T00:00:05.000Z' }
    const [merged] = mergeSessionCatalog([waiting], [diskRecord], undefined, new Map(), 0, () => true)
    expect(merged.status).toBe('waiting')
    expect(merged.eventRevision).toBe(1)
    expect(sessionAttentionSignature(merged)).toBe('waiting:1')

    const [settled] = mergeSessionCatalog([waiting], [diskRecord], undefined, new Map(), 0, () => false)
    expect(settled.status).toBe('running')
  })

  it('keeps a newer optimistic lastUserMessageAt over the disk value', () => {
    const live: SessionRecord = { ...session(), lastUserMessageAt: '2025-01-01T00:10:00.000Z' }
    const diskRecord: SessionRecord = { ...session(), lastUserMessageAt: '2025-01-01T00:00:00.000Z' }
    const [merged] = mergeSessionCatalog([live], [diskRecord], undefined, new Map(), 0)
    expect(merged.lastUserMessageAt).toBe('2025-01-01T00:10:00.000Z')
  })

  it('bumps the catalog revision only for records that actually changed', () => {
    const unchanged: SessionRecord = { ...session(), id: 'same', filePath: '/sessions/same.jsonl', syncRevision: 3 }
    const moved: SessionRecord = { ...session(), id: 'moved', filePath: '/sessions/moved.jsonl', syncRevision: 3 }
    const movedOnDisk: SessionRecord = { ...moved, updatedAt: '2025-01-02T00:00:00.000Z', syncRevision: undefined }
    const [mergedSame, mergedMoved] = mergeSessionCatalog(
      [unchanged, moved],
      [{ ...unchanged, syncRevision: undefined }, movedOnDisk],
      undefined,
      new Map(),
      7,
    )
    expect(mergedSame.syncRevision).toBe(3)
    expect(mergedMoved.syncRevision).toBe(7)
  })
})

describe('cleared-attention store', () => {
  it('guards malformed persisted values, including the null literal', () => {
    expect(readClearedAttention('null')).toEqual({})
    expect(readClearedAttention('[]')).toEqual({})
    expect(readClearedAttention('"waiting:1"')).toEqual({})
    expect(readClearedAttention('not json')).toEqual({})
    expect(readClearedAttention(null)).toEqual({})
    expect(readClearedAttention('{"a":"waiting:1","b":7}')).toEqual({ a: 'waiting:1' })
  })

  it('applies the same malformed-value guards to cleared activity', () => {
    expect(readClearedActivity('null')).toEqual({})
    expect(readClearedActivity('[]')).toEqual({})
    expect(readClearedActivity('not json')).toEqual({})
    expect(readClearedActivity('{"session":"complete:3","bad":false}')).toEqual({ session: 'complete:3' })
  })
})
