import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelCatalogProvider } from '../../electron/main/model-catalog'
import { OMP_NOT_INSTALLED_WARNING, OmpModelCatalogService, MAX_CATALOG_PROVIDERS } from '../../electron/main/providers-omp'
import type { PrimeModelCatalog } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-omp-'))
  dirs.push(dir)
  return dir
}

/** Fabricates a fake omp CLI as an executable node script, mirroring the fake-agent pattern in agent-rpc.test.ts. */
function fakeOmp(body: string): string {
  const executable = join(tempDir(), 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('omp/1.2.3\\n'); process.exit(0) }
if (process.argv[2] !== 'models' || process.argv[3] !== '--json') { process.exit(2) }
${body}
`)
  chmodSync(executable, 0o755)
  return executable
}

function fakeOmpWithCatalog(payload: unknown): string {
  return fakeOmp(`process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`)
}

const sampleCatalog = {
  models: [
    { provider: 'anthropic', id: 'claude-fable-5', selector: 'anthropic/claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, thinking: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], input: ['text', 'image'], cost: { input: 5, output: 25 } },
    { provider: 'anthropic', id: 'claude-3-5-sonnet-20240620', selector: 'anthropic/claude-3-5-sonnet-20240620', name: 'Claude Sonnet 3.5', contextWindow: 200_000, maxTokens: 8_192, reasoning: false, thinking: null, input: ['text', 'image'], cost: {} },
    { provider: 'openai-codex', id: 'gpt-5.6-luna', selector: 'openai-codex/gpt-5.6-luna', name: 'Luna GPT-5.6', contextWindow: 400_000, maxTokens: 128_000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh'], input: ['text'], cost: {} },
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

function ompModel(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: `${provider} ${id}`, reasoning: false, thinking: null, input: ['text'], contextWindow: 1, maxTokens: 1 }
}

describe('OMP model catalog service', () => {
  it('invalidates the unavailable cache when discovery finds an executable', async () => {
    let executable: string | null = null
    const service = new OmpModelCatalogService(() => executable)
    await expect(service.catalog()).resolves.toMatchObject({ models: [], warning: OMP_NOT_INSTALLED_WARNING })

    executable = fakeOmpWithCatalog(sampleCatalog)
    await expect(service.catalog()).resolves.toMatchObject({ primeVersion: '1.2.3', models: expect.any(Array) })
  })

  it('parses the CLI catalog into Prime descriptor shapes', async () => {
    const service: ModelCatalogProvider = new OmpModelCatalogService(fakeOmpWithCatalog(sampleCatalog))
    const catalog = await service.catalog(true)

    expect(catalog.primeVersion).toBe('1.2.3')
    expect(catalog.warning).toBeUndefined()
    expect(catalog.models.map((model) => model.key)).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-3-5-sonnet-20240620',
      'openai-codex/gpt-5.6-luna',
    ])

    const fable = catalog.models[0]
    expect(fable.name).toBe('Claude Fable 5')
    expect(fable.contextWindow).toBe(1_000_000)
    expect(fable.maxTokens).toBe(128_000)
    expect(fable.reasoning).toBe(true)
    expect(fable.input).toEqual(['text', 'image'])
    expect(fable.availableThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(fable.fastModeSupported).toBe(false)
    expect(fable.available).toBe(true)

    const sonnet = catalog.models[1]
    expect(sonnet.availableThinkingLevels).toEqual(['off'])
    expect(sonnet.reasoning).toBe(false)

    const luna = catalog.models[2]
    expect(luna.availableThinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(luna.fastModeSupported).toBe(true)
    expect(luna.input).toEqual(['text'])

    expect(catalog.providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai-codex'])
    const anthropic = catalog.providers[0]
    expect(anthropic.authMethod).toBe('external')
    expect(anthropic.configured).toBe(true)
    expect(anthropic.authLabel).toBe('Credentials managed by the omp CLI')
    expect(anthropic.modelCount).toBe(2)
    expect(anthropic.availableModelCount).toBe(2)
    expect(anthropic.enabled).toBe(true)
    const cached = await service.catalog()
    expect(cached.models).toEqual(catalog.models)
    expect(cached.providers).toEqual(catalog.providers)
  })

  it('resolves availability, capabilities, and desktop provider enablement', async () => {
    const service = new OmpModelCatalogService(fakeOmpWithCatalog(sampleCatalog))

    const model = await service.requireAvailableModel('openai-codex/gpt-5.6-luna')
    expect(model.provider).toBe('openai-codex')
    expect(model.id).toBe('gpt-5.6-luna')

    await expect(service.requireAvailableModel('nope/none')).rejects.toThrow(/not found in the OMP catalog/)
    await expect(service.requireAvailableModel('anthropic/claude-fable-5', new Set(['anthropic']))).rejects.toThrow(/disabled/)
    await expect(service.requireAvailableModel('openai-codex/gpt-5.6-luna', new Set(), new Set(['openai-codex/gpt-5.6-luna']))).rejects.toThrow(/disabled/)
    const disabledView = await service.catalog(false, new Set(['anthropic']))
    expect(disabledView.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(false)
    expect(disabledView.providers.find((provider) => provider.id === 'openai-codex')?.enabled).toBe(true)
    expect((await service.catalog(false, new Set(), new Set(['openai-codex/gpt-5.6-luna']))).models.find((candidate) => candidate.key === 'openai-codex/gpt-5.6-luna')?.enabled).toBe(false)

    expect(await service.capabilities('anthropic', 'claude-fable-5')).toMatchObject({ key: 'anthropic/claude-fable-5' })
    expect(await service.capabilities('anthropic', undefined)).toBeUndefined()
    expect(await service.capabilities(undefined, 'claude-fable-5')).toBeUndefined()
  })

  it('returns an empty catalog with a clear status when OMP is not installed', async () => {
    const service = new OmpModelCatalogService(null)
    const catalog = await service.catalog(true)

    expect(catalog.models).toEqual([])
    expect(catalog.providers).toEqual([])
    expect(catalog.warning).toBe(OMP_NOT_INSTALLED_WARNING)
    expect(catalog.primeVersion).toBe('unknown')
    await expect(service.requireAvailableModel('anthropic/claude-fable-5')).rejects.toThrow(/not found/)
  })

  it('rejects malformed JSON without caching a catalog', async () => {
    const service = new OmpModelCatalogService(fakeOmp("process.stdout.write('not json {{')"))
    await expect(service.catalog(true)).rejects.toThrow(/malformed model catalog JSON/)
    await expect(service.catalog()).rejects.toThrow(/malformed model catalog JSON/)
  })

  it('rejects valid JSON with an unexpected top-level shape', async () => {
    const service = new OmpModelCatalogService(fakeOmpWithCatalog({ models: 'nope' }))
    await expect(service.catalog(true)).rejects.toThrow(/unexpected model catalog shape/)
    const arrayService = new OmpModelCatalogService(fakeOmpWithCatalog([1, 2, 3]))
    await expect(arrayService.catalog(true)).rejects.toThrow(/unexpected model catalog shape/)
  })

  it('rejects oversized CLI output at the byte cap', async () => {
    const executable = fakeOmp("process.stdout.write('x'.repeat(256 * 1024))")
    const service = new OmpModelCatalogService(executable, { maxOutputBytes: 4_096 })
    await expect(service.catalog(true)).rejects.toThrow(/catalog output exceeded/)
  })

  it('kills a hung CLI at the timeout', async () => {
    const pidFile = join(tempDir(), 'omp.pid')
    const executable = fakeOmp(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const service = new OmpModelCatalogService(executable, { timeoutMs: 3_000 })

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
    const executable = fakeOmp(`
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(counterFile)}, 'x')
setTimeout(() => { process.stdout.write(${JSON.stringify(JSON.stringify(sampleCatalog))}) }, 50)
`)
    const service = new OmpModelCatalogService(executable)
    const runs = () => { try { return readFileSync(counterFile, 'utf8').length } catch { return 0 } }

    const [first, second, third] = await Promise.all([
      service.catalog(true),
      service.catalog(true),
      service.catalog(true, new Set(['anthropic'])),
    ])
    expect(runs()).toBe(1)
    expect(first.models.length).toBe(second.models.length)
    expect(third.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(false)
    expect(first.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(true)

    // Within the TTL an unforced call serves the cache without a new spawn.
    await service.catalog()
    expect(runs()).toBe(1)

    // After settling, a forced refresh spawns again (the in-flight slot was cleared).
    await service.catalog(true)
    expect(runs()).toBe(2)
  })

  it('keeps omitted models absent from cached and stale overflow catalogs', async () => {
    const stateFile = join(tempDir(), 'mode')
    const overflowModels = Array.from({ length: MAX_CATALOG_PROVIDERS + 1 }, (_, index) => (
      ompModel(`provider-${String(index).padStart(3, '0')}`, 'model')
    ))
    // First run succeeds; every later run exits non-zero.
    const executable = fakeOmp(`
