import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from 'prime-agent'
import { EXTENSION_INJECTIONS, SHIPPED_EXTENSION_FILENAMES, type ExtensionInjection } from '../../electron/main/extension-manifest'
import type { OmpExtensionApi } from '../../assets/extensions/omp-work-browser'
import type { PiFastModeExtensionApi } from '../../assets/extensions/pi-work-fast-mode'

type Registration = { kind: 'tool' | 'command' | 'event'; name: string }

interface Fixture {
  api: object
  registrations: Registration[]
}

type PrimeFixtureApi = Pick<ExtensionAPI, 'registerTool'>
type PiFixtureApi = PiFastModeExtensionApi & Omit<OmpExtensionApi, 'typebox'>

function primeHost(): Fixture {
  const registrations: Registration[] = []
  const target: PrimeFixtureApi = {
    registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      // Model the absent optional shim that shipped files probe before using their dynamic-import fallback.
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Prime fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

function ompHost(): Fixture {
  const registrations: Registration[] = []
  const schema = (kind: string) => (...args: unknown[]) => ({ kind, args })
  const target: OmpExtensionApi = {
    typebox: {
      Type: {
        Object: schema('object'),
        String: schema('string'),
        Number: schema('number'),
        Boolean: schema('boolean'),
        Array: schema('array'),
        Enum: schema('enum'),
        Optional: schema('optional'),
      },
    },
    registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      if (!(property in object)) throw new Error(`OMP fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

function piHost(): Fixture {
  const registrations: Registration[] = []
  const target: PiFixtureApi = {
    registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) },
    registerCommand: (name: string) => { registrations.push({ kind: 'command', name }) },
    on: (event: string) => { registrations.push({ kind: 'event', name: event }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      // Model the absent optional shim that shipped files probe before using their dynamic-import fallback.
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Pi fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

const fixtureFactories = {
  prime: primeHost,
  omp: ompHost,
  pi: piHost,
}

const expectedRegistrations: Record<string, Registration[]> = {
  'prime-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-ask-user.ts': [{ kind: 'tool', name: 'ask_user' }],
  'omp-work-collaboration.ts': [
    ...['gooeypi_session_list', 'gooeypi_session_models', 'gooeypi_session_create', 'gooeypi_session_read', 'gooeypi_session_send', 'gooeypi_session_wait'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-schedules.ts': [
    ...['scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'pi-work-fast-mode.ts': [
    { kind: 'command', name: 'gooeypi-fast-mode' },
    { kind: 'event', name: 'before_provider_request' },
  ],
}

const brokerVariables: Partial<Record<ExtensionInjection['capability'], readonly [string, string]>> = {
  browser: ['PRIME_WORK_BROWSER_URL', 'PRIME_WORK_BROWSER_TOKEN'],
  schedule: ['PRIME_WORK_SCHEDULE_URL', 'PRIME_WORK_SCHEDULE_TOKEN'],
  collaboration: ['GOOEYPI_COLLABORATION_URL', 'GOOEYPI_COLLABORATION_TOKEN'],
}

const LEGACY_UNPREFIXED_TOOLS = [
  'ask_user', 'terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page',
  'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate',
  'scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring',
  'scheduled_task_update', 'scheduled_task_manage',
]

async function loadExtension(injection: ExtensionInjection, configured: boolean) {
  vi.resetModules()
  vi.unstubAllEnvs()
  const variables = brokerVariables[injection.capability]
  if (configured && variables) {
    vi.stubEnv(variables[0], 'http://127.0.0.1:1/')
    vi.stubEnv(variables[1], 'inert-test-token')
  }
  const url = pathToFileURL(join(process.cwd(), 'assets', 'extensions', injection.filename)).href
  return (await import(url)).default as (api: object) => void | Promise<void>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('shipped extension contracts', () => {
  it('initializes every manifest injection against its genuine host surface', async () => {
    for (const filename of SHIPPED_EXTENSION_FILENAMES) {
      expect(expectedRegistrations[filename], `Missing registration contract for ${filename}`).toBeDefined()
    }
    for (const [harness, injections] of Object.entries(EXTENSION_INJECTIONS)) {
      for (const injection of injections) {
        for (const configured of [false, true]) {
          const fixture = fixtureFactories[harness as keyof typeof fixtureFactories]()
          const factory = await loadExtension(injection, configured)
          await factory(fixture.api)
          const expected = expectedRegistrations[injection.filename]
          expect(fixture.registrations, `${harness}/${injection.filename} configured=${configured}`).toEqual(
            configured || !brokerVariables[injection.capability] ? expected : [],
          )
        }
      }
    }
  })

  it('rejects an extension that reaches for a capability its host does not inject', () => {
    const badExtension = (api: OmpExtensionApi) => {
      api.typebox!.Type.Object({})
    }
    expect(() => badExtension(ompHost().api as OmpExtensionApi)).not.toThrow()
    expect(() => badExtension(primeHost().api as OmpExtensionApi)).toThrow()
    expect(() => badExtension(piHost().api as OmpExtensionApi)).toThrow()
  })

  it('keeps tool registrations namespaced', () => {
    // The allow-list only shrinks as legacy tools are renamed. See #192.
    for (const registrations of Object.values(expectedRegistrations)) {
      for (const registration of registrations) {
        if (registration.kind !== 'tool') continue
        expect(registration.name.startsWith('gooeypi_') || LEGACY_UNPREFIXED_TOOLS.includes(registration.name)).toBe(true)
      }
    }
  })

  it('rejects properties outside each host fixture from the proxy trap', () => {
    for (const [harness, factory] of Object.entries(fixtureFactories)) {
      const fixture = factory()
      expect(() => Reflect.get(fixture.api, 'unsupportedCapability'), harness).toThrow(`${harness === 'prime' ? 'Prime' : harness === 'omp' ? 'OMP' : 'Pi'} fixture does not inject unsupportedCapability`)
    }
  })

  it('derives the shipped inventory from the actual extension directory', () => {
    const actual = readdirSync(join(process.cwd(), 'assets', 'extensions'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort()
    expect(SHIPPED_EXTENSION_FILENAMES).toEqual(actual)
  })
})
