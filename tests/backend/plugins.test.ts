import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginService, beginPluginDiscoveryShutdown } from '../../electron/main/plugins'
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
  it('writes Prime HTTP auth fields and rejects unsupported stdio integrations', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await service.connectMcp({ name: 'oauth-service', scope: 'user', type: 'http', url: 'https://oauth.example/mcp', auth: 'oauth' })
    await service.connectMcp({ name: 'token-service', scope: 'user', type: 'http', url: 'https://token.example/mcp', auth: 'bearer', bearerTokenEnvVar: 'ACME_MCP_TOKEN' })

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.mcpServers['oauth-service']).toEqual({ type: 'http', url: 'https://oauth.example/mcp', oauth: true, enabled: true })
    expect(settings.mcpServers['token-service']).toEqual({ type: 'http', url: 'https://token.example/mcp', bearerTokenEnvVar: 'ACME_MCP_TOKEN', enabled: true })
    await expect(service.connectMcp({ name: 'local', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/remote HTTP/)
    await expect(service.connectMcp({ name: 'bad-env', scope: 'user', type: 'http', url: 'https://bad.example/mcp', auth: 'bearer', bearerTokenEnvVar: 'BAD-NAME' })).rejects.toThrow(/environment variable is invalid/)
  })

  it('keeps project settings preparation free of synchronous fs syscalls', () => {
    // renameSync is the one deliberate exception (kept adjacent to its identity
    // checks); everything else in the settings path must be fs/promises.
    const source = readFileSync('electron/main/plugins/mcp.ts', 'utf8')
    expect(source).not.toMatch(/\b(?:existsSync|lstatSync|mkdirSync|realpathSync|readFileSync|writeFileSync|rmSync)\b/)
  })

  it('connects an HTTP MCP server without treating its URL as a package repository', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.connectMcp({
      name: 'local-studio',
      scope: 'user',
      type: 'http',
      url: 'http://127.0.0.1:3333/mcp',
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.defaultModel).toBe('test/model')
    expect(settings.mcpServers['local-studio']).toEqual({ type: 'http', url: 'http://127.0.0.1:3333/mcp', enabled: true })
    const record = (await service.list()).skills.find((item) => item.name === 'local-studio')
    expect(record).toMatchObject({ kind: 'mcp', location: 'user', enabled: true, source: 'http://127.0.0.1:3333' })
    expect(record?.description).not.toContain('/mcp')
  })

  it('disables and re-enables an MCP server without deleting its definition', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    await service.connectMcp({ name: 'docs', scope: 'user', type: 'http', url: 'https://docs.example/mcp', auth: 'oauth' })

    expect((await service.setMcpEnabled({ name: 'docs', scope: 'user', enabled: false })).ok).toBe(true)
    let settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.mcpServers.docs).toEqual({ type: 'http', url: 'https://docs.example/mcp', oauth: true, enabled: false })
    expect((await service.list()).skills.find((item) => item.name === 'docs')).toMatchObject({ enabled: false })

    expect((await service.setMcpEnabled({ name: 'docs', scope: 'user', enabled: true })).ok).toBe(true)
    settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.mcpServers.docs.enabled).toBe(true)
  })

  it('surfaces legacy plaintext HTTP servers disabled and quarantines every auth mode on enable', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      none: { type: 'http', url: 'http://mcp.example/none' },
      bearer: { type: 'http', url: 'http://mcp.example/bearer', bearerTokenEnvVar: 'MCP_TOKEN', enabled: false },
      oauth: { type: 'http', url: 'http://mcp.example/oauth', oauth: true },
      secure: { type: 'http', url: 'https://mcp.example/secure', enabled: false },
      loopback: { type: 'http', url: 'http://127.0.0.1:4444/mcp', enabled: false },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const catalog = await service.list()
    for (const name of ['none', 'bearer', 'oauth']) {
      expect(catalog.skills.find((item) => item.name === name)).toMatchObject({ kind: 'mcp', enabled: false })
      await expect(service.setMcpEnabled({ name, scope: 'user', enabled: true })).resolves.toMatchObject({ ok: false, reason: 'blocked' })
    }
    await expect(service.setMcpEnabled({ name: 'secure', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: true })
    await expect(service.setMcpEnabled({ name: 'loopback', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: true })

    const servers = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers
    expect(servers.none.enabled).toBe(false)
    expect(servers.bearer.enabled).toBe(false)
    expect(servers.oauth.enabled).toBe(false)
    expect(servers.secure.enabled).toBe(true)
    expect(servers.loopback.enabled).toBe(true)
  })

  it('quarantines insecure user and project definitions before every harness runtime', async () => {
    for (const harness of ['prime', 'omp', 'pi'] as const) {
      const root = temp()
      const agentDir = join(root, `${harness}-agent`)
      const project = join(root, `${harness}-project`)
      const projectDir = harness === 'prime' ? join(project, '.prime', 'agent') : join(project, `.${harness}`)
      const filename = harness === 'prime' ? 'settings.json' : 'mcp.json'
      mkdirSync(agentDir, { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      const http = (url: string, enabled = true) => harness === 'pi'
        ? { url, auth: 'bearer', bearerTokenEnv: 'MCP_TOKEN', enabled }
        : { type: 'http', url, bearerTokenEnvVar: 'MCP_TOKEN', enabled }
      const stdio = harness === 'pi' ? { command: 'npx', enabled: true } : { type: 'stdio', command: 'npx', enabled: true }
      writeFileSync(join(agentDir, filename), JSON.stringify({ mcpServers: {
        legacy: http('http://legacy.example/mcp'),
        secure: http('https://secure.example/mcp'),
        loopback: http('http://localhost:4444/mcp'),
        stdio,
      } }))
      writeFileSync(join(projectDir, filename), JSON.stringify({ mcpServers: {
        projectLegacy: http('http://project.example/mcp'),
        alreadyDisabled: http('http://disabled.example/mcp', false),
      } }))
      const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness })

      await expect(service.quarantineInsecureMcpServers(project)).resolves.toEqual(expect.arrayContaining(['legacy', 'projectLegacy']))
      await expect(service.setMcpEnabled({ name: 'legacy', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: false, reason: 'blocked' })
      await expect(service.setMcpEnabled({ name: 'secure', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: true })
      await expect(service.setMcpEnabled({ name: 'loopback', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: true })

      const userServers = JSON.parse(readFileSync(join(agentDir, filename), 'utf8')).mcpServers
      const projectServers = JSON.parse(readFileSync(join(projectDir, filename), 'utf8')).mcpServers
      expect(userServers.legacy.enabled).toBe(false)
      expect(userServers.secure.enabled).toBe(true)
      expect(userServers.loopback.enabled).toBe(true)
      expect(userServers.stdio.enabled).toBe(true)
      expect(projectServers.projectLegacy.enabled).toBe(false)
      expect(projectServers.alreadyDisabled.enabled).toBe(false)
    }
  })

  it('quarantines OMP HTTP and SSE definitions despite force-enable overrides', async () => {
    const root = temp()
    const agentDir = join(root, 'omp-agent')
    const project = join(root, 'project')
    const projectDir = join(project, '.omp')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      enabledServers: ['legacyHttp', 'legacySse', 'projectLegacy', 'secureSse'],
      disabledServers: ['secureDenied'],
      mcpServers: {
        legacyHttp: { type: 'http', url: 'http://remote.example/mcp', headers: { Authorization: 'Bearer ${OMP_TOKEN}' }, enabled: false },
        legacySse: { type: 'sse', url: 'http://events.example/sse', headers: { Authorization: 'Bearer secret' } },
        secureSse: { type: 'sse', url: 'https://events.example/sse', enabled: false },
        loopbackSse: { type: 'sse', url: 'http://localhost:9999/sse' },
        secureDenied: { type: 'http', url: 'https://denied.example/mcp' },
      },
    }))
    writeFileSync(join(projectDir, 'mcp.json'), JSON.stringify({ mcpServers: {
      projectLegacy: { type: 'http', url: 'http://project.example/mcp', enabled: false },
      projectSecure: { type: 'http', url: 'https://project.example/mcp', enabled: false },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    const catalog = await service.list(project)
    for (const name of ['legacyHttp', 'legacySse', 'projectLegacy', 'secureDenied']) {
      expect(catalog.skills.find((item) => item.name === name)).toMatchObject({ kind: 'mcp', enabled: false })
    }
    expect(catalog.skills.find((item) => item.name === 'secureSse')).toMatchObject({ enabled: true })
    expect(catalog.skills.find((item) => item.name === 'loopbackSse')).toMatchObject({ enabled: true })

    await expect(service.quarantineInsecureMcpServers(project)).resolves.toEqual(expect.arrayContaining(['legacyHttp', 'legacySse', 'projectLegacy']))
    const user = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(user.enabledServers).toEqual(['secureSse'])
    expect(user.disabledServers).toEqual(expect.arrayContaining(['legacyHttp', 'legacySse', 'projectLegacy', 'secureDenied']))
    expect(user.mcpServers.legacyHttp.enabled).toBe(false)
    expect(user.mcpServers.legacySse.enabled).toBe(false)

    await expect(service.setMcpEnabled({ name: 'legacySse', scope: 'user', enabled: true })).resolves.toMatchObject({ ok: false, reason: 'blocked' })
    await expect(service.setMcpEnabled({ name: 'projectSecure', scope: 'project', projectPath: project, enabled: true })).resolves.toMatchObject({ ok: true })
    const updatedUser = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    expect(updatedUser.disabledServers).not.toContain('projectSecure')
    expect(updatedUser.enabledServers ?? []).not.toContain('projectSecure')
    expect(JSON.parse(readFileSync(join(projectDir, 'mcp.json'), 'utf8')).mcpServers.projectSecure.enabled).toBe(true)
  })

  it('fails closed without replacing a symlinked global MCP settings file', async () => {
    const root = temp()
    const agentDir = join(root, 'omp-agent')
    const project = join(root, 'project')
    const external = join(root, 'external-mcp.json')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project, { recursive: true })
    const source = JSON.stringify({ mcpServers: { legacy: { type: 'sse', url: 'http://remote.example/sse' } } })
    writeFileSync(external, source)
    symlinkSync(external, join(agentDir, 'mcp.json'))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })

    await expect(service.quarantineInsecureMcpServers(project)).rejects.toThrow('regular file')

    expect(lstatSync(join(agentDir, 'mcp.json')).isSymbolicLink()).toBe(true)
    expect(readFileSync(external, 'utf8')).toBe(source)
  })

  it('fails closed when the global MCP settings directory is replaced at the same path', async () => {
    const root = temp()
    const agentDir = join(root, 'omp-agent')
    const replacementAgentDir = join(root, 'replacement-agent')
    const displacedAgentDir = join(root, 'displaced-agent')
    mkdirSync(agentDir)
    // Allocate the replacement while the original exists so it cannot reuse
    // the pinned directory inode after the rename.
    mkdirSync(replacementAgentDir)
    const settingsPath = join(agentDir, 'mcp.json')
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp', enabled: true },
    } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, harness: 'omp' })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let substituted = false
    internal.settingsFingerprint = async (path) => {
      const fingerprint = await original(path)
      if (!substituted) {
        substituted = true
        const stagedNames = readdirSync(agentDir).filter((name) => name.startsWith('mcp.json.') && (name.endsWith('.tmp') || name.endsWith('.bak')))
        expect(stagedNames).toHaveLength(2)
        renameSync(agentDir, displacedAgentDir)
        renameSync(replacementAgentDir, agentDir)
        // Preserve the settings, staging, and backup inodes so the regression
        // specifically exercises the parent-directory identity check.
        for (const name of ['mcp.json', ...stagedNames]) {
          renameSync(join(displacedAgentDir, name), join(agentDir, name))
        }
      }
      return fingerprint
    }

    await expect(service.setMcpEnabled({ name: 'docs', scope: 'user', enabled: false })).rejects.toThrow(/settings directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers.docs.enabled).toBe(true)
  })

  it('does not create a missing MCP definition while changing state', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.setMcpEnabled({ name: 'missing', scope: 'user', enabled: false })
    expect(response).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('removes one MCP definition and its credential without changing neighboring servers', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: {
      docs: { type: 'http', url: 'https://docs.example/mcp', oauth: true },
      keep: { type: 'http', url: 'https://keep.example/mcp' },
    } }))
    const removeCredential = vi.fn(async () => undefined)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir, removeMcpCredential: removeCredential })

    const response = await service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'docs', scope: 'user' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers).toEqual({ keep: { type: 'http', url: 'https://keep.example/mcp' } })
    expect(removeCredential).toHaveBeenCalledWith('docs')
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

  it('temporarily disables a protected Prime MCP without deleting authorization', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const removeCredential = vi.fn(async () => undefined)
    const builtIn = { id: 'prime-mcp-notion', name: 'Notion', description: 'Official MCP.', kind: 'mcp' as const, location: 'bundled' as const, enabled: true }
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      builtInSkills: [builtIn],
      protectedMcpServers: { notion: 'https://mcp.notion.com/mcp' },
      removeMcpCredential: removeCredential,
    })

    expect((await service.mutateCapability({ kind: 'mcp', action: 'disable', name: 'notion', scope: 'user' })).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers.notion).toMatchObject({ enabled: false })
    expect((await service.list()).skills.filter((skill) => /notion/i.test(skill.name))).toEqual([expect.objectContaining({ id: 'prime-mcp-notion', enabled: false })])
    expect(removeCredential).not.toHaveBeenCalled()
    await expect(service.mutateCapability({ kind: 'mcp', action: 'remove', name: 'notion', scope: 'user' })).resolves.toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('connects a Prime HTTP MCP server at project scope', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    mkdirSync(project)
    const service = new PluginService(null, async (path) => {
      expect(path).toBe(project)
      return resolve(path)
    }, { agentDir })

    const response = await service.connectMcp({
      name: 'project-files',
      scope: 'project',
      projectPath: project,
      type: 'http',
      url: 'https://project-files.example/mcp',
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(project, '.prime', 'agent', 'settings.json'), 'utf8'))
    expect(settings.mcpServers['project-files']).toEqual({ type: 'http', url: 'https://project-files.example/mcp', enabled: true })
    expect((await service.list(project)).skills.find((item) => item.name === 'project-files')).toMatchObject({ kind: 'mcp', location: 'project' })
  })

  it('rejects project MCP settings paths that traverse repository symlinks', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project); mkdirSync(outside)
    symlinkSync(outside, join(project, '.prime'))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'http', url: 'http://127.0.0.1:3333/mcp',
    })).rejects.toThrow(/real directory/)
    expect(() => readFileSync(join(outside, 'agent', 'settings.json'))).toThrow()
  })

  it('fails closed when the project MCP directory is substituted at the final rename boundary', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const displacedAgentDir = join(project, '.prime', 'agent-original')
    const outside = join(root, 'outside')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    writeFileSync(join(outside, 'settings.json'), JSON.stringify({ outside: 'unchanged' }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let substituted = false
    internal.settingsFingerprint = async (path) => {
      const fingerprint = await original(path)
      if (!substituted) {
        substituted = true
        const temporaryName = readdirSync(projectAgentDir).find((name) => name.startsWith('settings.json.') && name.endsWith('.tmp'))
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
      name: 'escaped', scope: 'project', projectPath: project, type: 'http', url: 'https://escaped.example/mcp',
    })).rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'settings.json'), 'utf8')).outside).toBe('unchanged')
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'settings.json'), 'utf8')).mcpServers).toBeUndefined()
  })

  it('rejects credentialed URLs and refuses to overwrite an existing server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'safe' } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.connectMcp({ name: 'secret', scope: 'user', type: 'http', url: 'https://token@example.test/mcp' })).rejects.toThrow(/credentials/)
    const duplicate = await service.connectMcp({ name: 'existing', scope: 'user', type: 'http', url: 'https://other.example/mcp' })
    expect(duplicate.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers.existing.command).toBe('safe')
  })

  it('serializes updates across service instances and rereads settings after locking', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'test/model' }))
    const first = new PluginService(null, async (path) => resolve(path), { agentDir })
    const second = new PluginService(null, async (path) => resolve(path), { agentDir })

    const responses = await Promise.all([
      first.connectMcp({ name: 'first', scope: 'user', type: 'http', url: 'https://first.example/mcp' }),
      second.connectMcp({ name: 'second', scope: 'user', type: 'http', url: 'https://second.example/mcp' }),
    ])

    expect(responses.every((response) => response.ok)).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.defaultModel).toBe('test/model')
    expect(settings.mcpServers.first.url).toBe('https://first.example/mcp')
    expect(settings.mcpServers.second.url).toBe('https://second.example/mcp')
  })

  it('recovers a lock only after its recorded owner has exited', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
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
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.connectMcp({ name: 'after-crash', scope: 'user', type: 'http', url: 'https://after-crash.example/mcp' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers['after-crash'].url).toBe('https://after-crash.example/mcp')
    expect(() => readFileSync(join(lockPath, 'owner.json'))).toThrow()
  })

  it('detects and merges a non-cooperating writer update before rename', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let injected = false
    internal.settingsFingerprint = async (path) => {
      if (!injected) {
        injected = true
        writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', changedByCli: true }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'merged', scope: 'user', type: 'http', url: 'https://merged.example/mcp' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.changedByCli).toBe(true)
    expect(settings.mcpServers.merged.url).toBe('https://merged.example/mcp')
  })

  it('retries multiple non-cooperating writer conflicts and merges the latest snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let conflicts = 0
    internal.settingsFingerprint = async (path) => {
      if (conflicts < 2) {
        conflicts += 1
        writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', externalRevision: conflicts }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'after-retries', scope: 'user', type: 'http', url: 'https://after-retries.example/mcp' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(conflicts).toBe(2)
    expect(settings.externalRevision).toBe(2)
    expect(settings.mcpServers['after-retries'].url).toBe('https://after-retries.example/mcp')
  })

  it('fails after bounded conflicts without replacing the external writer snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let externalRevision = 0
    internal.settingsFingerprint = async (path) => {
      externalRevision += 1
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', externalRevision }))
      return original(path)
    }

    await expect(service.connectMcp({ name: 'never-written', scope: 'user', type: 'http', url: 'https://never-written.example/mcp' }))
      .rejects.toThrow(/changed repeatedly/)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(externalRevision).toBe(4)
    expect(settings.externalRevision).toBe(4)
    expect(settings.mcpServers).toBeUndefined()
  })

  it('serializes package installation before an MCP settings merge', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const executable = join(root, 'prime-agent.cjs')
    const installStarted = join(root, 'install-started')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(installStarted)},'');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(settingsPath)},JSON.stringify({defaultModel:'test/model',packageInstalled:true}));process.stdout.write('installed\\n')},100)
