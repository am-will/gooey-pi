import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const localRequire = createRequire(import.meta.url)
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const nvmrcPath = fileURLToPath(new URL('../../.nvmrc', import.meta.url))

export function validateAbsoluteSingleLinePath(value, label, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32 : posix
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\0\r\n]/.test(value) || !pathApi.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute single-line path`)
  }
  return value
}

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
      const validatedNpmCli = validateAbsoluteSingleLinePath(npmCli, 'npm_execpath', platform)
      if (!/\.[cm]?js$/i.test(validatedNpmCli)) {
        throw new Error('npm_execpath must identify an absolute JavaScript npm CLI path')
      }
      return { file: process.execPath, args: [validatedNpmCli, ...args], shell: false }
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
  const env = options.env ?? process.env
  const invocation = resolveCommandInvocation(command, args, options.platform ?? process.platform, env)
  const result = spawnSync(invocation.file, invocation.args, {
    stdio: 'inherit',
    env,
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

function removeFinalLineEnding(output) {
  if (output.endsWith('\r\n')) return output.slice(0, -2)
  if (output.endsWith('\n') || output.endsWith('\r')) return output.slice(0, -1)
  return output
}

export function readNpmOutput(args, options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const invocation = options.npmCliPath
    ? {
        file: process.execPath,
        args: [validateAbsoluteSingleLinePath(options.npmCliPath, 'npm CLI path', platform), ...args],
        shell: false,
      }
    : resolveCommandInvocation('npm', args, platform, env)
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: 'utf8',
    env,
    shell: invocation.shell,
    windowsHide: true,
  })
  const command = `npm ${args.join(' ')}`
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = result.stderr?.trim()
    throw new Error(`${command} failed with exit code ${result.status ?? `signal ${result.signal}`}${detail ? `: ${detail}` : ''}`)
  }
  const output = removeFinalLineEnding(result.stdout ?? '')
  if (!output) throw new Error(`${command} returned no output`)
  return output
}

export function readNpmVersion(options = {}) {
  return readNpmOutput(['--version'], options)
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
