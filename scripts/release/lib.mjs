import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const localRequire = createRequire(import.meta.url)

export const MINIMUM_NODE = [22, 12, 0]

/**
 * Resolves a release-script command to a spawn invocation that works on every platform.
 * Windows npm and npx ship as .cmd shims Node refuses to spawn without a shell, so known
 * commands run their JavaScript entrypoint directly under the current Node executable.
 */
export function resolveCommandInvocation(command, args, platform = process.platform, env = process.env) {
  if (command === 'node') return { file: process.execPath, args: [...args], shell: false }
  if (command === 'install-electron') {
    return { file: process.execPath, args: [localRequire.resolve('electron/install.js'), ...args], shell: false }
  }
  if (command === 'electron-builder') {
    return { file: process.execPath, args: [localRequire.resolve('electron-builder/cli.js'), ...args], shell: false }
  }
  if (command === 'npm') {
    const npmCli = env.npm_execpath
    if (npmCli && /\.[cm]?js$/.test(npmCli)) return { file: process.execPath, args: [npmCli, ...args], shell: false }
    // Outside an npm lifecycle there is no npm_execpath; on Windows npm.cmd requires a shell.
    return platform === 'win32' ? { file: 'npm.cmd', args: [...args], shell: true } : { file: 'npm', args: [...args], shell: false }
  }
  return { file: command, args: [...args], shell: false }
}

