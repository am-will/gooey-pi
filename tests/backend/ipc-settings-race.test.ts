import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcServiceStubs } from '../helpers/ipc-harness'
import type { AppSettings } from '../../src/types/api'

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() } }))
vi.mock('electron', () => electron)
import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'
import { SettingsService } from '../../electron/main/settings'
import { defaultSettings, type DesktopState, type JsonStateStore } from '../../electron/main/store'

let registration: IpcRegistration | undefined
afterEach(() => { registration?.dispose(); vi.restoreAllMocks() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('settings IPC transition ownership', () => {
  it.each([false, true])('reconciles fields retained after login-item refusal (retirement rejects=%j)', async (refreshFails) => {
    const handlers = new Map<string, (event: unknown, patch: unknown) => Promise<AppSettings>>()
    electron.ipcMain.handle.mockImplementation((channel, handler) => { handlers.set(channel, handler) })
    const state = { settings: { ...defaultSettings(), browserEnabled: true, launchAtLogin: false } }
    const store = {
      getSettings: () => structuredClone(state.settings),
      update: async (mutate: (state: DesktopState) => unknown) => structuredClone(mutate(state as DesktopState)),
    }
    const settings = new SettingsService(store as unknown as JsonStateStore, () => '/bin/sh', undefined, () => { throw new Error('macOS refused login item') })
    const refresh = vi.fn(async () => {})
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    if (refreshFails) refresh.mockRejectedValueOnce(new Error('Retirement failed'))
    const services = ipcServiceStubs()
    services.settings = settings
    services.agents = { ...services.agents as object, requestRuntimeEnvironmentRefresh: refresh }
    const url = 'prime-work://app/'
    const sender = { id: 1, getURL: () => url, mainFrame: { url }, isDestroyed: () => false }
    registration = registerIpc(services as never, url)
    registration.authorize(sender as never)
    await expect(handlers.get('settings:update')!({ sender, senderFrame: sender.mainFrame }, { browserEnabled: false, launchAtLogin: true, interfaceFontScale: 115 })).rejects.toThrow('macOS refused login item')
    expect(settings.get()).toMatchObject({ browserEnabled: false, launchAtLogin: false })
    expect(refresh).toHaveBeenCalledOnce()
    expect(services.applyInterfaceZoom).toHaveBeenCalledWith(115)
    if (refreshFails) expect(log).toHaveBeenCalledWith(expect.stringContaining('Retirement failed'))
    else expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['browserEnabled', false, true, false],
    ['askUserEnabled', false, true, false],
    ['ompApprovalMode', 'always-ask', 'yolo', false],
    ['browserEnabled', false, true, true],
  ] as const)('refreshes overlapping %s transitions from %j via %j (refresh rejects=%j)', async (key, initial, intermediate, refreshFails) => {
    const handlers = new Map<string, (event: unknown, patch: unknown) => Promise<AppSettings>>()
    electron.ipcMain.handle.mockImplementation((channel, handler) => { handlers.set(channel, handler) })
    let settings = { ...defaultSettings(), [key]: initial }
    const gates = [deferred(), deferred()]
    let writes = 0
    const store = {
      getSettings: () => structuredClone(settings),
      update: async (mutate: (state: DesktopState) => AppSettings) => {
        await gates[writes++].promise
        const result = mutate({ settings } as DesktopState)
        settings = structuredClone(result)
        return structuredClone(result)
      },
    }
    const service = new SettingsService(store as unknown as JsonStateStore, () => '/bin/sh')
    const refresh = vi.fn(async () => {})
    if (refreshFails) refresh.mockRejectedValueOnce(new Error('Runtime retirement failed'))
    const services = ipcServiceStubs()
    services.settings = service
    services.agents = { ...services.agents as object, requestRuntimeEnvironmentRefresh: vi.fn(async () => {}) }
    services.omp = { ...services.omp as object, agents: { requestRuntimeEnvironmentRefresh: refresh } }
    const url = 'prime-work://app/'
    const sender = { id: 1, getURL: () => url, mainFrame: { url }, isDestroyed: () => false }
    registration = registerIpc(services as never, url)
    registration.authorize(sender as never)
    const invoke = handlers.get('settings:update')!
    const event = { sender, senderFrame: sender.mainFrame }
    const first = invoke(event, { [key]: intermediate })
    const second = invoke(event, { [key]: initial })
    await vi.waitFor(() => expect(writes).toBe(1))
    gates[0].resolve()
    if (refreshFails) await expect(first).rejects.toThrow('Runtime retirement failed')
    else await first
    expect(settings[key]).toBe(intermediate)
    // A runtime can be created under this generation while the second disk write waits.
    expect(refresh).toHaveBeenCalledTimes(1)
    gates[1].resolve()
    await second
    expect(settings[key]).toBe(initial)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
