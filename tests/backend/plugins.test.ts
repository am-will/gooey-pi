import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService, beginPluginDiscoveryShutdown } from '../../electron/main/plugins'
import { removeMcpDefinition, updateMcpSettings, updateMcpState } from '../../electron/main/plugins/mcp'
import { executePiPluginInstall, executePiPluginRemove } from '../../electron/main/plugins/package-execution'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'prime-work-mcp-')); dirs.push(dir); return dir }

describe('PluginService discovery', () => {
  it('reads dynamic bundled capability state on each refreshed catalog', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let enabled = true
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      builtInSkills: () => [{
        id: 'gooeypi-ask-user', name: 'Ask user', description: '', kind: 'extension',
        location: 'system', enabled,
      }],
    })

    expect((await service.list()).skills[0].enabled).toBe(true)
    enabled = false
    expect((await service.refresh()).skills[0].enabled).toBe(false)
  })

  it('coalesces duplicate refreshes while discovery is in flight', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const first = service.list()
    const duplicate = service.refresh()

    expect(duplicate).toBe(first)
    await expect(first).resolves.toEqual({ skills: expect.any(Array), warnings: [] })
  })

  it('does not report a shared user settings tree as both user and project', async () => {
    const root = temp()
    const agentDir = join(root, '.prime', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: ['local-package'],
      mcpServers: { 'local-server': { type: 'stdio', command: 'local-command' } },
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(root)
    const packageRecords = catalog.skills.filter((item) => item.kind === 'package' && item.source === 'local-package')
    const mcpRecords = catalog.skills.filter((item) => item.kind === 'mcp' && item.name === 'local-server')

    expect(packageRecords).toHaveLength(1)
    expect(packageRecords[0]).toMatchObject({ location: 'user' })
    expect(mcpRecords).toHaveLength(1)
    expect(mcpRecords[0]).toMatchObject({ location: 'user' })
  })

  it('keeps every user and project Prime MCP definition visible but unavailable', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      'command-only': { command: 'npx', args: ['server'] },
      'legacy-scalar': 'legacy-owned-value',
    } }))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      'future-shape': { transport: 'future', endpoint: 42 },
      'null-shape': null,
    } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const records = (await service.list(project)).skills.filter((item) => item.kind === 'mcp')

    for (const [name, location] of [
      ['command-only', 'user'], ['legacy-scalar', 'user'],
      ['future-shape', 'project'], ['null-shape', 'project'],
    ] as const) {
      expect(records).toContainEqual(expect.objectContaining({
        name, location, availability: { available: false, detail: expect.stringContaining('managed outside GooeyPi') },
      }))
    }
    expect(records.find((item) => item.name === 'legacy-scalar')?.description).not.toContain('legacy-owned-value')
    expect(records.find((item) => item.name === 'command-only')?.description).toContain('Managed outside GooeyPi')

    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'legacy-scalar', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'null-shape', scope: 'project', projectPath: project }))
      .resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers).not.toHaveProperty('legacy-scalar')
    expect(JSON.parse(readFileSync(join(projectAgentDir, 'settings.json'), 'utf8')).mcpServers).not.toHaveProperty('null-shape')
  })

  it.each(['prime', 'omp', 'pi'] as const)('does not let saturated %s package discovery hide user or project MCP rows', async (harness) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, harness === 'prime' ? '.prime' : harness === 'omp' ? '.omp' : '.pi', ...(harness === 'prime' ? ['agent'] : []))
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    const packages = Array.from({ length: 2_500 }, (_, index) => `npm:catalog-saturation-${index}`)
    if (harness === 'pi') packages[0] = 'npm:pi-mcp-adapter'
    const userSettings = harness === 'prime'
      ? { packages, mcpServers: { 'user-must-be-visible': null } }
      : { packages }
    const projectSettings = harness === 'prime'
      ? { packages, mcpServers: { 'project-must-be-visible': null } }
      : { packages }
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(userSettings))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify(projectSettings))
    if (harness !== 'prime') {
      writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
        'user-must-be-visible': { type: 'http', url: 'https://user.example/mcp' },
      } }))
      writeFileSync(join(projectAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
        'project-must-be-visible': { type: 'http', url: 'https://project.example/mcp' },
      } }))
    }
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness })

    const records = (await service.list(project)).skills.filter((item) => item.kind === 'mcp')

    expect(records).toContainEqual(expect.objectContaining({ name: 'user-must-be-visible', location: 'user' }))
    expect(records).toContainEqual(expect.objectContaining({ name: 'project-must-be-visible', location: 'project' }))
  })

  it.each([
    ['prime', 'user'], ['prime', 'project'],
    ['omp', 'user'], ['omp', 'project'],
    ['pi', 'user'], ['pi', 'project'],
  ] as const)('bounds %s %s MCP discovery independently and reports the exact truncated file', async (harness, scope) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, harness === 'prime' ? '.prime' : harness === 'omp' ? '.omp' : '.pi', ...(harness === 'prime' ? ['agent'] : []))
    mkdirSync(agentDir)
    mkdirSync(projectAgentDir, { recursive: true })
    if (harness === 'pi') writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const mcpServers = Object.fromEntries(Array.from({ length: 2_501 }, (_, index) => [
      `server-${index}`,
      harness === 'prime' ? null : { type: 'http', url: 'https://mcp.example/server' },
    ]))
    const filename = harness === 'prime' ? 'settings.json' : 'mcp.json'
    const settingsPath = scope === 'user' ? join(agentDir, filename) : join(projectAgentDir, filename)
    writeFileSync(settingsPath, JSON.stringify({ mcpServers }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness })

    const catalog = await service.list(scope === 'project' ? project : undefined)
    const expectedSettingsPath = scope === 'project' ? realpathSync(settingsPath) : settingsPath

    expect(catalog.skills.filter((item) => item.kind === 'mcp')).toHaveLength(2_500)
    expect(catalog.warnings).toContainEqual({
      scope, path: expectedSettingsPath, message: expect.stringContaining('2,500'),
    })
  })

  it('ignores stray OMP settings.json MCP entries so actions identify only mcp.json definitions', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    const mcpPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {
      docs: { type: 'stdio', command: 'settings-shadow' },
    } }))
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {
      docs: { type: 'stdio', command: 'mcp-native' },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp' && item.name === 'docs')

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ source: 'mcp-native', definitionKey: 'docs', location: 'user' })
    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: records[0].name,
      definitionKey: records[0].definitionKey, scope: 'user',
    })).resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers).toHaveProperty('docs')
    expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers).not.toHaveProperty('docs')
  })

  it('removes unusual Prime definition keys by their exact bounded catalog identity', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const longKey = `long-${'x'.repeat(80)}`
    const oversizedKey = `oversized-${'x'.repeat(1_024)}`
    const definitions: Record<string, unknown> = Object.create(null)
    definitions['team/docs'] = { type: 'http', url: 'https://docs.example/mcp' }
    Object.defineProperty(definitions, '__proto__', {
      value: { type: 'http', url: 'https://prototype.example/mcp' }, enumerable: true, configurable: true, writable: true,
    })
    definitions['control\u0001key'] = null
    definitions[longKey] = 'legacy'
    definitions[oversizedKey] = 'direct-harness-cleanup-required'
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: definitions }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp' && item.location === 'user')
    const expected = [
      ['team/docs', 'team/docs'],
      ['__proto__', '__proto__'],
      ['control\u0001key', 'control�key'],
      [longKey, longKey],
    ] as const
    for (const [definitionKey, displayName] of expected) {
      expect(records).toContainEqual(expect.objectContaining({ name: displayName, definitionKey }))
      await expect(service.mutateCapability({
        kind: 'mcp', action: 'remove', name: displayName, definitionKey, scope: 'user',
      } as never)).resolves.toMatchObject({ ok: true })
    }
    expect(records).toContainEqual(expect.objectContaining({
      name: oversizedKey.slice(0, 120), definitionRemovalAvailable: false,
    }))
    expect(records.find((item) => item.name === oversizedKey.slice(0, 120))).not.toHaveProperty('definitionKey')
    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: 'oversized', definitionKey: oversizedKey, scope: 'user',
    } as never)).rejects.toThrow('exceeds the supported removal limit')
    await expect(removeMcpDefinition(join(agentDir, 'settings.json'), {
      name: 'oversized', definitionKey: oversizedKey,
    })).rejects.toThrow('exceeds the supported removal limit')
    expect(Object.keys(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers)).toEqual([oversizedKey])
  })

  it('uses package manifest metadata and collapses an associated MCP bridge row', async () => {
    const root = temp()
    const agentDir = join(root, '.prime', 'agent')
    const packageRoot = join(root, 'supabase-bridge')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(packageRoot)
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'Prime Supabase',
      description: 'Connect Prime Agent to Supabase.',
      gooeypi: { mcpServers: ['supabase'] },
    }))
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: [packageRoot],
      mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } },
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const catalog = await service.list()

    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'supabase', kind: 'mcp' }))
    expect(catalog.skills).not.toContainEqual(expect.objectContaining({ name: 'Prime Supabase', kind: 'package' }))
  })

  it('uses a normalized slug instead of exposing a package path when metadata is unavailable', async () => {
    const root = temp()
    const agentDir = join(root, '.prime', 'agent')
    const packageRoot = join(root, 'My Package')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(packageRoot)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageRoot] }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const record = (await service.list()).skills.find((skill) => skill.kind === 'package')

    expect(record).toMatchObject({ name: 'my-package', description: 'my-package capability package' })
    expect(record?.description).not.toContain(root)
  })

  it('coalesces lexical aliases after project authorization canonicalizes them', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const alias = join(root, 'project-alias')
    mkdirSync(agentDir); mkdirSync(project); symlinkSync(project, alias)
    let discoveries = 0
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async () => { discoveries += 1; await new Promise((resolveWait) => setTimeout(resolveWait, 20)); return { skills: [], warnings: [] } },
    })

    await Promise.all([service.list(project), service.list(alias)])

    expect(discoveries).toBe(1)
  })

  it('coalesces hostile concurrent nested paths to their authorized project root', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const pluginPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(project); writeFileSync(pluginPrompt, '# Project prompt')
    const nestedPaths = Array.from({ length: 96 }, (_, index) => join(project, 'workspaces', String(index), 'deep'))
    for (const path of nestedPaths) mkdirSync(path, { recursive: true })

    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projects = new ProjectService(store, () => null)
    await projects.list()

    let authorized = 0
    let signalAuthorized: () => void = () => undefined
    const allAuthorized = new Promise<void>((resolveWait) => { signalAuthorized = resolveWait })
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let discoveries = 0
    const discoveredRoots = new Set<string | undefined>()
    const service = new PluginService(null, async (path) => {
      const authorizedRoot = await projects.authorizeProjectRoot(path)
      authorized += 1
      if (authorized === nestedPaths.length) signalAuthorized()
      return authorizedRoot
    }, {
      agentDir,
      discover: async (_agentDir, projectPath) => {
        discoveries += 1
        discoveredRoots.add(projectPath)
        await discoveryGate
        return { skills: [{
          id: 'project-prompt', name: 'Project prompt', description: '', kind: 'prompt',
          location: 'project', path: realpathSync(pluginPrompt), enabled: true,
        }], warnings: [] }
      },
    })

    const requests = nestedPaths.map((path) => service.list(path))
    await allAuthorized
    expect(discoveries).toBe(1)
    expect(discoveredRoots).toEqual(new Set([realpathSync(project)]))
    releaseDiscovery()
    const results = await Promise.all(requests)

    expect(new Set(results).size).toBe(1)
    expect(service.authorizeReveal(pluginPrompt)).toBe(realpathSync(pluginPrompt))
  })

  it('rejects excess distinct discovery work instead of growing the global queue', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let active = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        await discoveryGate
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    const outcomes = Array.from({ length: 40 }, (_, index) => service.list(join(root, `hostile-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    const internal = service as unknown as { discoveryInFlight: Map<string, Promise<unknown>> }

    expect(active).toBe(2)
    expect(internal.discoveryInFlight.size).toBeLessThanOrEqual(34)
    releaseDiscovery()
    const settled = await Promise.all(outcomes)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(6)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('Too many plugin discoveries'))).toBe(true)
  })

  it('rejects queued discovery waiters on shutdown so pending lists settle', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => { await discoveryGate; return { skills: [], warnings: [] } },
    })

    const outcomes = Array.from({ length: 4 }, (_, index) => service.list(join(root, `pending-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))

    beginPluginDiscoveryShutdown()
    releaseDiscovery()
    const settled = await Promise.all(outcomes)

    expect(settled.filter((outcome) => outcome === 'fulfilled')).toHaveLength(2)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(2)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('shutting down'))).toBe(true)
  })

  it('bounds catalog work globally across distinct discovery keys', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let active = 0
    let peak = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    await Promise.all(Array.from({ length: 8 }, (_, index) => service.list(join(root, `project-${index}`))))

    expect(peak).toBe(2)
  })

  it('surfaces a structured warning for invalid settings.json instead of silently hiding plugins', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const skillDir = join(agentDir, 'skills', 'local')
    mkdirSync(skillDir, { recursive: true }); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: local\n---\nLocal skill')
    writeFileSync(join(agentDir, 'settings.json'), '{ this is not json')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify(['not', 'an', 'object']))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(project)

    expect(catalog.warnings).toEqual([
      { scope: 'user', path: join(agentDir, 'settings.json'), message: 'settings.json invalid — plugins hidden' },
      { scope: 'project', path: join(realpathSync(project), '.prime', 'agent', 'settings.json'), message: 'settings.json invalid — plugins hidden' },
    ])
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'local', kind: 'skill' }))
  })

  it('retains reveal authorization independently for user and project catalogs', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const userPrompt = join(root, 'agent', 'user-prompt.md')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(userPrompt, '# User prompt')
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [userPrompt] }))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    await service.list()
    await service.list(project)

    expect(service.authorizeReveal(userPrompt)).toBe(realpathSync(userPrompt))
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))
  })

  it('re-authorizes refresh scope and revokes reveal paths after project removal', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projectsService = new ProjectService(store, () => null)
    projectsService.bindProviders({
      sessions: async () => [],
      branch: async () => undefined,
      stopProjectProcesses: async (roots) => service.evictProjects(roots),
    })
    const service = new PluginService(null, (path) => projectsService.authorizeProjectRoot(path), { agentDir })

    await service.list(project)
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))

    expect(await projectsService.remove('project')).toBe(true)
    await expect(service.refresh()).rejects.toThrow(/not inside an added Prime Work project/)
    expect(() => service.authorizeReveal(projectPrompt)).toThrow('plugin path was not discovered')
  })

  it('bounds the reveal path owners to a fixed LRU window', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const projectFor = (index: number) => {
      const project = join(root, `project-${index}`)
      mkdirSync(project)
      writeFileSync(join(project, 'prompt.md'), `# ${index}`)
      return project
    }
    const projects = Array.from({ length: 66 }, (_, index) => projectFor(index))
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async (_agentDirectory, safeProjectPath) => safeProjectPath
        ? { skills: [{ id: `skill-${safeProjectPath}`, name: 'Prompt', description: '', kind: 'prompt', location: 'project', path: join(safeProjectPath, 'prompt.md'), enabled: true }], warnings: [] }
        : { skills: [], warnings: [] },
    })

    for (const project of projects) await service.list(project)

    expect(() => service.authorizeReveal(join(projects[0], 'prompt.md'))).toThrow('plugin path was not discovered')
    expect(service.authorizeReveal(join(projects.at(-1)!, 'prompt.md'))).toBe(realpathSync(join(projects.at(-1)!, 'prompt.md')))
  })

  it('discovers only the authorized project .agents root without walking ancestors', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'workspace', 'project')
    const localSkill = join(project, '.agents', 'skills', 'local', 'SKILL.md')
    const ancestorSkill = join(root, 'workspace', '.agents', 'skills', 'ancestor', 'SKILL.md')
    mkdirSync(agentDir)
    mkdirSync(resolve(localSkill, '..'), { recursive: true })
    mkdirSync(resolve(ancestorSkill, '..'), { recursive: true })
    writeFileSync(localSkill, '---\nname: local\n---\nLocal skill')
    writeFileSync(ancestorSkill, '---\nname: ancestor\n---\nAncestor skill')
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ name: 'local', path: realpathSync(localSkill) }))
    expect(records.some((record) => record.path === realpathSync(ancestorSkill))).toBe(false)
    expect(readFileSync('electron/main/plugins/catalog.ts', 'utf8')).not.toContain('collectAncestorSkills')
  })

  it('keeps user-configured discovery contained to the agent directory and home', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const inside = join(agentDir, 'inside-prompt.md')
    const outside = join(root, 'outside-prompt.md')
    mkdirSync(agentDir)
    writeFileSync(inside, '# Inside\ncontained user discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [inside, outside] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list()

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'user', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === realpathSync(outside))).toBe(false)
  })

  it('keeps project-configured discovery contained while accepting in-project files', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const notes = join(project, 'notes')
    const outside = join(root, 'outside.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(notes)
    const inside = join(notes, 'inside.md')
    writeFileSync(inside, '# Inside\ncontained discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    symlinkSync(outside, join(notes, 'linked-outside.md'))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({
      prompts: [inside, outside, join(notes, 'linked-outside.md')],
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'project', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === join(notes, 'linked-outside.md'))).toBe(false)
  })
})

