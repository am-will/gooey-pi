import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_TTL_MS, type ModelCatalogProvider } from '../../electron/main/model-catalog'
import { CATALOG_CACHE_FILE_NAME, JsonModelCatalogCache } from '../../electron/main/model-catalog-cache'
import type { CliModelCatalogOptions } from '../../electron/main/model-catalog-cli'
import type { ExecutableSource } from '../../electron/main/process-utils'
import { PI_CATALOG_TIMEOUT_MS, PI_NOT_INSTALLED_WARNING, PiModelCatalogService, MAX_CATALOG_PROVIDERS } from '../../electron/main/providers-pi'
import type { PrimeModelCatalog } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-pi-'))
  dirs.push(dir)
  return dir
}

/**
 * Every probe here is answered by a fake binary that writes its frames as soon as the request lands,
 * so no test needs the production 60s budget. Pinning a moderate one keeps a spawn starved by a loaded
 * worker from parking a child for a minute after vitest has already moved on to the next file -- which
 * is how one slow suite used to leak timeouts into unrelated suites -- while still leaving room for a
 * node process to boot under contention.
 */
const TEST_PROBE_TIMEOUT_MS = 10_000

function piService(executable: ExecutableSource, options: Omit<CliModelCatalogOptions, 'timeoutMs'> & { timeoutMs?: number } = {}): PiModelCatalogService {
  return new PiModelCatalogService(executable, { timeoutMs: TEST_PROBE_TIMEOUT_MS, ...options })
}

/**
 * Fabricates a fake pi RPC binary as an executable node script, mirroring the
 * fake-omp pattern in providers-omp.test.ts. The body runs once the probe's
 * `get_available_models` request has arrived on stdin, so every scenario also
 * proves the request was written. Happy-path bodies write their frames and
 * rely on the probe's settle cleanup to terminate the child.
 */
function fakePi(body: string, dir = tempDir()): string {
  const executable = join(dir, 'fake-pi.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('0.84.1\\n'); process.exit(0) }
if (process.argv[2] !== '--mode' || process.argv[3] !== 'rpc' || process.argv[4] !== '--no-session' || process.argv[5] !== '--offline') { process.exit(2) }
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf('\\n')
  if (newline === -1) return
  let request
  try { request = JSON.parse(buffer.slice(0, newline)) } catch { process.exit(4) }
  if (request.type !== 'get_available_models' || request.id !== '1') process.exit(3)
  onRequest()
})
function onRequest() {
${body}
}
`)
  chmodSync(executable, 0o755)
  return executable
}

/** Fake pi that answers the probe with the given data, preceded by the noise lines a real pi stream may carry. */
function fakePiWithCatalog(payload: unknown, dir?: string): string {
  return fakePi(`
