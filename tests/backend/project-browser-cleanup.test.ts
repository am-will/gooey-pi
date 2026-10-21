import { describe, expect, it, vi } from 'vitest'
import { closeProjectBrowserSessions } from '../../electron/main/browser/project-cleanup'
import type { RuntimeInfo } from '../../src/types/api'

const runtime = (cwd: string, sessionFile?: string): RuntimeInfo => ({ harness: 'omp', runtimeId: cwd, cwd, sessionFile, isStreaming: false })

describe('project browser cleanup', () => {
  it('closes catalog and newly created runtime sessions once, without touching sibling projects', async () => {
    const closeForSession = vi.fn()
    await closeProjectBrowserSessions({ roots: ['/project'], sessions: async () => [
      { filePath: '/sessions/old.jsonl', projectPath: '/project/nested' },
      { filePath: '/sessions/unrelated.jsonl', projectPath: '/project-other' },
    ], runtimes: [runtime('/project', '/sessions/old.jsonl'), runtime('/project/new', '/sessions/new.jsonl'), runtime('/project-other', '/sessions/other.jsonl')], browser: { closeForSession } })
    expect(closeForSession.mock.calls).toEqual([['/sessions/old.jsonl'], ['/sessions/new.jsonl']])
  })

  it('leaves project removal retryable if its session catalog cannot be read', async () => {
    const closeForSession = vi.fn()
    await expect(closeProjectBrowserSessions({ roots: ['/project'], sessions: async () => { throw new Error('catalog failed') }, runtimes: [], browser: { closeForSession } })).rejects.toThrow('catalog failed')
    expect(closeForSession).not.toHaveBeenCalled()
  })
})
