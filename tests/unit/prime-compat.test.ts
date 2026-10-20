import { describe, expect, it } from 'vitest'
import {
  PRIME_RUST_UNAVAILABLE_CAPABILITIES,
  primeCapabilityAvailable,
  primeCapabilityRecordAvailability,
  primeImplementationFromVersion,
  primeUnavailableCapabilitiesNotice,
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

  it('names what Rust Prime does not offer in one notice', () => {
    expect(primeUnavailableCapabilitiesNotice('rust')).toBe(
      'Not available with Prime Agent 0.10+: Browser control, Ask user, Session collaboration, Fast mode, TypeScript extensions. Pi and OMP keep them.',
    )
    expect(primeUnavailableCapabilitiesNotice('typescript')).toBeUndefined()
    expect(primeUnavailableCapabilitiesNotice(undefined)).toBeUndefined()
  })

  it('labels the Plugins records Rust Prime cannot load', () => {
    const browser = { id: 'prime-work-browser', kind: 'skill', location: 'system' } as const
    const askUser = { id: 'gooeypi-ask-user', kind: 'extension', location: 'system' } as const
    const userExtension = { id: 'extension:user:legacy', kind: 'extension', location: 'user' } as const
    const projectExtension = { id: 'extension:project:tools', kind: 'extension', location: 'project' } as const

    for (const record of [browser, askUser]) {
      expect(primeCapabilityRecordAvailability(record, 'rust')).toEqual({
        available: false,
        detail: 'Prime Agent 0.10+ cannot load GooeyPi\'s TypeScript extension for this capability. Pi and OMP keep it.',
      })
    }
    for (const record of [userExtension, projectExtension]) {
      expect(primeCapabilityRecordAvailability(record, 'rust')).toEqual({ available: false, detail: 'Prime Agent 0.10+ does not load TypeScript extensions.' })
    }
    for (const record of [browser, askUser, userExtension]) {
      expect(primeCapabilityRecordAvailability(record, 'typescript')).toBeUndefined()
      expect(primeCapabilityRecordAvailability(record, undefined)).toBeUndefined()
    }
  })

  it('leaves Rust Prime records it can load alone', () => {
    for (const record of [
      { id: 'prime-work-schedules', kind: 'skill', location: 'system' },
      { id: 'gooeypi-computer-use', kind: 'extension', location: 'system' },
      { id: 'skill:user:notes', kind: 'skill', location: 'user' },
      { id: 'constructor', kind: 'package', location: 'user' },
      { id: 'prime-mcp-docs', kind: 'mcp', location: 'user' },
    ] as const) {
      expect(primeCapabilityRecordAvailability(record, 'rust')).toBeUndefined()
    }
  })

  it('withholds a listed capability only from Rust Prime', () => {
    for (const { id } of PRIME_RUST_UNAVAILABLE_CAPABILITIES) {
      expect(primeCapabilityAvailable('rust', id)).toBe(false)
      expect(primeCapabilityAvailable('typescript', id)).toBe(true)
      expect(primeCapabilityAvailable(undefined, id)).toBe(true)
    }
  })
})
