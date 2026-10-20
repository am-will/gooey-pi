import { primeCapabilityAvailable, type PrimeRustUnavailableCapability } from '../../src/lib/prime-compat'
import type { AppSettings } from '../../src/types/api'
import type { RuntimeEnvironmentScope } from './agent-rpc'
import type { CuaDriverService } from './cua-driver'
import type { CapabilityScope } from './lib/capability-bridge'

/** A capability broker that mints one bearer claim per runtime. */
interface CapabilityClaimSource {
  environmentFor(scope: CapabilityScope): NodeJS.ProcessEnv
}

export interface PrimeRuntimeEnvironmentDependencies {
  settings: Pick<AppSettings, 'browserEnabled' | 'askUserEnabled' | 'computerUseEnabled'>
  scheduleBridge: CapabilityClaimSource
  browserBridge: CapabilityClaimSource
  collaborationBridge: CapabilityClaimSource
  askUserExtensionPath: string
  cuaDriver: Pick<CuaDriverService, 'executable'>
  computerUseSkillPath: string
}

/**
 * Capability environment for one Prime runtime: broker claims for the
 * schedule, browser and collaboration bridges, the ask-user extension, and the
 * computer-use driver. The Prime adapter turns the *_SKILL_PATH and
 * *_EXTENSION_PATH entries into --skill and --extension argv.
 *
 * Rust Prime (the 'rust' adapter variant) cannot load the browser, ask-user
 * or collaboration extensions, so it gets no claim for them at all: no broker
 * token reaches its kernel, which inherits the whole process environment, and
 * no browser skill points the model at tools that do not exist. Schedules and
 * computer use work there and stay.
 */
export function primeRuntimeEnvironment(scope: RuntimeEnvironmentScope, dependencies: PrimeRuntimeEnvironmentDependencies): NodeJS.ProcessEnv {
  const { variant, ...capabilityScope } = scope
  const offered = (capability: PrimeRustUnavailableCapability) => primeCapabilityAvailable(variant, capability)
  const { settings } = dependencies
  const cuaDriverPath = settings.computerUseEnabled ? dependencies.cuaDriver.executable() : null
  return {
    ...dependencies.scheduleBridge.environmentFor(capabilityScope),
    ...(settings.browserEnabled && offered('browser') ? dependencies.browserBridge.environmentFor(capabilityScope) : {}),
    ...(offered('collaboration') ? dependencies.collaborationBridge.environmentFor({ ...capabilityScope, harness: 'prime' }) : {}),
    PRIME_WORK_ASK_USER_EXTENSION_PATH: settings.askUserEnabled && scope.interactive && offered('askUser') ? dependencies.askUserExtensionPath : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
    GOOEYPI_CUA_DRIVER_PATH: cuaDriverPath ?? undefined,
    GOOEYPI_COMPUTER_USE_SKILL_PATH: cuaDriverPath ? dependencies.computerUseSkillPath : undefined,
  }
}
