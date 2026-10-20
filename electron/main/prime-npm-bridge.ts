import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { readAtMost } from './plugins/file-io'
import { isRecord } from './validation'

export type PrimeNpmBridgeState = 'not-bridge' | 'migrated' | 'recovery' | 'unmigrated'

export const PRIME_NPM_BRIDGE_UNMIGRATED_DETAIL = 'Prime Agent\'s npm package has not finished its Rust migration; run prime-agent once in a terminal'

/** Entrypoints the bridge package ships (older npm self-updaters relaunch each of them). */
const BRIDGE_ENTRYPOINTS = [['dist', 'bundle', 'cli.js'], ['dist', 'bundle', 'cli-node.js'], ['dist', 'cli.js']] as const
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/**
 * Prime Agent 0.10's npm package is a launcher that migrates the install to
 * the Rust build. Until its per-version receipt and the Rust payload exist,
 * every launch, even `--version`, runs the full Rust installer (network
 * download and a forced daemon stop). A background probe must never start
 * that, so this reads the same receipts as the launcher without running it:
 * 'migrated' takes the launcher's fast path to the payload, 'recovery' runs
 * its bundled TypeScript 0.9.8 fallback, and only 'unmigrated' would install.
 * The bridge exists for macOS and Linux only.
 */
export async function inspectPrimeNpmBridge(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<PrimeNpmBridgeState> {
  if (platform === 'win32') return 'not-bridge'
  let target: string
  try { target = await realpath(candidate) } catch { return 'not-bridge' }
  const entrypoint = BRIDGE_ENTRYPOINTS.find((segments) => target.endsWith(`${sep}${join('prime-agent', ...segments)}`))
  if (!entrypoint) return 'not-bridge'
  const packageRoot = join(target, ...entrypoint.map(() => '..'))
  let manifest: unknown
  try {
    const { content, truncated } = await readAtMost(join(packageRoot, 'package.json'), MAX_PACKAGE_MANIFEST_BYTES)
    manifest = truncated ? undefined : JSON.parse(content)
  } catch { return 'not-bridge' }
  if (!isRecord(manifest) || manifest.primeAgentRustBridge !== true) return 'not-bridge'
  // Receipts are named by the package version; without a usable one the
  // launcher cannot have recorded a migration either.
  if (typeof manifest.version !== 'string' || !RELEASE_VERSION.test(manifest.version)) return 'unmigrated'
  const configuredPrefix = env.PRIME_AGENT_RUST_PREFIX
  const prefix = configuredPrefix && isAbsolute(configuredPrefix) ? configuredPrefix : join(home, '.local')
  const receipt = join(prefix, 'share', '.prime-agent-npm-bridge', manifest.version)
  if (await exists(receipt) && await exists(join(prefix, 'share', 'prime-agent', 'prime-agent'))) return 'migrated'
  if (await exists(`${receipt}.failed`)) return 'recovery'
  return 'unmigrated'
}
