import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  api: undefined as unknown,
  contextBridge: { exposeInMainWorld: vi.fn((_name: string, api: unknown) => { electronMocks.api = api }) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))

vi.mock('electron', () => ({ contextBridge: electronMocks.contextBridge, ipcRenderer: electronMocks.ipcRenderer }))

await import('../../electron/preload/index')

type BridgeApi = Record<string, Record<string, (...args: unknown[]) => unknown>>

const INVOKE_CASES: Array<[domain: string, method: string, channel: string, args: unknown[]]> = [
  ['app', 'getMeta', 'app:get-meta', []],
  ['app', 'refreshHarnesses', 'app:refresh-harnesses', []],
  ['app', 'openExternal', 'app:open-external', ['https://example.com']],
  ['app', 'revealPath', 'app:reveal-path', ['/repo/file']],
  ['app', 'popupMenu', 'app:popup-menu', ['file', 10, 20]],
  ['app', 'setTitleBarTheme', 'app:set-title-bar-theme', ['dark']],
  ['updates', 'getState', 'updates:get-state', []],
  ['updates', 'check', 'updates:check', []],
  ['updates', 'downloadAndInstall', 'updates:download-and-install', []],
  ['projects', 'list', 'projects:list', ['omp']],
  ['projects', 'listFiles', 'projects:list-files', ['/repo', 'omp']],
  ['projects', 'listWorktrees', 'projects:list-worktrees', ['/repo', 'omp']],
  ['projects', 'openWorktree', 'projects:open-worktree', ['/repo', '/linked', 'omp']],
  ['projects', 'createWorktree', 'projects:create-worktree', ['/repo', 'feature', 'omp']],
  ['projects', 'add', 'projects:add', ['omp']],
  ['projects', 'grantInferred', 'projects:grant-inferred', ['/repo', 'omp']],
  ['projects', 'remove', 'projects:remove', ['project-id', 'omp']],
  ['projects', 'touch', 'projects:touch', ['project-id', 'omp']],
  ['projects', 'updateScripts', 'projects:update-scripts', ['project-id', { setup: 'npm install', run: 'npm run dev' }, 'omp']],
  ['projects', 'markSetupStarted', 'projects:mark-setup-started', ['project-id', 'npm install', 'omp']],
  ['projects', 'finishSetup', 'projects:finish-setup', ['project-id', 'npm install', 0, 'omp']],
  ['sessions', 'list', 'sessions:list', ['/repo', true, 'omp', true]],
  ['sessions', 'read', 'sessions:read', ['/session.jsonl']],
  ['sessions', 'followUp', 'sessions:follow-up', ['/session.jsonl', 'next', 'queue']],
  ['sessions', 'rename', 'sessions:rename', ['/session.jsonl', 'Title']],
  ['sessions', 'archive', 'sessions:archive', ['/session.jsonl', true]],
  ['agent', 'start', 'agent:start', [{ cwd: '/repo' }]],
  ['agent', 'command', 'agent:command', ['runtime', { type: 'abort' }]],
  ['agent', 'stop', 'agent:stop', ['runtime']],
  ['agent', 'list', 'agent:list', []],
  ['providers', 'catalog', 'providers:catalog', [true, 'omp']],
  ['providers', 'saveApiKey', 'providers:save-api-key', ['openai', 'secret']],
  ['providers', 'logout', 'providers:logout', ['openai']],
  ['providers', 'setEnabled', 'providers:set-enabled', ['openai', false, 'omp']],
  ['providers', 'setDisabled', 'providers:set-disabled', [['openai'], 'omp']],
  ['providers', 'setModelEnabled', 'providers:set-model-enabled', ['openai/model', true, 'omp']],
  ['providers', 'startOAuth', 'providers:start-oauth', ['openai']],
  ['providers', 'respondOAuth', 'providers:respond-oauth', ['flow', 'prompt', 'value']],
  ['providers', 'cancelOAuth', 'providers:cancel-oauth', ['flow']],
  ['voice', 'credentialStatus', 'voice:credential-status', []],
  ['voice', 'saveApiKey', 'voice:save-api-key', ['openai', 'secret']],
  ['voice', 'deleteApiKey', 'voice:delete-api-key', ['openai']],
  ['voice', 'createRealtimeCall', 'voice:create-realtime-call', [{ mode: 'transcription', sdp: 'sdp' }]],
  ['voice', 'cancelRealtimeCall', 'voice:cancel-realtime-call', ['setup-id']],
  ['voice', 'transcribe', 'voice:transcribe', [{ provider: 'openai', audioBase64: 'audio' }]],
  ['voice', 'testSelfHosted', 'voice:test-self-hosted', [{ url: 'https://voice.example' }]],
  ['voice', 'executeTool', 'voice:execute-tool', [{ name: 'list_projects', arguments: {} }, 'omp']],
  ['pets', 'list', 'pets:list', []],
  ['pets', 'sprite', 'pets:sprite', ['gooey-pi']],
  ['terminal', 'create', 'terminal:create', [{ cwd: '/repo' }]],
  ['terminal', 'bindSession', 'terminal:bind-session', ['terminal', '/session.jsonl']],
  ['terminal', 'kill', 'terminal:kill', ['terminal']],
  ['git', 'status', 'git:status', ['/repo']],
  ['git', 'diff', 'git:diff', ['/repo', 'file.ts', true]],
  ['git', 'stage', 'git:stage', ['/repo', ['file.ts']]],
  ['git', 'unstage', 'git:unstage', ['/repo', ['file.ts']]],
  ['git', 'restore', 'git:restore', ['/repo', ['file.ts']]],
  ['git', 'commit', 'git:commit', ['/repo', 'message']],
  ['plugins', 'list', 'plugins:list', ['/repo', 'omp']],
  ['plugins', 'install', 'plugins:install', ['npm:example', 'omp']],
  ['plugins', 'installExtension', 'plugins:install-extension', [{ source: '/extension.ts', scope: 'user' }, 'omp']],
  ['plugins', 'setMcpSupport', 'plugins:set-mcp-support', [true, 'pi']],
  ['plugins', 'connectMcp', 'plugins:connect-mcp', [{ name: 'docs' }, 'omp']],
  ['plugins', 'setMcpEnabled', 'plugins:set-mcp-enabled', [{ name: 'docs', enabled: true }, 'omp']],
  ['plugins', 'mutateCapability', 'plugins:mutate-capability', [{ kind: 'mcp', action: 'remove' }, 'omp']],
  ['plugins', 'refresh', 'plugins:refresh', ['omp']],
  ['settings', 'get', 'settings:get', []],
  ['settings', 'update', 'settings:update', [{ theme: 'dark' }]],
  ['settings', 'resetBrowserData', 'settings:reset-browser-data', []],
  ['browser', 'state', 'browser:state', []],
  ['browser', 'attachTab', 'browser:attach-tab', ['tab', 7]],
  ['browser', 'selectTab', 'browser:select-tab', ['tab']],
  ['browser', 'closeTab', 'browser:close-tab', ['tab']],
  ['browser', 'setPreviewContext', 'browser:set-preview-context', [7, '/session.jsonl']],
  ['browser', 'navigateTab', 'browser:navigate-tab', ['tab', 'navigate', 'https://example.com']],
  ['heartbeats', 'list', 'heartbeats:list', []],
  ['heartbeats', 'manage', 'heartbeats:manage', ['heartbeat', 'pause']],
  ['schedules', 'list', 'schedules:list', ['omp']],
  ['schedules', 'get', 'schedules:get', ['schedule']],
  ['schedules', 'preview', 'schedules:preview', [{ kind: 'once', at: '2026-08-26T00:00:00Z' }, 3]],
  ['schedules', 'create', 'schedules:create', [{ prompt: 'work' }, 'omp']],
  ['schedules', 'update', 'schedules:update', ['schedule', { title: 'Updated' }]],
  ['schedules', 'pause', 'schedules:pause', ['schedule']],
  ['schedules', 'resume', 'schedules:resume', ['schedule']],
  ['schedules', 'delete', 'schedules:delete', ['schedule']],
  ['schedules', 'runNow', 'schedules:run-now', ['schedule']],
]

