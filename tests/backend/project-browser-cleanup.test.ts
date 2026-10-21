import { describe, expect, it, vi } from 'vitest'
import { stopProjectResources } from '../../electron/main/browser/project-cleanup'
import type { RuntimeInfo } from '../../src/types/api'

const runtime = (cwd: string, sessionFile?: string): RuntimeInfo => ({ harness: 'omp', runtimeId: cwd, cwd, sessionFile, isStreaming: false })

describe('project browser cleanup', () => {
  it('closes catalog and newly created runtime sessions once, without touching sibling projects', async () => {
    const closeForSession = vi.fn()
    await stopProjectResources({ stopProcesses: async () => undefined, roots: ['/project'], sessions: async () => [
      { filePath: '/sessions/old.jsonl', projectPath: '/project/nested' },
      { filePath: '/sessions/unrelated.jsonl', projectPath: '/project-other' },
    ], runtimes: [runtime('/project', '/sessions/old.jsonl'), runtime('/project/new', '/sessions/new.jsonl'), runtime('/project-other', '/sessions/other.jsonl')], browser: { closeForSession } })
    expect(closeForSession.mock.calls).toEqual([['/sessions/old.jsonl'], ['/sessions/new.jsonl']])
  })

  it('releases a browser guest created while its runtime is stopping', async () => {
    const guests = new Set(['/sessions/old.jsonl'])
    await stopProjectResources({ roots: ['/project'], runtimes: [runtime('/project', '/sessions/new.jsonl')],
      stopProcesses: async () => { await Promise.resolve(); guests.add('/sessions/new.jsonl') },
      sessions: async () => [{ filePath: '/sessions/old.jsonl', projectPath: '/project' }],
      browser: { closeForSession: (file) => guests.delete(String(file)) },
    })
    expect([...guests]).toEqual([])
  })

  it('still stops processes when no browser service is available', async () => {
    const stopProcesses = vi.fn(async () => undefined)
    const sessions = vi.fn(async () => [])
    await stopProjectResources({ roots: ['/project'], runtimes: [], stopProcesses, sessions, browser: null })
    expect(stopProcesses).toHaveBeenCalledOnce()
    expect(sessions).not.toHaveBeenCalled()
  })

  it('leaves project removal retryable if its session catalog cannot be read', async () => {
    const closeForSession = vi.fn()
    await expect(stopProjectResources({ stopProcesses: async () => undefined, roots: ['/project'], sessions: async () => { throw new Error('catalog failed') }, runtimes: [], browser: { closeForSession } })).rejects.toThrow('catalog failed')
    expect(closeForSession).not.toHaveBeenCalled()
  })
})
