import { createHash } from 'node:crypto'
import type { Dir } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { HarnessId, PluginCatalog, PluginWarning, SkillRecord } from '../../../src/types/api'
import { HARNESSES } from '../harness'
import { mapLimit } from '../lib/async'
import { isPathWithin, isRecord } from '../validation'
import { errorCode, readAtMost } from './file-io'
import { isInsecurePersistedMcpDefinition } from './mcp-policy'

type Kind = SkillRecord['kind']
type Location = SkillRecord['location']
interface Candidate { path: string; kind: Exclude<Kind, 'package' | 'mcp'>; location: Location }

/** Project-relative directory that holds a harness's project agent state. */
const PROJECT_AGENT_SEGMENTS: Record<HarnessId, readonly string[]> = {
  prime: ['.prime', 'agent'],
  omp: ['.omp'],
  pi: ['.pi'],
}

const MAX_DISCOVERY_CANDIDATES = 2_000
const MAX_DISCOVERY_DIRECTORIES = 1_000
const MAX_DISCOVERY_ENTRIES = 20_000
const MAX_DISCOVERY_RECORDS = 2_500
const MAX_METADATA_BYTES = 128 * 1024
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const METADATA_CONCURRENCY = 16

interface DiscoveryBudget {
  candidates: number
  directories: number
  entries: number
  seenCandidates: Set<string>
}

function idFor(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
}

async function readSmall(path: string, max = MAX_METADATA_BYTES): Promise<string> {
  try { return (await readAtMost(path, max)).content } catch { return '' }
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return undefined
  const value = match[1].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
  if (value === '|' || value === '>') return undefined
  return value.slice(0, 500)
}

async function markdownMetadata(path: string): Promise<{ name?: string; description: string }> {
  const content = await readSmall(path)
  const frontmatterEnd = content.indexOf('\n---', 3)
  const frontmatter = content.startsWith('---') ? content.slice(3, frontmatterEnd >= 0 ? frontmatterEnd : 0) : ''
  const name = scalar(frontmatter, 'name')
  const description = scalar(frontmatter, 'description')
    ?? content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('---') && !line.startsWith('#'))
    ?? ''
  return { name, description: description.slice(0, 500) }
}

function normalizedPackageSlug(source: string): string {
  let value = source.trim().replace(/^(?:npm:|git:)/i, '').replace(/[?#].*$/, '').replace(/\.git$/i, '')
  value = value.replace(/\/+$/, '').slice(value.lastIndexOf('/') + 1).replace(/@[^@/]+$/, '')
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'package'
}

interface PackageMetadata {
  name: string
  description: string
  associatedMcpServers?: string[]
}

async function packageMetadata(sourceValue: string, settingsPath: string): Promise<PackageMetadata> {
  const slug = normalizedPackageSlug(sourceValue)
  const fallback = { name: slug, description: `${slug} capability package` }
  const rawSource = sourceValue.replace(/^(?:npm:|git:)/i, '')
  if (sourceValue.startsWith('npm:') || sourceValue.startsWith('git:') || /^(?:https?|ssh|git):\/\//i.test(rawSource)) return fallback
  const packageRoot = isAbsolute(rawSource) ? rawSource : resolve(dirname(settingsPath), rawSource)
  try {
    const value = JSON.parse(await readSmall(join(packageRoot, 'package.json'))) as unknown
    if (!isRecord(value)) return fallback
    const name = typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim().slice(0, 120)
      : typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : slug
    const description = typeof value.description === 'string' && value.description.trim()
      ? value.description.trim().slice(0, 500)
      : `${name} capability package`
    const gooeypi = isRecord(value.gooeypi) ? value.gooeypi : undefined
    const associatedMcpServers = Array.isArray(gooeypi?.mcpServers)
      ? gooeypi.mcpServers.filter((server): server is string => typeof server === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(server)).slice(0, 32)
      : undefined
    return { name, description, ...(associatedMcpServers?.length ? { associatedMcpServers } : {}) }
  } catch {
    return fallback
  }
}

interface SettingsReadResult { settings: Record<string, unknown>; warning?: PluginWarning }

/**
 * Reads settings.json with readSettingsForUpdate's strictness philosophy: a
 * missing file is fine, but an unreadable, oversized, unparsable, or
 * non-object file yields empty settings plus a structured warning the
 * Plugins UI surfaces, instead of silently hiding configured plugins.
 */
async function readSettings(path: string, scope: PluginWarning['scope']): Promise<SettingsReadResult> {
  const filename = basename(path)
  const invalid = (message: string): SettingsReadResult => ({ settings: {}, warning: { scope, path, message } })
  let content: string
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) return invalid(`${filename} is too large — plugins hidden`)
    content = value.content
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { settings: {} }
    return invalid(`${filename} unreadable — plugins hidden`)
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { return invalid(`${filename} invalid — plugins hidden`) }
  if (!isRecord(value)) return invalid(`${filename} invalid — plugins hidden`)
  return { settings: value }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path) } catch { return resolve(path) }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([canonicalPath(left), canonicalPath(right)])
  return canonicalLeft === canonicalRight
}

