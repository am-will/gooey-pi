// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsService } from '../../electron/main/settings'
import { JsonStateStore } from '../../electron/main/store'
import { useAppSettings } from '../../src/hooks/useAppSettings'
import { DEFAULT_SETTINGS } from '../../src/lib/default-settings'
import type { AppSettings, PrimeWorkApi } from '../../src/types/api'

vi.mock('electron', () => ({ session: {} }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const directories: string[] = []
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('reconciles retained settings after the real main service rejects a login-item change', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-settings-reconcile-')); directories.push(directory)
  const store = new JsonStateStore(join(directory, 'state.json'))
  await store.ready()
  await store.update((state) => { state.settings.browserEnabled = true })
  const failure = new Error('login item refused')
  const service = new SettingsService(store, () => '/bin/sh', undefined, () => { throw failure })
  const get = vi.fn(async () => service.get())
  const bridge = { settings: { get, update: (patch: unknown) => service.update(patch) } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let state!: ReturnType<typeof useAppSettings>
  function Probe() { state = useAppSettings({ bridge, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  let result: boolean | undefined
  await act(async () => { result = await state.updateSettings({ browserEnabled: false, interfaceFontScale: 115, launchAtLogin: true }) })
  expect(result).toBe(false)
  expect(service.get()).toMatchObject({ browserEnabled: false, interfaceFontScale: 115, launchAtLogin: false })
  expect(state.settings).toEqual(service.get())
  expect(get).toHaveBeenCalledTimes(2)
  expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('finishes failure reconciliation before the next write without replacing newer optimistic edits', async () => {
  const retained = { ...DEFAULT_SETTINGS, browserEnabled: false }
  const recovery = deferred<AppSettings>()
  const secondSave = deferred<AppSettings>()
  const order: string[] = []
  const failure = new Error('first write partly applied')
  const get = vi.fn().mockResolvedValueOnce(DEFAULT_SETTINGS).mockImplementationOnce(() => { order.push('recover'); return recovery.promise })
  const update = vi.fn().mockImplementationOnce(async () => { order.push('first'); throw failure })
    .mockImplementationOnce(() => { order.push('second'); return secondSave.promise })
  const bridge = { settings: { get, update } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let state!: ReturnType<typeof useAppSettings>
  function Probe() { state = useAppSettings({ bridge, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  let first!: Promise<boolean>
  let second!: Promise<boolean>
  await act(async () => {
    first = state.updateSettings({ browserEnabled: false, launchAtLogin: true })
    second = state.updateSettings({ theme: 'dark' })
  })
  expect(order).toEqual(['first', 'recover'])
  expect(state.settings).toMatchObject({ theme: 'dark', browserEnabled: false, launchAtLogin: true })
  await act(async () => { recovery.resolve(retained); await first })
  expect(order).toEqual(['first', 'recover', 'second'])
  expect(state.settings.theme).toBe('dark')
  await act(async () => { secondSave.resolve({ ...retained, theme: 'dark' }); expect(await second).toBe(true) })
  expect(state.settings).toEqual({ ...retained, theme: 'dark' })
  expect(await first).toBe(false)
  expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
})

it('keeps transient panels during failure reconciliation and reports the original error if recovery also fails', async () => {
  const failure = new Error('save failed')
  const get = vi.fn().mockResolvedValueOnce(DEFAULT_SETTINGS).mockRejectedValueOnce(new Error('refresh failed'))
  const update = vi.fn(async () => { throw failure })
  const bridge = { settings: { get, update } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let state!: ReturnType<typeof useAppSettings>
  function Probe() { state = useAppSettings({ bridge, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => {
    const save = state.updateSettings({ browserHome: 'https://unsaved.example/' })
    state.setInspectorOpen(false)
    expect(await save).toBe(false)
  })
  expect(state.settings).toEqual(DEFAULT_SETTINGS)
  expect(state.inspectorOpen).toBe(false)
  expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
})
