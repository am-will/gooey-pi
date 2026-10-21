import { describe, expect, it, vi } from 'vitest'
import { indexStartedSession, sessionTitleFromPrompt, titleStartedSession } from '../../src/hooks/useWorkspaceActions'
import type { PrimeWorkApi, SessionRecord } from '../../src/types/api'

const existing: SessionRecord = {
  id: 'existing', harness: 'prime', filePath: '/sessions/existing.jsonl', projectPath: '/project', title: 'Existing chat',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, unread: false,
}

describe('new session indexing', () => {
  it('force-indexes a newly started session before navigation can hide it', async () => {
    const created: SessionRecord = {
      ...existing,
      id: 'created',
      filePath: '/sessions/created.jsonl',
      title: 'Created chat',
      status: 'running',
    }
    const list = vi.fn(async () => [existing, created])
    let sessions = [existing]
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }

    const indexed = await indexStartedSession({
      bridge: { sessions: { list } } as unknown as PrimeWorkApi,
      harness: 'prime',
      sessionFile: created.filePath,
      setSessions,
    })

    expect(list).toHaveBeenCalledWith(undefined, true, 'prime', true)
    expect(indexed).toEqual(created)
    expect(sessions.map((session) => session.id)).toEqual(['existing', 'created'])
  })

  it('titles a newly accepted prompt immediately and persists it through the harness', async () => {
    const untitled: SessionRecord = {
      ...existing,
      id: 'created',
      filePath: '/sessions/created.jsonl',
      title: 'Untitled session',
      status: 'running',
    }
    const command = vi.fn(async () => ({ type: 'response', command: 'set_session_name', success: true }))
    const list = vi.fn(async () => [existing, untitled])
    let sessions = [existing, untitled]
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }

    await titleStartedSession({
      bridge: { agent: { command }, sessions: { list } } as unknown as PrimeWorkApi,
      harness: 'prime',
      runtimeId: 'runtime-created',
      sessionFile: untitled.filePath,
      prompt: '  Build the sidebar\nright away.  ',
      setSessions,
    })

    expect(command).toHaveBeenCalledWith('runtime-created', { type: 'set_session_name', name: 'Build the sidebar right away.' })
    expect(list).toHaveBeenCalledWith(undefined, true, 'prime', true)
    expect(sessions.find((session) => session.id === 'created')?.title).toBe('Build the sidebar right away.')
  })

  it('keeps an authoritative harness title and treats title persistence as best-effort', async () => {
    const titled: SessionRecord = {
      ...existing,
      id: 'created',
      filePath: '/sessions/created.jsonl',
      title: 'Harness generated title',
      status: 'running',
    }
    const command = vi.fn(async () => { throw new Error('older harness') })
    const list = vi.fn(async () => [existing, titled])
    let sessions: SessionRecord[] = [{ ...titled, title: 'Untitled session' }]
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }

    await expect(titleStartedSession({
      bridge: { agent: { command }, sessions: { list } } as unknown as PrimeWorkApi,
      harness: 'prime',
      runtimeId: 'runtime-created',
      sessionFile: titled.filePath,
      prompt: 'Prompt fallback title',
      setSessions,
    })).resolves.toBeUndefined()

    expect(sessions.find((session) => session.id === 'created')?.title).toBe('Harness generated title')
  })

  it('matches the session catalog title compaction boundary', () => {
    expect(sessionTitleFromPrompt(`  ${'a'.repeat(100)}  `)).toBe('a'.repeat(100))
    expect(sessionTitleFromPrompt(`  ${'a'.repeat(101)}  `)).toBe(`${'a'.repeat(99)}…`)
  })

  it('does not merge a stale catalog after the workspace changes', async () => {
    let resolveList: ((sessions: SessionRecord[]) => void) | undefined
    const list = vi.fn(() => new Promise<SessionRecord[]>((resolve) => { resolveList = resolve }))
    let current = true
    let sessions = [existing]
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }

    const indexing = indexStartedSession({
      bridge: { sessions: { list } } as unknown as PrimeWorkApi,
      harness: 'prime',
      sessionFile: '/sessions/created.jsonl',
      setSessions,
      isCurrent: () => current,
    })
    current = false
    resolveList?.([{ ...existing, id: 'stale', filePath: '/sessions/created.jsonl' }])
    await indexing

    expect(sessions).toEqual([existing])
  })
})

it('keeps a renderer-owned waiting question during explicit session indexing', async () => {
  const waiting: SessionRecord = { ...existing, status: 'waiting', unread: true }
  let current = [waiting]
  const bridge = { sessions: { list: async () => [{ ...waiting, status: 'idle' }] } } as unknown as PrimeWorkApi
  await indexStartedSession({ bridge, harness: 'prime', sessionFile: waiting.filePath, activeSessionFile: () => '/other/session.jsonl', sessionHasOpenExtensionUi: (file) => file === waiting.filePath,
    setSessions: (next) => { current = typeof next === 'function' ? next(current) : next } })
  expect(current[0]).toMatchObject({ status: 'waiting', unread: true })
})