describe('PluginService MCP connections', () => {
  it('rejects network transports at the settings writer even if callers bypass service validation', async () => {
    const root = temp()
    const settingsPath = join(root, 'mcp.json')

    await expect(updateMcpSettings(
      settingsPath,
      { name: 'remote', scope: 'user', type: 'sse', url: 'https://mcp.example/sse' } as never,
      undefined,
      { harness: 'omp', agentName: 'OMP' },
    )).rejects.toThrow(/managed outside GooeyPi/)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('rejects state changes at the low-level writer unless the caller identifies OMP or Pi', async () => {
    const root = temp()
    const settingsPath = join(root, 'settings.json')
    const original = JSON.stringify({ mcpServers: { local: { type: 'stdio', command: 'mcp-local', enabled: true } } })
    writeFileSync(settingsPath, original)

    await expect(updateMcpState(settingsPath, { name: 'local', scope: 'user', enabled: false }))
      .resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('Prime Agent MCP servers are managed outside GooeyPi') })
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
  })

  it.each(['prime', 'omp', 'pi'] as const)('rejects every %s network MCP transport before touching settings', async (harness) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness })
    const settingsPath = join(agentDir, harness === 'prime' ? 'settings.json' : 'mcp.json')

    for (const input of [
      { type: 'http', url: 'http://127.0.0.1:3333/mcp', auth: 'none' },
      { type: 'http', url: 'http://localhost:3333/mcp', auth: 'none' },
      { type: 'http', url: 'http://[::1]:3333/mcp', auth: 'none' },
      { type: 'http', url: 'https://mcp.example/mcp', auth: 'oauth' },
      { type: 'http', url: 'https://mcp.example/mcp', auth: 'bearer', bearerTokenEnvVar: 'MCP_TOKEN' },
      { type: 'sse', url: 'https://mcp.example/sse', auth: 'none' },
      { type: 'stdio', command: 'mcp-local', url: 42 },
    ] as const) {
      await expect(service.connectMcp({ name: 'remote', scope: 'user', ...input } as never))
        .rejects.toThrow('Network MCP servers are managed outside GooeyPi')
      expect(existsSync(settingsPath)).toBe(false)
    }
  })

  it.each(['omp', 'pi'] as const)('retains local stdio create and state management for %s', async (harness) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    if (harness === 'pi') writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness })

    expect((await service.connectMcp({ name: 'files', scope: 'user', type: 'stdio', command: 'mcp-files', args: ['--root', '/tmp'] })).ok).toBe(true)
    expect((await service.setMcpEnabled({ name: 'files', scope: 'user', enabled: false })).ok).toBe(true)
    expect((await service.setMcpEnabled({ name: 'files', scope: 'user', enabled: true })).ok).toBe(true)

    const config = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(config.mcpServers.files).toMatchObject({ command: 'mcp-files', args: ['--root', '/tmp'], enabled: true })
  })

  it.each(['omp', 'pi'] as const)('marks unaddressable local %s MCP keys non-actionable while retaining bounded cleanup identity', async (harness) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    if (harness === 'pi') writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const longKey = `long-${'x'.repeat(60)}`
    const oversizedKey = `oversized-${'x'.repeat(1_024)}`
    const mcpServers: Record<string, unknown> = Object.create(null)
    mcpServers.valid = { type: 'stdio', command: 'mcp-valid' }
    mcpServers['team/docs'] = { type: 'stdio', command: 'mcp-slash' }
    mcpServers[longKey] = { type: 'stdio', command: 'mcp-long' }
    mcpServers['control\u0001key'] = { type: 'stdio', command: 'mcp-control' }
    mcpServers[oversizedKey] = { type: 'stdio', command: 'mcp-oversized' }
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness })

    const records = (await service.list()).skills.filter((item) => item.kind === 'mcp')

    expect(records.find((item) => item.name === 'valid')?.availability).toBeUndefined()
    for (const definitionKey of ['team/docs', longKey, 'control\u0001key']) {
      expect(records.find((item) => item.definitionKey === definitionKey)).toMatchObject({
        availability: { available: false, detail: expect.stringContaining('enable or disable') },
      })
    }
    expect(records.find((item) => item.name === oversizedKey.slice(0, 120))).toMatchObject({
      definitionRemovalAvailable: false,
      availability: { available: false, detail: expect.stringContaining('enable or disable') },
    })
  })

  it.each([
    ['set', 'missing', { name: 'files', scope: 'user', enabled: false }],
    ['enable', 'missing', { kind: 'mcp', action: 'enable', name: 'files', scope: 'user' }],
    ['disable', 'missing', { kind: 'mcp', action: 'disable', name: 'files', scope: 'user' }],
    ['set', 'disabled', { name: 'files', scope: 'user', enabled: false }],
    ['enable', 'disabled', { kind: 'mcp', action: 'enable', name: 'files', scope: 'user' }],
    ['disable', 'disabled', { kind: 'mcp', action: 'disable', name: 'files', scope: 'user' }],
  ] as const)('rejects Pi MCP state writes through %s when its adapter is %s', async (path, adapterState, input) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    if (adapterState === 'disabled') {
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
        packages: [{ source: 'npm:pi-mcp-adapter', extensions: [], skills: [], prompts: [], themes: [] }],
        gooeypiDisabledPackages: { 'npm:pi-mcp-adapter': 'npm:pi-mcp-adapter' },
      }))
    }
    const mcpPath = join(agentDir, 'mcp.json')
    const original = JSON.stringify({ mcpServers: { files: { command: 'mcp-files', enabled: true } } })
    writeFileSync(mcpPath, original)
    const service = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })

    const response = path === 'set'
      ? await service.setMcpEnabled(input)
      : await service.mutateCapability(input)

    expect(response).toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('supported adapter first') })
    expect(readFileSync(mcpPath, 'utf8')).toBe(original)
  })

  it.each(['create', 'set', 'enable', 'disable'] as const)('serializes Pi adapter disable ahead of an overlapping MCP %s request', async (path) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const mcpPath = join(agentDir, 'mcp.json')
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { files: { command: 'mcp-files', enabled: true } } }))
    const service = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })
    const internals = service as unknown as {
      piMcpAdapterState(): Promise<{ source: string; enabled: boolean } | undefined>
    }
    const readAdapter = internals.piMcpAdapterState.bind(service)
    let admissionReads = 0
    internals.piMcpAdapterState = async () => ++admissionReads <= 2
      ? { source: 'npm:pi-mcp-adapter', enabled: true }
      : readAdapter()

    const disabling = service.setMcpSupport(false)
    const writing = path === 'create'
      ? service.connectMcp({ name: 'new-server', scope: 'user', type: 'stdio', command: 'mcp-new' })
      : path === 'set'
        ? service.setMcpEnabled({ name: 'files', scope: 'user', enabled: false })
        : service.mutateCapability({ kind: 'mcp', action: path, name: 'files', scope: 'user' })

    await expect(disabling).resolves.toMatchObject({ ok: true })
    await expect(writing).resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('supported adapter first') })
    const config = JSON.parse(readFileSync(mcpPath, 'utf8'))
    expect(config.mcpServers.files.enabled).toBe(true)
    expect(config.mcpServers['new-server']).toBeUndefined()
  })

  it.each([
    ['support toggle', 'create'], ['support toggle', 'set'], ['support toggle', 'enable'], ['support toggle', 'disable'],
    ['generic package mutation', 'create'], ['generic package mutation', 'set'], ['generic package mutation', 'enable'], ['generic package mutation', 'disable'],
  ] as const)('serializes Pi adapter %s against MCP %s across service instances', async (transition, path) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    const mcpPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { files: { command: 'mcp-files', enabled: true } } }))
    const adapterService = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })
    const writerService = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })
    const internals = adapterService as unknown as { settingsFingerprint(path: string): Promise<string> }
    const originalFingerprint = internals.settingsFingerprint.bind(adapterService)
    let releaseDisable: () => void = () => undefined
    const disableGate = new Promise<void>((resolveGate) => { releaseDisable = resolveGate })
    let markDisableHolding: () => void = () => undefined
    const disableHolding = new Promise<void>((resolveHolding) => { markDisableHolding = resolveHolding })
    let gated = false
    internals.settingsFingerprint = async (target) => {
      if (!gated && target === settingsPath) {
        gated = true
        markDisableHolding()
        await disableGate
      }
      return originalFingerprint(target)
    }

    const disabling = transition === 'support toggle'
      ? adapterService.setMcpSupport(false)
      : adapterService.mutateCapability({
          kind: 'package', action: 'disable', name: 'Pi MCP Adapter', source: 'npm:pi-mcp-adapter', scope: 'user',
        })
    await disableHolding
    expect(existsSync(join(agentDir, '.gooeypi-pi-mcp-admission.lock'))).toBe(true)
    const writing = path === 'create'
      ? writerService.connectMcp({ name: 'new-server', scope: 'user', type: 'stdio', command: 'mcp-new' })
      : path === 'set'
        ? writerService.setMcpEnabled({ name: 'files', scope: 'user', enabled: false })
        : writerService.mutateCapability({ kind: 'mcp', action: path, name: 'files', scope: 'user' })
    await new Promise((resolveWait) => setTimeout(resolveWait, 75))
    const whileDisabled = JSON.parse(readFileSync(mcpPath, 'utf8'))
    expect(whileDisabled.mcpServers.files.enabled).toBe(true)
    expect(whileDisabled.mcpServers['new-server']).toBeUndefined()

    releaseDisable()
    await expect(disabling).resolves.toMatchObject({ ok: true })
    await expect(writing).resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('supported adapter first') })
  })

  it.each([
    'pi-mcp-adapter',
    'npm:@evil/pi-mcp-adapter',
    'git:https://example.test/attacker/pi-mcp-adapter',
    '/tmp/pi-mcp-adapter',
    'npm:pi-mcp-adapter@1.2.3-01',
    'npm:pi-mcp-adapter@1.2.3-alpha.01',
  ])('does not authorize Pi MCP writes for adapter lookalike %s', async (source) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [source] }))
    const service = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })

    expect((await service.list()).skills).toContainEqual(expect.objectContaining({ id: 'gooeypi-pi-mcp', enabled: false }))
    await expect(service.connectMcp({ name: 'files', scope: 'user', type: 'stdio', command: 'mcp-files' }))
      .resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('supported adapter first') })
    expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false)
  })

  it('accepts an explicit semantic version of the canonical Pi MCP adapter package', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter@1.2.3-beta.1+build.2'] }))
    const service = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })

    expect((await service.list()).skills).toContainEqual(expect.objectContaining({ id: 'gooeypi-pi-mcp', enabled: true }))
    await expect(service.connectMcp({ name: 'files', scope: 'user', type: 'stdio', command: 'mcp-files' }))
      .resolves.toMatchObject({ ok: true })
  })

  it('marks local Pi MCP entries unavailable while its adapter is absent', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      files: { command: 'mcp-files', enabled: true },
    } }))
    const service = new PluginService(null, async (value) => resolve(value), { agentDir, harness: 'pi' })

    expect((await service.list()).skills.find((skill) => skill.kind === 'mcp' && skill.name === 'files')).toMatchObject({
      availability: { available: false, detail: expect.stringContaining('supported adapter first') },
    })
  })

  it.each([
    ['prime', { type: 'http', url: 'https://mcp.example/mcp', enabled: true }],
    ['omp', { type: 'sse', url: 'https://mcp.example/sse', enabled: true }],
    ['pi', { url: 'https://mcp.example/mcp', enabled: true }],
  ] as const)('keeps an externally configured %s network server visible but non-actionable', async (harness, definition) => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    if (harness === 'pi') writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const settingsPath = join(agentDir, harness === 'prime' ? 'settings.json' : 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { remote: definition } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness })

    const record = (await service.list()).skills.find((item) => item.kind === 'mcp' && item.name === 'remote')
    expect(record).toMatchObject({
      enabled: true,
      availability: {
        available: false,
        detail: expect.stringContaining('managed outside GooeyPi'),
      },
    })

    const original = readFileSync(settingsPath, 'utf8')
    await expect(service.setMcpEnabled({ name: 'remote', scope: 'user', enabled: false }))
      .resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('managed outside GooeyPi') })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'enable', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('managed outside GooeyPi') })
    await expect(service.mutateCapability({ kind: 'mcp', action: 'disable', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('managed outside GooeyPi') })
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
  })

  it('allows definition-only deletion for an externally configured network server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example/mcp', oauth: true, enabled: true },
      keep: { type: 'http', url: 'https://keep.example/mcp', enabled: true },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'remote', scope: 'user' }))
      .resolves.toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers).toEqual({
      keep: { type: 'http', url: 'https://keep.example/mcp', enabled: true },
    })
  })

  it('does not offer a writable MCP transport for Prime Agent', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.connectMcp({ name: 'remote', scope: 'user', type: 'http', url: 'https://mcp.example/mcp' }))
      .rejects.toThrow('managed outside GooeyPi')
    await expect(service.connectMcp({ name: 'local', scope: 'user', type: 'stdio', command: 'npx' }))
      .rejects.toThrow('only manages local stdio MCP definitions for OMP and Pi')
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)
  })

  it('keeps project settings preparation free of synchronous fs syscalls', () => {
    // renameSync is the one deliberate exception (kept adjacent to its identity
    // checks); everything else in the settings path must be fs/promises.
    const source = readFileSync('electron/main/plugins/mcp.ts', 'utf8')
    expect(source).not.toMatch(/\b(?:existsSync|lstatSync|mkdirSync|realpathSync|readFileSync|writeFileSync|rmSync)\b/)
  })

  it('does not create a missing MCP definition while changing state', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.setMcpEnabled({ name: 'missing', scope: 'user', enabled: false })
    expect(response).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('removes one MCP definition without changing neighboring servers or global credentials', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp', oauth: true },
      keep: { type: 'http', url: 'https://keep.example/mcp' },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'docs', scope: 'user' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers).toEqual({ keep: { type: 'http', url: 'https://keep.example/mcp' } })
  })

  it('removes only the MCP definition when an associated package source is forged into the request', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const executable = join(root, 'prime-agent.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp' },
    } }))
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('removed\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir })

    await expect(service.mutateCapability({
      kind: 'mcp', action: 'remove', name: 'docs', source: 'npm:prime-docs', scope: 'user',
    })).resolves.toMatchObject({ ok: true })

    expect(existsSync(capture)).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers).toEqual({})
  })

  it('disables and restores a package while preserving its original filters', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const original = { source: 'npm:acme-tools', skills: ['skills/review/SKILL.md'] }
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [original], keep: true }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    expect((await service.mutateCapability({ kind: 'package', action: 'disable', name: 'acme-tools', source: 'npm:acme-tools', scope: 'user' })).ok).toBe(true)
    let settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.packages[0]).toEqual({ source: 'npm:acme-tools', extensions: [], skills: [], prompts: [], themes: [] })
    expect(settings.keep).toBe(true)
    expect((await service.list()).skills.find((skill) => skill.kind === 'package')).toMatchObject({ enabled: false })

    expect((await service.mutateCapability({ kind: 'package', action: 'enable', name: 'acme-tools', source: 'npm:acme-tools', scope: 'user' })).ok).toBe(true)
    settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.packages[0]).toEqual(original)
    expect(settings.gooeypiDisabledPackages).toBeUndefined()
  })

  it('connects an OMP stdio MCP server at project scope', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    mkdirSync(project)
    const service = new PluginService(null, async (path) => {
      expect(path).toBe(project)
      return resolve(path)
    }, { agentDir, harness: 'omp' })

    const response = await service.connectMcp({
      name: 'project-files',
      scope: 'project',
      projectPath: project,
      type: 'stdio',
      command: 'mcp-project-files',
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'))
    expect(settings.mcpServers['project-files']).toEqual({ type: 'stdio', command: 'mcp-project-files', enabled: true })
    expect((await service.list(project)).skills.find((item) => item.name === 'project-files')).toMatchObject({ kind: 'mcp', location: 'project' })
  })

  it('rejects project MCP settings paths that traverse repository symlinks', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project); mkdirSync(outside)
    symlinkSync(outside, join(project, '.omp'))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'mcp-local',
    })).rejects.toThrow(/real directory/)
    expect(() => readFileSync(join(outside, 'agent', 'settings.json'))).toThrow()
  })

  it('fails closed when the project MCP directory is substituted at the final rename boundary', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.omp')
    const displacedAgentDir = join(project, '.omp-original')
    const outside = join(root, 'outside')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ outside: 'unchanged' }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let substituted = false
    internal.settingsFingerprint = async (path) => {
      const fingerprint = await original(path)
      if (!substituted) {
        substituted = true
        const temporaryName = readdirSync(projectAgentDir).find((name) => name.startsWith('mcp.json.') && name.endsWith('.tmp'))
        expect(temporaryName).toBeTypeOf('string')
        const stagedSettings = readFileSync(join(projectAgentDir, temporaryName!), 'utf8')
        renameSync(projectAgentDir, displacedAgentDir)
        symlinkSync(outside, projectAgentDir, 'dir')
        // Recreate the observed random staging name so the vulnerable lexical
        // rename would overwrite settings in the substituted directory.
        writeFileSync(join(outside, temporaryName!), stagedSettings)
      }
      return fingerprint
    }

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'mcp-local',
    })).rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'mcp.json'), 'utf8')).outside).toBe('unchanged')
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'mcp.json'), 'utf8')).mcpServers).toBeUndefined()
  })

  it('rechecks the pinned project directory before reading a definition-removal snapshot', async () => {
    const root = temp()
    const projectAgentDir = join(root, 'project', '.omp')
    const displacedAgentDir = join(root, 'project', '.omp-original')
    const outside = join(root, 'outside')
    mkdirSync(projectAgentDir, { recursive: true })
    mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'mcp-other' } } }))
    writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ outside: 'unchanged', mcpServers: {} }))
    let verifyCalls = 0
    let substituted = false
    const verify = async () => {
      verifyCalls += 1
      if (substituted) throw new TypeError('Project MCP configuration directory changed during update')
      // Lock acquisition performs three verification calls. Substitute only
      // when removal enters its pre-snapshot check so both the pre- and
      // post-read checks are required to catch the change before early return.
      if (verifyCalls === 4) {
        renameSync(projectAgentDir, displacedAgentDir)
        symlinkSync(outside, projectAgentDir, 'dir')
        substituted = true
      }
    }

    await expect(removeMcpDefinition({ path: settingsPath, verify }, { name: 'docs', definitionKey: 'docs' }))
      .rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'mcp.json'), 'utf8'))).toEqual({ outside: 'unchanged', mcpServers: {} })
    expect(verifyCalls).toBe(5)
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'mcp.json'), 'utf8')).mcpServers).toHaveProperty('other')
  })

  it('rejects network URLs and refuses to overwrite an existing local server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'safe' } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    await expect(service.connectMcp({ name: 'secret', scope: 'user', type: 'http', url: 'https://token@example.test/mcp' })).rejects.toThrow(/managed outside GooeyPi/)
    const duplicate = await service.connectMcp({ name: 'existing', scope: 'user', type: 'stdio', command: 'other' })
    expect(duplicate.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers.existing.command).toBe('safe')
  })

  it('serializes updates across service instances and rereads settings after locking', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ marker: 'kept' }))
    const first = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const second = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const responses = await Promise.all([
      first.connectMcp({ name: 'first', scope: 'user', type: 'stdio', command: 'mcp-first' }),
      second.connectMcp({ name: 'second', scope: 'user', type: 'stdio', command: 'mcp-second' }),
    ])

    expect(responses.every((response) => response.ok)).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(settings.marker).toBe('kept')
    expect(settings.mcpServers.first.command).toBe('mcp-first')
    expect(settings.mcpServers.second.command).toBe('mcp-second')
  })

  it('recovers a lock only after its recorded owner has exited', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const exitedPid = exited.pid
    expect(exitedPid).toBeTypeOf('number')
    await new Promise<void>((resolveExit, rejectExit) => {
      exited.once('error', rejectExit)
      exited.once('exit', () => resolveExit())
    })
    const lockPath = `${settingsPath}.lock`
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: 'exited-test-owner',
      createdAt: Date.now() - 1_000,
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const response = await service.connectMcp({ name: 'after-crash', scope: 'user', type: 'stdio', command: 'mcp-after-crash' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers['after-crash'].command).toBe('mcp-after-crash')
    expect(() => readFileSync(join(lockPath, 'owner.json'))).toThrow()
  })

  it('detects and merges a non-cooperating writer update before rename', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let injected = false
    internal.settingsFingerprint = async (path) => {
      if (!injected) {
        injected = true
        writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', changedByCli: true }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'merged', scope: 'user', type: 'stdio', command: 'mcp-merged' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.changedByCli).toBe(true)
    expect(settings.mcpServers.merged.command).toBe('mcp-merged')
  })

  it('retries multiple non-cooperating writer conflicts and merges the latest snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let conflicts = 0
    internal.settingsFingerprint = async (path) => {
      if (conflicts < 2) {
        conflicts += 1
        writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', externalRevision: conflicts }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'after-retries', scope: 'user', type: 'stdio', command: 'mcp-after-retries' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(conflicts).toBe(2)
    expect(settings.externalRevision).toBe(2)
    expect(settings.mcpServers['after-retries'].command).toBe('mcp-after-retries')
  })

  it('fails after bounded conflicts without replacing the external writer snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ marker: 'kept' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let externalRevision = 0
    internal.settingsFingerprint = async (path) => {
      externalRevision += 1
      writeFileSync(settingsPath, JSON.stringify({ marker: 'kept', externalRevision }))
      return original(path)
    }

    await expect(service.connectMcp({ name: 'never-written', scope: 'user', type: 'stdio', command: 'mcp-never-written' }))
      .rejects.toThrow(/changed repeatedly/)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(externalRevision).toBe(4)
    expect(settings.externalRevision).toBe(4)
    expect(settings.mcpServers).toBeUndefined()
  })

  it('registers a standalone project extension through Prime package install --local', async () => {
    const root = temp()
    const agentDir = join(root, '.prime', 'agent')
    const project = join(root, 'project')
    const extension = join(root, 'review.ts')
    const executable = join(root, 'prime-agent.cjs')
    const capture = join(root, 'extension-argv.json')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(extension, 'export default () => undefined\n')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => realpathSync(path), { agentDir })

    expect((await service.installExtension({ source: extension, scope: 'project', projectPath: project })).ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ args: ['package', 'install', '--local', realpathSync(extension)], cwd: realpathSync(project) })
  })

})