`)
    chmodSync(executable, 0o755)
    const installer = new PluginService(executable, async (path) => resolve(path), { agentDir })
    const connector = new PluginService(null, async (path) => resolve(path), { agentDir })

    const installPromise = installer.install('npm:example-package')
    for (let attempt = 0; attempt < 1000 && !existsSync(installStarted); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    expect(existsSync(installStarted)).toBe(true)
    const [installed, connected] = await Promise.all([
      installPromise,
      connector.connectMcp({ name: 'after-package', scope: 'user', type: 'http', url: 'https://after-package.example/mcp' }),
    ])

    expect(installed.ok).toBe(true)
    expect(connected.ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.packageInstalled).toBe(true)
    expect(settings.mcpServers['after-package'].url).toBe('https://after-package.example/mcp')
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
  it.each(['user', 'project'] as const)('reconciles OMP %s MCP capability mutations across reloads', async (scope) => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    const projectDir = join(project, '.omp')
    const name = `${scope}Legacy`
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    const userPath = join(agentDir, 'mcp.json')
    const projectPath = join(projectDir, 'mcp.json')
    const definition = { type: 'sse', url: 'http://remote.example/sse', enabled: false }
    writeFileSync(userPath, JSON.stringify({
      enabledServers: [name],
      mcpServers: scope === 'user' ? { [name]: definition } : {},
    }))
    writeFileSync(projectPath, JSON.stringify({
      mcpServers: scope === 'project' ? { [name]: definition } : {},
    }))
    const inputScope = scope === 'project' ? { scope, projectPath: project } : { scope }
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    await expect(service.mutateCapability({
      kind: 'mcp', action: 'disable', name, ...inputScope,
    })).resolves.toMatchObject({ ok: true })

    let userConfig = JSON.parse(readFileSync(userPath, 'utf8'))
    expect(userConfig.enabledServers ?? []).not.toContain(name)
    expect(userConfig.disabledServers).toContain(name)

    // Even if a still-running harness retained or rewrote entry.enabled=true,
    // its next MCP reload remains suppressed by the persisted global denylist.
    const definitionPath = scope === 'user' ? userPath : projectPath
    const reloadedDefinition = JSON.parse(readFileSync(definitionPath, 'utf8'))
    reloadedDefinition.mcpServers[name].enabled = true
    writeFileSync(definitionPath, JSON.stringify(reloadedDefinition))
    const reloadedService = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })
    expect((await reloadedService.list(project)).skills.find((item) => item.name === name)).toMatchObject({ enabled: false })

    // Once the persisted endpoint is corrected, enable clears both global
    // overrides even when the entry itself already says enabled.
    const corrected = JSON.parse(readFileSync(definitionPath, 'utf8'))
    corrected.mcpServers[name].url = 'https://remote.example/sse'
    writeFileSync(definitionPath, JSON.stringify(corrected))
    await expect(service.mutateCapability({
      kind: 'mcp', action: 'enable', name, ...inputScope,
    })).resolves.toMatchObject({ ok: true })

    userConfig = JSON.parse(readFileSync(userPath, 'utf8'))
    expect(userConfig.enabledServers ?? []).not.toContain(name)
    expect(userConfig.disabledServers ?? []).not.toContain(name)
    expect((await new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' }).list(project))
      .skills.find((item) => item.name === name)).toMatchObject({ enabled: true })
  })

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
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'docs', kind: 'mcp', location: 'user' }))
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'files', kind: 'mcp', location: 'project' }))
  })

  it('writes native OMP mcp.json files with the upstream schema at both scopes', async () => {
    const root = temp()
    const agentDir = join(root, '.omp', 'agent')
    const project = join(root, 'project')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'omp' })

    const user = await service.connectMcp({ name: 'docs:remote', scope: 'user', type: 'http', url: 'https://docs.example/mcp', auth: 'oauth' })
    await service.connectMcp({ name: 'token', scope: 'user', type: 'http', url: 'https://token.example/mcp', auth: 'bearer', bearerTokenEnvVar: 'OMP_MCP_TOKEN' })
    const projectResult = await service.connectMcp({ name: 'files', scope: 'project', projectPath: project, type: 'stdio', command: 'npx', args: ['-y', 'server'] })
    await expect(service.connectMcp({ name: 'invalid name', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/unsupported characters/)

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('new OMP session') })
    expect(projectResult.ok).toBe(true)
    const userConfig = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const projectConfig = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'))
    expect(userConfig.$schema).toContain('can1357/oh-my-pi')
    expect(userConfig.mcpServers['docs:remote']).toEqual({ type: 'http', url: 'https://docs.example/mcp', enabled: true })
    expect(userConfig.mcpServers.token).toEqual({ type: 'http', url: 'https://token.example/mcp', headers: { Authorization: 'Bearer ${OMP_MCP_TOKEN}' }, enabled: true })
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
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'docs', kind: 'mcp', location: 'user' }))
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

  it('writes pi-mcp-adapter mcp.json files at both scopes only after the adapter is installed', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    const project = join(root, 'project')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(project)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const user = await service.connectMcp({ name: 'docs:remote', scope: 'user', type: 'http', url: 'https://docs.example/mcp', auth: 'oauth' })
    await service.connectMcp({ name: 'token', scope: 'user', type: 'http', url: 'https://token.example/mcp', auth: 'bearer', bearerTokenEnvVar: 'PI_MCP_TOKEN' })
    const projectResult = await service.connectMcp({ name: 'files', scope: 'project', projectPath: project, type: 'stdio', command: 'npx', args: ['-y', 'server'] })
    await expect(service.connectMcp({ name: 'invalid name', scope: 'user', type: 'stdio', command: 'npx' })).rejects.toThrow(/unsupported characters/)

    expect(user).toMatchObject({ ok: true, output: expect.stringContaining('new Pi session') })
    expect(user.output).toContain('through pi-mcp-adapter')
    expect(projectResult.ok).toBe(true)
    const userConfig = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
    const projectConfig = JSON.parse(readFileSync(join(project, '.pi', 'mcp.json'), 'utf8'))
    expect(userConfig.$schema).toBeUndefined()
    expect(userConfig.mcpServers['docs:remote']).toEqual({ url: 'https://docs.example/mcp', auth: 'oauth', enabled: true })
    expect(userConfig.mcpServers.token).toEqual({ url: 'https://token.example/mcp', auth: 'bearer', bearerTokenEnv: 'PI_MCP_TOKEN', enabled: true })
    expect(projectConfig.mcpServers.files).toEqual({ command: 'npx', args: ['-y', 'server'], enabled: true })
    expect(existsSync(join(project, '.prime'))).toBe(false)
  })

  it('blocks MCP configuration without pi-mcp-adapter and writes nothing', async () => {
    const root = temp()
    const agentDir = join(root, '.pi', 'agent')
    mkdirSync(agentDir, { recursive: true })
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir, harness: 'pi' })

    const result = await service.connectMcp({ name: 'docs', scope: 'user', type: 'http', url: 'https://docs.example/mcp' })

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
      name: 'escaped', scope: 'project', projectPath: project, type: 'http', url: 'http://127.0.0.1:3333/mcp',
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
