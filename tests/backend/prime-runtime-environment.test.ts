import { describe, expect, it, vi } from 'vitest'
import type { CapabilityScope } from '../../electron/main/lib/capability-bridge'
import { primeRuntimeEnvironment, type PrimeRuntimeEnvironmentDependencies } from '../../electron/main/prime-runtime-environment'

const SCHEDULE_ENVIRONMENT = {
  PRIME_WORK_SCHEDULE_URL: 'http://127.0.0.1:45001/v1/call',
  PRIME_WORK_SCHEDULE_TOKEN: 'schedule-token',
  PRIME_WORK_SCHEDULE_SKILL_PATH: '/app/skills/prime-work-schedules',
}
const BROWSER_ENVIRONMENT = {
  PRIME_WORK_BROWSER_URL: 'http://127.0.0.1:45002/v1/call',
  PRIME_WORK_BROWSER_TOKEN: 'browser-token',
  PRIME_WORK_BROWSER_EXTENSION_PATH: '/app/extensions/prime-work-browser.ts',
  PRIME_WORK_BROWSER_SKILL_PATH: '/app/skills/prime-work-browser',
}
const COLLABORATION_ENVIRONMENT = {
  GOOEYPI_COLLABORATION_URL: 'http://127.0.0.1:45003/v1/call',
  GOOEYPI_COLLABORATION_TOKEN: 'collaboration-token',
  GOOEYPI_COLLABORATION_EXTENSION_PATH: '/app/extensions/omp-work-collaboration.ts',
}
const ASK_USER_EXTENSION = '/app/extensions/omp-work-ask-user.ts'
const COMPUTER_USE_SKILL = '/app/skills/gooeypi-computer-use/SKILL.md'

function dependencies(settings: PrimeRuntimeEnvironmentDependencies['settings'], cuaDriverPath: string | null = '/opt/cua/cua-driver') {
  const bridge = (environment: NodeJS.ProcessEnv) => ({ environmentFor: vi.fn((_scope: CapabilityScope) => environment) })
  return {
    settings,
    scheduleBridge: bridge(SCHEDULE_ENVIRONMENT),
    browserBridge: bridge(BROWSER_ENVIRONMENT),
    collaborationBridge: bridge(COLLABORATION_ENVIRONMENT),
    askUserExtensionPath: ASK_USER_EXTENSION,
    cuaDriver: { executable: () => cuaDriverPath },
    computerUseSkillPath: COMPUTER_USE_SKILL,
  }
}

const allEnabled = { browserEnabled: true, askUserEnabled: true, computerUseEnabled: true }

describe('Prime runtime environment', () => {
  it('mints every capability claim for an interactive TypeScript Prime runtime', () => {
    const deps = dependencies(allEnabled)
    const scope = { cwd: '/work', sessionPath: '/sessions/a.jsonl', interactive: true }

    expect(primeRuntimeEnvironment(scope, deps)).toEqual({
      ...SCHEDULE_ENVIRONMENT,
      ...BROWSER_ENVIRONMENT,
      ...COLLABORATION_ENVIRONMENT,
      PRIME_WORK_ASK_USER_EXTENSION_PATH: ASK_USER_EXTENSION,
      GOOEYPI_MANAGES_ASK_USER: '1',
      GOOEYPI_CUA_DRIVER_PATH: '/opt/cua/cua-driver',
      GOOEYPI_COMPUTER_USE_SKILL_PATH: COMPUTER_USE_SKILL,
    })
    expect(deps.scheduleBridge.environmentFor).toHaveBeenCalledWith(scope)
    expect(deps.browserBridge.environmentFor).toHaveBeenCalledWith(scope)
    expect(deps.collaborationBridge.environmentFor).toHaveBeenCalledWith({ ...scope, harness: 'prime' })
  })

  it('omits disabled capabilities and keeps ask-user out of unattended runtimes', () => {
    const deps = dependencies({ browserEnabled: false, askUserEnabled: true, computerUseEnabled: false })

    expect(primeRuntimeEnvironment({ cwd: '/work', interactive: false }, deps)).toEqual({
      ...SCHEDULE_ENVIRONMENT,
      ...COLLABORATION_ENVIRONMENT,
      PRIME_WORK_ASK_USER_EXTENSION_PATH: undefined,
      GOOEYPI_MANAGES_ASK_USER: '1',
      GOOEYPI_CUA_DRIVER_PATH: undefined,
      GOOEYPI_COMPUTER_USE_SKILL_PATH: undefined,
    })
    expect(deps.browserBridge.environmentFor).not.toHaveBeenCalled()
  })

  it('withholds computer use while the driver is not installed', () => {
    const environment = primeRuntimeEnvironment({ cwd: '/work', interactive: true }, dependencies(allEnabled, null))

    expect(environment.GOOEYPI_CUA_DRIVER_PATH).toBeUndefined()
    expect(environment.GOOEYPI_COMPUTER_USE_SKILL_PATH).toBeUndefined()
  })
})