describe('PluginService OMP parity', () => {
  it('discovers OMP-native user, project, MCP, and installed plugin surfaces', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const userSkill = join(root, '.omp', 'skills', 'user-skill', 'SKILL.md')
    const userPackage = join(root, '.omp', 'plugins', 'node_modules', 'user-plugin')
    const packageSkill = join(userPackage, 'skills', 'package-skill', 'SKILL.md')
    const project = join(root, 'project')
    const projectSkill = join(project, '.omp', 'skills', 'project-skill', 'SKILL.md')
    const projectPackage = join(project, '.omp', 'plugins', 'node_modules', 'project-plugin')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(resolve(userSkill, '..'), { recursive: true })
    mkdirSync(resolve(packageSkill, '..'), { recursive: true })
    mkdirSync(resolve(projectSkill, '..'), { recursive: true })
    mkdirSync(projectPackage, { recursive: true })
    writeFileSync(userSkill, '---\nname: OMP user skill\n---\nUser workflow')
    writeFileSync(packageSkill, '---\nname: Plugin skill\n---\nInstalled workflow')
    writeFileSync(join(userPackage, 'package.json'), JSON.stringify({ name: 'user-plugin', description: 'User OMP plugin', omp: {} }))
    writeFileSync(projectSkill, '---\nname: OMP project skill\n---\nProject workflow')
    writeFileSync(join(projectPackage, 'package.json'), JSON.stringify({ name: 'project-plugin', description: 'Project OMP plugin', pi: {} }))
    writeFileSync(join(project, '.omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'project-plugin': { enabled: false, enabledFeatures: null, version: '1.0.0' } }, settings: {} }))
    const transitive = join(root, '.omp', 'plugins', 'node_modules', 'transitive-only')
    mkdirSync(transitive)
    writeFileSync(join(transitive, 'package.json'), JSON.stringify({ name: 'transitive-only' }))
    const marketplace = join(root, '.omp', 'plugins', 'node_modules', 'marketplace-plugin')
    mkdirSync(marketplace)
    writeFileSync(join(marketplace, 'package.json'), JSON.stringify({ name: 'marketplace-plugin', description: 'Marketplace plugin' }))
    writeFileSync(join(root, '.omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'marketplace-plugin': { enabled: true, enabledFeatures: null, version: '1.0.0' } }, settings: {} }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }))
    mkdirSync(join(project, '.omp'), { recursive: true })
    writeFileSync(join(project, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'npx' } } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const catalog = await service.list(project)

    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'OMP user skill', kind: 'skill', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'OMP project skill', kind: 'skill', location: 'project' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'Plugin skill', kind: 'skill', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'user-plugin', kind: 'package', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'project-plugin', kind: 'package', location: 'project', enabled: false }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'marketplace-plugin', kind: 'package', location: 'user', enabled: true }))
    expect(catalog.skills.some((item) => item.name === 'transitive-only')).toBe(false)
    expect(catalog.skills).toContainEqual(expect.objectContaining({
      name: 'docs', kind: 'mcp', location: 'user',
      availability: { available: false, detail: expect.stringContaining('managed outside GooeyPi') },
    }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'files', kind: 'mcp', location: 'project' }))
  })

  it('writes only local stdio definitions to native OMP mcp.json files at both scopes', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    await expect(service.connectMcp({ name: 'docs:remote', scope: 'user', type: 'http', url: 'https://docs.example/mcp', auth: 'oauth' }))
      .rejects.toThrow(/managed outside GooeyPi/)
    await expect(service.connectMcp({ name: 'stream', scope: 'user', type: 'sse', url: 'https://docs.example/sse' } as never))
      .rejects.toThrow(/managed outside GooeyPi/)
    const user = await service.connectMcp({ name: 'local', scope: 'user', type: 'stdio', command: 'mcp-local' })
    const projectResult = await service.connectMcp({ name: 'files', scope: 'project', projectPath: project, type: 'stdio', command: 'npx', args: ['-y', 'server'] })
    await expect(service.connectMcp({ name: 'invalid name', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/unsupported characters/)

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('new OMP session') })
    expect(projectResult.ok).toBe(true)
    const userConfig = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const projectConfig = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'))
    expect(userConfig.$schema).toContain('can1357/oh-my-pi')
    expect(userConfig.mcpServers).toEqual({ local: { type: 'stdio', command: 'mcp-local', enabled: true } })
    expect(projectConfig.mcpServers.files).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server'], enabled: true })
    expect(existsSync(join(project, '.prime'))).toBe(false)
  })

  it('installs through the native omp plugin command with validated argv', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const executable = join(root, 'omp.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('{"ok":true}\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const result = await service.install('npm:@scope/example-plugin')

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['plugin', 'install', '@scope/example-plugin', '--json'])

    await service.install('code-review@official')
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['plugin', 'install', 'code-review@official', '--json'])
  })

  it('installs standalone OMP extensions through native user and project extension directories', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    const source = join(root, 'clock.ts')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(source, 'export default () => undefined\n')
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const user = await service.installExtension({ source, scope: 'user' })
    const local = await service.installExtension({ source, scope: 'project', projectPath: project })
    const duplicate = await service.installExtension({ source, scope: 'user' })

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('clock.ts') })
    expect(local.ok).toBe(true)
    expect(readFileSync(join(agentDir, 'extensions', 'clock.ts'), 'utf8')).toContain('export default')
    expect(readFileSync(join(project, '.omp', 'extensions', 'clock.ts'), 'utf8')).toContain('export default')
    expect(duplicate).toMatchObject({ ok: false, reason: 'blocked' })
    await expect(service.installExtension({ source: join(root, 'missing.ts'), scope: 'user' })).rejects.toThrow(/does not exist/)
  })
})

