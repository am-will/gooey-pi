import { expect, it, vi } from 'vitest'
import { ipcServiceStubs } from '../helpers/ipc-harness'

const electron = vi.hoisted(() => ({
  api: undefined as unknown,
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => undefined), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn((_name: string, api: unknown) => { electron.api = api }) },
  shell: {},
}))
vi.mock('electron', () => electron)

import { registerIpc } from '../../electron/main/ipc'
await import('../../electron/preload/index')

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new TypeError('Expected an exposed API object')
  return Object.fromEntries(Object.entries(value))
}

function channels(calls: unknown[][]): string[] {
  return [...new Set(calls.map(([channel]) => {
    if (typeof channel !== 'string') throw new TypeError('Expected a fixed channel')
    return channel
  }))].sort()
}

it('registers exactly the invoke and send channels exposed by the actual preload', async () => {
  const registration = registerIpc(ipcServiceStubs() as never, 'prime-work://app/')
  try {
    for (const domain of Object.values(record(electron.api))) {
      for (const method of Object.values(record(domain))) {
        if (typeof method !== 'function') throw new TypeError('Unexpected non-method in preload API')
        await method(() => undefined)
      }
    }
    expect(channels(electron.ipcRenderer.invoke.mock.calls)).toEqual(channels(electron.ipcMain.handle.mock.calls))
    expect(channels(electron.ipcRenderer.send.mock.calls)).toEqual(channels(electron.ipcMain.on.mock.calls))
    expect(electron.ipcMain.handle.mock.calls).toHaveLength(channels(electron.ipcMain.handle.mock.calls).length)
    expect(electron.ipcMain.on.mock.calls).toHaveLength(channels(electron.ipcMain.on.mock.calls).length)
  } finally { registration.dispose() }
})
