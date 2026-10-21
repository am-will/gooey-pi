// Packaged-application layout checks. Kept out of lib.mjs because
// bootstrap-npm.mjs imports lib.mjs before `npm ci`, and these checks load
// main-process source the toolchain bootstrap never needs.
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SHIPPED_EXTENSION_FILENAMES } from '../../electron/main/extension-manifest.ts'

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
  const unexpected = [...normalized].find((entry) => entry !== 'package.json' && entry !== 'out' && !entry.startsWith('out/') && entry !== 'node_modules' && !entry.startsWith('node_modules/'))
  if (unexpected) throw new Error(`Unexpected top-level ASAR path: ${unexpected}`)
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

export function assertPackagedExtensions(resourcesDirectory) {
  const extensionsDirectory = join(resourcesDirectory, 'extensions')
  if (!existsSync(extensionsDirectory) || !lstatSync(extensionsDirectory).isDirectory()) {
    throw new Error(`Packaged application must contain a resources/extensions directory: ${extensionsDirectory}`)
  }
  const entries = readdirSync(extensionsDirectory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const nonFiles = entries
    .filter((entry) => !entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const expected = [...SHIPPED_EXTENSION_FILENAMES].sort()
  const missing = expected.filter((name) => !files.includes(name))
  const extra = files.filter((name) => !expected.includes(name))
  if (missing.length || extra.length || nonFiles.length) {
    throw new Error(`Unexpected packaged extension layout (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}; non-file: ${nonFiles.join(', ') || 'none'})`)
  }
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

export function assertMacUnpackedNativeLayout(unpackedDirectory, appArchitectures, readArchitectures) {
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
