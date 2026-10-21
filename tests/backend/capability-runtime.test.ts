import { describe, expect, it, vi } from 'vitest'
import { bindRuntimeCapabilities, extensionHarnessRuntimeEnvironment } from '../../electron/main/capability-runtime'

function fixture() {
  const bridge = (tokenKey: string, token: string) => ({
    environmentFor: vi.fn(() => ({ [tokenKey]: token })),
    revoke: vi.fn(() => true),
  })
  return {
    settings: { browserEnabled: true, askUserEnabled: true, computerUseEnabled: true },
    scheduleBridge: bridge('PRIME_WORK_SCHEDULE_TOKEN', 'schedule'),
    browserBridge: bridge('PRIME_WORK_BROWSER_TOKEN', 'browser'),
    collaborationBridge: bridge('GOOEYPI_COLLABORATION_TOKEN', 'collaboration'),
    extensionPaths: { schedule: '/schedule.ts', browser: '/browser.ts', askUser: '/ask.ts' },
    cuaDriver: { executable: vi.fn(() => '/cua') },
    computerUseSkillPath: '/computer-use/SKILL.md',
    piFastModeExtensionPath: '/pi-fast.ts',
  }
}

describe('extension harness capability construction', () => {
  it('binds every broker to the same discovered session and runtime', () => {
    const bridges = { scheduleBridge: { bindSession: vi.fn() }, browserBridge: { bindSession: vi.fn() }, collaborationBridge: { bindSession: vi.fn() } }
    bindRuntimeCapabilities({ PRIME_WORK_SCHEDULE_TOKEN: 'schedule', PRIME_WORK_BROWSER_TOKEN: 'browser', GOOEYPI_COLLABORATION_TOKEN: 'collaboration' }, { runtimeId: 'runtime', harness: 'omp', cwd: '/work', isStreaming: false, sessionFile: '/session' }, bridges)
    expect(bridges.scheduleBridge.bindSession).toHaveBeenCalledWith('schedule', '/session', 'runtime')
    expect(bridges.browserBridge.bindSession).toHaveBeenCalledWith('browser', '/session', 'runtime')
    expect(bridges.collaborationBridge.bindSession).toHaveBeenCalledWith('collaboration', '/session', 'runtime')
  })

  it.each(['omp', 'pi'] as const)('cleans every earlier claim when %s collaboration construction fails', (harness) => {
    const deps = fixture()
    deps.collaborationBridge.environmentFor.mockImplementation(() => { throw new Error('Cannot mint collaboration') })
    expect(() => extensionHarnessRuntimeEnvironment({ cwd: '/work', interactive: true }, { ...deps, harness })).toThrow('Cannot mint collaboration')
    expect(deps.scheduleBridge.revoke).toHaveBeenCalledWith('schedule')
    expect(deps.browserBridge.revoke).toHaveBeenCalledWith('browser')
    expect(deps.collaborationBridge.revoke).not.toHaveBeenCalled()
  })

  it.each(['omp', 'pi'] as const)('retains successful %s claims and reads the enabled driver once', (harness) => {
    const deps = fixture()
    const environment = extensionHarnessRuntimeEnvironment({ cwd: '/work', interactive: true }, { ...deps, harness })
    expect(environment).toMatchObject({ PRIME_WORK_SCHEDULE_TOKEN: 'schedule', PRIME_WORK_BROWSER_TOKEN: 'browser', GOOEYPI_COLLABORATION_TOKEN: 'collaboration', GOOEYPI_CUA_DRIVER_PATH: '/cua', GOOEYPI_COMPUTER_USE_SKILL_PATH: deps.computerUseSkillPath })
    expect(environment.GOOEYPI_PI_FAST_MODE_EXTENSION_PATH).toBe(harness === 'pi' ? '/pi-fast.ts' : undefined)
    expect(deps.cuaDriver.executable).toHaveBeenCalledTimes(1)
    for (const bridge of [deps.scheduleBridge, deps.browserBridge, deps.collaborationBridge]) expect(bridge.revoke).not.toHaveBeenCalled()
  })

  it('attempts all earlier revocations even if one cleanup throws', () => {
    const deps = fixture()
    deps.collaborationBridge.environmentFor.mockImplementation(() => { throw new Error('Original error') })
    deps.scheduleBridge.revoke.mockImplementation(() => { throw new Error('Cleanup failed') })
    expect(() => extensionHarnessRuntimeEnvironment({ cwd: '/work', interactive: true }, { ...deps, harness: 'omp' })).toThrow('Original error')
    expect(deps.browserBridge.revoke).toHaveBeenCalledWith('browser')
  })
})
