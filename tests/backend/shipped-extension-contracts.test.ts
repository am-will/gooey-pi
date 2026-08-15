import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHIPPED_EXTENSION_FILES, SHIPPED_EXTENSIONS, assertPackagedExtensionSet, assertSourceExtensionSet } from '../../scripts/release/extension-inventory.mjs'

type ExtensionHost = 'prime' | 'omp' | 'pi'

interface InventoryEntry {
  file: string
  hosts: readonly ExtensionHost[]
  brokerEnvironment: readonly string[]
  registrations: {
    tools: readonly string[]
    commands: readonly string[]
    events: readonly string[]
  }
}

interface ExtensionModule {
  default(api: object): void | Promise<void>
}

interface Registrations {
  tools: string[]
  commands: string[]
  events: string[]
}

const EXPECTED_EXTENSION_FILES = ['omp-work-ask-user.ts', 'omp-work-browser.ts', 'omp-work-collaboration.ts', 'omp-work-schedules.ts', 'pi-work-fast-mode.ts', 'prime-work-browser.ts'] as const

const EXPECTED_EXTENSION_HOSTS: Record<(typeof EXPECTED_EXTENSION_FILES)[number], readonly ExtensionHost[]> = {
  'omp-work-ask-user.ts': ['prime', 'omp', 'pi'],
  'omp-work-browser.ts': ['omp', 'pi'],
  'omp-work-collaboration.ts': ['prime', 'omp', 'pi'],
  'omp-work-schedules.ts': ['omp', 'pi'],
  'pi-work-fast-mode.ts': ['pi'],
  'prime-work-browser.ts': ['prime'],
}

const EXTENSION_LOADERS: Record<string, () => Promise<ExtensionModule>> = {
  'omp-work-ask-user.ts': async () => (await import('../../assets/extensions/omp-work-ask-user')) as unknown as ExtensionModule,
  'omp-work-browser.ts': async () => (await import('../../assets/extensions/omp-work-browser')) as unknown as ExtensionModule,
  'omp-work-collaboration.ts': async () => (await import('../../assets/extensions/omp-work-collaboration')) as unknown as ExtensionModule,
  'omp-work-schedules.ts': async () => (await import('../../assets/extensions/omp-work-schedules')) as unknown as ExtensionModule,
  'pi-work-fast-mode.ts': async () => (await import('../../assets/extensions/pi-work-fast-mode')) as unknown as ExtensionModule,
  'prime-work-browser.ts': async () => (await import('../../assets/extensions/prime-work-browser')) as unknown as ExtensionModule,
}

const inventory = SHIPPED_EXTENSIONS as readonly InventoryEntry[]

function fakeTypebox() {
  const schema =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args })
  return {
    Type: {
      Object: schema('object'),
      String: schema('string'),
      Number: schema('number'),
      Boolean: schema('boolean'),
      Array: schema('array'),
      Enum: schema('enum'),
      Optional: schema('optional'),
    },
  }
}

function configureBroker(entry: InventoryEntry, available: boolean): void {
  for (const name of entry.brokerEnvironment) {
    const value = available ? (name.endsWith('_URL') ? 'http://127.0.0.1:1/' : 'test-only-broker-token') : (undefined as unknown as string)
    vi.stubEnv(name, value)
  }
}

async function initialize(entry: InventoryEntry, host: ExtensionHost, brokerAvailable: boolean): Promise<Registrations> {
  vi.resetModules()
  configureBroker(entry, brokerAvailable)
  const network = vi.fn(() => {
    throw new Error('Extension initialization must not use the network')
  })
  vi.stubGlobal('fetch', network)

  const registrations: Registrations = { tools: [], commands: [], events: [] }
  const api: Record<string, unknown> = {
    registerTool: (tool: { name: string }) => {
      registrations.tools.push(tool.name)
    },
    registerCommand: (name: string) => {
      registrations.commands.push(name)
    },
    on: (event: string) => {
      registrations.events.push(event)
    },
  }
  if (host === 'omp') api.typebox = fakeTypebox()

  const extension = await EXTENSION_LOADERS[entry.file]()
  await extension.default(api)
  expect(network).not.toHaveBeenCalled()
  return registrations
}

