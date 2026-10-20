import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HarnessDiscoveryService, detectedHarnesses, probeHarnessExecutable, probePrimeImplementation, reconcileActiveHarness, type HarnessProbeFailure } from '../../electron/main/harness-discovery'
import { defaultSettings, type DesktopState } from '../../electron/main/store'
import { HARNESSES, type HarnessDescriptor } from '../../electron/main/harness'
import { inspectPrimeNpmBridge, PRIME_NPM_BRIDGE_UNMIGRATED_DETAIL } from '../../electron/main/prime-npm-bridge'
import { findHarnessExecutable } from '../../electron/main/process-utils'
import type { PrimeImplementation } from '../../src/types/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('HarnessDiscoveryService', () => {
  it('reconciles against the settings state inside the serialized transaction', async () => {
    const state = { settings: defaultSettings() } as DesktopState
    state.settings.activeHarness = 'prime'
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let queue = Promise.resolve()
    const store = {
      update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
        const operation = queue.then(async () => {
          if (state.settings.activeHarness === 'prime') await firstGate
          return mutator(state)
        })
        queue = operation.then(() => undefined, () => undefined)
        return operation
      },
    }
    const userSelection = store.update((draft) => { draft.settings.activeHarness = 'omp' })
    const reconciliation = reconcileActiveHarness(store, {
      omp: { path: '/bin/omp', version: '1' },
      prime: { path: '/bin/prime-agent', version: '1' },
      pi: { path: null, version: null },
    })
    releaseFirst()

    await userSelection
    await expect(reconciliation).resolves.toMatchObject({ activeHarness: 'omp' })
    expect(state.settings.activeHarness).toBe('omp')
  })

  it('publishes one atomic status snapshot using the current runtime overrides', async () => {
    const runtimePaths = { omp: '/configured/omp', prime: '', pi: '' }
    const findExecutable = vi.fn(async (descriptor: HarnessDescriptor, configured?: string, accept?: (candidate: string) => Promise<boolean>) => {
      const candidate = descriptor.id === 'omp' ? configured ?? null : descriptor.id === 'pi' ? '/usr/bin/pi' : null
      return candidate && await accept?.(candidate) ? candidate : null
    })
    const probeExecutable = vi.fn(async (path: string) => ({ runnable: true, version: `${path}-version` }))
    const discovery = new HarnessDiscoveryService(() => runtimePaths, { findExecutable, probeExecutable })

    const statuses = await discovery.refresh()

    expect(statuses).toEqual({
      omp: { path: '/configured/omp', version: '/configured/omp-version' },
      prime: { path: null, version: null },
      pi: { path: '/usr/bin/pi', version: '/usr/bin/pi-version' },
    })
    expect(discovery.executable('omp')).toBe('/configured/omp')
    expect(detectedHarnesses(statuses)).toEqual(['omp', 'pi'])
    expect(findExecutable).toHaveBeenCalledWith(expect.objectContaining({ id: 'omp' }), '/configured/omp', expect.any(Function), expect.any(Function))
  })

  it('excludes existing but non-runnable candidates and continues discovery', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '/broken/omp', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp' || !accept) return null
          for (const candidate of ['/broken/omp', '/working/omp']) if (await accept(candidate)) return candidate
          return null
        },
        probeExecutable: async (path) => path.includes('working')
          ? { runnable: true, version: '2.0.0' }
          : { runnable: false, version: null },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: '/working/omp', version: '2.0.0' },
    })
  })

  it('prevents an older overlapping refresh from replacing newer results', async () => {
    const firstOmp = deferred<string | null>()
    let generation = 0
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp') return null
          generation += 1
          const candidate = generation === 1 ? await firstOmp.promise : '/new/omp'
          return candidate && await accept?.(candidate) ? candidate : null
        },
        probeExecutable: async () => ({ runnable: true, version: null }),
      },
    )

    const stale = discovery.refresh()
    const current = await discovery.refresh()
    firstOmp.resolve('/old/omp')

    expect(current.omp.path).toBe('/new/omp')
    await expect(stale).resolves.toMatchObject({ omp: { path: '/new/omp' } })
    expect(discovery.executable('omp')).toBe('/new/omp')
  })

  it.each([
    ['exit', { kind: 'exit', code: 1, detail: 'Node.js is too old' }],
    ['spawn', { kind: 'spawn', detail: 'path does not exist' }],
    ['timeout', { kind: 'timeout', detail: 'after 10 seconds' }],
    ['overflow', { kind: 'overflow', detail: 'output exceeded the probe limit' }],
  ] as const)('reports a %s probe failure', async (_label, failure) => {
    const probeFailure = failure as HarnessProbeFailure
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept, onFailure) => {
          if (descriptor.id !== 'pi' || !accept) return null
          await accept('/broken/pi')
          onFailure?.({ path: '/broken/pi', reason: 'probe failed', kind: 'rejected' })
          return null
        },
        probeExecutable: async () => ({ runnable: false, version: null, failure: probeFailure }),
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      pi: { path: null, version: null, problem: { path: '/broken/pi', reason: expect.stringContaining(failure.kind === 'exit' ? 'exited with code 1' : failure.kind === 'spawn' ? 'could not start' : failure.kind === 'timeout' ? 'timed out' : 'output exceeded') } },
    })
  })

  it('reports missing and non-executable configured candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-discovery-'))
    const missing = join(dir, 'missing-pi')
    const nonExecutable = join(dir, 'pi')
    writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n')
    chmodSync(nonExecutable, 0o644)
    try {
      const missingFailures: Array<{ path: string; reason: string }> = []
      await findHarnessExecutable(HARNESSES.pi, missing, async () => false, (failure) => missingFailures.push(failure))
      expect(missingFailures.find((failure) => failure.path === missing)).toEqual({ path: missing, reason: 'path does not exist', kind: 'missing' })

      const nonExecutableFailures: Array<{ path: string; reason: string }> = []
      await findHarnessExecutable(HARNESSES.pi, nonExecutable, async () => false, (failure) => nonExecutableFailures.push(failure))
      expect(nonExecutableFailures.find((failure) => failure.path === nonExecutable)).toEqual({ path: nonExecutable, reason: 'not executable', kind: 'rejected' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not report an absent automatic candidate', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'pi') onFailure?.({ path: '/automatic/pi', reason: 'path does not exist', kind: 'missing' })
          return null
        },
      },
    )

    const statuses = await discovery.refresh()
    expect(statuses).toMatchObject({
      pi: { path: null, version: null },
    })
    expect(statuses.pi.problem).toBeUndefined()
  })

  it('reports an automatic candidate that exists but is rejected', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'pi') onFailure?.({ path: '/automatic/pi', reason: 'probe failed', kind: 'rejected' })
          return null
        },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      pi: { path: null, version: null, problem: { path: '/automatic/pi', reason: 'probe failed' } },
    })
  })

  it('reports an absent configured override', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '/configured/pi' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'pi') onFailure?.({ path: '/configured/pi', reason: 'path does not exist', kind: 'missing' })
          return null
        },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      pi: { path: null, version: null, problem: { path: '/configured/pi', reason: 'path does not exist' } },
    })
  })

  it('keeps the meaningful last stderr line in a probe failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-probe-'))
    const executable = join(dir, 'pi')
    writeFileSync(executable, '#!/bin/sh\nprintf "warning noise\\n(node:123) ExperimentalWarning: noisy\\nTypeError: webidl.util.markAsUncloneable is not a function\\n" >&2\nexit 1\n')
    chmodSync(executable, 0o755)
    try {
      await expect(probeHarnessExecutable(executable)).resolves.toMatchObject({
        runnable: false,
        failure: { kind: 'exit', detail: 'TypeError: webidl.util.markAsUncloneable is not a function' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Prime implementation discovery', () => {
  const probeDirs: string[] = []
  afterEach(() => { for (const dir of probeDirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  const discoverEverything = (version: string | null, probePrimeImplementation = vi.fn(async (): Promise<PrimeImplementation> => 'rust')) => ({
    probePrimeImplementation,
    discovery: new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          const candidate = `/bin/${descriptor.id}`
          return await accept?.(candidate) ? candidate : null
        },
        probeExecutable: async () => ({ runnable: true, version }),
        probePrimeImplementation,
      },
    ),
  })

  it.each([
    ['0.10.0', 'rust'],
    ['0.7.0-gooeypi.1', 'typescript'],
  ] as const)('classifies Prime %s from its version without a feature probe', async (version, implementation) => {
    const { discovery, probePrimeImplementation: probe } = discoverEverything(version)

    const statuses = await discovery.refresh()

    expect(statuses.prime).toEqual({ path: '/bin/prime', version, implementation })
    expect(discovery.primeImplementation()).toBe(implementation)
    expect(probe).not.toHaveBeenCalled()
    // Implementation is a Prime-only field.
    expect(statuses.omp).toEqual({ path: '/bin/omp', version })
    expect(statuses.pi).toEqual({ path: '/bin/pi', version })
  })

  it.each([null, 'garbage'])('runs the feature probe when the Prime version is %j', async (version) => {
    const { discovery, probePrimeImplementation: probe } = discoverEverything(version, vi.fn(async (): Promise<PrimeImplementation> => 'typescript'))

    await expect(discovery.refresh()).resolves.toMatchObject({ prime: { path: '/bin/prime', implementation: 'typescript' } })
    expect(probe).toHaveBeenCalledExactlyOnceWith('/bin/prime')
  })

  it('reports no implementation while Prime is undiscovered', async () => {
    const discovery = new HarnessDiscoveryService(() => ({ omp: '', prime: '', pi: '' }), { findExecutable: async () => null })

    await discovery.refresh()

    expect(discovery.primeImplementation()).toBeUndefined()
  })

  const writeProbeTarget = (body: string): { executable: string; argvPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-prime-impl-'))
    probeDirs.push(dir)
    const executable = join(dir, 'prime-agent')
    const argvPath = join(dir, 'argv.json')
    writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
${body}
`)
    chmodSync(executable, 0o755)
    return { executable, argvPath }
  }

  it.each([
    ['typescript', 'accepts --extension', "process.stdout.write('0.9.8\\n')"],
    ['rust', 'rejects --extension', "process.stderr.write('Error: Unknown option: --extension\\n'); process.exit(1)"],
    ['rust', 'answers inconclusively (output overflow)', "process.stdout.write('x'.repeat(64 * 1024))"],
  ] as const)('probes %s when the executable %s, without creating the extension path', async (implementation, _label, body) => {
    const target = writeProbeTarget(body)

    await expect(probePrimeImplementation(target.executable)).resolves.toBe(implementation)

    const argv = JSON.parse(readFileSync(target.argvPath, 'utf8')) as string[]
    expect(argv).toEqual(['--extension', expect.stringMatching(/never-created\.ts$/), '--version'])
    expect(existsSync(dirname(argv[1]))).toBe(false)
  })

  it('treats an executable that cannot start as Rust', async () => {
    await expect(probePrimeImplementation(join(tmpdir(), 'gooeypi-missing-prime-agent'))).resolves.toBe('rust')
  })

  it('treats an unwritable temporary directory as inconclusive instead of failing discovery', async () => {
    const target = writeProbeTarget("process.stdout.write('0.9.8\\n')")
    vi.stubEnv('TMPDIR', join(dirname(target.executable), 'missing', 'tmp'))
    try {
      await expect(probePrimeImplementation(target.executable)).resolves.toBe('rust')
    } finally {
      vi.unstubAllEnvs()
    }
    expect(existsSync(target.argvPath)).toBe(false)
  })
})

describe('Prime npm migration bridge', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A global npm prefix holding prime-agent with the given manifest, plus a
   * Rust prefix for its receipts. Running the package entrypoint leaves a
   * marker, which is what the real bridge's installer would do much worse.
   */
  const npmLayout = (manifest: Record<string, unknown>, entrypoint: readonly string[] = ['dist', 'bundle', 'cli.js']) => {
    const root = mkdtempSync(join(tmpdir(), 'gooeypi-prime-bridge-'))
    roots.push(root)
    const packageRoot = join(root, 'npm', 'lib', 'node_modules', 'prime-agent')
    const script = join(packageRoot, ...entrypoint)
    const marker = join(root, 'executed')
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'prime-agent', ...manifest }))
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho 0.10.0\n`)
    chmodSync(script, 0o755)
    const bin = join(root, 'npm', 'bin', 'prime-agent')
    mkdirSync(dirname(bin), { recursive: true })
    symlinkSync(script, bin)
    const prefix = join(root, 'rust')
    const receipts = join(prefix, 'share', '.prime-agent-npm-bridge')
    mkdirSync(receipts, { recursive: true })
    const launcher = join(prefix, 'bin', 'prime-agent')
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(launcher, '#!/bin/sh\necho 0.10.0\n')
    chmodSync(launcher, 0o755)
    return {
      bin, launcher, marker, prefix,
      writeReceipt: (name: string) => writeFileSync(join(receipts, name), ''),
      writePayload: () => {
        mkdirSync(join(prefix, 'share', 'prime-agent'), { recursive: true })
        writeFileSync(join(prefix, 'share', 'prime-agent', 'prime-agent'), '')
      },
    }
  }
  const bridgeManifest = { version: '0.10.0', primeAgentRustBridge: true }
  const discoverPrime = (candidates: string[]) => new HarnessDiscoveryService(
    () => ({ omp: '', prime: '', pi: '' }),
    {
      findExecutable: async (descriptor, _configured, accept, onFailure) => {
        if (descriptor.id !== 'prime' || !accept) return null
        for (const candidate of candidates) {
          if (await accept(candidate)) return candidate
          onFailure?.({ path: candidate, reason: 'probe failed', kind: 'rejected' })
        }
        return null
      },
    },
  ).refresh()

  it('never executes an un-migrated bridge and reports why it was skipped', async () => {
    const layout = npmLayout(bridgeManifest)
    vi.stubEnv('PRIME_AGENT_RUST_PREFIX', layout.prefix)

    const statuses = await discoverPrime([layout.bin])

    expect(statuses.prime).toEqual({ path: null, version: null, problem: { path: layout.bin, reason: PRIME_NPM_BRIDGE_UNMIGRATED_DETAIL } })
    expect(existsSync(layout.marker)).toBe(false)
  })

  it('moves past an un-migrated bridge to a later candidate', async () => {
    const layout = npmLayout(bridgeManifest)
    vi.stubEnv('PRIME_AGENT_RUST_PREFIX', layout.prefix)

    const statuses = await discoverPrime([layout.bin, layout.launcher])

    expect(statuses.prime).toEqual({ path: layout.launcher, version: '0.10.0', implementation: 'rust' })
    expect(existsSync(layout.marker)).toBe(false)
  })

  it.each([
    ['a migrated bridge', bridgeManifest, (layout: ReturnType<typeof npmLayout>) => { layout.writeReceipt('0.10.0'); layout.writePayload() }],
    ['a bridge in TypeScript recovery', bridgeManifest, (layout: ReturnType<typeof npmLayout>) => layout.writeReceipt('0.10.0.failed')],
    ['a TypeScript npm install', { version: '0.7.0-gooeypi.1' }, () => undefined],
  ] as const)('probes %s normally', async (_label, manifest, prepare) => {
    const layout = npmLayout(manifest)
    vi.stubEnv('PRIME_AGENT_RUST_PREFIX', layout.prefix)
    prepare(layout)

    const statuses = await discoverPrime([layout.bin])

    expect(statuses.prime).toMatchObject({ path: layout.bin, version: '0.10.0' })
    expect(existsSync(layout.marker)).toBe(true)
  })

  it.each([
    ['dist', 'bundle', 'cli.js'],
    ['dist', 'bundle', 'cli-node.js'],
    ['dist', 'cli.js'],
  ])('recognizes the %s/%s entrypoint', async (...entrypoint) => {
    const layout = npmLayout(bridgeManifest, entrypoint)

    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: layout.prefix })).resolves.toBe('unmigrated')
    layout.writeReceipt('0.10.0')
    layout.writePayload()
    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: layout.prefix })).resolves.toBe('migrated')
  })

  it('reads receipts from ~/.local unless an absolute prefix is configured', async () => {
    const layout = npmLayout(bridgeManifest)
    const home = join(layout.prefix, '..', 'home')
    mkdirSync(join(home, '.local', 'share', '.prime-agent-npm-bridge'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', '.prime-agent-npm-bridge', '0.10.0.failed'), '')

    await expect(inspectPrimeNpmBridge(layout.bin, {}, home)).resolves.toBe('recovery')
    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: 'relative/prefix' }, home)).resolves.toBe('recovery')
    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: layout.prefix }, home)).resolves.toBe('unmigrated')
  })

  it('treats a bridge without a usable version as un-migrated', async () => {
    const layout = npmLayout({ version: '../0.10.0', primeAgentRustBridge: true })

    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: layout.prefix })).resolves.toBe('unmigrated')
  })

  it('skips the inspection on Windows, where the bridge does not exist', async () => {
    const layout = npmLayout(bridgeManifest)

    await expect(inspectPrimeNpmBridge(layout.bin, { PRIME_AGENT_RUST_PREFIX: layout.prefix }, undefined, 'win32')).resolves.toBe('not-bridge')
  })

  it('leaves unrelated executables alone', async () => {
    const layout = npmLayout(bridgeManifest)

    await expect(inspectPrimeNpmBridge(layout.launcher)).resolves.toBe('not-bridge')
    await expect(inspectPrimeNpmBridge(join(layout.prefix, 'missing'))).resolves.toBe('not-bridge')
  })
})
