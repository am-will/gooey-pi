import type { PrimeImplementation } from '../types/api'

/** How user-facing copy names the Rust build. */
export const RUST_PRIME_AGENT_NAME = 'Prime Agent 0.10+'

/**
 * Prime Agent shipped as a TypeScript CLI through 0.9.8 and as a Rust rewrite
 * from the 0.9.9 betas on (0.10.0 is the first stable Rust release). Both
 * print a bare semver for --version, so the version alone classifies every
 * published build; a prerelease suffix does not change the answer.
 */
const FIRST_RUST_VERSION = [0, 9, 9] as const

export function primeImplementationFromVersion(version: string | null): PrimeImplementation | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!match) return undefined
  for (const [index, part] of match.slice(1, 4).map(Number).entries()) {
    if (part !== FIRST_RUST_VERSION[index]) return part > FIRST_RUST_VERSION[index] ? 'rust' : 'typescript'
  }
  return 'rust'
}

/**
 * GooeyPi capabilities that Rust Prime Agent cannot load: they ship as
 * TypeScript extensions or need a harness command 0.10 does not have. They are
 * not offered on Rust Prime and stay fully supported on TypeScript Prime, OMP
 * and Pi.
 */
export const PRIME_RUST_UNAVAILABLE_CAPABILITIES = Object.freeze([
  { id: 'browser', label: 'Browser control' },
  { id: 'askUser', label: 'Ask user' },
  { id: 'collaboration', label: 'Session collaboration' },
  { id: 'fastMode', label: 'Fast mode' },
  { id: 'typescriptExtensions', label: 'TypeScript extensions' },
] as const)

export type PrimeRustUnavailableCapability = (typeof PRIME_RUST_UNAVAILABLE_CAPABILITIES)[number]['id']

/** An unclassified Prime (undefined) keeps the TypeScript behavior. */
export function primeCapabilityAvailable(implementation: PrimeImplementation | undefined, capability: PrimeRustUnavailableCapability): boolean {
  return implementation !== 'rust' || !PRIME_RUST_UNAVAILABLE_CAPABILITIES.some(({ id }) => id === capability)
}
