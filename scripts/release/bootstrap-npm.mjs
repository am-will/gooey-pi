#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertSupportedNode, assertSupportedNpm, readNpmOutput, readRepositoryToolchain, runCommand, validateAbsoluteSingleLinePath } from './lib.mjs'

const repositoryRootPath = fileURLToPath(new URL('../../', import.meta.url))
const dependencyPinsPath = fileURLToPath(new URL('./dependency-pins.json', import.meta.url))
const npmArtifactFields = ['integrity', 'license', 'path', 'size', 'source', 'version']

function invalidArtifactPin(message) {
  throw new Error(`Invalid npm bootstrap artifact pin in dependency-pins.json: ${message}`)
}

export function parsePinnedNpmArtifact(manifestSource, toolchain, repositoryRoot = repositoryRootPath) {
  let manifest
  try {
    manifest = JSON.parse(manifestSource)
  } catch (error) {
    invalidArtifactPin(`cannot parse JSON (${error instanceof Error ? error.message : String(error)})`)
  }

  const artifact = manifest?.artifacts?.npm
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) invalidArtifactPin('artifacts.npm must be an object')
  const fields = Object.keys(artifact).sort()
  if (fields.length !== npmArtifactFields.length || fields.some((field, index) => field !== npmArtifactFields[index])) {
    invalidArtifactPin(`artifacts.npm must contain exactly ${npmArtifactFields.join(', ')}`)
  }

  const expectedRelativePath = `vendor/npm-${toolchain.npm}.tgz`
  const expectedSource = `https://registry.npmjs.org/npm/-/npm-${toolchain.npm}.tgz`
  if (artifact.version !== toolchain.npm) invalidArtifactPin(`version must match packageManager (${toolchain.npm})`)
  if (artifact.path !== expectedRelativePath) invalidArtifactPin(`path must be ${expectedRelativePath}`)
  if (artifact.source !== expectedSource) invalidArtifactPin(`source must be ${expectedSource}`)
  if (typeof artifact.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.integrity)) {
    invalidArtifactPin('integrity must be one exact SHA-512 SRI digest')
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) invalidArtifactPin('size must be a positive integer byte count')
  if (artifact.license !== 'Artistic-2.0') invalidArtifactPin('license must be Artistic-2.0')

  return Object.freeze({
    version: artifact.version,
    relativePath: artifact.path,
    path: resolve(repositoryRoot, expectedRelativePath),
    source: artifact.source,
    integrity: artifact.integrity,
    size: artifact.size,
    license: artifact.license,
  })
}

export function readPinnedNpmArtifact(toolchain = readRepositoryToolchain(), options = {}) {
  const manifestSource = options.manifestSource ?? readFileSync(options.manifestPath ?? dependencyPinsPath, 'utf8')
  return parsePinnedNpmArtifact(manifestSource, toolchain, options.repositoryRoot ?? repositoryRootPath)
}

export function verifyPinnedNpmArtifact(artifact, options = {}) {
  const lstat = options.lstat ?? lstatSync
  const readFile = options.readFile ?? readFileSync
  let metadata
  try {
    metadata = lstat(artifact.path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') throw new Error(`npm bootstrap artifact does not exist: ${artifact.path}`)
    throw new Error(`Cannot inspect npm bootstrap artifact ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`npm bootstrap artifact must be a regular non-symlink file: ${artifact.path}`)
  if (metadata.size !== artifact.size) {
    throw new Error(`npm bootstrap artifact size does not match pin: expected ${artifact.size} bytes, found ${metadata.size}`)
  }

  let bytes
  try {
    bytes = readFile(artifact.path)
  } catch (error) {
    throw new Error(`Cannot read npm bootstrap artifact ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (bytes.length !== artifact.size) {
    throw new Error(`npm bootstrap artifact size changed while reading: expected ${artifact.size} bytes, read ${bytes.length}`)
  }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== artifact.integrity) throw new Error(`npm bootstrap artifact integrity does not match pin: ${artifact.path}`)
  return artifact
}

function samePath(left, right, platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function resolveNpmGlobalLayout(prefixOutput, rootOutput, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32 : posix
  const prefix = pathApi.normalize(validateAbsoluteSingleLinePath(prefixOutput, 'npm global prefix', platform))
  const root = pathApi.normalize(validateAbsoluteSingleLinePath(rootOutput, 'npm global root', platform))
  const expectedRoot = platform === 'win32' ? pathApi.join(prefix, 'node_modules') : pathApi.join(prefix, 'lib', 'node_modules')
  if (!samePath(root, expectedRoot, platform)) {
    throw new Error(`npm global root (${root}) does not match its configured prefix (${prefix})`)
  }

  const shimDirectory = platform === 'win32' ? prefix : pathApi.join(prefix, 'bin')
  return {
    prefix,
    root,
    cliPath: pathApi.join(root, 'npm', 'bin', 'npm-cli.js'),
    shimDirectory,
    shimPath: pathApi.join(shimDirectory, platform === 'win32' ? 'npm.cmd' : 'npm'),
  }
}

export function persistNpmShimDirectory(shimDirectory, githubPath = process.env.GITHUB_PATH, platform = process.platform) {
  const validatedShimDirectory = validateAbsoluteSingleLinePath(shimDirectory, 'npm shim directory', platform)
  if (!githubPath) return false
  const destination = validateAbsoluteSingleLinePath(githubPath, 'GITHUB_PATH', platform)
  appendFileSync(destination, `${validatedShimDirectory}\n`, 'utf8')
  return true
}

export function bootstrapNpm(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const nodeVersion = options.nodeVersion ?? process.version
  const toolchain = options.toolchain ?? readRepositoryToolchain()
  const readOutput = options.readOutput ?? readNpmOutput
  const run = options.run ?? runCommand
  const fileExists = options.fileExists ?? existsSync
  const persist = options.persist ?? persistNpmShimDirectory

  assertSupportedNode(nodeVersion, toolchain)
  const artifact = options.artifact ?? readPinnedNpmArtifact(toolchain)
  verifyPinnedNpmArtifact(artifact)

  const npmOptions = { env, platform }
  const current = readOutput(['--version'], npmOptions)
  const prefix = readOutput(['prefix', '--global'], npmOptions)
  const root = readOutput(['root', '--global'], npmOptions)
  const layout = resolveNpmGlobalLayout(prefix, root, platform)

  console.log(`Installing verified repository npm ${toolchain.npm} at ${layout.prefix} (invoked ${current})...`)
  run('npm', ['install', '--global', '--prefix', layout.prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', artifact.path], {
    env,
    platform,
    shell: false,
  })

  if (!fileExists(layout.cliPath)) throw new Error(`Installed npm CLI does not exist: ${layout.cliPath}`)
  if (!fileExists(layout.shimPath)) throw new Error(`Installed npm shim does not exist: ${layout.shimPath}`)
  const installed = readOutput(['--version'], { ...npmOptions, npmCliPath: layout.cliPath })
  assertSupportedNpm(installed, toolchain)
  if (installed !== toolchain.npm) throw new Error(`Expected pinned npm ${toolchain.npm} after bootstrap, found ${installed}`)

  const githubPathUpdated = persist(layout.shimDirectory, env.GITHUB_PATH, platform)
  console.log(`Repository toolchain bootstrap passed: Node ${nodeVersion} and npm ${installed}.`)
  return { current, installed, artifactPath: artifact.path, artifactIntegrity: artifact.integrity, ...layout, githubPathUpdated }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    bootstrapNpm()
  } catch (error) {
    console.error(`Repository toolchain bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