function resolveConfiguredPath(value: string, base: string): string | null {
  if (!value || /^[!+*-]/.test(value) || value.includes('*') || value.includes('?')) return null
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(base, expanded)
}

function isPathWithinAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isPathWithin(root, candidate))
}

function discoveryExhausted(budget: DiscoveryBudget): boolean {
  return budget.candidates >= MAX_DISCOVERY_CANDIDATES
    || budget.directories >= MAX_DISCOVERY_DIRECTORIES
    || budget.entries >= MAX_DISCOVERY_ENTRIES
}

function runtimePluginEnabled(value: unknown): boolean {
  return !isRecord(value) || value.enabled !== false
}

function addCandidate(candidate: Candidate, output: Candidate[], budget: DiscoveryBudget): void {
  if (budget.candidates >= MAX_DISCOVERY_CANDIDATES) return
  const key = `${candidate.kind}:${candidate.path}`
  if (budget.seenCandidates.has(key)) return
  budget.seenCandidates.add(key)
  budget.candidates += 1
  output.push(candidate)
}

async function collectDirectory(
  root: string,
  kind: Candidate['kind'],
  location: Location,
  output: Candidate[],
  budget: DiscoveryBudget,
  options: { skillRoot?: boolean; depth?: number; containmentRoots?: readonly string[] } = {},
): Promise<void> {
  if (discoveryExhausted(budget)) return
  const depth = options.depth ?? 0
  if (depth === 0 && options.containmentRoots?.length) {
    try {
      const canonicalRoot = await realpath(root)
      if (!isPathWithinAny(options.containmentRoots, canonicalRoot)) return
    } catch { return }
  }

  let directory: Dir
  try {
    directory = await opendir(root)
    budget.directories += 1
  } catch { return }

  try {
    for await (const entry of directory) {
      if (discoveryExhausted(budget)) break
      budget.entries += 1
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        if (kind === 'skill' && (entry.name === 'SKILL.md' || (depth === 0 && options.skillRoot && extname(entry.name) === '.md'))) addCandidate({ path, kind, location }, output, budget)
        else if (kind === 'prompt' && depth === 0 && extname(entry.name) === '.md') addCandidate({ path, kind, location }, output, budget)
        else if (kind === 'extension' && (depth === 0 || /^index\.(?:[cm]?[jt]s)$/.test(entry.name)) && ['.ts', '.js', '.mjs', '.cjs'].includes(extname(entry.name))) addCandidate({ path, kind, location }, output, budget)
      } else if (entry.isDirectory() && depth < 6) {
        await collectDirectory(path, kind, location, output, budget, { ...options, depth: depth + 1 })
      }
    }
  } catch { /* directory changed while it was being traversed */ }
}