process.stdout.write('pi startup noise, not json\\n')
process.stdout.write(JSON.stringify({ type: 'event', name: 'unrelated' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'response', id: '2', command: 'other', success: true }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(payload)} }) + '\\n')
`, dir)
}

const sampleCatalog = {
  models: [
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api/codex', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 128_000, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' } },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', api: 'google-generative-ai', provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoning: true, input: ['text', 'image'], cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536, thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' } },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', api: 'google-generative-ai', provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoning: true, input: ['text', 'image'], cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', api: 'google-generative-ai', provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoning: false, input: ['text', 'image'], cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 8_192 },
  ],
}

const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

function expectRelationalIntegrity(catalog: PrimeModelCatalog): void {
  const providerIds = catalog.providers.map((provider) => provider.id)
  expect(new Set(providerIds).size).toBe(providerIds.length)
  const providerIdSet = new Set(providerIds)
  for (const model of catalog.models) expect(providerIdSet.has(model.provider)).toBe(true)
  for (const provider of catalog.providers) {
    const models = catalog.models.filter((model) => model.provider === provider.id)
    expect(provider.modelCount).toBe(models.length)
    expect(provider.availableModelCount).toBe(models.filter((model) => model.available).length)
  }
}

function piModel(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: `${provider} ${id}`, reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1 }
}

describe('Pi model catalog service', () => {
  it('invalidates the unavailable cache when discovery finds an executable', async () => {
    let executable: string | null = null
    const service = piService(() => executable)
    await expect(service.catalog()).resolves.toMatchObject({ models: [], warning: PI_NOT_INSTALLED_WARNING })

    executable = fakePiWithCatalog(sampleCatalog)
    await expect(service.catalog()).resolves.toMatchObject({ primeVersion: '0.84.1', models: expect.any(Array) })
  })

  it('parses the RPC probe response into Prime descriptor shapes, skipping noise lines', async () => {
    const service: ModelCatalogProvider = piService(fakePiWithCatalog(sampleCatalog))
    const catalog = await service.catalog(true)

    expect(catalog.primeVersion).toBe('0.84.1')
    expect(catalog.warning).toBeUndefined()
    expect(catalog.models.map((model) => model.key)).toEqual([
      'openai-codex/gpt-5.6-luna',
      'google/gemini-3-pro-preview',
      'google/gemini-2.5-pro',
      'google/gemini-2.0-flash',
    ])

    const luna = catalog.models[0]
    expect(luna.name).toBe('GPT-5.6 Luna')
    expect(luna.contextWindow).toBe(272_000)
    expect(luna.maxTokens).toBe(128_000)
    expect(luna.reasoning).toBe(true)
    expect(luna.input).toEqual(['text'])
    // xhigh and max are named by the map, minimal is remapped (not null), and
    // the unmapped defaults stay supported: the full pi ladder.
    expect(luna.availableThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(luna.fastModeSupported).toBe(true)
    expect(luna.available).toBe(true)

    // Levels mapped to null are unsupported; xhigh/max are absent from the map.
    const geminiPro = catalog.models[1]
    expect(geminiPro.availableThinkingLevels).toEqual(['low', 'high'])

    // No map at all: every non-extended level, but never xhigh/max.
    const gemini25 = catalog.models[2]
    expect(gemini25.availableThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])

    const flash = catalog.models[3]
    expect(flash.reasoning).toBe(false)
    expect(flash.availableThinkingLevels).toEqual(['off'])

    expect(catalog.providers.map((provider) => provider.id)).toEqual(['google', 'openai-codex'])
    const google = catalog.providers[0]
    expect(google.authMethod).toBe('external')
    expect(google.configured).toBe(true)
    expect(google.authLabel).toBe('Credentials managed by the pi CLI')
    expect(google.modelCount).toBe(3)
    expect(google.availableModelCount).toBe(3)
    expect(google.enabled).toBe(true)
    const cached = await service.catalog()
    expect(cached.models).toEqual(catalog.models)
    expect(cached.providers).toEqual(catalog.providers)
  })

  it('resolves availability, capabilities, and desktop provider enablement', async () => {
    const service = piService(fakePiWithCatalog(sampleCatalog))

    const model = await service.requireAvailableModel('openai-codex/gpt-5.6-luna')
    expect(model.provider).toBe('openai-codex')
    expect(model.id).toBe('gpt-5.6-luna')

    await expect(service.requireAvailableModel('nope/none')).rejects.toThrow(/not found in the Pi catalog/)
    await expect(service.requireAvailableModel('google/gemini-2.5-pro', new Set(['google']))).rejects.toThrow(/disabled/)
    await expect(service.requireAvailableModel('openai-codex/gpt-5.6-luna', new Set(), new Set(['openai-codex/gpt-5.6-luna']))).rejects.toThrow(/disabled/)
    const disabledView = await service.catalog(false, new Set(['google']))
    expect(disabledView.providers.find((provider) => provider.id === 'google')?.enabled).toBe(false)
    expect(disabledView.providers.find((provider) => provider.id === 'openai-codex')?.enabled).toBe(true)
    expect((await service.catalog(false, new Set(), new Set(['openai-codex/gpt-5.6-luna']))).models.find((candidate) => candidate.key === 'openai-codex/gpt-5.6-luna')?.enabled).toBe(false)

    expect(await service.capabilities('google', 'gemini-2.5-pro')).toMatchObject({ key: 'google/gemini-2.5-pro' })
    expect(await service.capabilities('google', undefined)).toBeUndefined()
    expect(await service.capabilities(undefined, 'gemini-2.5-pro')).toBeUndefined()
  })

  it('passes the user environment to its probe without the Rust Prime opt-out', async () => {
    vi.stubEnv('PRIME_AGENT_TELEMETRY', '1')
    try {
      const service = piService(fakePi(`
