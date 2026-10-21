import { getModels, getProviders, supportsFastMode } from 'prime-agent-ai'
import { describe, expect, it } from 'vitest'
import piWorkFastMode, { type PiFastModeExtensionApi } from '../../assets/extensions/pi-work-fast-mode'

type ProviderHandler = (event: { payload: unknown }, context: { model?: { provider?: unknown; id?: unknown; api?: unknown } }) => unknown
type CommandHandler = (args: string) => void | Promise<void>

function loadExtension(): { provider: ProviderHandler; command: CommandHandler } {
  let provider: ProviderHandler | undefined
  let command: CommandHandler | undefined
  const api: PiFastModeExtensionApi = {
    on: (_event, handler) => { provider = handler },
    registerCommand: (name, options) => {
      expect(name).toBe('gooeypi-fast-mode')
      command = options.handler
    },
  }
  piWorkFastMode(api)
  if (!provider || !command) throw new Error('Fast-mode extension did not register its handlers')
  return { provider, command }
}

const supportedModel = { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses' }

describe('Pi fast-mode compatibility extension', () => {
  it('applies default and priority tiers to supported provider requests', async () => {
    const extension = loadExtension()
    const payload = { model: 'gpt-5.6-luna', input: [] }

    expect(extension.provider({ payload }, { model: supportedModel })).toEqual({ ...payload, service_tier: 'default' })
    await extension.command('priority')
    expect(extension.provider({ payload }, { model: supportedModel })).toEqual({ ...payload, service_tier: 'priority' })
    await extension.command('default')
    expect(extension.provider({ payload }, { model: supportedModel })).toEqual({ ...payload, service_tier: 'default' })
  })

  it('matches the pinned Prime catalog fast-mode support for every provider model', () => {
    const extension = loadExtension()
    const models = getProviders().flatMap((provider) => getModels(provider))
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(extension.provider({ payload: {} }, { model }) !== undefined, `${model.provider}/${model.id}`).toBe(supportsFastMode(model))
    }
  })

  it('leaves unsupported models and malformed payloads untouched', async () => {
    const extension = loadExtension()
    await extension.command('priority')

    expect(extension.provider({ payload: { input: [] } }, { model: { ...supportedModel, id: 'gpt-5.3-codex' } })).toBeUndefined()
    expect(extension.provider({ payload: [] }, { model: supportedModel })).toBeUndefined()
    expect(() => extension.command('turbo')).toThrow('Invalid GooeyPi fast-mode tier')
  })
})
