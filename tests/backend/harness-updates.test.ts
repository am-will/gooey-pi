import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessId, HarnessStatus } from '../../src/types/api'
import { readInstalledChangelog, sliceChangelog } from '../../electron/main/harness-changelog'
import { HarnessUpdateService, isNewerVersion, PI_CHANGELOG_PACKAGE, type HarnessUpdateServiceOptions, type RegistryFetcher } from '../../electron/main/harness-updates'

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

/** Fake omp: `update --check` prints the given report; `update` touches a marker file. */
function fakeOmp(checkReport: string, markerFile?: string, checkExitCode = 0): string {
  const executable = join(tempDir(), 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] !== 'update') process.exit(9)
if (process.argv[3] === '--check') {
  process.stdout.write(${JSON.stringify(checkReport)}, () => process.exit(${checkExitCode}))
} else {
  ${markerFile ? `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran')` : ''}
  process.exit(0)
}
`)
  chmodSync(executable, 0o755)
  return executable
}

interface ServiceSetup {
  enabled?: boolean
  piStatus?: HarnessStatus
  ompStatus?: HarnessStatus
  primeStatus?: HarnessStatus
  fetchRegistry?: RegistryFetcher
  refreshHarnesses?: () => Promise<unknown>
  overrides?: Partial<HarnessUpdateServiceOptions>
}

function service(setup: ServiceSetup = {}) {
  let enabled = setup.enabled ?? true
  const statuses: Record<HarnessId, HarnessStatus> = {
    prime: setup.primeStatus ?? { path: null, version: null },
    omp: setup.ompStatus ?? { path: null, version: null },
    pi: setup.piStatus ?? { path: null, version: null },
  }
  const fetchCalls: string[] = []
  const instance = new HarnessUpdateService({
    enabled: () => enabled,
    harnessStatus: (harness: HarnessId) => statuses[harness],
    refreshHarnesses: setup.refreshHarnesses ?? (async () => undefined),
    isBundledExecutable: () => false,
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
    setPiStatus: (value: HarnessStatus) => { statuses.pi = value },
    setOmpStatus: (value: HarnessStatus) => { statuses.omp = value },
    setPrimeStatus: (value: HarnessStatus) => { statuses.prime = value },
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
    expect(states.omp.message).toContain('not installed')
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
    expect(events).toEqual(['checking', 'available', 'updating', 'up-to-date'])
  })

  it('publishes a bounded error when the updater fails and refuses updates that make no sense', async () => {
    const failing = service({ piStatus: { path: fakePiUpdater(join(tempDir(), 'never'), 7), version: '0.82.1' } })
    await failing.instance.check(true)
    expect(await failing.instance.update('pi')).toMatchObject({ phase: 'error' })

    const idle = service()
    await expect(idle.instance.update('prime')).rejects.toThrow(/No harness update is available/)

    const disabled = service({ enabled: false })
    await expect(disabled.instance.update('pi')).rejects.toThrow(/disabled/)

    const upToDate = service({ piStatus: { path: '/usr/bin/pi', version: '0.84.1' } })
    await upToDate.instance.check(true)
    await expect(upToDate.instance.update('pi')).rejects.toThrow(/No harness update is available/)
  })

  it('lets omp report its own availability through update --check', async () => {
    const available = service({ ompStatus: { path: fakeOmp('Current version: 17.0.2\nNew version available: 17.3.3\n'), version: 'omp/17.0.2' } })
    expect((await available.instance.check(true)).omp).toMatchObject({ phase: 'available', installedVersion: '17.0.2', latestVersion: '17.3.3' })

    const current = service({ ompStatus: { path: fakeOmp('Current version: 17.3.3\n'), version: 'omp/17.3.3' } })
    expect((await current.instance.check(true)).omp).toMatchObject({ phase: 'up-to-date', installedVersion: '17.3.3' })

    const garbled = service({ ompStatus: { path: fakeOmp('unexpected words\n'), version: null } })
    const garbledState = (await garbled.instance.check(true)).omp
    expect(garbledState.phase).toBe('error')
    expect(garbledState.message).toMatch(/unrecognized format/)

    const failing = service({ ompStatus: { path: fakeOmp('boom', undefined, 3), version: null } })
    expect((await failing.instance.check(true)).omp.phase).toBe('error')
    // Four sequential subprocess spawns need headroom under full-suite load.
  }, 20_000)

  it('runs omp update through omp itself and republishes the refreshed state', async () => {
    const markerFile = join(tempDir(), 'omp-updated')
    const executable = fakeOmp('Current version: 17.0.2\nNew version available: 17.3.3\n', markerFile)
    const upgraded = fakeOmp('Current version: 17.3.3\n')
    const setup = service({
      ompStatus: { path: executable, version: 'omp/17.0.2' },
      refreshHarnesses: async () => { setup.setOmpStatus({ path: upgraded, version: 'omp/17.3.3' }) },
    })
    await setup.instance.check(true)
    const result = await setup.instance.update('omp')

    expect(existsSync(markerFile)).toBe(true)
    expect(result).toMatchObject({ phase: 'up-to-date', installedVersion: '17.3.3' })
  }, 20_000)

  it('reads the pi changelog from the installed package behind the executable symlink', async () => {
    const root = tempDir()
    const packageDir = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent')
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: PI_CHANGELOG_PACKAGE, version: '0.84.1' }))
    writeFileSync(join(packageDir, 'CHANGELOG.md'), '# Changelog\n\n## [0.84.1] - 2026-08-07\n\n- New thing\n\n## [0.84.0] - 2026-08-06\n\n- Older thing\n')
    writeFileSync(join(packageDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
    symlinkSync(join(packageDir, 'dist', 'cli.js'), join(root, 'bin', 'pi'))

    expect(await readInstalledChangelog(join(root, 'bin', 'pi'), PI_CHANGELOG_PACKAGE)).toContain('New thing')
    expect(await readInstalledChangelog(join(root, 'bin', 'pi'), 'some-other-package')).toBeNull()
    expect(await readInstalledChangelog(join(root, 'missing'), PI_CHANGELOG_PACKAGE)).toBeNull()

    const setup = service({
      piStatus: { path: join(root, 'bin', 'pi'), version: '0.84.1' },
    })
    const notes = await setup.instance.changelog('pi', '0.84.0')
    expect(notes).toMatchObject({ toVersion: '0.84.1' })
    expect(notes?.markdown).toContain('New thing')
    expect(notes?.markdown).not.toContain('Older thing')

    expect(await setup.instance.changelog('omp')).toBeNull()
    await expect(setup.instance.changelog('pi', '../../etc/passwd')).rejects.toThrow(/not a valid version/)
  })

  it('slices changelog sections between versions with sane fallbacks', () => {
    const markdown = [
      '# Changelog', '',
      '## [0.84.1] - 2026-08-07', '', 'newest', '',
      '## [0.84.0] - 2026-08-06', '', 'middle', '',
      '## [0.82.1] - 2026-07-30', '', 'oldest', '',
    ].join('\n')

    const range = sliceChangelog(markdown, '0.84.1', '0.82.1')
    expect(range?.toVersion).toBe('0.84.1')
    expect(range?.markdown).toContain('newest')
    expect(range?.markdown).toContain('middle')
    expect(range?.markdown).not.toContain('oldest')

    // No last-seen version: only the installed release's section.
    const single = sliceChangelog(markdown, '0.84.0')
    expect(single?.markdown).toContain('middle')
    expect(single?.markdown).not.toContain('newest')
    expect(single?.markdown).not.toContain('oldest')

    // Changelog older than the installed build has nothing to show.
    expect(sliceChangelog(markdown, '0.99.0')).toBeNull()
    expect(sliceChangelog('no headings here', '0.84.1')).toBeNull()
  })

  it('resolves prime-agent availability from its installer release channel', async () => {
    const channel = (body: string): RegistryFetcher => async (url) => url.includes('r2.dev') ? body : JSON.stringify({ version: '0.84.1' })

    const ahead = service({ primeStatus: { path: '/usr/bin/prime-agent', version: '0.7.0' }, fetchRegistry: channel('v0.7.2\n') })
    expect((await ahead.instance.check(true)).prime).toMatchObject({ phase: 'available', installedVersion: '0.7.0', latestVersion: '0.7.2' })
    expect(ahead.fetchCalls).toContain('https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/stable')

    const current = service({ primeStatus: { path: '/usr/bin/prime-agent', version: '0.7.2' }, fetchRegistry: channel('v0.7.2\n') })
    expect((await current.instance.check(true)).prime.phase).toBe('up-to-date')

    const hostile = service({ primeStatus: { path: '/usr/bin/prime-agent', version: '0.7.0' }, fetchRegistry: channel('<html>bucket error</html>') })
    expect((await hostile.instance.check(true)).prime.phase).toBe('error')
  })

  it('reports a bundled prime-agent as updating with GooeyPi and never probes it', async () => {
    const setup = service({
      primeStatus: { path: '/Applications/GooeyPi.app/Contents/Resources/agent/prime-agent', version: '0.7.0' },
      overrides: { isBundledExecutable: (path: string) => path.includes('/Resources/') },
    })
    const state = (await setup.instance.check(true)).prime
    expect(state.phase).toBe('unsupported')
    expect(state.message).toContain('bundled with GooeyPi')
    expect(setup.fetchCalls.every((url) => !url.includes('r2.dev'))).toBe(true)
    await expect(setup.instance.update('prime')).rejects.toThrow(/No harness update is available/)
  })

  it('serves the prime-agent changelog from its installed package', async () => {
    const root = tempDir()
    const packageDir = join(root, 'versions', '0.7.0', 'node_modules', 'prime-agent')
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'prime-agent', version: '0.7.0' }))
    writeFileSync(join(packageDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- Pending\n\n## [0.7.0] - 2026-08-05\n\n- Prime thing\n')
    writeFileSync(join(packageDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
    symlinkSync(join(packageDir, 'dist', 'cli.js'), join(root, 'bin', 'prime-agent'))

    const setup = service({ primeStatus: { path: join(root, 'bin', 'prime-agent'), version: '0.7.0' } })
    const notes = await setup.instance.changelog('prime')
    expect(notes).toMatchObject({ toVersion: '0.7.0' })
    expect(notes?.markdown).toContain('Prime thing')
    // The [Unreleased] block has no version heading and never leaks into a slice.
    expect(notes?.markdown).not.toContain('Pending')
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