const model = { ...${JSON.stringify(sampleCatalog.models[0])}, id: 'env-' + (process.env.PRIME_AGENT_TELEMETRY ?? 'unset') }
process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: { models: [model] } }) + '\\n')
`))
      expect((await service.catalog(true)).models.map((model) => model.id)).toEqual(['env-1'])
    } finally { vi.unstubAllEnvs() }
  })

  it('returns an empty catalog with a clear status when pi is not installed', async () => {
    const service = piService(null)
    const catalog = await service.catalog(true)

    expect(catalog.models).toEqual([])
    expect(catalog.providers).toEqual([])
    expect(catalog.warning).toBe(PI_NOT_INSTALLED_WARNING)
    expect(catalog.primeVersion).toBe('unknown')
    await expect(service.requireAvailableModel('google/gemini-2.5-pro')).rejects.toThrow(/not found/)
  })

  it('terminates a pi that lingers after answering the probe', async () => {
    const pidFile = join(tempDir(), 'pi.pid')
    const executable = fakePi(`
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(sampleCatalog)} }) + '\\n')
setInterval(() => {}, 1000)
`)
    const service = piService(executable)
    const catalog = await service.catalog(true)
    expect(catalog.models).toHaveLength(4)

    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    await waitUntil(() => !processExists(pid))
  })

  it('rejects a probe that pi answers with success:false, bounding the untrusted error text', async () => {
    const service = piService(fakePi(`
process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: false, error: 'boom\\u0007\\u001b[31mhostile' }) + '\\n')
`))
    const error = await service.catalog(true).then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/rejected the model catalog request: boom/)
    // The bell and ANSI escape control characters were stripped.
    expect([...(error as Error).message].some((character) => character.charCodeAt(0) <= 0x1f)).toBe(false)
    expect((error as Error).message).toContain('hostile')
  })

  it('rejects a pi that exits without ever answering the probe', async () => {
    // Exit explicitly after the flush: the probe holds stdin open, so a fake
    // that merely stops writing would idle until the timeout instead.
    const service = piService(fakePi("process.stdout.write('not json {{\\n', () => process.exit(0))"))
    await expect(service.catalog(true)).rejects.toThrow(/without answering the model catalog probe/)
    await expect(service.catalog()).rejects.toThrow(/without answering/)
  })

  it('keeps stdin open so a pi that exits on EOF can still answer the probe', async () => {
    // Real pi 0.82.x/0.83.x treats stdin EOF as client-disconnect and can shut
    // down before processing a request that arrived in the same flush. This
    // fake answers only after a delay, and exits the moment stdin ends.
    const service = piService(fakePi(`
process.stdin.on('end', () => process.exit(0))
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(sampleCatalog)} }) + '\\n')
}, 200)
`))
    const catalog = await service.catalog(true)
    expect(catalog.models).toHaveLength(4)
  })

  it('rejects a matching response with an unexpected data shape', async () => {
    const service = piService(fakePiWithCatalog({ models: 'nope' }))
    await expect(service.catalog(true)).rejects.toThrow(/unexpected model catalog shape/)
    const arrayService = piService(fakePiWithCatalog([1, 2, 3]))
    await expect(arrayService.catalog(true)).rejects.toThrow(/unexpected model catalog shape/)
  })

  it('rejects oversized probe output at the byte cap', async () => {
    const executable = fakePi("process.stdout.write('x'.repeat(256 * 1024)); setInterval(() => {}, 1000)")
    const service = piService(executable, { maxOutputBytes: 4_096 })
    await expect(service.catalog(true)).rejects.toThrow(/output exceeded/)
  })

  it('kills a hung pi at the timeout', async () => {
    const pidFile = join(tempDir(), 'pi.pid')
    const executable = fakePi(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const service = piService(executable, { timeoutMs: 3_000 })

    const pending = expect(service.catalog(true)).rejects.toThrow(/timed out/)
    // The pid file must exist before the timeout fires, or a slow test host
    // could kill the child before it ever wrote the file.
    await waitUntil(() => existsSync(pidFile))
    await pending
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    await waitUntil(() => !processExists(pid))
  })

  it('caches within the TTL and single-flights concurrent refreshes', async () => {
    const counterFile = join(tempDir(), 'runs')
    const executable = fakePi(`
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(counterFile)}, 'x')
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(sampleCatalog)} }) + '\\n')
}, 50)
`)
    const service = piService(executable)
    const runs = () => { try { return readFileSync(counterFile, 'utf8').length } catch { return 0 } }

    const [first, second, third] = await Promise.all([
      service.catalog(true),
      service.catalog(true),
      service.catalog(true, new Set(['google'])),
    ])
    expect(runs()).toBe(1)
    expect(first.models.length).toBe(second.models.length)
    expect(third.providers.find((provider) => provider.id === 'google')?.enabled).toBe(false)
    expect(first.providers.find((provider) => provider.id === 'google')?.enabled).toBe(true)

    // Within the TTL an unforced call serves the cache without a new spawn.
    await service.catalog()
    expect(runs()).toBe(1)

    // After settling, a forced refresh spawns again (the in-flight slot was cleared).
    await service.catalog(true)
    expect(runs()).toBe(2)
  })

  it('serves the last good catalog with a warning when a refresh fails', async () => {
    const stateFile = join(tempDir(), 'mode')
    // First run answers; every later run exits non-zero without responding.
    const executable = fakePi(`
