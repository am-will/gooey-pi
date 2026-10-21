import type { RuntimeEnvironmentScope } from './agent-rpc'
import type { AppSettings, RuntimeInfo } from '../../src/types/api'
import type { CapabilityScope } from './lib/capability-bridge'

export interface RuntimeCapabilityBridge {
  environmentFor(scope: CapabilityScope): NodeJS.ProcessEnv
  revoke(token: string | undefined): boolean
}

export interface RuntimeCapabilityBridges {
  scheduleBridge: RuntimeCapabilityBridge
  browserBridge: RuntimeCapabilityBridge
  collaborationBridge: RuntimeCapabilityBridge
}

const TOKEN_KEYS = {
  scheduleBridge: 'PRIME_WORK_SCHEDULE_TOKEN',
  browserBridge: 'PRIME_WORK_BROWSER_TOKEN',
  collaborationBridge: 'GOOEYPI_COLLABORATION_TOKEN',
} as const

type BridgeName = keyof RuntimeCapabilityBridges

/** A failed environment build must release every claim it already minted. */
export function buildCapabilityEnvironment(
  bridges: RuntimeCapabilityBridges,
  build: (mint: (name: BridgeName, scope: CapabilityScope) => NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const minted: Array<{ bridge: RuntimeCapabilityBridge; token: string | undefined }> = []
  try {
    return build((name, scope) => {
      const bridge = bridges[name]
      const environment = bridge.environmentFor(scope)
      minted.push({ bridge, token: environment[TOKEN_KEYS[name]] })
      return environment
    })
  } catch (error) {
    for (const { bridge, token } of minted) {
      try { bridge.revoke(token) } catch { /* Preserve the construction failure while attempting every cleanup. */ }
    }
    throw error
  }
}

/** Filesystem locations of the three shared capability extensions injected into extension-based harnesses. */
export interface CapabilityExtensionPaths {
  schedule: string
  browser: string
  askUser: string
}

/**
 * Runtime environment for the extension-injected harnesses (OMP and pi, which
 * share pi's ancestral extension API): the capability-broker variables from
 * the schedule bridge and lazily enabled browser bridge minus the Prime-only
 * --skill paths, plus the three PRIME_WORK_*_EXTENSION_PATH variables the harness adapters turn
 * into --extension argv. Both harnesses must receive the identical surface.
 */
export function extensionRuntimeEnvironment(
  scheduleBridgeEnvironment: NodeJS.ProcessEnv,
  browserBridgeEnvironment: () => NodeJS.ProcessEnv,
  extensionPaths: CapabilityExtensionPaths,
  askUserEnabled = true,
  browserEnabled = true,
): NodeJS.ProcessEnv {
  const { PRIME_WORK_SCHEDULE_SKILL_PATH: _scheduleSkill, ...scheduleEnvironment } = scheduleBridgeEnvironment
  const browserEnvironment = browserEnabled ? browserBridgeEnvironment() : {}
  const { PRIME_WORK_BROWSER_SKILL_PATH: _browserSkill, ...runtimeBrowserEnvironment } = browserEnvironment
  return {
    ...scheduleEnvironment,
    ...runtimeBrowserEnvironment,
    PRIME_WORK_SCHEDULE_EXTENSION_PATH: extensionPaths.schedule,
    PRIME_WORK_BROWSER_EXTENSION_PATH: browserEnabled ? extensionPaths.browser : undefined,
    PRIME_WORK_ASK_USER_EXTENSION_PATH: askUserEnabled ? extensionPaths.askUser : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
  }
}

export interface ExtensionHarnessEnvironmentDependencies extends RuntimeCapabilityBridges {
  harness: 'omp' | 'pi'
  settings: Pick<AppSettings, 'browserEnabled' | 'askUserEnabled' | 'computerUseEnabled'>
  extensionPaths: CapabilityExtensionPaths
  cuaDriver: { executable(): string | null }
  computerUseSkillPath: string
  piFastModeExtensionPath?: string
}

export function extensionHarnessRuntimeEnvironment(scope: RuntimeEnvironmentScope, dependencies: ExtensionHarnessEnvironmentDependencies): NodeJS.ProcessEnv {
  const { settings, harness } = dependencies
  const cuaDriverPath = settings.computerUseEnabled ? dependencies.cuaDriver.executable() : null
  return buildCapabilityEnvironment(dependencies, (mint) => ({
    ...extensionRuntimeEnvironment(mint('scheduleBridge', scope), () => mint('browserBridge', scope), dependencies.extensionPaths, settings.askUserEnabled && scope.interactive, settings.browserEnabled),
    ...mint('collaborationBridge', { ...scope, harness }),
    ...(harness === 'pi' ? { GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: dependencies.piFastModeExtensionPath } : {}),
    GOOEYPI_CUA_DRIVER_PATH: cuaDriverPath ?? undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: cuaDriverPath ? dependencies.computerUseSkillPath : undefined,
  }))
}

interface RuntimeCapabilityBinding {
  bindSession(token: string | undefined, sessionFile: string | undefined, runtimeId?: string): void
}

/** Bind the first session discovered by a newly started runtime on every broker. */
export function bindRuntimeCapabilities(environment: NodeJS.ProcessEnv, info: RuntimeInfo, bridges: Record<BridgeName, RuntimeCapabilityBinding>): void {
  for (const name of ['scheduleBridge', 'browserBridge', 'collaborationBridge'] as const) {
    bridges[name].bindSession(environment[TOKEN_KEYS[name]], info.sessionFile, info.runtimeId)
  }
}