async function collectConfigured(
  value: unknown,
  base: string,
  kind: Candidate['kind'],
  location: Location,
  output: Candidate[],
  budget: DiscoveryBudget,
  containmentRoots?: readonly string[],
): Promise<void> {
  if (!Array.isArray(value)) return
  for (const raw of value) {
    if (discoveryExhausted(budget)) break
    if (typeof raw !== 'string') continue
    const path = resolveConfiguredPath(raw, base)
    if (!path) continue
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) continue
      const canonicalPath = await realpath(path)
      if (containmentRoots?.length && !isPathWithinAny(containmentRoots, canonicalPath)) continue
      if (stat.isFile()) addCandidate({ path: canonicalPath, kind, location }, output, budget)
      else if (stat.isDirectory()) await collectDirectory(canonicalPath, kind, location, output, budget, { skillRoot: kind === 'skill', containmentRoots })
    } catch { /* stale configured path */ }
  }
}


function displayName(candidate: Candidate, metadata: { name?: string }): string {
  if (metadata.name) return metadata.name
  const file = basename(candidate.path)
  if (file === 'SKILL.md' || /^index\.(?:[cm]?[jt]s)$/.test(file)) return basename(dirname(candidate.path))
  return basename(file, extname(file))
}

async function buildCandidateRecords(candidates: Candidate[], safeProjectPath?: string, harness: HarnessId = 'prime'): Promise<SkillRecord[]> {
  const seenPaths = new Set<string>()
  return mapLimit(candidates, METADATA_CONCURRENCY, async (candidate): Promise<SkillRecord | null> => {
    let path: string
    try { path = await realpath(candidate.path) } catch { return null }
    if (candidate.location === 'project' && (!safeProjectPath || !isPathWithin(safeProjectPath, path))) return null
    const extension = extname(path).toLowerCase()
    if (candidate.kind === 'prompt' && extension !== '.md') return null
    if (candidate.kind === 'skill' && extension !== '.md') return null
    if (candidate.kind === 'extension' && !['.ts', '.js', '.mjs', '.cjs'].includes(extension)) return null
    const key = `${candidate.kind}:${path}`
    if (seenPaths.has(key)) return null
    seenPaths.add(key)
    const metadata = candidate.kind === 'extension' ? { description: `${HARNESSES[harness].agentName} extension` } : await markdownMetadata(path)
    const name = displayName(candidate, metadata)
    return {
      id: idFor(candidate.kind, path),
      name,
      description: metadata.description || `${candidate.kind[0].toUpperCase()}${candidate.kind.slice(1)} ${name}`,
      kind: candidate.kind,
      location: candidate.location,
      path,
      enabled: true,
    }
  })
}

async function addSettingsMetadata(
  settings: Record<string, unknown>,
  settingsPath: string,
  location: 'user' | 'project',
  output: SkillRecord[],
  harness: HarnessId = 'prime',
  // Pi's settings.json is not an MCP source (the pi-mcp-adapter extension reads
  // mcp.json files, surfaced separately below); a stray mcpServers key there
  // would advertise servers pi never loads.
  includeMcpServers: boolean = harness !== 'pi',
  ompOverrides: { disabled: ReadonlySet<string>; enabled: ReadonlySet<string> } = { disabled: new Set(), enabled: new Set() },
): Promise<void> {
  if (Array.isArray(settings.packages)) {
    for (const raw of settings.packages) {
      if (output.length >= MAX_DISCOVERY_RECORDS) break
      const sourceValue = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.source === 'string' ? raw.source : undefined
      if (!sourceValue) continue
      const source = sourceValue.slice(0, 2_048)
      const metadata = await packageMetadata(sourceValue, settingsPath)
      const enabled = !(isRecord(raw) && ['extensions', 'skills', 'prompts', 'themes'].every((key) => Array.isArray(raw[key]) && raw[key].length === 0))
      output.push({ id: idFor('package', location, sourceValue), ...metadata, kind: 'package', location, enabled, source })
    }
  }
  if (includeMcpServers && isRecord(settings.mcpServers)) {
    for (const [name, raw] of Object.entries(settings.mcpServers)) {
      if (output.length >= MAX_DISCOVERY_RECORDS) break
      if (!isRecord(raw)) continue
      const enabled = !ompOverrides.disabled.has(name)
        && (raw.enabled !== false || ompOverrides.enabled.has(name))
        && !isInsecurePersistedMcpDefinition(raw, harness)
      if ((raw.type === 'http' || (harness === 'omp' && raw.type === 'sse') || harness === 'pi') && typeof raw.url === 'string') {
        let origin = 'remote HTTP server'
        try { const url = new URL(raw.url); origin = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : 'remote server' } catch { /* omit invalid and potentially secret URL */ }
        output.push({ id: idFor('mcp', location, name), name, description: `HTTP MCP server at ${origin}`, kind: 'mcp', location, enabled, source: origin })
      } else if ((raw.type === 'stdio' || harness === 'pi') && typeof raw.command === 'string') {
        const command = basename(raw.command).slice(0, 120)
        output.push({ id: idFor('mcp', location, name), name, description: `Local stdio MCP server (${command})`, kind: 'mcp', location, enabled, source: command })
      }
    }
  }
}