const fs = require('node:fs')
if (fs.existsSync(${JSON.stringify(stateFile)})) process.exit(7)
fs.writeFileSync(${JSON.stringify(stateFile)}, 'ran')
process.stdout.write(${JSON.stringify(JSON.stringify({ models: overflowModels }))})
`)
    const service = new OmpModelCatalogService(executable)
    const fresh = await service.catalog(true)
    expect(fresh.models).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(fresh.models.some((model) => model.key === 'provider-256/model')).toBe(false)
    expect(fresh.warning).toMatch(/provider limit/)

    const cached = await service.catalog()
    expect(cached.models).toEqual(fresh.models)
    expect(cached.providers).toEqual(fresh.providers)
    expect(cached.models.some((model) => model.key === 'provider-256/model')).toBe(false)

    const stale = await service.catalog(true)
    expect(stale.models).toEqual(fresh.models)
    expect(stale.providers).toEqual(fresh.providers)
    expect(stale.models.some((model) => model.key === 'provider-256/model')).toBe(false)
    expect(stale.warning).toMatch(/could not be refreshed/)
    expect(stale.warning).toMatch(/last loaded catalog/)
    expect(await service.capabilities('provider-256', 'model')).toBeUndefined()
    await expect(service.requireAvailableModel('provider-256/model')).rejects.toThrow(/not found/)

    // With no prior catalog the failure still surfaces.
    const failingOnly = new OmpModelCatalogService(fakeOmp('process.exit(7)'))
    await expect(failingOnly.catalog(true)).rejects.toThrow(/exited with status 7/)
  })

  it('rejects hostile model entries and sanitizes suspicious fields', async () => {
    const service = new OmpModelCatalogService(fakeOmpWithCatalog({
      models: [
        sampleCatalog.models[0],
        'not-an-object',
        null,
        ['nested', 'array'],
        { provider: '../evil', id: 'escape', name: 'Bad provider' },
        { provider: 'anthropic', id: 'bad id with spaces', name: 'Bad id' },
        { provider: 'anthropic', id: 'no-name', name: 42 },
        { provider: 'anthropic', id: 'bad-reasoning', name: 'Bad reasoning', reasoning: 'yes' },
        { provider: 'anthropic', id: 'bad-thinking', name: 'Bad thinking', reasoning: true, thinking: 'high' },
        { provider: 'anthropic', id: 'claude-fable-5', name: 'Duplicate key' },
        {
          provider: 'zai',
          id: 'glm-5',
          name: `Padded${'x'.repeat(2_000)}`,
          reasoning: true,
          thinking: [{ hostile: true }, 'medium', 'turbo', 'max'],
          input: ['text', 'video', { type: 'image' }],
          contextWindow: '200000',
          maxTokens: -5,
        },
      ],
    }))
    const catalog = await service.catalog(true)

    expect(catalog.models.map((model) => model.key)).toEqual(['anthropic/claude-fable-5', 'zai/glm-5'])
    expect(catalog.models[0].name).toBe('Claude Fable 5')
    const glm = catalog.models[1]
    expect(glm.name.length).toBe(500)
    expect(glm.availableThinkingLevels).toEqual(['off', 'medium', 'max'])
    expect(glm.input).toEqual(['text'])
    expect(glm.contextWindow).toBe(0)
    expect(glm.maxTokens).toBe(0)
    expect(catalog.warning).toMatch(/could not validate/)
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['anthropic', 'zai'])
  })

  it('keeps an exact-boundary catalog unchanged and relationally consistent', async () => {
    const models: unknown[] = []
    for (let index = 0; index < MAX_CATALOG_PROVIDERS; index += 1) {
      models.push(ompModel(`provider-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = MAX_CATALOG_PROVIDERS; index < 5_000; index += 1) {
      models.push(ompModel('provider-000', `model-${index}`))
    }

    const service = new OmpModelCatalogService(fakeOmpWithCatalog({ models }))
    const catalog = await service.catalog(true)

    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.warning).toBeUndefined()
    expectRelationalIntegrity(catalog)
  })

  it('caps provider-only overflow without returning orphan models', async () => {
    const models = Array.from({ length: MAX_CATALOG_PROVIDERS + 1 }, (_, index) => (
      ompModel(`provider-${String(index).padStart(3, '0')}`, 'model')
    ))
    const service = new OmpModelCatalogService(fakeOmpWithCatalog({ models }))
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
    const models = Array.from({ length: 5_001 }, (_, index) => ompModel('provider-000', `model-${index}`))
    const service = new OmpModelCatalogService(fakeOmpWithCatalog({ models }))
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
      models.push(ompModel(`overflow-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = 0; index < 5_010; index += 1) {
      models.push(ompModel('anthropic', `model-${index}`))
    }
    const service = new OmpModelCatalogService(fakeOmpWithCatalog({ models }))
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

  it('rejects a CLI that exits with a failure status', async () => {
    const service = new OmpModelCatalogService(fakeOmp('process.exit(3)'))
    await expect(service.catalog(true)).rejects.toThrow(/exited with status 3/)
  })
})