describe('PluginService Pi parity', () => {
  it('discovers pi-native user, project, shared skill, and mcp.json surfaces', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const userSkill = join(agentDir, 'skills', 'user-skill', 'SKILL.md')
    const userExtension = join(agentDir, 'extensions', 'user-tool.ts')
    const project = join(root, 'project')
    const projectSkill = join(project, '.pi', 'skills', 'project-skill', 'SKILL.md')
    const projectExtension = join(project, '.pi', 'extensions', 'project-tool.ts')
    const sharedSkill = join(project, '.agents', 'skills', 'shared-skill', 'SKILL.md')
    mkdirSync(resolve(userSkill, '..'), { recursive: true })
    mkdirSync(resolve(userExtension, '..'), { recursive: true })
    mkdirSync(resolve(projectSkill, '..'), { recursive: true })
    mkdirSync(resolve(projectExtension, '..'), { recursive: true })
    mkdirSync(resolve(sharedSkill, '..'), { recursive: true })
    writeFileSync(userSkill, '---\nname: Pi user skill\n---\nUser workflow')
    writeFileSync(userExtension, 'export default (pi) => {}')
    writeFileSync(projectSkill, '---\nname: Pi project skill\n---\nProject workflow')
    writeFileSync(projectExtension, 'export default (pi) => {}')
    writeFileSync(sharedSkill, '---\nname: Shared skill\n---\nShared workflow')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: ['npm:installed-package'],
      mcpServers: { stray: { type: 'stdio', command: 'never-loaded' } },
    }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }))
    writeFileSync(join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'npx' } } }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const catalog = await service.list(project)

    expect(catalog.warnings).toEqual([])
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'Pi user skill', kind: 'skill', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'Pi project skill', kind: 'skill', location: 'project' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'Shared skill', kind: 'skill', location: 'project' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'user-tool', kind: 'extension', location: 'user', description: 'Pi extension' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'project-tool', kind: 'extension', location: 'project', description: 'Pi extension' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'installed-package', kind: 'package', description: 'installed-package capability package' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ id: 'gooeypi-pi-mcp', name: 'Pi MCP Adapter', enabled: false }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({
      name: 'docs', kind: 'mcp', location: 'user',
      availability: { available: false, detail: expect.stringContaining('managed outside GooeyPi') },
    }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'files', kind: 'mcp', location: 'project' }))
    // settings.json is not an MCP source for pi; only mcp.json entries surface.
    expect(catalog.skills.some((item) => item.name === 'stray')).toBe(false)
  })

  it('bounds hostile oversized pi mcp.json files with a structured warning', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), `{"mcpServers":{"big":{"type":"stdio","command":"${'a'.repeat(5 * 1024 * 1024)}"}}}`)
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const catalog = await service.list()

    expect(catalog.warnings).toContainEqual({ scope: 'user', path: join(agentDir, 'mcp.json'), message: 'mcp.json is too large — plugins hidden' })
    expect(catalog.skills.some((item) => item.kind === 'mcp')).toBe(false)
  })

  it('writes only local stdio definitions to pi-mcp-adapter mcp.json files at both scopes', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const project = join(root, 'project')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    await expect(service.connectMcp({ name: 'docs:remote', scope: 'user', type: 'http', url: 'https://docs.example/mcp', auth: 'oauth' }))
      .rejects.toThrow(/managed outside GooeyPi/)
    await expect(service.connectMcp({ name: 'stream', scope: 'user', type: 'sse', url: 'https://docs.example/sse' } as never))
      .rejects.toThrow(/managed outside GooeyPi/)
    const user = await service.connectMcp({ name: 'local', scope: 'user', type: 'stdio', command: 'mcp-local' })
    const projectResult = await service.connectMcp({ name: 'files', scope: 'project', projectPath: project, type: 'stdio', command: 'npx', args: ['-y', 'server'] })
    await expect(service.connectMcp({ name: 'invalid name', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/unsupported characters/)

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('new Pi session') })
    expect(user.output).toContain('through pi-mcp-adapter')
    expect(projectResult.ok).toBe(true)
    const userConfig = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const projectConfig = JSON.parse(readFileSync(join(project, '.pi', 'mcp.json'), 'utf8'))
    expect(userConfig.$schema).toBeUndefined()
    expect(userConfig.mcpServers).toEqual({ local: { command: 'mcp-local', enabled: true } })
    expect(projectConfig.mcpServers.files).toEqual({ command: 'npx', args: ['-y', 'server'], enabled: true })
    expect(existsSync(join(project, '.prime'))).toBe(false)
  })

  it('blocks MCP configuration without pi-mcp-adapter and writes nothing', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    mkdirSync(agentDir, { recursive: true })
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const result = await service.connectMcp({ name: 'docs', scope: 'user', type: 'stdio', command: 'mcp-docs' })

    expect(result).toMatchObject({ ok: false, reason: 'blocked', output: expect.stringContaining('pi install npm:pi-mcp-adapter') })
    expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false)
  })

  it('rejects pi project MCP paths that traverse repository symlinks', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    mkdirSync(project)
    mkdirSync(outside)
    symlinkSync(outside, join(project, '.pi'))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'mcp-local',
    })).rejects.toThrow(/real directory/)
    expect(() => readFileSync(join(outside, 'mcp.json'))).toThrow()
  })

  it('installs through the native pi install command with validated argv', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const executable = join(root, 'pi.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('installed\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir, harness: 'pi' })

    const result = await service.install('npm:@scope/example-plugin')

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['install', 'npm:@scope/example-plugin'])

    const missing = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'pi' })
    expect(await missing.install('npm:@scope/example-plugin')).toEqual({ ok: false, reason: 'blocked', output: 'Pi executable was not found' })
    await expect(service.install('--registry=https://evil.test')).rejects.toThrow(/Invalid package source/)
  })

  it('registers a standalone project extension through pi install -l', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const project = join(root, 'project')
    const extension = join(root, 'review.ts')
    const executable = join(root, 'pi.cjs')
    const capture = join(root, 'extension-argv.json')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(extension, 'export default () => undefined\n')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    expect((await service.installExtension({ source: extension, scope: 'project', projectPath: project })).ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ args: ['install', '-l', realpathSync(extension)], cwd: realpathSync(project) })
  })

  it('installs the Pi MCP adapter once, then disables and restores it without removing files or MCP config', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const executable = join(root, 'pi.cjs')
    const capture = join(root, 'argv.json')
    mkdirSync(agentDir, { recursive: true })
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example/mcp' } } }))
    writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), nativeLock: fs.existsSync(${JSON.stringify(`${settingsPath}.lock`)}), gooeypiLock: fs.existsSync(${JSON.stringify(`${settingsPath}.gooeypi.lock`)}) })); process.stdout.write('ok\\n')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir, harness: 'pi' })

    expect((await service.list()).skills).toContainEqual(expect.objectContaining({ id: 'gooeypi-pi-mcp', enabled: true, source: 'npm:pi-mcp-adapter' }))
    expect((await service.setMcpSupport(false)).ok).toBe(true)
    let settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.packages).toEqual([{ source: 'npm:pi-mcp-adapter', extensions: [], skills: [], prompts: [], themes: [] }])
    expect(settings.gooeypiDisabledPackages).toEqual({ 'npm:pi-mcp-adapter': 'npm:pi-mcp-adapter' })
    expect((await service.list()).skills).toContainEqual(expect.objectContaining({ id: 'gooeypi-pi-mcp', enabled: false, source: 'npm:pi-mcp-adapter' }))
    expect(existsSync(capture)).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers.docs).toBeTruthy()

    expect((await service.setMcpSupport(true)).ok).toBe(true)
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.packages).toEqual(['npm:pi-mcp-adapter'])
    expect(settings.gooeypiDisabledPackages).toBeUndefined()
    expect(existsSync(capture)).toBe(false)
    await expect(service.setMcpSupport('yes')).rejects.toThrow(/boolean/)
  })

  it('runs the Pi remove command with a bounded argv result', async () => {
    const root = temp()
    const executable = join(root, 'pi.cjs')
    const capture = join(root, 'argv.json')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('removed\\n')\n`)
    chmodSync(executable, 0o755)

    expect((await executePiPluginRemove(executable, 'npm:pi-mcp-adapter')).ok).toBe(true)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['remove', 'npm:pi-mcp-adapter'])
  })

  it('bounds and sanitizes untrusted pi CLI output', async () => {
    const root = temp()
    const noisy = join(root, 'pi-noisy.cjs')
    writeFileSync(noisy, '#!/usr/bin/env node\nprocess.stdout.write("\\u001b[32minstalled pi plugin\\u001b[0m\\n")\n')
    chmodSync(noisy, 0o755)
    const flooding = join(root, 'pi-flooding.cjs')
    writeFileSync(flooding, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(9 * 1024 * 1024, 97))\n')
    chmodSync(flooding, 0o755)

    const sanitized = await executePiPluginInstall(noisy, 'npm:example-plugin')
    const flooded = await executePiPluginInstall(flooding, 'npm:example-plugin')

    expect(sanitized.ok).toBe(true)
    expect(sanitized.output).toContain('installed pi plugin')
    expect(sanitized.output).not.toContain('\u001b')
    expect(flooded.ok).toBe(false)
    expect(flooded.reason).toBe('overflow')
  })

  it('keeps pi project discovery contained and reveal authorization scoped to discovered paths', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const project = join(root, 'project')
    const localSkill = join(project, '.pi', 'skills', 'local', 'SKILL.md')
    const outside = join(root, 'outside')
    const outsideSkill = join(outside, 'SKILL.md')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(resolve(localSkill, '..'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(localSkill, '---\nname: local\n---\nLocal skill')
    writeFileSync(outsideSkill, '---\nname: outside\n---\nShould not be disclosed')
    symlinkSync(outside, join(project, '.pi', 'skills', 'linked-outside'))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ name: 'local', path: realpathSync(localSkill) }))
    expect(records.some((record) => record.path === outsideSkill || record.path === realpathSync(outsideSkill))).toBe(false)
    expect(service.authorizeReveal(localSkill)).toBe(realpathSync(localSkill))
    expect(() => service.authorizeReveal(outsideSkill)).toThrow('plugin path was not discovered')
  })
})