function writePackagedExtensions(resources: string): string {
  const directory = join(resources, 'extensions')
  mkdirSync(directory, { recursive: true })
  for (const file of EXPECTED_EXTENSION_FILES) writeFileSync(join(directory, file), '// fixture\n')
  return directory
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('shipped extension inventory', () => {
  it('matches every source file and the package resource mapping exactly', () => {
    const sourceFiles = readdirSync(resolve('assets/extensions'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    expect(SHIPPED_EXTENSION_FILES).toEqual(EXPECTED_EXTENSION_FILES)
    expect(sourceFiles).toEqual(EXPECTED_EXTENSION_FILES)
    expect(() => assertSourceExtensionSet()).not.toThrow()

    const packageJson = JSON.parse(readFile('package.json')) as {
      build: { extraResources: Array<{ from: string; to: string }> }
    }
    expect(packageJson.build.extraResources.filter((resource) => resource.to === 'extensions')).toEqual([{ from: 'assets/extensions', to: 'extensions' }])
  })

  it('requires a smoke loader for every inventoried extension', () => {
    expect(Object.keys(EXTENSION_LOADERS).sort()).toEqual([...SHIPPED_EXTENSION_FILES])
  })

  it('requires the canonical non-empty host matrix for every inventoried extension', () => {
    expect(Object.fromEntries(inventory.map((entry) => [entry.file, entry.hosts]))).toEqual(EXPECTED_EXTENSION_HOSTS)
    expect(inventory.every((entry) => entry.hosts.length > 0)).toBe(true)
  })

  it('uses a strict isolated TypeScript project and includes extensions in lint and format checks', () => {
    const config = JSON.parse(readFile('tsconfig.extensions.json')) as {
      compilerOptions: { strict?: boolean; noEmit?: boolean; lib?: string[]; types?: string[] }
      include?: string[]
    }
    const packageJson = JSON.parse(readFile('package.json')) as { scripts: Record<string, string> }
    expect(config.compilerOptions).toMatchObject({ strict: true, noEmit: true, lib: ['ES2022'], types: ['node'] })
    expect(config.include).toEqual(['assets/extensions/**/*.ts'])
    expect(config.compilerOptions.lib).not.toContain('DOM')
    expect(config.compilerOptions.types).not.toContain('electron')
    expect(packageJson.scripts.typecheck).toContain('tsc --noEmit -p tsconfig.extensions.json')
    expect(packageJson.scripts.lint).toContain('assets/extensions')
    expect(packageJson.scripts['format:check']).toContain('assets/extensions')
  })

  it('wires exact resource-set verification into every platform package verifier', () => {
    for (const path of ['scripts/release/verify-package.mjs', 'scripts/release/verify-cross-platform-package.mjs']) {
      const source = readFile(path)
      expect(source).toContain("from './extension-inventory.mjs'")
      expect(source).toContain('assertPackagedExtensionSet(resources)')
    }
  })

  it('accepts only the exact packaged extension set', () => {
    const resources = mkdtempSync(join(tmpdir(), 'gooeypi-extension-package-'))
    try {
      const extensions = writePackagedExtensions(resources)
      expect(() => assertPackagedExtensionSet(resources)).not.toThrow()

      unlinkSync(join(extensions, 'prime-work-browser.ts'))
      expect(() => assertPackagedExtensionSet(resources)).toThrow(/missing: prime-work-browser\.ts/)
      writeFileSync(join(extensions, 'prime-work-browser.ts'), '// fixture\n')

      writeFileSync(join(extensions, 'unreviewed-extension.ts'), '// fixture\n')
      expect(() => assertPackagedExtensionSet(resources)).toThrow(/extra: unreviewed-extension\.ts/)
      unlinkSync(join(extensions, 'unreviewed-extension.ts'))

      mkdirSync(join(extensions, 'nested-extension'))
      expect(() => assertPackagedExtensionSet(resources)).toThrow(/non-file: nested-extension/)
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })
})

describe('shipped extension host-contract smoke fixtures', () => {
  it.each(inventory.flatMap((entry) => entry.hosts.map((host) => ({ entry, host }))))('imports and initializes $entry.file on $host without network access', async ({ entry, host }) => {
    expect(await initialize(entry, host, true)).toEqual(entry.registrations)
  })

  it.each(
    inventory
      .filter((entry) => entry.brokerEnvironment.length > 0)
      .flatMap((entry) => entry.hosts.map((host) => ({ entry, host }))),
  )('$entry.file registers nothing on $host when its broker claim is unavailable', async ({ entry, host }) => {
    expect(await initialize(entry, host, false)).toEqual({ tools: [], commands: [], events: [] })
  })
})

function readFile(path: string): string {
  return readFileSync(path, 'utf8')
}
