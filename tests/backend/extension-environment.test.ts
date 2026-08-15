import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/prime-work'),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => false),
  },
  BrowserWindow: class {},
  dialog: { showMessageBoxSync: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
  Tray: class {},
}))

vi.mock('electron', () => electron)

import { extensionRuntimeEnvironment, type CapabilityExtensionPaths } from '../../electron/main/index'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER } from '../../electron/main/agent-rpc'

const extensionPaths: CapabilityExtensionPaths = {
  schedule: '/app/extensions/omp-work-schedules.ts',
  browser: '/app/extensions/omp-work-browser.ts',
  askUser: '/app/extensions/omp-work-ask-user.ts',
}

/** What the schedule and browser bridges hand every runtime of the harness. */
const scheduleBridgeEnvironment = {
  PRIME_WORK_SCHEDULE_URL: 'http://127.0.0.1:45001',
  PRIME_WORK_SCHEDULE_TOKEN: 'schedule-token',
  PRIME_WORK_SCHEDULE_SKILL_PATH: '/app/skills/prime-work-schedules',
}
const browserBridgeEnvironment = {
  PRIME_WORK_BROWSER_URL: 'http://127.0.0.1:45002',
  PRIME_WORK_BROWSER_TOKEN: 'browser-token',
  PRIME_WORK_BROWSER_EXTENSION_PATH: '/app/extensions/prime-work-browser.ts',
  PRIME_WORK_BROWSER_SKILL_PATH: '/app/skills/prime-work-browser',
}

describe('capability extension environment parity (OMP and pi)', () => {
  it('populates the three shared extension paths and strips the Prime-only skill paths', () => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths)

    expect(environment.PRIME_WORK_SCHEDULE_EXTENSION_PATH).toBe('/app/extensions/omp-work-schedules.ts')
    expect(environment.PRIME_WORK_BROWSER_EXTENSION_PATH).toBe('/app/extensions/omp-work-browser.ts')
    expect(environment.PRIME_WORK_ASK_USER_EXTENSION_PATH).toBe('/app/extensions/omp-work-ask-user.ts')
    expect(environment.GOOEYPI_MANAGES_ASK_USER).toBe('1')
    // The Prime-only --skill inputs never reach an extension-based harness.
    expect(environment.PRIME_WORK_SCHEDULE_SKILL_PATH).toBeUndefined()
    expect(environment.PRIME_WORK_BROWSER_SKILL_PATH).toBeUndefined()
    // The loopback-broker contract from both bridges is preserved untouched.
    expect(environment.PRIME_WORK_SCHEDULE_URL).toBe('http://127.0.0.1:45001')
    expect(environment.PRIME_WORK_SCHEDULE_TOKEN).toBe('schedule-token')
    expect(environment.PRIME_WORK_BROWSER_URL).toBe('http://127.0.0.1:45002')
    expect(environment.PRIME_WORK_BROWSER_TOKEN).toBe('browser-token')
  })

  it.each([
    ['omp', OMP_RPC_ADAPTER],
    ['pi', PI_RPC_ADAPTER],
  ] as const)('turns the shared environment into all three --extension injections for %s runtimes', (_harness, adapter) => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths)
    const args = adapter.buildStartArgs({ cwd: '/work', environment })

    const injected: string[] = []
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '--extension') injected.push(args[index + 1])
    }
    expect(injected).toEqual([
      '/app/extensions/omp-work-schedules.ts',
      '/app/extensions/omp-work-browser.ts',
      '/app/extensions/omp-work-ask-user.ts',
    ])
    // Neither extension-based harness receives Prime's --skill injections.
    expect(args).not.toContain('--skill')
  })

  it('injects the Pi-only fast-mode compatibility extension without adding it to OMP', () => {
    const environment = {
      ...extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths),
      GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: '/app/extensions/pi-work-fast-mode.ts',
    }
    expect(PI_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment })).toContain('/app/extensions/pi-work-fast-mode.ts')
    expect(OMP_RPC_ADAPTER.buildStartArgs({ cwd: '/work', environment })).not.toContain('/app/extensions/pi-work-fast-mode.ts')
  })

  it('keeps standalone copies suppressed while omitting the bundled tool when disabled', () => {
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, () => browserBridgeEnvironment, extensionPaths, false)
    expect(environment.GOOEYPI_MANAGES_ASK_USER).toBe('1')
    expect(environment.PRIME_WORK_ASK_USER_EXTENSION_PATH).toBeUndefined()
    for (const adapter of [OMP_RPC_ADAPTER, PI_RPC_ADAPTER]) {
      expect(adapter.buildStartArgs({ cwd: '/work', environment })).not.toContain(extensionPaths.askUser)
    }
  })

  it.each([
    ['omp', OMP_RPC_ADAPTER],
    ['pi', PI_RPC_ADAPTER],
  ] as const)('does not mint or inject a browser claim for %s when Browser is disabled', (_harness, adapter) => {
    const mintBrowserClaim = vi.fn(() => browserBridgeEnvironment)
    const environment = extensionRuntimeEnvironment(scheduleBridgeEnvironment, mintBrowserClaim, extensionPaths, true, false)
    expect(mintBrowserClaim).not.toHaveBeenCalled()
    expect(environment.PRIME_WORK_BROWSER_EXTENSION_PATH).toBeUndefined()
    expect(environment.PRIME_WORK_BROWSER_URL).toBeUndefined()
    expect(environment.PRIME_WORK_BROWSER_TOKEN).toBeUndefined()
    expect(adapter.buildStartArgs({ cwd: '/work', environment })).not.toContain(extensionPaths.browser)
  })

  it('injects the bundled ask_user extension into Prime interactive runtimes', () => {
    const args = PRIME_RPC_ADAPTER.buildStartArgs({
      cwd: '/work',
      environment: { PRIME_WORK_ASK_USER_EXTENSION_PATH: extensionPaths.askUser },
    })
    expect(args.slice(-2)).toEqual(['--extension', extensionPaths.askUser])
  })

  it.each([
    ['prime', PRIME_RPC_ADAPTER],
    ['omp', OMP_RPC_ADAPTER],
    ['pi', PI_RPC_ADAPTER],
  ] as const)('injects session collaboration into %s without accepting an unsafe path', (_harness, adapter) => {
    const args = adapter.buildStartArgs({ cwd: '/work', environment: { GOOEYPI_COLLABORATION_EXTENSION_PATH: '/app/extensions/omp-work-collaboration.ts' } })
    expect(args.slice(-2)).toEqual(['--extension', '/app/extensions/omp-work-collaboration.ts'])
    const unsafe = adapter.buildStartArgs({ cwd: '/work', environment: { GOOEYPI_COLLABORATION_EXTENSION_PATH: '--session-injection' } })
    expect(unsafe).not.toContain('--session-injection')
  })
})
