// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionAttention } from '../../src/hooks/useSessionAttention'
import { useGitStatus } from '../../src/hooks/useGitStatus'
import { useCheckoutCatalog } from '../../src/hooks/useCheckoutCatalog'
import { CLEARED_ACTIVITY_STORAGE_KEY, CLEARED_ATTENTION_STORAGE_KEY, signatureCleared, sessionAttentionSignature } from '../../src/app/session-attention'
import type { CheckoutCatalog, GitStatus, PrimeWorkApi, ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const project: ProjectRecord = { id: 'project', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false, createdAt: '2026-01-01', lastOpenedAt: '2026-01-01', sessionCount: 1 }
const session: SessionRecord = { id: 'session', harness: 'omp', projectPath: '/project', filePath: '/sessions/s.jsonl', title: 'Session', status: 'complete', unread: true, depth: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('owns activity dismissal, unread updates, and persisted companion clears', async () => {
  let attention!: ReturnType<typeof useSessionAttention>
  let sessions: SessionRecord[] = []
  function Probe() {
    const [items, setSessions] = useState([session, { ...session, id: 'other' }])
    sessions = items
    attention = useSessionAttention({ setSessions })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { attention.clearActivity([session]) })
  expect(sessions.map((item) => item.unread)).toEqual([false, true])
  expect(signatureCleared(sessionAttentionSignature(session), attention.clearedAttention.session, true, session.updatedAt)).toBe(true)
  expect(JSON.parse(localStorage.getItem(CLEARED_ACTIVITY_STORAGE_KEY)!)).toEqual(attention.clearedActivity)
  expect(JSON.parse(localStorage.getItem(CLEARED_ATTENTION_STORAGE_KEY)!)).toEqual(attention.clearedAttention)
  const previous = attention.clearedAttention
  await act(async () => { attention.clearSessionAttention(session) })
  expect(attention.clearedAttention).toBe(previous)
})

it('keeps dismissal usable when storage reads and writes are denied', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  let attention!: ReturnType<typeof useSessionAttention>
  function Probe() { const [, setSessions] = useState<SessionRecord[]>([]); attention = useSessionAttention({ setSessions }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { attention.clearSessionAttention(session) })
  expect(attention.clearedAttention.session).toBeDefined()
})

it('preserves caller-owned demo Git status without a bridge', async () => {
  const status: GitStatus = { isRepo: true, branch: 'demo', files: [] }
  const workspaceRef = { current: { cwd: '/project', generation: 0 } }
  let git!: ReturnType<typeof useGitStatus>
  const reportError = vi.fn()
  function Probe() { git = useGitStatus({ bridge: null, cwd: '/project', workspaceRef, initialSnapshot: { cwd: '/project', status }, locallyOwnedSession: false, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { await git.refreshGit() })
  expect(git.git).toBe(status)
})

it('rejects stale Git results and errors after the workspace generation changes', async () => {
  const first = deferred<GitStatus>()
  const second = deferred<GitStatus>()
  const status = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const bridge = { git: { status } } as unknown as PrimeWorkApi
  const workspaceRef = { current: { cwd: '/project', generation: 0 } }
  const reportError = vi.fn()
  let git!: ReturnType<typeof useGitStatus>
  function Probe() { git = useGitStatus({ bridge, cwd: '/project', workspaceRef, locallyOwnedSession: false, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  workspaceRef.current = { cwd: '/project', generation: 1 }
  await act(async () => { first.resolve({ isRepo: true, branch: 'old', files: [] }); await first.promise })
  expect(git.git.isRepo).toBe(false)
  let refresh!: Promise<void>
  await act(async () => { refresh = git.refreshGit() })
  workspaceRef.current = { cwd: '/project', generation: 2 }
  await act(async () => { second.reject(new Error('old error')); await refresh })
  expect(reportError).not.toHaveBeenCalled()
})

it('refreshes Git on an external running-to-idle transition without catalog-tick churn', async () => {
  const status = vi.fn(async () => ({ isRepo: true, files: [] }))
  const bridge = { git: { status } } as unknown as PrimeWorkApi
  const workspaceRef = { current: { cwd: '/project', generation: 0 } }
  const reportError = vi.fn()
  let sessionStatus: SessionRecord['status'] = 'running'
  function Probe() { useGitStatus({ bridge, cwd: '/project', workspaceRef, sessionStatus, locallyOwnedSession: false, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { root.render(<Probe />) })
  expect(status).toHaveBeenCalledTimes(1)
  sessionStatus = 'idle'
  await act(async () => { root.render(<Probe />) })
  expect(status).toHaveBeenCalledTimes(2)
})

it('keeps the current checkout request and reloads for strategy and harness changes', async () => {
  const stale = deferred<CheckoutCatalog>()
  const catalog: CheckoutCatalog = { strategy: 'worktree', activePath: project.path, checkouts: [] }
  const list = vi.fn().mockImplementationOnce(() => stale.promise).mockResolvedValue(catalog)
  const bridge = { projects: { listCheckouts: list } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let activeProject = project
  let strategy: 'worktree' | 'branch' = 'worktree'
  let checkouts!: ReturnType<typeof useCheckoutCatalog>
  function Probe() { checkouts = useCheckoutCatalog({ bridge, project: activeProject, checkoutStrategy: strategy, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  activeProject = { ...project, harness: 'pi' }
  await act(async () => { root.render(<Probe />) })
  expect(list).toHaveBeenLastCalledWith(project.id, 'pi')
  await act(async () => { stale.reject(new Error('old harness')); await stale.promise.catch(() => undefined) })
  expect(checkouts.checkoutCatalog).toBe(catalog)
  expect(checkouts.checkoutsLoading).toBe(false)
  expect(reportError).not.toHaveBeenCalled()
  strategy = 'branch'
  await act(async () => { root.render(<Probe />) })
  expect(list).toHaveBeenCalledTimes(3)
})

it('reports a current Git failure through the latest error callback without another fetch', async () => {
  const pending = deferred<GitStatus>()
  const status = vi.fn(() => pending.promise)
  const bridge = { git: { status } } as unknown as PrimeWorkApi
  const workspaceRef = { current: { cwd: '/project', generation: 0 } }
  const first = vi.fn()
  const latest = vi.fn()
  let reportError = first
  function Probe() { useGitStatus({ bridge, cwd: '/project', workspaceRef, locallyOwnedSession: false, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  reportError = latest
  await act(async () => { root.render(<Probe />) })
  const failure = new Error('Git unavailable')
  await act(async () => { pending.reject(failure); await pending.promise.catch(() => undefined) })
  expect(status).toHaveBeenCalledTimes(1)
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledExactlyOnceWith(failure)
})

it.each([undefined, { ...project, inferred: true }])('does not enumerate checkouts without an explicit project grant', async (project) => {
  const listCheckouts = vi.fn()
  const bridge = { projects: { listCheckouts } } as unknown as PrimeWorkApi
  let checkouts!: ReturnType<typeof useCheckoutCatalog>
  const reportError = vi.fn()
  function Probe() { checkouts = useCheckoutCatalog({ bridge, project, checkoutStrategy: 'worktree', reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  expect(listCheckouts).not.toHaveBeenCalled()
  expect(checkouts.checkoutCatalog).toBeUndefined()
  expect(checkouts.checkoutsLoading).toBe(false)
})

it('replaces an invalidated initial Git request when a new session keeps the same cwd', async () => {
  const first = deferred<GitStatus>()
  const replacement = deferred<GitStatus>()
  const status = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => replacement.promise)
  const bridge = { git: { status } } as unknown as PrimeWorkApi
  const workspaceRef = { current: { cwd: '/project', generation: 0 } }
  const reportError = vi.fn()
  let git!: ReturnType<typeof useGitStatus>
  function Probe() {
    const options = { bridge, cwd: '/project', workspaceRef, workspaceGeneration: workspaceRef.current.generation, locallyOwnedSession: false, reportError }
    git = useGitStatus(options)
    return null
  }
  await act(async () => { root.render(<Probe />) })
  expect(status).toHaveBeenCalledTimes(1)
  workspaceRef.current = { cwd: '/project', generation: 1 }
  await act(async () => { root.render(<Probe />) })
  expect(status).toHaveBeenCalledTimes(2)
  await act(async () => { first.resolve({ isRepo: true, branch: 'stale', files: [] }); await first.promise })
  expect(git.git.isRepo).toBe(false)
  const current: GitStatus = { isRepo: true, branch: 'current', files: [{ path: 'changed.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }
  await act(async () => { replacement.resolve(current); await replacement.promise })
  expect(git.git).toBe(current)
  expect(reportError).not.toHaveBeenCalled()
})
