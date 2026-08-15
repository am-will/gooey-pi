import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

vi.mock('electron', () => electronMocks)

import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'

const EXPECTED_URL = 'prime-work://app/'
const PRIME_SESSION = '/home/user/.prime/agent/sessions/session.jsonl'
const OMP_SESSION = '/home/user/.omp/agent/sessions/bucket/session.jsonl'
const PI_SESSION = '/home/user/.pi/agent/sessions/--home-user-project--/session.jsonl'

function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

interface Harness {
  invoke(channel: string, ...args: unknown[]): unknown
  services: ReturnType<typeof buildServices>
  registration: IpcRegistration
}

function buildServices() {
  const settingsState = { disabledProviders: ['blocked'], disabledModels: [], ompDisabledProviders: ['anthropic'], ompDisabledModels: [], piDisabledProviders: ['anthropic'], piDisabledModels: [] }
  const catalog = (from: string, disabled: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()) => {
    const models = [
      { key: 'anthropic/claude', provider: 'anthropic', id: 'claude' },
      { key: 'openai/gpt', provider: 'openai', id: 'gpt' },
    ]
    const providerEnabled = (id: string) => !disabled.has(id) && models.some((model) => model.provider === id && !disabledModels.has(model.key))
    return {
      from,
      models: models.map((model) => ({ ...model, enabled: providerEnabled(model.provider) && !disabledModels.has(model.key) })),
      providers: ['anthropic', 'openai'].map((id) => ({ id, enabled: providerEnabled(id) })),
    }
  }
  const sessionGate = (accepted: string) => vi.fn(async (path: unknown) => {
    if (path === accepted) return path
    throw new TypeError('Session path is outside the Prime session directory')
  })
  const harnessSet = (name: string, session: string) => ({
    plugins: { ...serviceStub(), list: vi.fn(async () => `${name}-plugins`), install: vi.fn(async () => undefined), installExtension: vi.fn(async () => undefined), setMcpSupport: vi.fn(async () => undefined), connectMcp: vi.fn(async () => undefined), refresh: vi.fn(async () => `${name}-plugins`) },
    projects: { ...serviceStub(), list: vi.fn(async () => [`${name}-projects`]), listWorktrees: vi.fn(async () => [`${name}-worktrees`]), openWorktree: vi.fn(async () => `${name}-open`), createWorktree: vi.fn(async () => `${name}-create`), grantInferred: vi.fn(async () => `${name}-grant`) },
    sessions: {
      ...serviceStub(),
      onDidChange: vi.fn(() => () => undefined),
      requireSessionPath: sessionGate(session),
      list: vi.fn(async () => [`${name}-sessions`]),
      read: vi.fn(async () => [`${name}-transcript`]),
      followUp: vi.fn(async () => true),
      rename: vi.fn(async () => false),
      archive: vi.fn(async () => true),
    },
    agents: {
      ...serviceStub(),
      has: vi.fn((id: string) => id === `${name}-runtime`),
      start: vi.fn(async (options: unknown) => ({ started: name, options })),
      command: vi.fn(async () => ({ ok: name })),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: `${name}-runtime`, harness: name }]),
    },
    catalog: {
      catalog: vi.fn(async (_force, disabled, disabledModels) => catalog(name, disabled, disabledModels)),
    },
  })
  return {
    meta: { version: '0.0.0-test' },
    projects: { ...serviceStub(), list: vi.fn(async () => ['prime-projects']), grantInferred: vi.fn(async () => 'prime-grant') },
    sessions: {
      ...serviceStub(),
      onDidChange: vi.fn(() => () => undefined),
      requireSessionPath: sessionGate(PRIME_SESSION),
      list: vi.fn(async () => ['prime-sessions']),
      read: vi.fn(async () => ['prime-transcript']),
      followUp: vi.fn(async () => true),
      rename: vi.fn(async () => true),
      archive: vi.fn(async () => true),
    },
    agents: {
      ...serviceStub(),
      has: vi.fn((id: string) => id === 'prime-runtime'),
      start: vi.fn(async (options: unknown) => ({ started: 'prime', options })),
      command: vi.fn(async () => ({ ok: 'prime' })),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: 'prime-runtime', harness: 'prime' }]),
    },
    terminals: { ...serviceStub(), killForSession: vi.fn(async () => undefined) },
    git: serviceStub(),
    plugins: { ...serviceStub(), list: vi.fn(async () => 'prime-plugins') },
    providers: { ...serviceStub(), catalog: vi.fn(async (_force, disabled, disabledModels) => catalog('prime', disabled, disabledModels)), saveApiKey: vi.fn(async () => undefined) },
    settings: {
      ...serviceStub(),
      get: vi.fn(() => settingsState),
      update: vi.fn(async (patch: Partial<typeof settingsState>) => { Object.assign(settingsState, patch); return settingsState }),
    },
    heartbeats: serviceStub(),
    schedules: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), list: vi.fn(() => 'scheduled'), create: vi.fn(async () => 'created') },
    browser: { ...serviceStub(), closeForSession: vi.fn(() => true), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
    omp: harnessSet('omp', OMP_SESSION),
    pi: harnessSet('pi', PI_SESSION),
  }
}

