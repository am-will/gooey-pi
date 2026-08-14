import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessId, HarnessStatus } from '../../src/types/api'
import { HarnessUpdateService, isNewerVersion, type HarnessUpdateServiceOptions, type RegistryFetcher } from '../../electron/main/harness-updates'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-harness-updates-'))
  dirs.push(dir)
  return dir
}

/** Fake pi updater: `update --self` touches a marker file so tests can assert the exact argv reached the executable. */
function fakePiUpdater(markerFile: string, exitCode = 0): string {
  const executable = join(tempDir(), 'fake-pi.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] !== 'update' || process.argv[3] !== '--self') process.exit(9)
require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran')
process.exit(${exitCode})
`)
  chmodSync(executable, 0o755)
  return executable
}

function registryAnswer(version: string): RegistryFetcher {
  return async () => JSON.stringify({ name: '@earendil-works/pi-coding-agent', version })
}

interface ServiceSetup {
  enabled?: boolean
  piStatus?: HarnessStatus
  fetchRegistry?: RegistryFetcher
  refreshHarnesses?: () => Promise<unknown>
  overrides?: Partial<HarnessUpdateServiceOptions>
}

function service(setup: ServiceSetup = {}) {
  let enabled = setup.enabled ?? true
  let piStatus = setup.piStatus ?? { path: null, version: null }
  const fetchCalls: string[] = []
  const instance = new HarnessUpdateService({
    enabled: () => enabled,
    harnessStatus: (harness: HarnessId) => harness === 'pi' ? piStatus : { path: null, version: null },
    refreshHarnesses: setup.refreshHarnesses ?? (async () => undefined),
    fetchRegistry: async (url, limits) => {
      fetchCalls.push(url)
      return (setup.fetchRegistry ?? registryAnswer('0.84.1'))(url, limits)
    },
    ...setup.overrides,
  })
  return {
    instance,
    fetchCalls,
    setEnabled: (value: boolean) => { enabled = value },
    setPiStatus: (value: HarnessStatus) => { piStatus = value },
  }
}

describe('Harness update service', () => {
  it('compares dotted numeric versions and never trusts unparseable ones', () => {
    expect(isNewerVersion('0.84.1', '0.82.1')).toBe(true)
    expect(isNewerVersion('0.84.1', '0.84.1')).toBe(false)
    expect(isNewerVersion('0.82.1', '0.84.1')).toBe(false)
    expect(isNewerVersion('1.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.84.1-beta.2', '0.84.0')).toBe(true)
    expect(isNewerVersion('v0.84.1', '0.82.1')).toBe(true)
    expect(isNewerVersion('latest', '0.82.1')).toBe(false)
    expect(isNewerVersion('0.84.1', 'garbage')).toBe(false)
  })

  it('reports available when the registry is ahead and up-to-date when it is not', async () => {
    const ahead = service({ piStatus: { path: '/usr/bin/pi', version: '0.82.1' } })
    const states = await ahead.instance.check()
    expect(states.pi).toMatchObject({ phase: 'available', installedVersion: '0.82.1', latestVersion: '0.84.1' })
    expect(states.omp.phase).toBe('unsupported')
    expect(states.prime.phase).toBe('unsupported')

    const current = service({ piStatus: { path: '/usr/bin/pi', version: '0.84.1' } })
    expect((await current.instance.check()).pi.phase).toBe('up-to-date')
  })

  it('skips the registry entirely while the setting is off and recovers when re-enabled', async () => {
    const disabled = service({ enabled: false, piStatus: { path: '/usr/bin/pi', version: '0.82.1' } })
    expect((await disabled.instance.check(true)).pi.phase).toBe('disabled')
    expect(disabled.fetchCalls).toHaveLength(0)

    disabled.setEnabled(true)
    expect((await disabled.instance.check(true)).pi.phase).toBe('available')
    expect(disabled.fetchCalls).toEqual(['https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest'])
  })

  it('caches within the TTL and single-flights concurrent checks', async () => {
    const cached = service({ piStatus: { path: '/usr/bin/pi', version: '0.82.1' } })
    await Promise.all([cached.instance.check(true), cached.instance.check(true)])
    expect(cached.fetchCalls).toHaveLength(1)
    await cached.instance.check()
    expect(cached.fetchCalls).toHaveLength(1)
    await cached.instance.check(true)
    expect(cached.fetchCalls).toHaveLength(2)
  })

  it('answers unsupported without an executable and error without a version or with hostile registry data', async () => {
    const missing = service()
    expect((await missing.instance.check(true)).pi).toMatchObject({ phase: 'unsupported' })

    const unversioned = service({ piStatus: { path: '/usr/bin/pi', version: null } })
    expect((await unversioned.instance.check(true)).pi.phase).toBe('error')

    for (const body of ['not json {{', JSON.stringify({ version: 42 }), JSON.stringify({ version: 'evilversion' }), JSON.stringify([1, 2])]) {
      const hostile = service({ piStatus: { path: '/usr/bin/pi', version: '0.82.1' }, fetchRegistry: async () => body })
      const state = (await hostile.instance.check(true)).pi
      expect(state.phase).toBe('error')
      expect([...(state.message ?? '')].every((character) => character.charCodeAt(0) >= 0x20)).toBe(true)
    }
  })

  it('runs the harness updater with a fixed argv, refreshes discovery, and republishes the new version', async () => {
    const markerFile = join(tempDir(), 'updated')
    const executable = fakePiUpdater(markerFile)
    let refreshed = false
    const setup = service({
      piStatus: { path: executable, version: '0.82.1' },
      refreshHarnesses: async () => {
        refreshed = true
        setup.setPiStatus({ path: executable, version: '0.84.1' })
      },
    })
    const events: string[] = []
    // The sink fires once per harness publish; only pi's phase transitions matter here.
    setup.instance.setEventSink((states) => { if (events.at(-1) !== states.pi.phase) events.push(states.pi.phase) })
    await setup.instance.check(true)
    const result = await setup.instance.update('pi')

    expect(existsSync(markerFile)).toBe(true)
    expect(refreshed).toBe(true)
    expect(result).toMatchObject({ phase: 'up-to-date', installedVersion: '0.84.1', latestVersion: '0.84.1' })
    expect(events).toEqual(['idle', 'available', 'updating', 'up-to-date'])
  })

  it('publishes a bounded error when the updater fails and refuses updates that make no sense', async () => {
    const failing = service({ piStatus: { path: fakePiUpdater(join(tempDir(), 'never'), 7), version: '0.82.1' } })
    await failing.instance.check(true)
    expect(await failing.instance.update('pi')).toMatchObject({ phase: 'error' })

    const unsupported = service()
    await expect(unsupported.instance.update('omp')).rejects.toThrow(/not supported/)

    const disabled = service({ enabled: false })
    await expect(disabled.instance.update('pi')).rejects.toThrow(/disabled/)

    const upToDate = service({ piStatus: { path: '/usr/bin/pi', version: '0.84.1' } })
    await upToDate.instance.check(true)
    await expect(upToDate.instance.update('pi')).rejects.toThrow(/No harness update is available/)
  })

  it('checks on the initial timer and interval only through injected timers', async () => {
    const timers: Array<() => void> = []
    const setup = service({
      piStatus: { path: '/usr/bin/pi', version: '0.82.1' },
      overrides: {
        setTimeout: ((callback: () => void) => { timers.push(callback); return { unref: () => undefined } }) as unknown as typeof globalThis.setTimeout,
        setInterval: ((callback: () => void) => { timers.push(callback); return { unref: () => undefined } }) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
      },
    })
    setup.instance.start()
    expect(setup.fetchCalls).toHaveLength(0)
    expect(timers).toHaveLength(2)
    for (const fire of timers) fire()
    await setup.instance.check()
    expect(setup.fetchCalls.length).toBeGreaterThan(0)
    setup.instance.dispose()
  })
})
