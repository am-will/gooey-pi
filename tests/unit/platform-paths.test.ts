import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAbsolutePathForPlatform } from '../../src/lib/platform-paths'

const SAMPLES = [
  'C:\\x',
  'c:/x',
  'C:\\Windows\\System32\\cmd.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:',
  'C:x',
  '1:\\x',
  '\\\\server\\share',
  '\\foo',
  '/foo',
  '/bin/zsh',
  'bin/zsh',
  'cmd.exe',
  './zsh',
  '~/bin/zsh',
  ' /bin/zsh',
  '',
]

describe('isAbsolutePathForPlatform', () => {
  it.each(SAMPLES)('matches node:path win32.isAbsolute for %j', (value) => {
    expect(isAbsolutePathForPlatform(value, 'win32')).toBe(win32.isAbsolute(value))
  })

  it.each(SAMPLES)('matches node:path posix.isAbsolute for %j on linux and darwin', (value) => {
    expect(isAbsolutePathForPlatform(value, 'linux')).toBe(posix.isAbsolute(value))
    expect(isAbsolutePathForPlatform(value, 'darwin')).toBe(posix.isAbsolute(value))
  })

  it('accepts Windows drive paths only on win32', () => {
    expect(isAbsolutePathForPlatform('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe(true)
    expect(isAbsolutePathForPlatform('C:\\Windows\\System32\\cmd.exe', 'darwin')).toBe(false)
    expect(isAbsolutePathForPlatform('/bin/zsh', 'darwin')).toBe(true)
    expect(isAbsolutePathForPlatform('cmd.exe', 'win32')).toBe(false)
  })
})
