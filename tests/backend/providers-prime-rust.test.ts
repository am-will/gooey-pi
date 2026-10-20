import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RustPrimeModelCatalogService } from '../../electron/main/providers-prime-rust'
import type { PrimeProviderDescriptor } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

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
  process.stdout.write(JSON.stringify({ type: 'response', id: '1', command: 'get_available_models', success: true, data: ${JSON.stringify(payload)} }) + '\\n')
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
      ['anthropic', 'external', 'Credentials managed by Prime Agent 0.10+'],
      ['openai', 'external', 'Credentials managed by Prime Agent 0.10+'],
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
