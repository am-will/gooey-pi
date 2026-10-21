import { describe, expect, it, vi } from 'vitest'
import { CUA_DRIVER_INSTALL_URL, CuaDriverService, cuaDriverExecutableCandidates } from '../../electron/main/cua-driver'

describe('cuaDriverExecutableCandidates', () => {
  it('covers PATH and standard macOS, Windows, and Linux installs', () => {
    expect(cuaDriverExecutableCandidates({ PATH: '/custom/bin:/usr/bin' }, 'darwin', '/Users/test')).toContain('/opt/homebrew/bin/cua-driver')
    expect(cuaDriverExecutableCandidates({ Path: 'C:\\Tools;C:\\Windows', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'win32', 'C:\\Users\\test'))
      .toContain('C:\\Users\\test\\AppData\\Local\\Programs\\trycua\\cua-driver-rs\\bin\\cua-driver.exe')
    expect(cuaDriverExecutableCandidates({ PATH: '/custom/bin' }, 'linux', '/home/test')).toContain('/home/linuxbrew/.linuxbrew/bin/cua-driver')
  })

  it('accepts only an absolute override and deduplicates candidates', () => {
    const candidates = cuaDriverExecutableCandidates({ CUA_DRIVER_PATH: '/opt/cua-driver', PATH: '/opt:/opt' }, 'linux', '/home/test')
    expect(candidates[0]).toBe('/opt/cua-driver')
    expect(candidates.filter((candidate) => candidate === '/opt/cua-driver')).toHaveLength(1)
    expect(cuaDriverExecutableCandidates({ CUA_DRIVER_PATH: 'relative/cua-driver', PATH: '' }, 'linux', '/home/test')).not.toContain('relative/cua-driver')
  })
})

describe('CuaDriverService', () => {
  it('coalesces probes, caches briefly, and forces a fresh enable check', async () => {
    let now = 0
    const probe = vi.fn(async () => '0.19.0')
    const service = new CuaDriverService({ platform: 'linux', environment: { CUA_DRIVER_PATH: '/opt/cua' }, home: '/home/test', access: async () => {}, probe, now: () => now })
    await Promise.all([service.status(), service.status()])
    await service.status()
    expect(probe).toHaveBeenCalledTimes(1)
    now = 5_001
    await service.status()
    expect(probe).toHaveBeenCalledTimes(2)
    await service.requireAvailable()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('reports an actionable unavailable state when no runnable driver is found', async () => {
    const service = new CuaDriverService({
      platform: 'linux', home: '/home/test', environment: { PATH: '/missing' },
      access: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    })
    await expect(service.status()).resolves.toMatchObject({ available: false, path: null, installUrl: CUA_DRIVER_INSTALL_URL })
    await expect(service.requireAvailable()).rejects.toThrow('Install Cua Driver')
  })

  it('requires a runnable version probe and remembers the resolved executable', async () => {
    const executable = '/opt/cua-driver'
    const service = new CuaDriverService({
      platform: 'linux', home: '/home/test', environment: { CUA_DRIVER_PATH: executable, PATH: '' },
      access: vi.fn(async (candidate) => { if (candidate !== executable) throw new Error('missing') }),
      probe: vi.fn(async (candidate) => candidate === executable ? '0.19.0' : null),
    })
    await expect(service.requireAvailable()).resolves.toMatchObject({ available: true, path: executable, version: '0.19.0' })
    expect(service.executable()).toBe(executable)
  })
})
