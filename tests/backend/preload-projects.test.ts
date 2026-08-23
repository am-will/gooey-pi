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
    electronMocks.ipcRenderer.invoke.mockResolvedValue(undefined)
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
  it('exposes project script lifecycle calls with harness scoping', async () => {
    const api = electronMocks.api as { projects: {
      updateScripts(id: string, scripts: { setup: string; run: string }, harness?: string): Promise<unknown>
      markSetupStarted(id: string, setup: string, harness?: string): Promise<unknown>
      finishSetup(id: string, setup: string, exitCode: number, harness?: string): Promise<unknown>
    } }
    await api.projects.updateScripts('project-1', { setup: 'npm install', run: 'npm run dev' }, 'omp')
    await api.projects.markSetupStarted('project-1', 'npm install', 'omp')
    await api.projects.finishSetup('project-1', 'npm install', 0, 'omp')
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([
      ['projects:update-scripts', 'project-1', { setup: 'npm install', run: 'npm run dev' }, 'omp'],
      ['projects:mark-setup-started', 'project-1', 'npm install', 'omp'],
      ['projects:finish-setup', 'project-1', 'npm install', 0, 'omp'],
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

  it('unwraps recognized Electron invoke errors while retaining diagnostics and error type', async () => {
    const original = new TypeError("Error invoking remote method 'settings:update': TypeError: Invalid voice URL")
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { settings: { update(patch: unknown): Promise<unknown> } }

    const rejection = api.settings.update({})
    await expect(rejection).rejects.toMatchObject({ message: 'Invalid voice URL' })
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(TypeError)
      expect(error).not.toBe(original)
      expect((error as Error).cause).toBe(original)
    })
    expect(errorSpy).toHaveBeenCalledWith('Electron IPC invocation failed:', original)
    errorSpy.mockRestore()
  })

  it('leaves unrecognized Error messages untouched', async () => {
    const original = new Error("Error invoking remote method 'settings:update': malformed")
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { settings: { update(patch: unknown): Promise<unknown> } }

    await expect(api.settings.update({})).rejects.toBe(original)
  })

  it('leaves non-Error rejections untouched', async () => {
    const original = { reason: 'raw rejection' }
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { settings: { update(patch: unknown): Promise<unknown> } }

    await expect(api.settings.update({})).rejects.toBe(original)
  })
})