export function runCommand(command, args, options = {}) {
  const invocation = resolveCommandInvocation(command, args)
  const result = spawnSync(invocation.file, invocation.args, {
    stdio: 'inherit',
    env: options.env ?? process.env,
    shell: invocation.shell,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? `signal ${result.signal}`}`)
  return result
}

export const RELEASE_CREDENTIAL_NAMES = [
  'RELEASE_SIGNING_TEAM_ID',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
]

export function withoutReleaseCredentials(env = process.env, allowed = []) {
  const allowedNames = new Set(allowed)
  return Object.fromEntries(Object.entries(env).filter(([name]) => !RELEASE_CREDENTIAL_NAMES.includes(name) || allowedNames.has(name)))
}

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`Cannot parse Node.js version: ${version}`)
  return match.slice(1).map(Number)
}

export function assertSupportedNode(version = process.version) {
  const parsed = parseVersion(version)
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parsed[index] > MINIMUM_NODE[index]) return
    if (parsed[index] < MINIMUM_NODE[index]) {
      throw new Error(`Node.js >=${MINIMUM_NODE.join('.')} is required (found ${version})`)
    }
  }
}

function requireNonEmpty(env, names, label) {
  const missing = names.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`${label} credentials are incomplete; missing ${missing.join(', ')}`)
}

export function validateReleaseCredentials(env = process.env, options = {}) {
  const { checkApiKeyFile = true } = options
  requireNonEmpty(env, ['RELEASE_SIGNING_TEAM_ID'], 'Developer ID signing')
  requireNonEmpty(env, ['CSC_LINK', 'CSC_KEY_PASSWORD'], 'Developer ID signing')

  const appleIdNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  const hasAppleIdValue = appleIdNames.some((name) => env[name]?.trim())
  const hasApiKeyValue = apiKeyNames.some((name) => env[name]?.trim())
  if (hasAppleIdValue === hasApiKeyValue) {
    throw new Error('Provide exactly one complete notarization credential set: Apple ID or App Store Connect API key')
  }
  const selected = hasAppleIdValue ? appleIdNames : apiKeyNames
  requireNonEmpty(env, selected, 'Notarization')
  if (hasAppleIdValue && env.APPLE_TEAM_ID !== env.RELEASE_SIGNING_TEAM_ID) {
    throw new Error('APPLE_TEAM_ID must match RELEASE_SIGNING_TEAM_ID')
  }
  if (hasApiKeyValue && checkApiKeyFile && !existsSync(env.APPLE_API_KEY)) {
    throw new Error(`APPLE_API_KEY does not exist: ${env.APPLE_API_KEY}`)
  }
  if (hasApiKeyValue && checkApiKeyFile) accessSync(env.APPLE_API_KEY, constants.R_OK)
}

export function validateWindowsReleaseCredentials(env = process.env) {
  requireNonEmpty(env, ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'], 'Windows Authenticode signing')
}

export function requireReleaseArtifacts(paths) {
  const artifacts = { dmg: [], zip: [] }
  for (const path of paths) {
    if (path.endsWith('.dmg')) artifacts.dmg.push(path)
    if (path.endsWith('.zip')) artifacts.zip.push(path)
  }
  for (const [extension, matches] of Object.entries(artifacts)) {
    if (matches.length !== 1) throw new Error(`Expected exactly one ${extension.toUpperCase()} artifact, found ${matches.length}`)
  }
  return { dmg: artifacts.dmg[0], zip: artifacts.zip[0] }
}

export function artifactArchitectures(path) {
  const architecture = /-(arm64|x64|universal)\.(?:dmg|zip)$/.exec(path)?.[1]
  if (!architecture) throw new Error(`Artifact name does not declare a supported architecture: ${path}`)
  if (architecture === 'arm64') return new Set(['arm64'])
  if (architecture === 'x64') return new Set(['x86_64'])
  return new Set(['arm64', 'x86_64'])
}

export function assertExactArchitectures(actual, expected, label) {
  const missing = [...expected].filter((architecture) => !actual.has(architecture))
  const unexpected = [...actual].filter((architecture) => !expected.has(architecture))
  if (missing.length || unexpected.length) {
    throw new Error(`${label} architectures do not match its artifact name (expected ${[...expected].join(', ')}, found ${[...actual].join(', ')})`)
  }
}

export function parseTeamIdentifier(output) {
  return /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim()
}

export function parseArchitectures(output) {
  return new Set(output.trim().split(/\s+/).filter(Boolean))
}

export function assertArchitectureCoverage(appArchitectures, nativeArchitectures, label) {
  const missing = [...appArchitectures].filter((architecture) => !nativeArchitectures.has(architecture))
  if (missing.length) throw new Error(`${label} is missing app architecture(s): ${missing.join(', ')}`)
}

export function assertAsarLayout(entries) {
  const normalized = new Set(entries.map((entry) => entry.replaceAll('\\', '/').replace(/^\//, '')))
  const required = [
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'node_modules/node-pty/lib/index.js',
    'node_modules/zeromq/lib/index.js',
    'node_modules/zeromq/build/manifest.json',
  ]
  const missing = required.filter((entry) => !normalized.has(entry))
  if (missing.length) throw new Error(`ASAR is missing required runtime entries: ${missing.join(', ')}`)
  const forbiddenPrefixes = ['node_modules/@xterm/', 'node_modules/lucide-react/', 'node_modules/react/', 'node_modules/react-dom/', 'node_modules/react-markdown/', 'node_modules/remark-gfm/']
  const forbidden = [...normalized].find((entry) => forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)))
  if (forbidden) throw new Error(`Renderer-only dependency was duplicated into the ASAR: ${forbidden}`)
}

const NODE_PTY_UNPACKED_FILES = ['node_modules/node-pty/build/Release/pty.node', 'node_modules/node-pty/build/Release/spawn-helper']

const ZEROMQ_ARCHITECTURE_DIRECTORIES = new Map([
  ['arm64', 'arm64'],
  ['x86_64', 'x64'],
])

// Runtime-library directory names (for example, "libc-115-Release") encode
// the zeromq prebuild's toolchain and change across upgrades. An architecture
// may intentionally ship multiple ABI fallbacks, so match the bounded set
// without pinning the directory names.
export function expectedUnpackedNativeLayout(appArchitectures) {
  if (!appArchitectures.size) throw new Error('Packaged application architecture list is empty')
  const files = [...NODE_PTY_UNPACKED_FILES]
  const zeroMqAddons = []
  for (const architecture of [...appArchitectures].sort()) {
    const directory = ZEROMQ_ARCHITECTURE_DIRECTORIES.get(architecture)
    if (!directory) throw new Error(`Unsupported packaged application architecture: ${architecture}`)
    zeroMqAddons.push({
      label: `node_modules/zeromq/build/darwin/${directory}/node/*-Release/addon.node`,
      pattern: new RegExp(`^node_modules/zeromq/build/darwin/${directory}/node/[^/]+-Release/addon\\.node$`),
    })
  }
  return { files, zeroMqAddons }
}

function listUnpackedEntries(directory, prefix = '', found = { files: [], directories: [] }) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.directories.push(relativePath)
      listUnpackedEntries(join(directory, entry.name), relativePath, found)
    } else if (entry.isFile()) found.files.push(relativePath)
    else throw new Error(`Unpacked runtime contains a forbidden non-file entry: ${relativePath}`)
  }
  return found
}

function expectedDirectories(files) {
  const directories = new Set()
  for (const file of files) {
    const segments = file.split('/')
    for (let end = 1; end < segments.length; end += 1) directories.add(segments.slice(0, end).join('/'))
  }
  return directories
}

export function assertUnpackedNativeLayout(unpackedDirectory, appArchitectures, readArchitectures) {
  const { files, zeroMqAddons } = expectedUnpackedNativeLayout(appArchitectures)
  const actual = listUnpackedEntries(unpackedDirectory)
  const missing = files.filter((path) => !actual.files.includes(path))
  if (missing.length) throw new Error(`Missing unpacked native runtime file(s): ${missing.join(', ')}`)
  const expected = [...files]
  for (const { label, pattern } of zeroMqAddons) {
    const matches = actual.files.filter((path) => pattern.test(path))
    if (!matches.length) throw new Error(`Expected at least one unpacked ZeroMQ addon matching ${label}, found 0`)
    expected.push(...matches)
  }
  const expectedSet = new Set(expected)
  const allowedDirectories = expectedDirectories(expected)
  const extra = [...actual.files.filter((path) => !expectedSet.has(path)), ...actual.directories.filter((path) => !allowedDirectories.has(path))]
  if (extra.length) throw new Error(`Unexpected unpacked path(s): ${extra.join(', ')}`)

  for (const relativePath of expected) {
    const architectures = readArchitectures(join(unpackedDirectory, relativePath))
    assertArchitectureCoverage(appArchitectures, architectures, relativePath)
  }
}
