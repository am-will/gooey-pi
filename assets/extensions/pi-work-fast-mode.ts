type JsonObject = Record<string, unknown>

interface PiFastModeContext {
  model?: { provider?: unknown; id?: unknown; api?: unknown }
}

export interface PiFastModeExtensionApi {
  on(event: 'before_provider_request', handler: (event: { payload: unknown }, context: PiFastModeContext) => unknown): void
  registerCommand(name: string, options: { description?: string; handler: (args: string) => void | Promise<void> }): void
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function supportsFastMode(model: PiFastModeContext['model']): boolean {
  if (model?.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || typeof model.id !== 'string') return false
  return model.id === 'gpt-5.4' || model.id === 'gpt-5.5' || model.id === 'gpt-5.6' || model.id.startsWith('gpt-5.6-')
}

/**
 * Base Pi exposes provider-payload interception but no service-tier RPC
 * command. GooeyPi drives this private slash command over Pi's normal prompt
 * RPC, then the hook applies the selected tier only to models that support it.
 */
export default function piWorkFastMode(pi: PiFastModeExtensionApi): void {
  let priority = false

  pi.registerCommand('gooeypi-fast-mode', {
    description: 'Set GooeyPi fast mode for this Pi runtime.',
    handler: (args) => {
      const tier = args.trim()
      if (tier !== 'default' && tier !== 'priority') throw new Error('Invalid GooeyPi fast-mode tier')
      priority = tier === 'priority'
    },
  })

  pi.on('before_provider_request', (event, context) => {
    if (!supportsFastMode(context.model) || !isJsonObject(event.payload)) return undefined
    return { ...event.payload, service_tier: priority ? 'priority' : 'default' }
  })
}
