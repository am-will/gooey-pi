import { join, win32 } from 'node:path'

import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES } from '../../src/lib/harness'
import type { HarnessId } from '../../src/types/api'

/**
 * Static description of one agent harness: how its executable is discovered
 * and where its agent state lives on disk. Discovery itself stays in
 * process-utils (`harnessExecutableCandidates`/`findHarnessExecutable`) so
 * every harness shares the same absolute-path and X_OK rules.
 */
export interface HarnessDescriptor {
  id: HarnessId
  productName: string
  agentName: string
  executableName: (platform: NodeJS.Platform) => string
  /** Environment override for the executable; only absolute paths are honored. */
  binaryEnvVar: string
  /** Directories under process.resourcesPath (as path segments) that may bundle the executable. */
  bundledResourceDirs: readonly (readonly string[])[]
  /** Harness-specific locations beyond the shared package-manager and system directories. */
  candidateDirs: (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => string[]
  /** Official npm `.cmd` shim on Windows and the package entrypoint below `<shim dir>\node_modules`. */
  windowsNpmShim?: { shim: string; entrypoint: readonly string[] }
  agentDir: (home: string) => string
  sessionRoot: (home: string) => string
  /** Project-relative directory (as path segments) that holds the harness's project agent state. */
  projectAgentSegments: readonly string[]
}

export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  prime: {
    id: 'prime',
    productName: HARNESS_PRODUCT_NAMES.prime,
    agentName: HARNESS_AGENT_NAMES.prime,
    executableName: (platform) => platform === 'win32' ? 'prime-agent.exe' : 'prime-agent',
    binaryEnvVar: 'PRIME_AGENT_BINARY',
    bundledResourceDirs: [['agent'], ['agent', 'bin']],
    candidateDirs: (platform, home, env) => platform === 'win32' ? [
      win32.join(env.PRIME_AGENT_RUST_PREFIX || win32.join(home, '.local'), 'share', 'prime-agent'),
    ] : [
      join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'prime-agent-node', 'current', 'bin'),
    ],
    windowsNpmShim: { shim: 'prime-agent.cmd', entrypoint: ['prime-agent', 'dist', 'bundle', 'cli.js'] },
    agentDir: (home) => join(home, '.prime', 'agent'),
    sessionRoot: (home) => join(home, '.prime', 'agent', 'sessions'),
    projectAgentSegments: ['.prime', 'agent'],
  },
  omp: {
    id: 'omp',
    productName: HARNESS_PRODUCT_NAMES.omp,
    agentName: HARNESS_AGENT_NAMES.omp,
    executableName: (platform) => platform === 'win32' ? 'omp.exe' : 'omp',
    binaryEnvVar: 'OMP_BINARY',
    bundledResourceDirs: [],
    candidateDirs: (platform, _home, env) => {
      if (platform === 'win32') return env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'omp')] : []
      return env.PI_INSTALL_DIR ? [env.PI_INSTALL_DIR] : []
    },
    agentDir: (home) => join(home, '.omp', 'agent'),
    sessionRoot: (home) => join(home, '.omp', 'agent', 'sessions'),
    projectAgentSegments: ['.omp'],
  },
  pi: {
    id: 'pi',
    productName: HARNESS_PRODUCT_NAMES.pi,
    agentName: HARNESS_AGENT_NAMES.pi,
    executableName: (platform) => platform === 'win32' ? 'pi.exe' : 'pi',
    binaryEnvVar: 'PI_BINARY',
    bundledResourceDirs: [],
    candidateDirs: (platform, home, env) => platform === 'win32' ? [] : [
      join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'pi-node', 'current', 'bin'),
    ],
    windowsNpmShim: { shim: 'pi.cmd', entrypoint: ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'] },
    agentDir: (home) => join(home, '.pi', 'agent'),
    sessionRoot: (home) => join(home, '.pi', 'agent', 'sessions'),
    projectAgentSegments: ['.pi'],
  },
}
