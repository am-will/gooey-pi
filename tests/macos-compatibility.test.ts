import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertMacOSBundleMinimum, assertMacOSDeploymentTargets } from '../scripts/release/macos-compatibility.mjs'

const modern = (minimum: string, platform = '1') => `Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform ${platform}
    minos ${minimum}
      sdk 14.5
   ntools 1
`

describe('macOS package compatibility', () => {
  it('declares the floor required by the shipped ZeroMQ arm64 module', () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(metadata.build.mac.minimumSystemVersion).toBe('14.0.0')
  })

  it('accepts captured node-pty and ZeroMQ deployment targets below or at the floor', () => {
    expect(() => assertMacOSDeploymentTargets(modern('11.0'), '14.0.0', 'pty.node')).not.toThrow()
    expect(() => assertMacOSDeploymentTargets(modern('14.0'), '14.0.0', 'addon.node')).not.toThrow()
    expect(() => assertMacOSBundleMinimum('14.0', '14.0.0')).not.toThrow()
  })

  it('checks every architecture in a fat binary, including older load commands', () => {
    const legacy = 'Load command 9\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 13.7\n      sdk 14.2\n'
    expect(() => assertMacOSDeploymentTargets(`${modern('14.0')}${legacy}`, '14.0.0', 'addon.node')).not.toThrow()
    expect(() => assertMacOSDeploymentTargets(`${modern('14.0')}${modern('14.1')}`, '14.0.0', 'addon.node')).toThrow(/requires macOS 14.1/)
  })

  it('rejects absent, malformed and non-macOS deployment targets and a mismatched bundle floor', () => {
    expect(() => assertMacOSDeploymentTargets('not a Mach-O load command', '14.0.0', 'addon.node')).toThrow(/no macOS deployment target/)
    expect(() => assertMacOSDeploymentTargets(modern('invalid'), '14.0.0', 'addon.node')).toThrow(/invalid macOS version/)
    expect(() => assertMacOSDeploymentTargets(modern('14.0', '2'), '14.0.0', 'addon.node')).toThrow(/non-macOS/)
    expect(() => assertMacOSBundleMinimum('12.0', '14.0.0')).toThrow(/does not match/)
  })
})