const fs = require('node:fs')
if (fs.existsSync(${JSON.stringify(stateFile)})) process.exit(7)
fs.writeFileSync(${JSON.stringify(stateFile)}, 'ran')
process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(sampleCatalog)} }) + '\\n')
`)
    const service = piService(executable)
    const fresh = await service.catalog(true)
    expect(fresh.warning).toBeUndefined()

    const stale = await service.catalog(true)
    expect(stale.models.length).toBe(fresh.models.length)
    expect(stale.warning).toMatch(/could not be refreshed/)
    expect(stale.warning).toMatch(/last loaded catalog/)

    // With no prior catalog the failure still surfaces.
    const failingOnly = piService(fakePi('process.exit(7)'))
    await expect(failingOnly.catalog(true)).rejects.toThrow(/exited with status 7 without answering/)
  })

  it('runs pi again after invalidate, and a refresh already in flight never fills the cache', async () => {
    const counterFile = join(tempDir(), 'runs')
    // The first run answers slowly with one model; later runs answer at once with four.
    const executable = fakePi(`
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(counterFile)}, 'x')
const first = fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8').length === 1
const data = first ? { models: ${JSON.stringify(sampleCatalog.models.slice(0, 1))} } : ${JSON.stringify(sampleCatalog)}
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data }) + '\\n')
}, first ? 400 : 0)
`)
    const service = piService(executable)
    const runs = () => { try { return readFileSync(counterFile, 'utf8').length } catch { return 0 } }

    const inFlight = service.catalog(true)
    await waitUntil(() => runs() === 1)
    service.invalidate()
    const fresh = await service.catalog()
    expect(fresh.models).toHaveLength(4)
    // The older refresh still answers its own caller...
    expect((await inFlight).models).toHaveLength(1)
    // ...but the cache keeps the newer catalog, served within the TTL without another run.
    expect((await service.catalog()).models).toHaveLength(4)
    expect(runs()).toBe(2)
  })

  it('rejects hostile model entries and sanitizes suspicious fields', async () => {
    const service = piService(fakePiWithCatalog({
      models: [
        sampleCatalog.models[0],
        'not-an-object',
        null,
        ['nested', 'array'],
        { provider: '../evil', id: 'escape', name: 'Bad provider' },
        { provider: 'google', id: 'bad id with spaces', name: 'Bad id' },
        { provider: 'google', id: 'no-name', name: 42 },
        { provider: 'google', id: 'bad-reasoning', name: 'Bad reasoning', reasoning: 'yes' },
        { provider: 'google', id: 'bad-map-string', name: 'Bad map', reasoning: true, thinkingLevelMap: 'high' },
        { provider: 'google', id: 'bad-map-array', name: 'Bad map', reasoning: true, thinkingLevelMap: ['low'] },
        { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Duplicate key' },
        {
          provider: 'zai',
          id: 'glm-5',
          name: `Padded${'x'.repeat(2_000)}`,
          reasoning: true,
          // Hostile map values: objects and numbers are treated as absent, so
          // xhigh (number) stays off while max (string) is admitted; medium
          // (null) is unsupported; off's hostile object leaves it supported.
          thinkingLevelMap: { off: { hostile: true }, medium: null, xhigh: 42, max: 'max' },
          input: ['text', 'video', { type: 'image' }],
          contextWindow: '200000',
          maxTokens: -5,
        },
      ],
    }))
    const catalog = await service.catalog(true)

    expect(catalog.models.map((model) => model.key)).toEqual(['openai-codex/gpt-5.6-luna', 'zai/glm-5'])
    expect(catalog.models[0].name).toBe('GPT-5.6 Luna')
    const glm = catalog.models[1]
    expect(glm.name.length).toBe(500)
    expect(glm.availableThinkingLevels).toEqual(['off', 'minimal', 'low', 'high', 'max'])
    expect(glm.input).toEqual(['text'])
    expect(glm.contextWindow).toBe(0)
    expect(glm.maxTokens).toBe(0)
    expect(catalog.warning).toMatch(/could not validate/)
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['openai-codex', 'zai'])
  })

  it('keeps an exact-boundary catalog unchanged and relationally consistent', async () => {
    const models: unknown[] = []
    for (let index = 0; index < MAX_CATALOG_PROVIDERS; index += 1) {
      models.push(piModel(`provider-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = MAX_CATALOG_PROVIDERS; index < 5_000; index += 1) {
      models.push(piModel('provider-000', `model-${index}`))
    }

    const service = piService(fakePiWithCatalog({ models }))
    const catalog = await service.catalog(true)

    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.warning).toBeUndefined()
    expectRelationalIntegrity(catalog)
  })

  it('caps provider-only overflow without returning orphan models', async () => {
    const models = Array.from({ length: MAX_CATALOG_PROVIDERS + 1 }, (_, index) => (
      piModel(`provider-${String(index).padStart(3, '0')}`, 'model')
    ))
    const service = piService(fakePiWithCatalog({ models }))
    const catalog = await service.catalog(true)

    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.models).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.warning).toMatch(/257 valid providers.*retained 256.*1 omitted/)
    expect(catalog.warning).toMatch(/257 valid unique models.*retained 256.*1 omitted/)
    expect(catalog.warning).toContain('1 omitted by catalog limits: 1 with omitted providers and 0 beyond the model limit')
    expectRelationalIntegrity(catalog)
    await expect(service.requireAvailableModel('provider-256/model')).rejects.toThrow(/not found/)
    expect(await service.capabilities('provider-256', 'model')).toBeUndefined()
  })

  it('caps model-only overflow while keeping visibility and launch validation aligned', async () => {
    const models = Array.from({ length: 5_001 }, (_, index) => piModel('provider-000', `model-${index}`))
    const service = piService(fakePiWithCatalog({ models }))
    const catalog = await service.catalog(true, new Set(), new Set(['provider-000/model-0']))

    expect(catalog.providers).toHaveLength(1)
    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.models[0]?.enabled).toBe(false)
    expect(catalog.warning).toMatch(/5,001 valid unique models.*retained 5,000.*1 omitted/)
    expect(catalog.warning).toContain('1 omitted by catalog limits: 0 with omitted providers and 1 beyond the model limit')
    expectRelationalIntegrity(catalog)
    await expect(service.requireAvailableModel('provider-000/model-5000')).rejects.toThrow(/not found/)
    await expect(service.requireAvailableModel('provider-000/model-0', new Set(), new Set(['provider-000/model-0']))).rejects.toThrow(/disabled/)
  })

  it('applies simultaneous model and provider caps as one relational operation', async () => {
    const models: unknown[] = []
    for (let index = 0; index < 300; index += 1) {
      models.push(piModel(`overflow-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = 0; index < 5_010; index += 1) {
      models.push(piModel('google', `model-${index}`))
    }
    const service = piService(fakePiWithCatalog({ models }))
    const catalog = await service.catalog(true)

    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    const names = catalog.providers.map((provider) => provider.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(catalog.warning).toMatch(/301 valid providers.*retained 256.*45 omitted/)
    expect(catalog.warning).toMatch(/5,310 valid unique models.*retained 5,000.*310 omitted/)
    expect(catalog.warning).toContain('310 omitted by catalog limits: 45 with omitted providers and 265 beyond the model limit')
    expectRelationalIntegrity(catalog)
    expect(catalog.models.some((model) => model.provider === 'overflow-299')).toBe(false)
    await expect(service.requireAvailableModel('overflow-299/model')).rejects.toThrow(/not found/)
  })
  it('decodes split UTF-8 and an unterminated final response without losing model text', async () => {
    const models = [{ provider: 'test', id: 'test-model', name: '日本語 model', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100 }]
    const frame = JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: { models } })
    const executable = fakePi(`const bytes = Buffer.from(${JSON.stringify(frame)}); let index = 0; const timer = setInterval(() => { if (index === bytes.length) { clearInterval(timer); process.exit(0) } else process.stdout.write(bytes.subarray(index, ++index)) }, 1)`)
    expect((await piService(executable).catalog()).models[0].name).toBe('日本語 model')
  })

  // A real pi with the user's extension set takes 11.4-24.0s to answer the probe, and ~25.9s
  // when another pi starts alongside it, so the watchdog must sit outside that band rather than
  // inside it -- which is what made the very first fetch of a run fail and leave the model list empty.
  it('gives the pi probe a watchdog above the measured cold start', () => {
    expect(PI_CATALOG_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  describe('last good catalog persisted to disk', () => {
    it('writes the last good catalog into the cache file', async () => {
      const dir = tempDir()
      await piService(fakePiWithCatalog(sampleCatalog), { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' }).catalog(true)
      const persisted = JSON.parse(readFileSync(join(dir, CATALOG_CACHE_FILE_NAME), 'utf8'))
      expect(persisted.version).toBe(1)
      expect(persisted.catalogs.pi.catalog.models.length).toBe(sampleCatalog.models.length)
      expect(persisted.catalogs.pi.executable).toContain('fake-pi.cjs')
      expect(typeof persisted.catalogs.pi.cachedAt).toBe('number')
    })

    it('serves the catalog from disk without starting pi at all while it is still fresh', async () => {
      const dir = tempDir()
      // One executable path for both services, because the cache is keyed on it: what changes between
      // the two launches is whether pi answers, not where pi lives.
      const executable = fakePiWithCatalog(sampleCatalog, dir)
      const fresh = await piService(executable, { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' }).catalog(true)

      // A second service stands in for an app relaunch. pi is replaced with a script that dies
      // immediately, so the call resolving at all proves no probe was started: the model picker is
      // populated from disk rather than waiting on a CLI that would have failed it.
      fakePi('process.exit(1)', dir)
      const restarted = piService(executable, { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' })
      const catalog = await restarted.catalog()
      expect(catalog.models.map((model) => model.key)).toEqual(fresh.models.map((model) => model.key))
      expect(catalog.warning).toBeUndefined()
      expectRelationalIntegrity(catalog)
    })

    it('serves the persisted catalog with a warning when the first probe of the run dies', async () => {
      const dir = tempDir()
      const executable = fakePiWithCatalog(sampleCatalog, dir)
      const fresh = await piService(executable, { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' }).catalog(true)

      // The same relaunch past the TTL does probe, and the probe dies -- the failure used to reject the
      // very first fetch of the run and leave the picker on "No model available".
      fakePi('process.exit(1)', dir)
      const restarted = piService(executable, {
        diskCache: new JsonModelCatalogCache(dir),
        cacheKey: 'pi',
        now: () => Date.now() + CATALOG_TTL_MS + 1_000,
      })
      const catalog = await restarted.catalog()
      expect(catalog.models.map((model) => model.key)).toEqual(fresh.models.map((model) => model.key))
      expect(catalog.warning).toMatch(/could not be refreshed/)
      expectRelationalIntegrity(catalog)
    })

    it('does not serve a catalog persisted for a different executable path', async () => {
      const dir = tempDir()
      await piService(fakePiWithCatalog(sampleCatalog), { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' }).catalog(true)
      await expect(piService(fakePi('process.exit(1)'), { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' })
        .catalog()).rejects.toThrow(/without answering the model catalog probe/)
    })

    it('ignores a cache file that another process left malformed', async () => {
      const dir = tempDir()
      writeFileSync(join(dir, CATALOG_CACHE_FILE_NAME), '{truncated')
      const catalog = await piService(fakePiWithCatalog(sampleCatalog), { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' }).catalog()
      expect(catalog.models.length).toBe(sampleCatalog.models.length)
    })

    it('drops cached models whose key does not match their provider and id', async () => {
      const dir = tempDir()
      const executable = fakePi('process.exit(1)', dir)
      writeFileSync(join(dir, CATALOG_CACHE_FILE_NAME), JSON.stringify({
        version: 1,
        catalogs: { pi: {
          executable,
          cachedAt: Date.now(),
          // A key that disagrees with its parts is treated as tampered and dropped; a non-numeric
          // context window is repaired rather than dropped, so one bad field cannot cost a model.
          catalog: { primeVersion: '1', refreshedAt: 'now', models: [{ key: 'wrong/key', provider: 'test', id: 'ok', name: 'Ok', reasoning: false, input: ['text'], contextWindow: 10, maxTokens: 1, available: true }, { key: 'test/ok', provider: 'test', id: 'ok', name: 'Ok', reasoning: false, input: ['text'], contextWindow: 'wide', maxTokens: 1, available: true }], providers: [] }
        } } }
      ))
      const service = piService(executable, { diskCache: new JsonModelCatalogCache(dir), cacheKey: 'pi' })
      const catalog = await service.catalog()
      expect(catalog.models.map((model) => model.key)).toEqual(['test/ok'])
      expect(catalog.models[0]?.contextWindow).toBe(0)
    })
  })

  it('serves a stale catalog at once and refreshes it in the background', async () => {
    const dir = tempDir()
    const counter = join(dir, 'run')
    let clock = 0
    const service = piService(countingFakePiCounter(counter, dir), { now: () => clock })
    expect((await service.catalog(true)).models[0].id).toBe('model-1')

    clock = CATALOG_TTL_MS + 1
    const startedAt = Date.now()
    const stale = await service.catalog()
    // The 30s TTL used to put a 13-24s CLI probe in front of every later interaction.
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(stale.models[0].id).toBe('model-1')

    await waitUntil(() => readFileSync(counter, 'utf8') === '2')
    expect((await service.catalog()).models[0].id).toBe('model-2')
  })

  it('joins the in-flight probe started by prewarm instead of starting a second one', async () => {
    const dir = tempDir()
    const counter = join(dir, 'run')
    const service = piService(countingFakePiCounter(counter, dir))
    expect(service.prewarm()).toBeUndefined()
    const catalog = await service.catalog()
    expect(catalog.models[0].id).toBe('model-1')
    expect(readFileSync(counter, 'utf8')).toBe('1')
  })

  it('prewarm is a no-op when the harness executable is not installed', async () => {
    const service = piService(null)
    expect(service.prewarm()).toBeUndefined()
    await expect(service.catalog()).resolves.toMatchObject({ models: [], warning: PI_NOT_INSTALLED_WARNING })
  })

  it('probes models and the version one CLI process at a time', async () => {
    const dir = tempDir()
    const order = join(dir, 'order')
    const executable = join(dir, 'ordered-pi.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const append = (c) => fs.appendFileSync(${JSON.stringify(order)}, c)
if (process.argv[2] === '--version') { append('v'); process.stdout.write('0.84.1\\n'); process.exit(0) }
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (buffer.indexOf('\\n') === -1) return
  append('r')
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: { models: [] } }) + '\\n')
})
`)
    chmodSync(executable, 0o755)
    const catalog = await piService(executable).catalog(true)
    expect(catalog.primeVersion).toBe('0.84.1')
    // Concurrent probes made the slow half of the startup twice as slow.
    expect(readFileSync(order, 'utf8')).toBe('rv')
  })
})

/** Fake pi that records how many model probes have run, so tests can count CLI spawns. */
function countingFakePiCounter(counterFile: string, dir: string, delayMs = 0): string {
  const executable = join(dir, `counting-pi-${Math.random().toString(36).slice(2)}.cjs`)
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') { process.stdout.write('0.84.1\\n'); process.exit(0) }
if (process.argv[2] !== '--mode') { process.exit(2) }
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf('\\n')
  if (newline === -1) return
  const request = JSON.parse(buffer.slice(0, newline))
  if (request.type !== 'get_available_models' || request.id !== '1') process.exit(3)
  const run = (() => { try { return Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) + 1 } catch { return 1 } })()
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(run))
  const models = [{ provider: 'test', id: 'model-' + run, name: 'Model ' + run, reasoning: false, input: ['text'], contextWindow: 10, maxTokens: 1 }]
  const write = () => process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: { models } }) + '\\n')
  if (${delayMs}) setTimeout(write, ${delayMs}); else write()
})
`)
  chmodSync(executable, 0o755)
  return executable
}
