import { describe, expect, it } from 'vitest'
import { parseProtectedScopeSettings } from '../../electron/main/git-protected-config'

const record = (scope: string, key: string, value: string) => `${scope}\0${key}\n${value}\0`
describe('protected Git configuration', () => {
  it('accepts only protected scopes and allowlisted scalar values', () => {
    const result = parseProtectedScopeSettings(
      record('system', 'core.autocrlf', 'false') + record('global', 'core.autocrlf', 'input')
      + record('global', 'core.eol', 'CRLF') + record('local', 'safe.directory', '*')
      + record('command', 'safe.directory', '*') + record('global', 'filter.evil.process', 'sh -c bad'),
    )
    expect([...result.values]).toEqual([['core.autocrlf', 'input'], ['core.eol', 'crlf']])
    expect(result.safeDirectories).toEqual([])
  })

  it('preserves ordered ownership entries including an empty reset after a wildcard', () => {
    const values = ['*', '', '/trusted/repository']
    const result = parseProtectedScopeSettings(values.map((value) => record('global', 'safe.directory', value)).join(''))
    expect(result.safeDirectories).toEqual(values)
  })

  it('discards the entire ownership list if a bound could hide a later reset', () => {
    const many = Array.from({ length: 257 }, () => record('global', 'safe.directory', '*')).join('')
    expect(parseProtectedScopeSettings(many).safeDirectories).toEqual([])
    const large = Array.from({ length: 8 }, () => record('global', 'safe.directory', '/x'.repeat(2048))).join('')
    expect(parseProtectedScopeSettings(large).safeDirectories).toEqual([])
  })

  it('rejects multiline values and invalid scalar enums', () => {
    const result = parseProtectedScopeSettings(record('global', 'safe.directory', '/repo\n*')
      + record('global', 'core.autocrlf', 'arbitrary') + record('global', 'core.eol', 'bad')
      + record('global', 'core.excludesfile', 'relative/file'))
    expect(result.safeDirectories).toEqual([])
    expect([...result.values]).toEqual([])
  })
})
