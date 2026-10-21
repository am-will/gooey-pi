import type { PrimeThinkingLevel, PromptImage } from './api'

/** Commands sent by the renderer; external payload validation remains in the main process. */
export type AgentRpcCommand =
  | { type: 'abort' }
  | { type: 'prompt'; message: string; images?: PromptImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer' | 'follow_up'; message: string; images?: PromptImage[] }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: PrimeThinkingLevel }
  | { type: 'set_service_tier'; serviceTier: 'default' | 'priority' }
  | { type: 'set_session_name'; name: string }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'extension_ui_response'; id: string; cancelled: true }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; value: string }
