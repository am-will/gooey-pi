import { describe, expect, it } from 'vitest'
import { verificationEnvironment } from '../.cursor/skills/verify-gooeypi/control.mjs'

const parent = {
  HOME: '/real/home', USERPROFILE: '/real/profile', APPDATA: '/real/app-data', LOCALAPPDATA: '/real/local',
  NVM_DIR: '/real/nvm', NVM_BIN: '/real/node', NVM_HOME: '/real/nvm-home', NVM_SYMLINK: '/real/nvm-link',
  PRIME_AGENT_BINARY: '/real/prime', OMP_BINARY: '/real/omp', PI_BINARY: '/real/pi',
  XDG_CONFIG_HOME: '/real/config', XDG_DATA_HOME: '/real/data', XDG_CACHE_HOME: '/real/cache',
  PATH: '/real/bin', ELECTRON_RUN_AS_NODE: '1', SECRET_TOKEN: 'private',
  DISPLAY: ':99', XAUTHORITY: '/display/authority', SystemRoot: 'C:\\Windows',
}

describe('verification driver environment', () => {
  it('isolates all harness storage and omits parent binary and credential overrides', () => {
    const env = verificationEnvironment('/fixture/home', '/fixture', parent, 'darwin')
    expect(env.HOME).toBe('/fixture/home')
    expect(env.USERPROFILE).toBe('/fixture/home')
    expect(env.XDG_DATA_HOME).toBe('/fixture/data')
    expect(env.XDG_CONFIG_HOME).toBe('/fixture/config')
    expect(env.DISPLAY).toBe(':99')
    for (const key of ['NVM_DIR', 'NVM_BIN', 'NVM_HOME', 'NVM_SYMLINK', 'PRIME_AGENT_BINARY', 'OMP_BINARY', 'PI_BINARY', 'ELECTRON_RUN_AS_NODE', 'SECRET_TOKEN']) expect(env).not.toHaveProperty(key)
    expect(env.PATH).not.toContain('/real')
  })

  it('sets Windows profile and system paths without retaining the real user profile', () => {
    const env = verificationEnvironment('C:\\fixture\\home', 'C:\\fixture', parent, 'win32')
    expect(env.USERPROFILE).toBe('C:\\fixture\\home')
    expect(env.HOMEDRIVE).toBe('C:')
    expect(env.HOMEPATH).toBe('\\fixture\\home')
    expect(env.APPDATA).toBe('C:\\fixture\\app-data')
    expect(env.LOCALAPPDATA).toBe('C:\\fixture\\local-app-data')
    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\Windows')
  })
})