const SUBSCRIPTION_CASES: Array<[domain: string, method: string, channel: string]> = [
  ['updates', 'onChanged', 'updates:changed'],
  ['sessions', 'onChanged', 'sessions:changed'],
  ['agent', 'onEvent', 'agent:event'],
  ['providers', 'onAuthEvent', 'providers:auth-event'],
  ['terminal', 'onData', 'terminal:data'],
  ['terminal', 'onExit', 'terminal:exit'],
  ['browser', 'onChanged', 'browser:changed'],
  ['browser', 'onPointer', 'browser:pointer'],
  ['browser', 'onActivity', 'browser:activity'],
  ['schedules', 'onChanged', 'schedules:changed'],
]

describe('preload bridge contract', () => {
  beforeEach(() => {
    electronMocks.ipcRenderer.invoke.mockReset()
    electronMocks.ipcRenderer.invoke.mockResolvedValue(undefined)
    electronMocks.ipcRenderer.on.mockReset()
    electronMocks.ipcRenderer.removeListener.mockReset()
    electronMocks.ipcRenderer.send.mockReset()
  })

  it('exposes the main-process Settings signal with a removable listener', () => {
    const api = electronMocks.api as { app: { onOpenSettings(callback: () => void): () => void } }
    expect(() => (api.app.onOpenSettings as unknown as (callback: unknown) => unknown)(undefined)).toThrow('callback must be a function')
    const callback = vi.fn()
    const unsubscribe = api.app.onOpenSettings(callback)
    const listener = electronMocks.ipcRenderer.on.mock.calls[0]?.[1] as (() => void) | undefined

    expect(electronMocks.ipcRenderer.on).toHaveBeenCalledWith('app:open-settings', expect.any(Function))
    listener?.()
    expect(callback).toHaveBeenCalledOnce()
    unsubscribe()
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith('app:open-settings', listener)
  })

  it('freezes the exposed API and every domain', () => {
    const api = electronMocks.api as BridgeApi
    expect(electronMocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('prime', api)
    expect(Object.isFrozen(api)).toBe(true)
    for (const domain of Object.values(api)) expect(Object.isFrozen(domain)).toBe(true)
  })

  it.each(INVOKE_CASES)('routes %s.%s through fixed channel %s', async (domain, method, channel, args) => {
    const api = electronMocks.api as BridgeApi
    await api[domain][method](...args)
    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
  })

  it.each([
    ['input', 'terminal:input', ['terminal', 'text']],
    ['resize', 'terminal:resize', ['terminal', 120, 40]],
    ['setActiveContext', 'terminal:set-active-context', ['terminal', { label: 'shell', content: 'output' }]],
    ['clearActiveContext', 'terminal:clear-active-context', ['terminal']],
  ] as const)('sends terminal.%s through fixed channel %s', (method, channel, args) => {
    const api = electronMocks.api as BridgeApi
    api.terminal[method](...args)
    expect(electronMocks.ipcRenderer.send).toHaveBeenCalledWith(channel, ...args)
  })

  it.each(SUBSCRIPTION_CASES)('validates and filters %s.%s payloads', (domain, method, channel) => {
    const api = electronMocks.api as BridgeApi
    const callback = vi.fn()
    expect(() => api[domain][method](undefined)).toThrow('callback must be a function')
    const unsubscribe = api[domain][method](callback) as () => void
    const listener = electronMocks.ipcRenderer.on.mock.calls.at(-1)?.[1] as ((event: unknown, payload: unknown) => void)
    const payload = { ok: true }

    expect(electronMocks.ipcRenderer.on).toHaveBeenLastCalledWith(channel, listener)
    listener({}, payload)
    listener({}, 'ignored')
    listener({}, null)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)
  })


  it('unwraps recognized Electron invoke errors while retaining diagnostics and error type', async () => {
    const original = new TypeError("Error invoking remote method 'voice:transcribe': TypeError: Invalid voice URL")
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { voice: { transcribe(request: unknown): Promise<unknown> } }

    const rejection = api.voice.transcribe({})
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
