import { describe, expect, it } from 'vitest'
import {
  PRIME_RUST_UNAVAILABLE_CAPABILITIES,
  primeCapabilityAvailable,
  primeImplementationFromVersion,
} from '../../src/lib/prime-compat'

describe('Prime implementation classification', () => {
  it.each([
    '0.7.0-gooeypi.1',
    '0.7.4',
    '0.8.1',
    '0.9.8',
    '0.9.8-beta.2286.1.7d442aa',
    '0.9.1-fhcache1',
    'v0.9.7',
  ])('classifies %s as the TypeScript build', (version) => {
    expect(primeImplementationFromVersion(version)).toBe('typescript')
  })

  it.each([
    '0.9.9-beta.4',
    '0.9.9-beta.60',
    '0.9.9',
    '0.10.0',
    '0.10.1-beta.3',
    '1.0.0',
  ])('classifies %s as the Rust build', (version) => {
    expect(primeImplementationFromVersion(version)).toBe('rust')
  })

  it.each([null, '', 'garbage', '0.10', 'prime-agent 0.10.0'])('leaves %j unclassified', (version) => {
    expect(primeImplementationFromVersion(version)).toBeUndefined()
  })
})

describe('Prime capability availability', () => {
  it('lists every capability Rust Prime cannot load with a user-facing label', () => {
    expect(PRIME_RUST_UNAVAILABLE_CAPABILITIES.map(({ label }) => label)).toEqual([
      'Browser control',
      'Ask user',
      'Session collaboration',
      'Fast mode',
      'TypeScript extensions',
    ])
    expect(Object.isFrozen(PRIME_RUST_UNAVAILABLE_CAPABILITIES)).toBe(true)
  })

  it('withholds a listed capability only from Rust Prime', () => {
    for (const { id } of PRIME_RUST_UNAVAILABLE_CAPABILITIES) {
      expect(primeCapabilityAvailable('rust', id)).toBe(false)
      expect(primeCapabilityAvailable('typescript', id)).toBe(true)
      expect(primeCapabilityAvailable(undefined, id)).toBe(true)
    }
  })
})