describe('pi harness IPC routing', () => {
  let harness: Harness

  beforeEach(() => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    electronMocks.ipcMain.handle.mockReset()
    electronMocks.ipcMain.on.mockReset()
    electronMocks.ipcMain.handle.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    })
    const services = buildServices()
    const registration = registerIpc(services as never, EXPECTED_URL)
    const mainFrame = { url: EXPECTED_URL }
    const sender = { id: 1, isDestroyed: () => false, getURL: () => EXPECTED_URL, mainFrame }
    registration.authorize(sender as never)
    const event = { sender, senderFrame: mainFrame }
    harness = {
      invoke: (channel, ...args) => handlers.get(channel)!(event, ...args),
      services,
      registration,
    }
  })

  afterEach(() => { harness.registration.dispose() })

  it('accepts pi through the strict harness enum and still rejects junk', async () => {
    await expect(harness.invoke('projects:list', 'pi')).resolves.toEqual(['pi-projects'])
    await expect(async () => harness.invoke('projects:list', 'Pi')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('projects:list', 'codex')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'PI')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('agent:start', { cwd: '/tmp', harness: ['pi'] })).rejects.toThrow('Invalid harness')
    expect(harness.services.pi.agents.start).not.toHaveBeenCalled()
  })

  it('routes projects, sessions, and plugins channels to the pi services', async () => {
    await expect(harness.invoke('sessions:list', undefined, false, 'pi')).resolves.toEqual(['pi-sessions'])
    await expect(harness.invoke('projects:grant-inferred', '/somewhere', 'pi')).resolves.toBe('pi-grant')
    expect(harness.services.pi.projects.grantInferred).toHaveBeenCalledWith('/somewhere')
    expect(harness.services.projects.grantInferred).not.toHaveBeenCalled()
    await harness.invoke('plugins:list', '/repo', 'pi')
    expect(harness.services.pi.plugins.list).toHaveBeenCalledWith('/repo')
    await harness.invoke('plugins:install', 'npm:example', 'pi')
    expect(harness.services.pi.plugins.install).toHaveBeenCalledWith('npm:example')
    await harness.invoke('plugins:install-extension', { source: '/tmp/example.ts', scope: 'user' }, 'pi')
    expect(harness.services.pi.plugins.installExtension).toHaveBeenCalledWith({ source: '/tmp/example.ts', scope: 'user' })
    await harness.invoke('plugins:set-mcp-support', true, 'pi')
    expect(harness.services.pi.plugins.setMcpSupport).toHaveBeenCalledWith(true)
    await harness.invoke('plugins:connect-mcp', { name: 'docs' }, 'pi')
    expect(harness.services.pi.plugins.connectMcp).toHaveBeenCalledWith({ name: 'docs' })
    await harness.invoke('plugins:refresh', 'pi')
    expect(harness.services.pi.plugins.refresh).toHaveBeenCalledOnce()
  })

  it('routes agent:start to the pi manager and strips the routing field', async () => {
    await expect(harness.invoke('agent:start', { cwd: '/work', harness: 'pi' })).resolves.toEqual({ started: 'pi', options: { cwd: '/work' } })
    expect(harness.services.pi.agents.start).toHaveBeenCalledWith({ cwd: '/work' })
    expect(harness.services.agents.start).not.toHaveBeenCalled()
    expect(harness.services.omp.agents.start).not.toHaveBeenCalled()
  })

  it('routes agent:command and agent:stop by pi runtime ownership', async () => {
    await expect(harness.invoke('agent:command', 'pi-runtime', { type: 'abort' })).resolves.toEqual({ ok: 'pi' })
    expect(harness.services.pi.agents.command).toHaveBeenCalledWith('pi-runtime', { type: 'abort' })
    expect(harness.services.agents.command).not.toHaveBeenCalled()
    await expect(harness.invoke('agent:stop', 'pi-runtime')).resolves.toBe(true)
    expect(harness.services.pi.agents.stop).toHaveBeenCalledWith('pi-runtime')

    // Ids no manager owns still land on the Prime manager.
    await harness.invoke('agent:command', 'missing-runtime', { type: 'abort' })
    expect(harness.services.agents.command).toHaveBeenCalledWith('missing-runtime', { type: 'abort' })
  })

  it('routes session file operations for paths only the pi root authorizes', async () => {
    await expect(harness.invoke('sessions:read', PI_SESSION)).resolves.toEqual(['pi-transcript'])
    expect(harness.services.pi.sessions.read).toHaveBeenCalledWith(PI_SESSION)
    expect(harness.services.sessions.read).not.toHaveBeenCalled()
    expect(harness.services.omp.sessions.read).not.toHaveBeenCalled()

    await expect(harness.invoke('sessions:rename', PI_SESSION, 'Title')).resolves.toBe(false)
    expect(harness.services.pi.sessions.rename).toHaveBeenCalledWith(PI_SESSION, 'Title')
    await expect(harness.invoke('sessions:archive', PI_SESSION, true)).resolves.toBe(true)
    expect(harness.services.pi.sessions.archive).toHaveBeenCalledWith(PI_SESSION, true)
    expect(harness.services.browser.closeForSession).toHaveBeenCalledWith(PI_SESSION)
    expect(harness.services.terminals.killForSession).toHaveBeenCalledWith(PI_SESSION)

    // A path no root contains still fails with the Prime service's own error.
    await expect(async () => harness.invoke('sessions:read', '/etc/passwd')).rejects.toThrow('outside the Prime session directory')
  })

  it('answers follow-up for a pi session with the not-running result instead of the daemon path', async () => {
    await expect(harness.invoke('sessions:follow-up', PI_SESSION, 'hello', 'queue')).resolves.toBe(false)
    expect(harness.services.pi.sessions.followUp).not.toHaveBeenCalled()
    expect(harness.services.sessions.followUp).not.toHaveBeenCalled()
  })

  it('routes providers:catalog for pi with its own desktop visibility list', async () => {
    await expect(harness.invoke('providers:catalog', true, 'pi')).resolves.toMatchObject({ from: 'pi' })
    expect(harness.services.pi.catalog.catalog).toHaveBeenCalledWith(true, new Set(['anthropic']), new Set())
    expect(harness.services.providers.catalog).not.toHaveBeenCalled()
  })

  it('stores pi provider visibility in piDisabledProviders without mutating pi', async () => {
    await expect(harness.invoke('providers:set-enabled', 'openai', false, 'pi')).resolves.toMatchObject({
      from: 'pi',
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: false }],
    })
    expect(harness.services.settings.update).toHaveBeenCalledWith({ piDisabledProviders: ['anthropic', 'openai'], piDisabledModels: [] })

    await expect(harness.invoke('providers:set-disabled', ['openai'], 'pi')).resolves.toMatchObject({
      from: 'pi',
      providers: [{ id: 'anthropic', enabled: true }, { id: 'openai', enabled: false }],
    })
    expect(harness.services.settings.update).toHaveBeenLastCalledWith({ piDisabledProviders: ['openai'], piDisabledModels: [] })
  })

  it('rejects provider credential mutations aimed at the pi harness', async () => {
    for (const [channel, args] of [
      ['providers:save-api-key', ['openai', 'key']],
      ['providers:logout', ['openai']],
      ['providers:start-oauth', ['openai']],
    ] as const) {
      await expect(async () => harness.invoke(channel, ...args, 'pi'), channel).rejects.toThrow('Pi provider authentication is managed by the pi CLI')
    }
    expect(harness.services.providers.saveApiKey).not.toHaveBeenCalled()
  })

  it('routes schedules channels with the pi harness argument', async () => {
    expect(harness.invoke('schedules:list', 'pi')).toBe('scheduled')
    expect(harness.services.schedules.list).toHaveBeenCalledWith('pi')
    await expect(harness.invoke('schedules:create', { prompt: 'p' }, 'pi')).resolves.toBe('created')
    expect(harness.services.schedules.create).toHaveBeenCalledWith({ prompt: 'p' }, 'user', 'pi')
  })
})
