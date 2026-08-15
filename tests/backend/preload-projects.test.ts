import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrimeWorkApi } from '../../src/types/api'

const electronMocks = vi.hoisted(() => ({
  api: undefined as unknown,
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: unknown) => {
      electronMocks.api = api
    }),
  },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))

vi.mock('electron', () => ({ contextBridge: electronMocks.contextBridge, ipcRenderer: electronMocks.ipcRenderer }))

await import('../../electron/preload/index')

describe('preload project worktree bridge', () => {
  beforeEach(() => {
    electronMocks.ipcRenderer.invoke.mockReset()
    electronMocks.ipcRenderer.on.mockReset()
    electronMocks.ipcRenderer.removeListener.mockReset()
    electronMocks.ipcRenderer.send.mockReset()
  })

  it('maps the complete capability surface to fixed IPC channels and argument order', async () => {
    const api = electronMocks.api as PrimeWorkApi
    const timing = { kind: 'once' as const, at: '2030-01-01T00:00:00.000Z' }
    const execution = { model: 'auto' as const, thinking: 'auto' as const, speed: 'normal' as const }
    const target = { kind: 'project' as const, projectId: 'project-one' }
    const opaque = {} as never
    const invocations: Array<{ run: () => Promise<unknown>; expected: unknown[] }> = [
      { run: () => api.app.getMeta(), expected: ['app:get-meta'] },
      { run: () => api.app.refreshHarnesses(), expected: ['app:refresh-harnesses'] },
      { run: () => api.app.openExternal('https://example.test'), expected: ['app:open-external', 'https://example.test'] },
      { run: () => api.app.revealPath('/workspace/file'), expected: ['app:reveal-path', '/workspace/file'] },
      { run: () => api.app.popupMenu('file', 10, 20), expected: ['app:popup-menu', 'file', 10, 20] },
      { run: () => api.app.setTitleBarTheme('dark'), expected: ['app:set-title-bar-theme', 'dark'] },
      { run: () => api.updates.getState(), expected: ['updates:get-state'] },
      { run: () => api.updates.check(), expected: ['updates:check'] },
      { run: () => api.updates.downloadAndInstall(), expected: ['updates:download-and-install'] },
      { run: () => api.projects.list('omp'), expected: ['projects:list', 'omp'] },
      { run: () => api.projects.listFiles('/repo', 'omp'), expected: ['projects:list-files', '/repo', 'omp'] },
      { run: () => api.projects.listWorktrees('/repo', 'omp'), expected: ['projects:list-worktrees', '/repo', 'omp'] },
      { run: () => api.projects.openWorktree('/repo', '/linked', 'omp'), expected: ['projects:open-worktree', '/repo', '/linked', 'omp'] },
      { run: () => api.projects.createWorktree('/repo', 'feature', 'omp'), expected: ['projects:create-worktree', '/repo', 'feature', 'omp'] },
      { run: () => api.projects.add('omp'), expected: ['projects:add', 'omp'] },
      { run: () => api.projects.grantInferred('/repo', 'omp'), expected: ['projects:grant-inferred', '/repo', 'omp'] },
      { run: () => api.projects.remove('project-one', 'omp'), expected: ['projects:remove', 'project-one', 'omp'] },
      { run: () => api.projects.touch('project-one', 'omp'), expected: ['projects:touch', 'project-one', 'omp'] },
      { run: () => api.sessions.list('/repo', true, 'pi', true), expected: ['sessions:list', '/repo', true, 'pi', true] },
      { run: () => api.sessions.read('/sessions/one.jsonl'), expected: ['sessions:read', '/sessions/one.jsonl'] },
      { run: () => api.sessions.followUp('/sessions/one.jsonl', 'continue', 'steer'), expected: ['sessions:follow-up', '/sessions/one.jsonl', 'continue', 'steer'] },
      { run: () => api.sessions.rename('/sessions/one.jsonl', 'Renamed'), expected: ['sessions:rename', '/sessions/one.jsonl', 'Renamed'] },
      { run: () => api.sessions.archive('/sessions/one.jsonl', true), expected: ['sessions:archive', '/sessions/one.jsonl', true] },
      { run: () => api.agent.start({ cwd: '/repo', harness: 'prime' }), expected: ['agent:start', { cwd: '/repo', harness: 'prime' }] },
      { run: () => api.agent.command('runtime-one', { type: 'abort' }), expected: ['agent:command', 'runtime-one', { type: 'abort' }] },
      { run: () => api.agent.stop('runtime-one'), expected: ['agent:stop', 'runtime-one'] },
      { run: () => api.agent.list(), expected: ['agent:list'] },
      { run: () => api.providers.catalog(true, 'pi'), expected: ['providers:catalog', true, 'pi'] },
      { run: () => api.providers.saveApiKey('provider', 'secret'), expected: ['providers:save-api-key', 'provider', 'secret'] },
      { run: () => api.providers.logout('provider'), expected: ['providers:logout', 'provider'] },
      { run: () => api.providers.setEnabled('provider', false, 'omp'), expected: ['providers:set-enabled', 'provider', false, 'omp'] },
      { run: () => api.providers.setDisabled(['one'], 'omp'), expected: ['providers:set-disabled', ['one'], 'omp'] },
      { run: () => api.providers.setModelEnabled('provider/model', false, 'omp'), expected: ['providers:set-model-enabled', 'provider/model', false, 'omp'] },
      { run: () => api.providers.startOAuth('provider'), expected: ['providers:start-oauth', 'provider'] },
      { run: () => api.providers.startMcpOAuth('server', 'omp'), expected: ['providers:start-mcp-oauth', 'server', 'omp'] },
      { run: () => api.providers.logoutMcp('server', 'omp'), expected: ['providers:logout-mcp', 'server', 'omp'] },
      { run: () => api.providers.respondOAuth('flow', 'prompt', 'answer'), expected: ['providers:respond-oauth', 'flow', 'prompt', 'answer'] },
      { run: () => api.providers.cancelOAuth('flow'), expected: ['providers:cancel-oauth', 'flow'] },
      { run: () => api.voice.credentialStatus(), expected: ['voice:credential-status'] },
      { run: () => api.voice.saveApiKey('openai', 'secret'), expected: ['voice:save-api-key', 'openai', 'secret'] },
      { run: () => api.voice.deleteApiKey('openai'), expected: ['voice:delete-api-key', 'openai'] },
      { run: () => api.voice.createRealtimeCall({ mode: 'transcription', sdp: 'offer' }), expected: ['voice:create-realtime-call', { mode: 'transcription', sdp: 'offer' }] },
      { run: () => api.voice.transcribe({ provider: 'openai', audio: new Uint8Array([1]) }), expected: ['voice:transcribe', { provider: 'openai', audio: new Uint8Array([1]) }] },
      { run: () => api.voice.testSelfHosted({ url: 'https://voice.test', model: 'whisper' }), expected: ['voice:test-self-hosted', { url: 'https://voice.test', model: 'whisper' }] },
      { run: () => api.voice.executeTool({ name: 'get_local_context', arguments: {} }, 'pi'), expected: ['voice:execute-tool', { name: 'get_local_context', arguments: {} }, 'pi'] },
      { run: () => api.pets.list(), expected: ['pets:list'] },
      { run: () => api.pets.sprite('gooey-pi'), expected: ['pets:sprite', 'gooey-pi'] },
      { run: () => api.terminal.create({ cwd: '/repo' }), expected: ['terminal:create', { cwd: '/repo' }] },
      { run: () => api.terminal.bindSession('terminal-one', '/sessions/one.jsonl'), expected: ['terminal:bind-session', 'terminal-one', '/sessions/one.jsonl'] },
      { run: () => api.terminal.kill('terminal-one'), expected: ['terminal:kill', 'terminal-one'] },
      { run: () => api.git.status('/repo'), expected: ['git:status', '/repo'] },
      { run: () => api.git.diff('/repo', 'file.ts', true), expected: ['git:diff', '/repo', 'file.ts', true] },
      { run: () => api.git.stage('/repo', ['file.ts']), expected: ['git:stage', '/repo', ['file.ts']] },
      { run: () => api.git.unstage('/repo', ['file.ts']), expected: ['git:unstage', '/repo', ['file.ts']] },
      { run: () => api.git.restore('/repo', ['file.ts']), expected: ['git:restore', '/repo', ['file.ts']] },
      { run: () => api.git.commit('/repo', 'message'), expected: ['git:commit', '/repo', 'message'] },
      { run: () => api.plugins.list('/repo', 'pi'), expected: ['plugins:list', '/repo', 'pi'] },
      { run: () => api.plugins.install('package', 'pi'), expected: ['plugins:install', 'package', 'pi'] },
      { run: () => api.plugins.installExtension(opaque, 'pi'), expected: ['plugins:install-extension', opaque, 'pi'] },
      { run: () => api.plugins.setMcpSupport(true, 'pi'), expected: ['plugins:set-mcp-support', true, 'pi'] },
      { run: () => api.plugins.connectMcp(opaque, 'pi'), expected: ['plugins:connect-mcp', opaque, 'pi'] },
      { run: () => api.plugins.setMcpEnabled(opaque, 'pi'), expected: ['plugins:set-mcp-enabled', opaque, 'pi'] },
      { run: () => api.plugins.mutateCapability(opaque, 'pi'), expected: ['plugins:mutate-capability', opaque, 'pi'] },
      { run: () => api.plugins.refresh('pi'), expected: ['plugins:refresh', 'pi'] },
      { run: () => api.settings.get(), expected: ['settings:get'] },
      { run: () => api.settings.update({ theme: 'dark' }), expected: ['settings:update', { theme: 'dark' }] },
      { run: () => api.settings.resetBrowserData(), expected: ['settings:reset-browser-data'] },
      { run: () => api.browser.state(), expected: ['browser:state'] },
      { run: () => api.browser.attachTab('tab-one', 7), expected: ['browser:attach-tab', 'tab-one', 7] },
      { run: () => api.browser.selectTab('tab-one'), expected: ['browser:select-tab', 'tab-one'] },
      { run: () => api.browser.closeTab('tab-one'), expected: ['browser:close-tab', 'tab-one'] },
      { run: () => api.browser.setPreviewContext(7, '/sessions/one.jsonl'), expected: ['browser:set-preview-context', 7, '/sessions/one.jsonl'] },
      { run: () => api.browser.navigateTab('tab-one', 'url', 'https://example.test'), expected: ['browser:navigate-tab', 'tab-one', 'url', 'https://example.test'] },
      { run: () => api.heartbeats.list(), expected: ['heartbeats:list'] },
      { run: () => api.heartbeats.manage('heartbeat-one', 'pause'), expected: ['heartbeats:manage', 'heartbeat-one', 'pause'] },
      { run: () => api.schedules.list('omp'), expected: ['schedules:list', 'omp'] },
      { run: () => api.schedules.get('task-one'), expected: ['schedules:get', 'task-one'] },
      { run: () => api.schedules.preview(timing, 5), expected: ['schedules:preview', timing, 5] },
      { run: () => api.schedules.create({ prompt: 'run', target, timing, execution }, 'omp'), expected: ['schedules:create', { prompt: 'run', target, timing, execution }, 'omp'] },
      { run: () => api.schedules.update('task-one', { revision: 1, prompt: 'updated' }), expected: ['schedules:update', 'task-one', { revision: 1, prompt: 'updated' }] },
      { run: () => api.schedules.pause('task-one'), expected: ['schedules:pause', 'task-one'] },
      { run: () => api.schedules.resume('task-one'), expected: ['schedules:resume', 'task-one'] },
      { run: () => api.schedules.delete('task-one'), expected: ['schedules:delete', 'task-one'] },
      { run: () => api.schedules.runNow('task-one'), expected: ['schedules:run-now', 'task-one'] },
    ]

    for (const invocation of invocations) await invocation.run()
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual(invocations.map(({ expected }) => expected))

    api.terminal.input('terminal-one', 'input')
    api.terminal.resize('terminal-one', 120, 40)
    api.terminal.setActiveContext('terminal-one', { label: 'terminal', content: 'bounded', truncated: false })
    api.terminal.clearActiveContext('terminal-one')
    expect(electronMocks.ipcRenderer.send.mock.calls).toEqual([
      ['terminal:input', 'terminal-one', 'input'],
      ['terminal:resize', 'terminal-one', 120, 40],
      ['terminal:set-active-context', 'terminal-one', { label: 'terminal', content: 'bounded', truncated: false }],
      ['terminal:clear-active-context', 'terminal-one'],
    ])
  })

  it('filters subscription payloads, unregisters exact listeners, and freezes the exposed surface', () => {
    const api = electronMocks.api as PrimeWorkApi
    const registrations = [
      [api.updates.onChanged, 'updates:changed'],
      [api.sessions.onChanged, 'sessions:changed'],
      [api.agent.onEvent, 'agent:event'],
      [api.providers.onAuthEvent, 'providers:auth-event'],
      [api.terminal.onData, 'terminal:data'],
      [api.terminal.onExit, 'terminal:exit'],
      [api.browser.onChanged, 'browser:changed'],
      [api.browser.onPointer, 'browser:pointer'],
      [api.browser.onActivity, 'browser:activity'],
      [api.schedules.onChanged, 'schedules:changed'],
    ] as const
    const callbacks = registrations.map(() => vi.fn())
    const unsubscribe = registrations.map(([register], index) => (register as unknown as (callback: (payload: object) => void) => () => void)(callbacks[index]))

    expect(electronMocks.ipcRenderer.on.mock.calls.map(([channel]) => channel)).toEqual(registrations.map(([, channel]) => channel))
    for (const [index, call] of electronMocks.ipcRenderer.on.mock.calls.entries()) {
      const listener = call[1] as (_event: unknown, payload: unknown) => void
      listener({}, 'untrusted primitive')
      listener({}, { index })
      expect(callbacks[index]).toHaveBeenCalledOnce()
      expect(callbacks[index]).toHaveBeenCalledWith({ index })
      unsubscribe[index]()
    }
    expect(electronMocks.ipcRenderer.removeListener.mock.calls).toEqual(electronMocks.ipcRenderer.on.mock.calls)
    expect(() => (api.updates.onChanged as unknown as (callback: unknown) => void)(null)).toThrow(/callback must be a function/)
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.values(api).every(Object.isFrozen)).toBe(true)
  })

  it('exposes fixed worktree IPC calls with the harness in the final argument', async () => {
    const api = electronMocks.api as {
      projects: {
        listWorktrees(cwd: string, harness?: string): Promise<unknown>
        openWorktree(cwd: string, path: string, harness?: string): Promise<unknown>
        createWorktree(cwd: string, branch: string, harness?: string): Promise<unknown>
      }
    }
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
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([['pets:list'], ['pets:sprite', 'gooey-pi']])
  })

  it('exposes update status, check, and consented download-and-install calls', async () => {
    const api = electronMocks.api as { updates: { getState(): Promise<unknown>; check(): Promise<unknown>; downloadAndInstall(): Promise<unknown> } }
    await api.updates.getState()
    await api.updates.check()
    await api.updates.downloadAndInstall()
    expect(electronMocks.ipcRenderer.invoke.mock.calls).toEqual([['updates:get-state'], ['updates:check'], ['updates:download-and-install']])
  })
})