async function bundledSkillsDirectory(primeAgentPath: string | null): Promise<string | null> {
  if (!primeAgentPath) return null
  try {
    const executable = await realpath(primeAgentPath)
    const packageRoot = resolve(dirname(executable), '..', '..')
    const candidate = join(packageRoot, 'skills')
    return await pathExists(candidate) ? candidate : null
  } catch { return null }
}

async function collectOmpPluginPackages(
  root: string,
  location: 'user' | 'project',
  safeProjectPath: string | undefined,
  candidates: Candidate[],
  records: SkillRecord[],
  budget: DiscoveryBudget,
): Promise<void> {
  const nodeModules = join(root, 'node_modules')
  const packagePaths: Array<{ name: string; path: string }> = []
  let runtimePlugins: Record<string, unknown> = {}
  let disabledPlugins = new Set<string>()
  try {
    const lockFile = await readAtMost(join(root, 'omp-plugins.lock.json'), MAX_SETTINGS_BYTES)
    const lock = lockFile.truncated ? undefined : JSON.parse(lockFile.content) as unknown
    if (isRecord(lock) && isRecord(lock.plugins)) runtimePlugins = lock.plugins
  } catch { /* missing or invalid runtime state cannot authorize extra packages */ }
  if (location === 'project') {
    try {
      const overrides = JSON.parse(await readSmall(join(dirname(root), 'plugin-overrides.json'))) as unknown
      if (isRecord(overrides) && Array.isArray(overrides.disabled)) disabledPlugins = new Set(overrides.disabled.filter((name): name is string => typeof name === 'string'))
    } catch { /* no project overrides */ }
  }
  const collectLevel = async (directory: string, scope?: string): Promise<void> => {
    let entries: Dir
    try { entries = await opendir(directory); budget.directories += 1 } catch { return }
    try {
      for await (const entry of entries) {
        if (discoveryExhausted(budget)) break
        budget.entries += 1
        if (entry.name.startsWith('.')) continue
        const path = join(directory, entry.name)
        if (!scope && entry.name.startsWith('@') && entry.isDirectory()) await collectLevel(path, entry.name)
        else if (entry.isDirectory() || entry.isSymbolicLink()) packagePaths.push({ name: scope ? `${scope}/${entry.name}` : entry.name, path })
      }
    } catch { /* plugin state changed during discovery */ }
  }
  await collectLevel(nodeModules)
  for (const item of packagePaths) {
    if (records.length >= MAX_DISCOVERY_RECORDS || discoveryExhausted(budget)) break
    let packageRoot: string
    try { packageRoot = await realpath(item.path) } catch { continue }
    const itemRuntimeState = isRecord(runtimePlugins[item.name]) ? runtimePlugins[item.name] : undefined
    const outsideProject = location === 'project' && (!safeProjectPath || !isPathWithin(safeProjectPath, packageRoot))
    if (outsideProject) {
      // Marketplace installs commonly point at OMP's cache. A runtime lock
      // entry proves OMP owns the link; never inspect an arbitrary out-of-grant
      // project symlink just because it appears under node_modules.
      if (!itemRuntimeState) continue
      const enabled = runtimePluginEnabled(itemRuntimeState) && !disabledPlugins.has(item.name)
      records.push({ id: idFor('package', location, item.name), name: item.name, description: 'OMP project plugin', kind: 'package', location, enabled, source: item.name })
      continue
    }
    let name = item.name
    let description = 'OMP plugin package'
    let manifest: Record<string, unknown>
    try {
      const value = JSON.parse(await readSmall(join(packageRoot, 'package.json'))) as unknown
      if (!isRecord(value)) continue
      manifest = value
      if (typeof manifest.name === 'string') name = manifest.name.slice(0, 120)
      if (typeof manifest.description === 'string') description = manifest.description.slice(0, 500)
    } catch { continue }
    const runtimeState = itemRuntimeState ?? (isRecord(runtimePlugins[name]) ? runtimePlugins[name] : undefined)
    if (!isRecord(manifest.omp) && !isRecord(manifest.pi) && !runtimeState) continue
    const enabled = runtimePluginEnabled(runtimeState) && !disabledPlugins.has(item.name) && !disabledPlugins.has(name)
    records.push({ id: idFor('package', location, name), name, description, kind: 'package', location, enabled, source: name })
    if (!enabled) continue
    const containmentRoots = location === 'project' && safeProjectPath ? [safeProjectPath] : undefined
    await collectDirectory(join(packageRoot, 'skills'), 'skill', location, candidates, budget, { skillRoot: true, containmentRoots })
    await collectDirectory(join(packageRoot, 'prompts'), 'prompt', location, candidates, budget, { containmentRoots })
    await collectDirectory(join(packageRoot, 'commands'), 'prompt', location, candidates, budget, { containmentRoots })
    await collectDirectory(join(packageRoot, 'extensions'), 'extension', location, candidates, budget, { containmentRoots })
  }
}

