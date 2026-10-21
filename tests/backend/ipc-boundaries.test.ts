import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcServiceStubs } from '../helpers/ipc-harness'

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  shell: {},
}))
vi.mock('electron', () => electron)
import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const trustedUrl = 'prime-work://app/'
let registration: IpcRegistration
let handlers: Map<string, Handler>
let services: ReturnType<typeof ipcServiceStubs>
const sender = () => ({ id: 1, getURL: () => trustedUrl, mainFrame: { url: trustedUrl }, isDestroyed: () => false, send: vi.fn() })
let contents: ReturnType<typeof sender>
function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler({ sender: contents, senderFrame: contents.mainFrame }, ...args)
}

beforeEach(() => {
  handlers = new Map()
  electron.ipcMain.handle.mockImplementation((channel: string, handler: Handler) => { handlers.set(channel, handler) })
  services = ipcServiceStubs()
  registration = registerIpc(services as never, trustedUrl)
  contents = sender()
  registration.authorize(contents as never)
})
afterEach(() => { registration.dispose() })

describe('native menu and title-bar admission', () => {
  it.each(['unknown', '', null, {}, 1])('rejects invalid menu %j before native dispatch', (menu) => {
    expect(() => invoke('app:popup-menu', menu, 10, 20)).toThrow('Invalid application menu')
    expect(services.popupApplicationMenu).not.toHaveBeenCalled()
  })
  it.each([NaN, Infinity, -1, 10_001, '10', null])('rejects invalid menu coordinate %j', (coordinate) => {
    expect(() => invoke('app:popup-menu', 'file', coordinate, 20)).toThrow('Invalid menu coordinate')
    expect(services.popupApplicationMenu).not.toHaveBeenCalled()
  })
  it('passes the authorized sender and rounded coordinates to a valid native menu', () => {
    invoke('app:popup-menu', 'file', 10.4, 20.7)
    expect(services.popupApplicationMenu).toHaveBeenCalledWith(contents, 'file', 10, 21)
  })
  it.each(['system', 'unknown', null, {}, 0])('rejects unresolved title-bar theme %j', (theme) => {
    expect(() => invoke('app:set-title-bar-theme', theme)).toThrow('Invalid resolved theme')
    expect(services.setTitleBarTheme).not.toHaveBeenCalled()
  })
  it.each(['light', 'dark'])('accepts resolved title-bar theme %s', (theme) => {
    invoke('app:set-title-bar-theme', theme)
    expect(services.setTitleBarTheme).toHaveBeenCalledWith(contents, theme)
  })
})

describe('computer-use enable admission', () => {
  it('requires a successful fresh driver probe before persisting enablement', async () => {
    const order: string[] = []
    const get = vi.fn(() => ({ computerUseEnabled: false }))
    const update = vi.fn(async () => { order.push('persist'); return { computerUseEnabled: true } })
    const probe = vi.fn(async () => { order.push('probe') })
    services.settings = { get, update }
    services.cuaDriver = { requireAvailable: probe }
    await invoke('settings:update', { computerUseEnabled: true })
    expect(order).toEqual(['probe', 'persist'])
    expect(update).toHaveBeenCalledWith({ computerUseEnabled: true })
  })
  it('leaves settings untouched if the driver rejects enablement', async () => {
    const update = vi.fn()
    services.settings = { get: () => ({ computerUseEnabled: false }), update }
    services.cuaDriver = { requireAvailable: vi.fn(async () => { throw new Error('driver unavailable') }) }
    await expect(invoke('settings:update', { computerUseEnabled: true })).rejects.toThrow('driver unavailable')
    expect(update).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not probe for unrelated settings when already enabled=%s', async (enabled) => {
    const update = vi.fn(async () => ({ computerUseEnabled: enabled }))
    const probe = vi.fn()
    services.settings = { get: () => ({ computerUseEnabled: enabled }), update }
    services.cuaDriver = { requireAvailable: probe }
    await invoke('settings:update', { theme: 'dark' })
    expect(probe).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
  })
})

describe('provider visibility admission', () => {
  it.each([
    ['providers:set-enabled', ['', true]],
    ['providers:set-enabled', ['known', 'true']],
    ['providers:set-enabled', ['missing', true]],
    ['providers:set-disabled', [null]],
    ['providers:set-disabled', [Array(257).fill('known')]],
    ['providers:set-disabled', [['']]],
    ['providers:set-disabled', [['missing']]],
    ['providers:set-model-enabled', ['x', true]],
    ['providers:set-model-enabled', ['known/model', 1]],
    ['providers:set-model-enabled', ['missing/model', true]],
  ])('rejects malformed or unknown %s input before changing settings', async (channel, args) => {
    const update = vi.fn()
    services.settings = {
      get: () => ({ disabledProviders: [], disabledModels: [] }), update,
    }
    services.providers = {
      catalog: vi.fn(async () => ({
        providers: [{ id: 'known', enabled: true }],
        models: [{ key: 'known/model', provider: 'known', id: 'model', enabled: true }],
      })),
    }
    await expect(invoke(channel, ...args)).rejects.toThrow()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('trusted event broadcast lifetime', () => {
  it('checks registered contents identity rather than accepting a reused numeric ID', () => {
    const replacement = sender()
    const handler = handlers.get('settings:get')!
    expect(() => handler({ sender: replacement, senderFrame: replacement.mainFrame })).toThrow()
  })
  it('keeps delivering when an earlier receiver disappears during send', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      contents.send.mockImplementation(() => { throw new Error('receiver gone') })
      const later = { ...sender(), id: 2 }
      registration.authorize(later as never)
      registration.broadcast('agent:event', { runtimeId: 'sample' })
      expect(later.send).toHaveBeenCalledWith('agent:event', { runtimeId: 'sample' })
      registration.dispose()
      registration.broadcast('agent:event', {})
      expect(later.send).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore() }
  })
})
