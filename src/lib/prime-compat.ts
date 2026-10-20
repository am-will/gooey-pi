import type { PrimeImplementation, SkillRecord } from '../types/api'

/** How user-facing copy names the Rust build. */
export const RUST_PRIME_AGENT_NAME = 'Prime Agent 0.10+'

export const PRIME_IMPLEMENTATION_LABELS: Readonly<Record<PrimeImplementation, string>> = Object.freeze({ typescript: 'TypeScript', rust: 'Rust' })

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

/** One sentence naming the capabilities this Prime build does not offer; undefined when it offers them all. */
export function primeUnavailableCapabilitiesNotice(implementation: PrimeImplementation | undefined): string | undefined {
  const unavailable = PRIME_RUST_UNAVAILABLE_CAPABILITIES.filter(({ id }) => !primeCapabilityAvailable(implementation, id))
  if (!unavailable.length) return undefined
  return `Not available with ${RUST_PRIME_AGENT_NAME}: ${unavailable.map(({ label }) => label).join(', ')}. Pi and OMP keep them.`
}

/** GooeyPi's own Plugins-page records that Prime loads as TypeScript extensions. */
const PRIME_EXTENSION_CAPABILITY_RECORDS: ReadonlyMap<string, PrimeRustUnavailableCapability> = new Map([
  ['prime-work-browser', 'browser'],
  ['gooeypi-ask-user', 'askUser'],
])

/**
 * Availability of a Plugins-page record on this Prime build. Rust Prime
 * cannot load GooeyPi's browser and ask-user extensions or any discovered
 * user or project TypeScript extension, so those are labelled instead of
 * shown as active; every other record is left alone.
 */
export function primeCapabilityRecordAvailability(
  record: Pick<SkillRecord, 'id' | 'kind' | 'location'>,
  implementation: PrimeImplementation | undefined,
): SkillRecord['availability'] | undefined {
  const capability = PRIME_EXTENSION_CAPABILITY_RECORDS.get(record.id)
    ?? (record.kind === 'extension' && record.location !== 'system' ? 'typescriptExtensions' : undefined)
  if (!capability || primeCapabilityAvailable(implementation, capability)) return undefined
  return {
    available: false,
    detail: capability === 'typescriptExtensions'
      ? `${RUST_PRIME_AGENT_NAME} does not load TypeScript extensions.`
      : `${RUST_PRIME_AGENT_NAME} cannot load GooeyPi's TypeScript extension for this capability. Pi and OMP keep it.`,
  }
}
