#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertSupportedNode, assertSupportedNpm, readNpmOutput, readRepositoryToolchain, runCommand, validateAbsoluteSingleLinePath } from './lib.mjs'

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
  const npmOptions = { env, platform }
  const current = readOutput(['--version'], npmOptions)
  const prefix = readOutput(['prefix', '--global'], npmOptions)
  const root = readOutput(['root', '--global'], npmOptions)
  const layout = resolveNpmGlobalLayout(prefix, root, platform)

  let configured
  if (fileExists(layout.cliPath)) {
    try {
      configured = readOutput(['--version'], { ...npmOptions, npmCliPath: layout.cliPath })
    } catch {
      // A broken configured CLI is repaired by the pinned installation below.
    }
  }
  if (configured !== toolchain.npm || !fileExists(layout.shimPath)) {
    console.log(`Installing repository npm ${toolchain.npm} at ${layout.prefix} (invoked ${current}; configured ${configured ?? 'missing or unusable'})...`)
    run('npm', ['install', '--global', '--prefix', layout.prefix, `npm@${toolchain.npm}`], { env, platform })
  }

  if (!fileExists(layout.cliPath)) throw new Error(`Installed npm CLI does not exist: ${layout.cliPath}`)
  if (!fileExists(layout.shimPath)) throw new Error(`Installed npm shim does not exist: ${layout.shimPath}`)
  const installed = readOutput(['--version'], { ...npmOptions, npmCliPath: layout.cliPath })
  assertSupportedNpm(installed, toolchain)
  if (installed !== toolchain.npm) throw new Error(`Expected pinned npm ${toolchain.npm} after bootstrap, found ${installed}`)

  const githubPathUpdated = persist(layout.shimDirectory, env.GITHUB_PATH, platform)
  console.log(`Repository toolchain bootstrap passed: Node ${nodeVersion} and npm ${installed}.`)
  return { current, installed, ...layout, githubPathUpdated }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    bootstrapNpm()
  } catch (error) {
    console.error(`Repository toolchain bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
