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
import type { PrimeWorkApi } from '../../src/types/api'

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
