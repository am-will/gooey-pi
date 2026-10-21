export const PRIME_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PrimeThinkingLevel = (typeof PRIME_THINKING_LEVELS)[number]
export type PrimeServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
export type ProviderAuthMethod = 'oauth' | 'api_key' | 'external'
export type ProviderAuthSource = 'stored' | 'runtime' | 'environment' | 'prime_cli' | 'fallback' | 'models_json_key' | 'models_json_command' | 'stale'
export interface PrimeModelDescriptor {
  key: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  availableThinkingLevels: PrimeThinkingLevel[]
  fastModeSupported: boolean
  available: boolean
  /** GooeyPi visibility policy for this harness; absent catalogs predate per-model controls. */
  enabled?: boolean
}
export interface PrimeProviderDescriptor {
  id: string
  name: string
  authMethod: ProviderAuthMethod
  configured: boolean
  authSource?: ProviderAuthSource
  authLabel?: string
  modelCount: number
  availableModelCount: number
  enabled: boolean
}
export interface PrimeModelCatalog {
  primeVersion: string
  refreshedAt: string
  models: PrimeModelDescriptor[]
  providers: PrimeProviderDescriptor[]
  warning?: string
}
export type ProviderAuthEvent =
  | { flowId: string; providerId: string; type: 'auth'; url: string; instructions?: string }
  | { flowId: string; providerId: string; type: 'progress'; message: string }
  | { flowId: string; providerId: string; type: 'prompt'; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { flowId: string; providerId: string; type: 'select'; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { flowId: string; providerId: string; type: 'complete' | 'cancelled' }
  | { flowId: string; providerId: string; type: 'error'; error: string }