export async function discoverPlugins(agentDir: string, safeProjectPath: string | undefined, agentPath: string | null, harness: HarnessId = 'prime'): Promise<PluginCatalog> {
  const candidates: Candidate[] = []
  const warnings: PluginWarning[] = []
  const budget: DiscoveryBudget = { candidates: 0, directories: 0, entries: 0, seenCandidates: new Set() }
  const globalRead = await readSettings(join(agentDir, 'settings.json'), 'user')
  if (globalRead.warning) warnings.push(globalRead.warning)
  const globalSettings = globalRead.settings

  await collectDirectory(harness === 'omp' ? resolve(agentDir, '..', 'skills') : join(agentDir, 'skills'), 'skill', 'user', candidates, budget, { skillRoot: true })
  await collectDirectory(join(homedir(), '.agents', 'skills'), 'skill', 'user', candidates, budget)
  await collectDirectory(join(agentDir, 'extensions'), 'extension', 'user', candidates, budget)
  await collectDirectory(join(agentDir, 'prompts'), 'prompt', 'user', candidates, budget)
  const userConfiguredRoots = await Promise.all([agentDir, homedir()].map(async (root) => {
    try { return await realpath(root) } catch { return root }
  }))
  await collectConfigured(globalSettings.skills, agentDir, 'skill', 'user', candidates, budget, userConfiguredRoots)
  await collectConfigured(globalSettings.extensions, agentDir, 'extension', 'user', candidates, budget, userConfiguredRoots)
  await collectConfigured(globalSettings.prompts, agentDir, 'prompt', 'user', candidates, budget, userConfiguredRoots)

  const bundled = await bundledSkillsDirectory(harness === 'prime' ? agentPath : null)
  if (bundled) await collectDirectory(bundled, 'skill', 'bundled', candidates, budget)

  const ompPackageRecords: SkillRecord[] = []
  if (harness === 'omp') await collectOmpPluginPackages(resolve(agentDir, '..', 'plugins'), 'user', safeProjectPath, candidates, ompPackageRecords, budget)

  let projectSettings: Record<string, unknown> = {}
  if (safeProjectPath && isAbsolute(safeProjectPath) && await pathExists(safeProjectPath)) {
    const projectAgentDir = join(safeProjectPath, ...PROJECT_AGENT_SEGMENTS[harness])
    const projectSettingsPath = join(projectAgentDir, 'settings.json')
    const projectSkillsDir = join(safeProjectPath, '.agents', 'skills')
    const [sameAgentDir, sameSettingsFile, sameProjectSkillsDir] = await Promise.all([
      samePath(agentDir, projectAgentDir),
      samePath(join(agentDir, 'settings.json'), projectSettingsPath),
      samePath(join(homedir(), '.agents', 'skills'), projectSkillsDir),
    ])
    const projectRoots = [safeProjectPath]
    // A project can point back at the same Prime settings and shared skills
    // directories. Discover those paths once as user-scoped records instead
    // of presenting every entry twice.
    if (!sameSettingsFile) {
      const projectRead = await readSettings(projectSettingsPath, 'project')
      if (projectRead.warning) warnings.push(projectRead.warning)
      projectSettings = projectRead.settings
    }
    if (!sameAgentDir) {
      await collectDirectory(join(projectAgentDir, 'skills'), 'skill', 'project', candidates, budget, { skillRoot: true, containmentRoots: projectRoots })
      await collectDirectory(join(projectAgentDir, 'extensions'), 'extension', 'project', candidates, budget, { containmentRoots: projectRoots })
      await collectDirectory(join(projectAgentDir, 'prompts'), 'prompt', 'project', candidates, budget, { containmentRoots: projectRoots })
      if (!sameSettingsFile) {
        await collectConfigured(projectSettings.skills, projectAgentDir, 'skill', 'project', candidates, budget, projectRoots)
        await collectConfigured(projectSettings.extensions, projectAgentDir, 'extension', 'project', candidates, budget, projectRoots)
        await collectConfigured(projectSettings.prompts, projectAgentDir, 'prompt', 'project', candidates, budget, projectRoots)
      }
    }
    if (!sameProjectSkillsDir) {
      await collectDirectory(projectSkillsDir, 'skill', 'project', candidates, budget, { containmentRoots: projectRoots })
    }
    if (harness === 'omp') await collectOmpPluginPackages(join(safeProjectPath, '.omp', 'plugins'), 'project', safeProjectPath, candidates, ompPackageRecords, budget)
  }

  const result = await buildCandidateRecords(candidates, safeProjectPath, harness)
  result.push(...ompPackageRecords)
  await addSettingsMetadata(globalSettings, join(agentDir, 'settings.json'), 'user', result, harness)
  await addSettingsMetadata(projectSettings, safeProjectPath ? join(safeProjectPath, ...PROJECT_AGENT_SEGMENTS[harness], 'settings.json') : '', 'project', result, harness)
  // OMP reads mcp.json natively; pi reads the same layout through the
  // pi-mcp-adapter extension (~/.pi/agent/mcp.json and project .pi/mcp.json).
  if (harness !== 'prime') {
    const globalMcp = await readSettings(join(agentDir, 'mcp.json'), 'user')
    if (globalMcp.warning) warnings.push(globalMcp.warning)
    const ompOverrides = harness === 'omp' ? {
      disabled: new Set(Array.isArray(globalMcp.settings.disabledServers)
        ? globalMcp.settings.disabledServers.filter((name): name is string => typeof name === 'string')
        : []),
      enabled: new Set(Array.isArray(globalMcp.settings.enabledServers)
        ? globalMcp.settings.enabledServers.filter((name): name is string => typeof name === 'string')
        : []),
    } : { disabled: new Set<string>(), enabled: new Set<string>() }
    await addSettingsMetadata(globalMcp.settings, join(agentDir, 'mcp.json'), 'user', result, harness, true, ompOverrides)
    if (safeProjectPath) {
      const projectMcp = await readSettings(join(safeProjectPath, ...PROJECT_AGENT_SEGMENTS[harness], 'mcp.json'), 'project')
      if (projectMcp.warning) warnings.push(projectMcp.warning)
      await addSettingsMetadata(projectMcp.settings, join(safeProjectPath, ...PROJECT_AGENT_SEGMENTS[harness], 'mcp.json'), 'project', result, harness, true, ompOverrides)
    }
  }
  return { skills: result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), warnings }
}
