import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessAgentConfigCommand, requireAgentRoleConfigPatch, UNSUPPORTED_AGENT_CONFIG } from '../../electron/main/agent-config'
import { OMP_CONFIG_NOT_INSTALLED_WARNING, OmpAgentConfigService } from '../../electron/main/agent-config-omp'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import type { ModelCatalogProvider } from '../../electron/main/model-catalog'
import type { PrimeModelCatalog } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-omp-config-'))
  dirs.push(dir)
  return dir
}

const model = {
  key: 'anthropic/claude-opus-5', provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true,
  input: ['text'] as const, contextWindow: 1_000_000, maxTokens: 128_000,
  availableThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] as const, fastModeSupported: false, available: true,
}
const catalog: PrimeModelCatalog = {
  primeVersion: '17.2.9',
  refreshedAt: '2026-08-18T00:00:00.000Z',
  models: [
    { ...model, input: [...model.input], availableThinkingLevels: [...model.availableThinkingLevels] },
    {
      ...model, key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6',
      input: [...model.input], availableThinkingLevels: ['off', 'medium', 'max'],
    },
  ],
  providers: [
    { id: 'anthropic', name: 'anthropic', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
    { id: 'openai-codex', name: 'openai-codex', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
  ],
}

const catalogService: ModelCatalogProvider = {
  catalog: async () => catalog,
  requireAvailableModel: async () => catalog.models[0],
  capabilities: async () => catalog.models[0],
}

/**
 * Fabricates a fake omp CLI backed by a JSON settings file, mirroring the
 * fake-omp pattern in providers-omp.test.ts. `config get <key> --json` answers
 * the CLI's real `{key,value,type,description}` envelope and exits 1 for an
 * unknown key; `config set <key> <value>` replaces whole records exactly as
 * omp 17.2.9 does.
 */
function fakeOmp(settings: Record<string, unknown>, options: { body?: string } = {}): { executable: string; read(): Record<string, unknown>; argv(): string[][] } {
  const dir = tempDir()
  const store = join(dir, 'settings.json')
  const log = join(dir, 'argv.jsonl')
  writeFileSync(store, JSON.stringify(settings))
  const executable = join(dir, 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs')
const store = ${JSON.stringify(store)}
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
${options.body ?? ''}
const settings = JSON.parse(fs.readFileSync(store, 'utf8'))
if (args[0] !== 'config') process.exit(2)
if (args[1] === 'get') {
  const key = args[2]
  if (!(key in settings)) { process.stderr.write('Unknown setting: ' + key + '\\n'); process.exit(1) }
  process.stdout.write(JSON.stringify({ key, value: settings[key], type: 'record', description: '' }))
  process.exit(0)
}
if (args[1] === 'set') {
  const key = args[2]
  const raw = args[3]
  if (!(key in settings)) { process.stderr.write('Unknown setting: ' + key + '\\n'); process.exit(1) }
  if (key === 'advisor.syncBacklog' && !['off','1','3','5'].includes(raw)) {
    process.stderr.write('Error: Invalid value: ' + raw + '. Valid values: off, 1, 3, 5\\n'); process.exit(1)
  }
  // omp replaces a record wholesale rather than merging into it.
  settings[key] = key === 'modelRoles' ? JSON.parse(raw)
    : raw === 'true' ? true : raw === 'false' ? false
    : /^[0-9]+$/.test(raw) && key === 'advisor.immuneTurns' ? Number(raw) : raw
  fs.writeFileSync(store, JSON.stringify(settings))
  process.exit(0)
}
process.exit(2)
`)
  chmodSync(executable, 0o755)
  return {
    executable,
    read: () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, unknown>,
    argv: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
  }
}

const defaultSettings = {
  modelRoles: { default: 'anthropic/claude-opus-5:xhigh', smol: 'openai-codex/gpt-5.6-luna:max' },
  'advisor.enabled': true,
  'advisor.subagents': false,
  'advisor.syncBacklog': 1,
  'advisor.immuneTurns': 2,
}

describe('agent-config harness gating', () => {
  it('offers the surface only for harnesses whose adapter declares a config CLI', () => {
    expect(OMP_RPC_ADAPTER.agentConfigCommand).toBe('config')
    expect(PRIME_RPC_ADAPTER.agentConfigCommand).toBeUndefined()
    expect(PI_RPC_ADAPTER.agentConfigCommand).toBeUndefined()
    expect(harnessAgentConfigCommand('omp')).toBe('config')
    expect(harnessAgentConfigCommand('prime')).toBeUndefined()
    expect(harnessAgentConfigCommand('pi')).toBeUndefined()
  })

  it('describes an unsupported harness as having nothing to show', () => {
    expect(UNSUPPORTED_AGENT_CONFIG).toMatchObject({ supported: false, installed: false, roles: {}, advisor: null })
  })
})

describe('agent role patch validation', () => {
  it('accepts a bounded patch of known roles and advisor leaves', () => {
    expect(requireAgentRoleConfigPatch({
      roles: { plan: 'anthropic/claude-opus-5:high' },
      advisor: { enabled: false, subagents: true, syncBacklog: '5', immuneTurns: 3 },
    })).toEqual({
      roles: { plan: 'anthropic/claude-opus-5:high' },
      advisor: { enabled: false, subagents: true, syncBacklog: '5', immuneTurns: 3 },
    })
  })

  it('rejects unknown keys, unknown roles, and hostile leaf values', () => {
    expect(() => requireAgentRoleConfigPatch({ roles: {}, extra: 1 })).toThrow(/not supported/)
    expect(() => requireAgentRoleConfigPatch({ roles: { reviewer: 'anthropic/claude-opus-5' } })).toThrow(/not supported/)
    expect(() => requireAgentRoleConfigPatch({ advisor: { syncBacklog: '7' } })).toThrow(/not supported/)
    expect(() => requireAgentRoleConfigPatch({ advisor: { immuneTurns: -1 } })).toThrow(/must be an integer/)
    expect(() => requireAgentRoleConfigPatch({ advisor: { immuneTurns: 1_001 } })).toThrow(/must be an integer/)
    expect(() => requireAgentRoleConfigPatch({ advisor: { enabled: 'yes' } })).toThrow(/must be a boolean/)
    expect(() => requireAgentRoleConfigPatch({ roles: { plan: 42 } })).toThrow(/must be a string/)
  })

  it('refuses an empty patch rather than spawning a pointless CLI write', () => {
    expect(() => requireAgentRoleConfigPatch({})).toThrow(/at least one setting/)
  })
})

describe('OMP agent config service', () => {
  it('reads roles and advisor settings from the CLI envelope', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    await expect(service.read()).resolves.toEqual({
      supported: true,
      installed: true,
      roles: { default: 'anthropic/claude-opus-5:xhigh', smol: 'openai-codex/gpt-5.6-luna:max' },
      advisor: { enabled: true, subagents: false, syncBacklog: '1', immuneTurns: 2 },
    })
  })

  it('reads every setting from a neutral working directory so no project overlay leaks in', async () => {
    const cli = fakeOmp(defaultSettings)
    await new OmpAgentConfigService(cli.executable, catalogService).read()

    // `omp config get` merges a cwd-owned .omp/config.yml over the global
    // config, so the surface must never be read from a project directory.
    expect(cli.argv().every((args) => args[0] === 'config' && args[1] === 'get' && args[3] === '--json')).toBe(true)
    expect(cli.argv().map((args) => args[2]).sort()).toEqual([
      'advisor.enabled', 'advisor.immuneTurns', 'advisor.subagents', 'advisor.syncBacklog', 'modelRoles',
    ])
  })

  it('reports a missing CLI without pretending the harness lacks the concept', async () => {
    const service = new OmpAgentConfigService(null, catalogService)
    await expect(service.read()).resolves.toEqual({
      supported: true, installed: false, roles: {}, advisor: null, warning: OMP_CONFIG_NOT_INSTALLED_WARNING,
    })
    await expect(service.write({ advisor: { enabled: false } })).rejects.toThrow(OMP_CONFIG_NOT_INSTALLED_WARNING)
  })

  it('merges a partial role change over the stored record instead of replacing it', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    const next = await service.write({ roles: { plan: 'anthropic/claude-opus-5:high' } })

    // `omp config set modelRoles` replaces the whole record, so a partial
    // write that did not merge would silently delete default and smol.
    expect(cli.read().modelRoles).toEqual({
      default: 'anthropic/claude-opus-5:xhigh',
      smol: 'openai-codex/gpt-5.6-luna:max',
      plan: 'anthropic/claude-opus-5:high',
    })
    expect(next.roles.plan).toBe('anthropic/claude-opus-5:high')
  })

  it('preserves role keys this build does not know about', async () => {
    const cli = fakeOmp({ ...defaultSettings, modelRoles: { ...defaultSettings.modelRoles, reviewer: 'anthropic/claude-opus-5' } })
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    const next = await service.write({ roles: { plan: 'anthropic/claude-opus-5' } })

    expect(cli.read().modelRoles).toMatchObject({ reviewer: 'anthropic/claude-opus-5', plan: 'anthropic/claude-opus-5' })
    expect(next.roles).not.toHaveProperty('reviewer')
  })

  it('validates a selector against the harness catalog before writing anything', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    await expect(service.write({ roles: { plan: 'anthropic/not-a-model' } })).rejects.toThrow(/was not found in the OMP catalog/)
    // A thinking level the model does not offer is rejected just as firmly.
    await expect(service.write({ roles: { smol: 'openai-codex/gpt-5.6-luna:xhigh' } })).rejects.toThrow(/was not found in the OMP catalog/)
    expect(cli.read().modelRoles).toEqual(defaultSettings.modelRoles)
  })

  it('accepts a bare selector and a selector carrying a supported thinking level', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    await service.write({ roles: { plan: 'anthropic/claude-opus-5', task: 'openai-codex/gpt-5.6-luna:max' } })

    expect(cli.read().modelRoles).toMatchObject({ plan: 'anthropic/claude-opus-5', task: 'openai-codex/gpt-5.6-luna:max' })
  })

  it('writes only the advisor leaves the patch names', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    const next = await service.write({ advisor: { enabled: false, immuneTurns: 7 } })

    const writes = cli.argv().filter((args) => args[1] === 'set')
    expect(writes).toEqual([['config', 'set', 'advisor.enabled', 'false'], ['config', 'set', 'advisor.immuneTurns', '7']])
    expect(next.advisor).toEqual({ enabled: false, subagents: false, syncBacklog: '1', immuneTurns: 7 })
  })

  it('surfaces a CLI rejection as a bounded, printable error', async () => {
    const cli = fakeOmp(defaultSettings)
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    // The fake CLI enforces the real enum, so this is the harness's own refusal.
    await expect(service.write({ advisor: { syncBacklog: '9' as never } })).rejects.toThrow(/OMP rejected advisor\.syncBacklog: .*Invalid value/)
  })

  it('treats an unreadable or hostile answer as absent instead of failing the whole read', async () => {
    const cli = fakeOmp({
      modelRoles: { default: 12, smol: 'openai-codex/gpt-5.6-luna:max' },
      'advisor.enabled': 'yes',
      'advisor.subagents': null,
      'advisor.syncBacklog': 99,
      'advisor.immuneTurns': -4,
    })
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    await expect(service.read()).resolves.toEqual({
      supported: true,
      installed: true,
      roles: { smol: 'openai-codex/gpt-5.6-luna:max' },
      advisor: { enabled: false, subagents: false, syncBacklog: 'off', immuneTurns: 0 },
    })
  })

  it('reports an unknown setting as absent rather than as a failed read', async () => {
    const cli = fakeOmp({ modelRoles: { default: 'anthropic/claude-opus-5' } })
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    const config = await service.read()
    expect(config.roles).toEqual({ default: 'anthropic/claude-opus-5' })
    expect(config.advisor).toEqual({ enabled: false, subagents: false, syncBacklog: 'off', immuneTurns: 0 })
  })

  it('ignores malformed CLI output', async () => {
    const cli = fakeOmp(defaultSettings, { body: `process.stdout.write('not json'); process.exit(0)` })
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    await expect(service.read()).resolves.toMatchObject({ installed: true, roles: {} })
  })

  it('kills a hung CLI at the timeout instead of blocking the settings section', async () => {
    // Top-level return is legal in a CJS entry script: the CLI answers nothing until killed.
    const cli = fakeOmp(defaultSettings, { body: 'setTimeout(() => process.exit(0), 30_000); return' })
    const service = new OmpAgentConfigService(cli.executable, catalogService, { timeoutMs: 250 })

    await expect(service.read()).resolves.toMatchObject({ installed: true, roles: {}, advisor: { enabled: false } })
  })

  it('rejects a value that would be read as a CLI flag', async () => {
    const cli = fakeOmp({ ...defaultSettings, modelRoles: { default: '--dangerous' } })
    const service = new OmpAgentConfigService(cli.executable, catalogService)

    // The stored hostile value is dropped from the merge base, so it can never
    // be handed back to the CLI as an argument.
    await service.write({ roles: { plan: 'anthropic/claude-opus-5' } })
    expect(cli.read().modelRoles).toEqual({ plan: 'anthropic/claude-opus-5' })
  })
})
