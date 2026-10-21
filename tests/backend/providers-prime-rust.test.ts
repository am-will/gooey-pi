import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrimeProviderService } from '../../electron/main/providers'
import { RustPrimeModelCatalogService } from '../../electron/main/providers-prime-rust'
import type { PrimeImplementation, PrimeProviderDescriptor } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-rust-prime-'))
  dirs.push(dir)
  return dir
}

/**
 * A fake Rust prime-agent: `--version` prints 0.10.0, and the RPC probe argv
 * must be exactly `--mode rpc --no-session` (no --offline). It answers the
 * probe's get_available_models request with `payload`.
 */
function fakeRustPrime(payload: unknown): string {
  return fakeRustPrimeAnswering(JSON.stringify(payload))
}

/** Like fakeRustPrime, with the get_available_models data computed by the `data` expression in the fake. */
function fakeRustPrimeAnswering(data: string): string {
  const executable = join(tempDir(), 'fake-prime-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { process.stdout.write('0.10.0\\n'); process.exit(0) }
if (process.argv.slice(2).join(' ') !== '--mode rpc --no-session') process.exit(2)
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf('\\n')
  if (newline === -1) return
  const request = JSON.parse(buffer.slice(0, newline))
  if (request.type !== 'get_available_models' || request.id !== '1') process.exit(3)
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${data} }) + '\\n')
})
`)
  chmodSync(executable, 0o755)
  return executable
}

function rustModel(provider: string, id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider, id, name: `${provider} ${id}`, api: 'openai-responses', reasoning: false, input: ['text'], contextWindow: 400_000, maxTokens: 128_000, ...fields }
}

describe('Rust Prime model catalog service', () => {
  it('lists the models Rust Prime reports, with its version, as available', async () => {
    const service = new RustPrimeModelCatalogService(fakeRustPrime({
      models: [rustModel('anthropic', 'claude-opus-5-5', { reasoning: true, input: ['text', 'image'] }), rustModel('openai', 'gpt-6-sol')],
    }))
    const catalog = await service.catalog(true)

    expect(catalog.primeVersion).toBe('0.10.0')
    expect(catalog.warning).toBeUndefined()
    expect(catalog.models.map((model) => model.key)).toEqual(['anthropic/claude-opus-5-5', 'openai/gpt-6-sol'])
    expect(catalog.models.every((model) => model.available)).toBe(true)
    expect(catalog.models[0].input).toEqual(['text', 'image'])
    await expect(service.requireAvailableModel('anthropic/claude-opus-5-5')).resolves.toMatchObject({ id: 'claude-opus-5-5' })
    // Without a provider-row builder, each provider's credentials belong to the CLI.
    expect(catalog.providers.map((provider) => [provider.id, provider.authMethod, provider.authLabel])).toEqual([
      ['anthropic', 'external', 'Credentials managed by Rust Prime Agent'],
      ['openai', 'external', 'Credentials managed by Rust Prime Agent'],
    ])
  })

  it('applies Rust Prime thinking levels, where a wired level map counts without the reasoning flag', async () => {
    const service = new RustPrimeModelCatalogService(fakeRustPrime({
      models: [
        rustModel('openai', 'gpt-5.3-chat-latest', { thinkingLevelMap: { off: null, minimal: 'minimal', xhigh: 'xhigh' } }),
        rustModel('openai', 'all-null-map', { thinkingLevelMap: { off: null, low: null } }),
        rustModel('openai', 'plain'),
        rustModel('anthropic', 'reasoner', { reasoning: true }),
        rustModel('anthropic', 'max-reasoner', { reasoning: true, thinkingLevelMap: { minimal: null, max: 'max', xhigh: 7 } }),
      ],
    }))
    const levels = Object.fromEntries((await service.catalog(true)).models.map((model) => [model.id, model.availableThinkingLevels]))

    expect(levels).toEqual({
      'gpt-5.3-chat-latest': ['minimal', 'low', 'medium', 'high', 'xhigh'],
      'all-null-map': ['off'],
      plain: ['off'],
      reasoner: ['off', 'minimal', 'low', 'medium', 'high'],
      'max-reasoner': ['off', 'low', 'medium', 'high', 'max'],
    })
  })

  it('offers fast mode on no model, because Rust Prime has no service tier', async () => {
    const service = new RustPrimeModelCatalogService(fakeRustPrime({
      models: [rustModel('openai-codex', 'gpt-5.6', { api: 'openai-codex-responses' }), rustModel('openai', 'gpt-6-astra')],
    }))
    expect((await service.catalog(true)).models.map((model) => model.fastModeSupported)).toEqual([false, false])
  })

  it('turns Rust Prime usage reporting off for its probe only, whatever the user environment says', async () => {
    vi.stubEnv('PRIME_AGENT_TELEMETRY', '1')
    const service = new RustPrimeModelCatalogService(fakeRustPrimeAnswering(
      `{ models: [${JSON.stringify(rustModel('openai', 'probe'))}].map((model) => ({ ...model, id: 'env-' + (process.env.PRIME_AGENT_TELEMETRY ?? 'unset') })) }`,
    ))

    expect((await service.catalog(true)).models.map((model) => model.id)).toEqual(['env-0'])
    // GooeyPi's own environment, which user session runtimes inherit, keeps the user's choice.
    expect(process.env.PRIME_AGENT_TELEMETRY).toBe('1')
  })

  it('builds provider rows through the given builder, including providers without models', async () => {
    const seen: Array<ReadonlySet<string>> = []
    const row = (id: string, configured: boolean): PrimeProviderDescriptor => ({ id, name: id, authMethod: 'api_key', configured, modelCount: 0, availableModelCount: 0, enabled: true })
    const service = new RustPrimeModelCatalogService(fakeRustPrime({ models: [rustModel('openai', 'gpt-6-sol')] }), (providerIds) => {
      seen.push(providerIds)
      return [row('openai', true), row('xai', false)]
    })
    const catalog = await service.catalog(true)

    expect(seen).toEqual([new Set(['openai'])])
    expect(catalog.providers.map((provider) => [provider.id, provider.configured, provider.modelCount, provider.availableModelCount])).toEqual([
      ['openai', true, 1, 1],
      ['xai', false, 0, 0],
    ])
  })
})

/** A Prime auth directory: auth.json (written when `auth` is given) and the models.json path beside it. */
function primeAgentDir(auth?: Record<string, unknown>): { dir: string; authPath: string; modelsPath: string } {
  const dir = tempDir()
  const authPath = join(dir, 'auth.json')
  if (auth) writeFileSync(authPath, JSON.stringify(auth))
  return { dir, authPath, modelsPath: join(dir, 'models.json') }
}

function rustProviders(executable: string, paths: { authPath: string; modelsPath: string }, implementation: () => PrimeImplementation | undefined = () => 'rust'): PrimeProviderService {
  return new PrimeProviderService({ ...paths, executable, implementation })
}

describe('Prime provider service on Rust Prime', () => {
  it('lists Rust Prime models and accepts a 0.10-only model id, which the bundled registry lacks', async () => {
    const executable = fakeRustPrime({ models: [rustModel('anthropic', 'claude-opus-5-5', { reasoning: true, input: ['text', 'image'] })] })
    const providerService = rustProviders(executable, primeAgentDir())

    const catalog = await providerService.catalog(true)
    expect(catalog.primeVersion).toBe('0.10.0')
    expect(catalog.models.map((model) => model.key)).toEqual(['anthropic/claude-opus-5-5'])
    await expect(providerService.requireAvailableModel('anthropic/claude-opus-5-5')).resolves.toMatchObject({ provider: 'anthropic', id: 'claude-opus-5-5', available: true })
    await expect(providerService.capabilities('anthropic', 'claude-opus-5-5')).resolves.toMatchObject({ input: ['text', 'image'], availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] })
    // A 0.7 model Rust does not list is refused before a start, instead of running on a fallback template.
    await expect(providerService.requireAvailableModel('anthropic/claude-opus-4-1')).rejects.toThrow('Model was not found in the Prime Agent catalog')
    // The TypeScript path still lists the bundled registry when discovery says so.
    const typescript = rustProviders(executable, primeAgentDir(), () => 'typescript')
    await expect(typescript.requireAvailableModel('anthropic/claude-opus-5-5')).rejects.toThrow('Model was not found')
  })

  it('keeps provider rows for every Prime credential GooeyPi manages', async () => {
    vi.stubEnv('XAI_API_KEY', '')
    const executable = fakeRustPrime({ models: [rustModel('anthropic', 'claude-opus-5-5'), rustModel('xai', 'grok-4.7')] })
    const providerService = rustProviders(executable, primeAgentDir({ anthropic: { type: 'api_key', key: 'stored-test-key' } }))
    const providers = new Map((await providerService.catalog(true)).providers.map((provider) => [provider.id, provider]))

    expect(providers.get('anthropic')).toMatchObject({ authMethod: 'oauth', configured: true, authSource: 'stored', availableModelCount: 1 })
    // Rust lists models for a credential source the in-process store cannot see.
    expect(providers.get('xai')).toMatchObject({ authMethod: 'api_key', configured: true, authSource: undefined, availableModelCount: 1 })
    // Providers without credentials stay listed, so a key or login can be added.
    expect(providers.get('openai')).toMatchObject({ authMethod: 'api_key', configured: false, modelCount: 0 })
    expect(providers.get('openai-codex')).toMatchObject({ authMethod: 'oauth', configured: false })
  })

  it('probes again after a key is saved, so newly available models appear at once', async () => {
    const { authPath, modelsPath } = primeAgentDir({})
    vi.stubEnv('FAKE_PRIME_AUTH', authPath)
    // Like Rust Prime, the fake lists openai models only once auth.json holds an openai key.
    const executable = fakeRustPrimeAnswering(`(() => {
  const auth = JSON.parse(require('node:fs').readFileSync(process.env.FAKE_PRIME_AUTH, 'utf8'))
  return { models: auth.openai ? [${JSON.stringify(rustModel('openai', 'gpt-6-sol'))}] : [] }
})()`)
    const providerService = rustProviders(executable, { authPath, modelsPath })
    expect((await providerService.catalog()).models).toEqual([])

    await providerService.saveApiKey('openai', 'sk-test-key')

    expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual({ openai: { type: 'api_key', key: 'sk-test-key' } })
    expect((await providerService.catalog()).models.map((model) => model.key)).toEqual(['openai/gpt-6-sol'])
  })

  it('never runs the bundled registry refresh, which would rewrite Rust Prime\'s private-model cache', async () => {
    vi.stubEnv('PRIME_API_KEY', '')
    vi.stubEnv('PRIME_TEAM_ID', '')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'internal/glm-5.2-fast' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const teamLogin = { 'prime-inference': { type: 'api_key', key: 'team-test-key', primeTeam: { teamId: 'team-1', name: 'Team' } } }
    const rustCache = `${JSON.stringify({ fingerprint: 'rust-hmac-fingerprint', data: [], refreshedAt: 1 })}\n`
    const executable = fakeRustPrime({ models: [rustModel('prime-inference', 'z-ai/glm-5.3')] })

    const rust = primeAgentDir(teamLogin)
    writeFileSync(join(rust.dir, 'prime-inference-private-models.json'), rustCache)
    await rustProviders(executable, rust).catalog(true)
    expect(readFileSync(join(rust.dir, 'prime-inference-private-models.json'), 'utf8')).toBe(rustCache)
    expect(fetch).not.toHaveBeenCalled()

    // The same files on TypeScript Prime: its registry refetches and writes its own format.
    const typescript = primeAgentDir(teamLogin)
    writeFileSync(join(typescript.dir, 'prime-inference-private-models.json'), rustCache)
    await rustProviders(executable, typescript, () => 'typescript').catalog(true)
    expect(fetch).toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(typescript.dir, 'prime-inference-private-models.json'), 'utf8'))).toMatchObject({ modelIds: ['internal/glm-5.2-fast'] })
  })

  it('still offers the provider rows when no probe has answered yet', async () => {
    const executable = join(tempDir(), 'broken-prime-agent.cjs')
    writeFileSync(executable, "#!/usr/bin/env node\nif (process.argv[2] === '--version') { process.stdout.write('0.10.0\\n'); process.exit(0) }\nprocess.exit(7)\n")
    chmodSync(executable, 0o755)
    const providerService = rustProviders(executable, primeAgentDir())

    const catalog = await providerService.catalog(true)
    expect(catalog.models).toEqual([])
    expect(catalog.warning).toMatch(/^The Prime Agent model catalog could not be loaded \(prime-agent exited with status 7 without answering the model catalog probe\)\.$/)
    expect(catalog.providers.find((provider) => provider.id === 'openai')).toMatchObject({ authMethod: 'api_key', configured: false })
    await expect(providerService.requireAvailableModel('openai/gpt-6-sol')).rejects.toThrow('Model was not found')
  })

  it('follows the discovered build on every request', async () => {
    let implementation: PrimeImplementation = 'typescript'
    const executable = fakeRustPrime({ models: [rustModel('openai', 'gpt-6-sol')] })
    const providerService = rustProviders(executable, primeAgentDir(), () => implementation)

    const typescript = await providerService.catalog()
    expect(typescript.primeVersion).not.toBe('0.10.0')
    expect(typescript.models.some((model) => model.key === 'openai/gpt-6-sol')).toBe(false)
    implementation = 'rust'
    expect((await providerService.catalog()).models.map((model) => model.key)).toEqual(['openai/gpt-6-sol'])
  })
})
