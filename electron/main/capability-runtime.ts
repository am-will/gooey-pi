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
