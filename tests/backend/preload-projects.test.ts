import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  api: undefined as unknown,
  contextBridge: { exposeInMainWorld: vi.fn((_name: string, api: unknown) => { electronMocks.api = api }) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))

vi.mock('electron', () => ({ contextBridge: electronMocks.contextBridge, ipcRenderer: electronMocks.ipcRenderer }))

await import('../../electron/preload/index')

describe('preload project worktree bridge', () => {
  beforeEach(() => {
    electronMocks.ipcRenderer.invoke.mockReset()
    electronMocks.ipcRenderer.on.mockReset()
    electronMocks.ipcRenderer.removeListener.mockReset()
  })

  it('exposes the main-process Settings signal with a removable listener', () => {
    const api = electronMocks.api as { app: { onOpenSettings(callback: () => void): () => void } }
    const callback = vi.fn()
    const unsubscribe = api.app.onOpenSettings(callback)
    const listener = electronMocks.ipcRenderer.on.mock.calls[0]?.[1] as (() => void) | undefined

    expect(electronMocks.ipcRenderer.on).toHaveBeenCalledWith('app:open-settings', expect.any(Function))
    listener?.()
    expect(callback).toHaveBeenCalledOnce()
    unsubscribe()
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith('app:open-settings', listener)
  })

  it('exposes fixed worktree IPC calls with the harness in the final argument', async () => {
    const api = electronMocks.api as { projects: {
      listWorktrees(cwd: string, harness?: string): Promise<unknown>
      openWorktree(cwd: string, path: string, harness?: string): Promise<unknown>
      createWorktree(cwd: string, branch: string, harness?: string): Promise<unknown>
    } }
    await api.projects.listWorktrees('/repo', 'omp')
    await api.projects.openWorktree('/repo', '/linked', 'omp')
    await api.projects.createWorktree('/repo', 'feature', 'omp')
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['projects:list-worktrees', '/repo', 'omp'],
      ['projects:open-worktree', '/repo', '/linked', 'omp'],
      ['projects:create-worktree', '/repo', 'feature', 'omp'],
    ])
  })

  it('exposes fixed read-only pet IPC calls', async () => {
    const api = electronMocks.api as { pets: { list(): Promise<unknown>; sprite(id: string): Promise<unknown> } }
    await api.pets.list()
    await api.pets.sprite('gooey-pi')
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['pets:list'],
      ['pets:sprite', 'gooey-pi'],
    ])
  })

  it('exposes update status, check, and consented download-and-install calls', async () => {
    const api = electronMocks.api as { updates: { getState(): Promise<unknown>; check(): Promise<unknown>; downloadAndInstall(): Promise<unknown> } }
    await api.updates.getState()
    await api.updates.check()
    await api.updates.downloadAndInstall()
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['updates:get-state'],
      ['updates:check'],
      ['updates:download-and-install'],
    ])
  })
})
