import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const localRequire = createRequire(import.meta.url)
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const nvmrcPath = fileURLToPath(new URL('../../.nvmrc', import.meta.url))

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
    if (npmCli) {
      const absolute = platform === 'win32' ? win32.isAbsolute(npmCli) : isAbsolute(npmCli)
      if (!absolute || !/\.[cm]?js$/i.test(npmCli)) {
        throw new Error('npm_execpath must identify an absolute JavaScript npm CLI path')
      }
      return { file: process.execPath, args: [npmCli, ...args], shell: false }
    }
    if (platform === 'win32') {
      const adjacentCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(adjacentCli)) return { file: process.execPath, args: [adjacentCli, ...args], shell: false }
      throw new Error('Cannot locate a JavaScript npm CLI safely on Windows; run this command through npm or use a Node distribution that includes npm')
    }
    return { file: 'npm', args: [...args], shell: false }
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

function parseStableVersion(version, label, allowLeadingV = false) {
  if (typeof version !== 'string') throw new Error(`Cannot parse ${label} version: ${String(version)}`)
  const value = version.trim()
  const match = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match || (!allowLeadingV && match[1])) throw new Error(`Cannot parse ${label} version: ${version}`)
  if (match[5]) throw new Error(`A stable ${label} release is required (found ${version})`)
  return { numbers: match.slice(2, 5).map(Number), version: match.slice(2, 5).join('.') }
}

function parseEngineFloor(value, field) {
  if (typeof value !== 'string' || !/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`package.json ${field} must use an exact stable minimum in the form >=x.y.z`)
  }
  return value.slice(2)
}

export function parseToolchainMetadata(packageJsonSource, nvmrcSource) {
  let packageJson
  try {
    packageJson = JSON.parse(packageJsonSource)
  } catch (error) {
    throw new Error(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  const node = parseEngineFloor(packageJson?.engines?.node, 'engines.node')
  const npm = parseEngineFloor(packageJson?.engines?.npm, 'engines.npm')
  const nvmNode = parseStableVersion(nvmrcSource.trim(), '.nvmrc').version
  if (nvmNode !== node) throw new Error(`.nvmrc (${nvmNode}) must match the package.json engines.node floor (${node})`)

  const packageManager = packageJson?.packageManager
  const packageManagerMatch = typeof packageManager === 'string' ? /^npm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(packageManager) : null
  if (!packageManagerMatch) throw new Error('package.json packageManager must pin npm as npm@x.y.z')
  if (packageManagerMatch[1] !== npm) {
    throw new Error(`package.json packageManager (${packageManagerMatch[1]}) must match the engines.npm floor (${npm})`)
  }
  return { node, npm }
}

export function readRepositoryToolchain() {
  return parseToolchainMetadata(readFileSync(packageJsonPath, 'utf8'), readFileSync(nvmrcPath, 'utf8'))
}

function assertMinimumVersion(label, version, minimum, allowLeadingV = false) {
  const parsed = parseStableVersion(version, label, allowLeadingV).numbers
  const floor = parseStableVersion(minimum, `${label} minimum`).numbers
  for (let index = 0; index < floor.length; index += 1) {
    if (parsed[index] > floor[index]) return
    if (parsed[index] < floor[index]) throw new Error(`${label} >=${minimum} is required (found ${version})`)
  }
}

export function readNpmVersion(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const invocation = resolveCommandInvocation('npm', ['--version'], platform, env)
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: 'utf8',
    env,
    shell: invocation.shell,
    windowsHide: true,
  })
  if (result.error) throw new Error(`Cannot run npm --version: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = result.stderr?.trim()
    throw new Error(`npm --version failed with exit code ${result.status ?? `signal ${result.signal}`}${detail ? `: ${detail}` : ''}`)
  }
  const version = result.stdout?.trim()
  if (!version) throw new Error('npm --version returned no version')
  return version
}

export function assertSupportedNode(version = process.version, toolchain = readRepositoryToolchain()) {
  assertMinimumVersion('Node.js', version, toolchain.node, true)
}

export function assertSupportedNpm(version = readNpmVersion(), toolchain = readRepositoryToolchain()) {
  assertMinimumVersion('npm', version, toolchain.npm)
}

export function assertSupportedToolchain(options = {}) {
  const toolchain = options.toolchain ?? readRepositoryToolchain()
  const nodeVersion = options.nodeVersion ?? process.version
  const npmVersion = options.npmVersion ?? readNpmVersion(options)
  assertSupportedNode(nodeVersion, toolchain)
  assertSupportedNpm(npmVersion, toolchain)
  return { node: nodeVersion, npm: npmVersion, minimum: toolchain }
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
