// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { VoiceSettings } from '../../src/pages/settings/VoiceSettings'
import type { AppSettings, PrimeWorkApi, VoiceCredentialStatus } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const emptyStatus: VoiceCredentialStatus = {
  configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
  source: {},
  storage: { available: true },
  codexSubscription: false,
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => { root.render(node); await Promise.resolve() })
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function voiceBridge(overrides: Partial<PrimeWorkApi['voice']> = {}): PrimeWorkApi['voice'] {
  return {
    credentialStatus: vi.fn().mockResolvedValue(emptyStatus),
    saveApiKey: vi.fn().mockResolvedValue(emptyStatus),
    deleteApiKey: vi.fn().mockResolvedValue(emptyStatus),
    createRealtimeCall: vi.fn(),
    cancelRealtimeCall: vi.fn(),
    transcribe: vi.fn(),
    testSelfHosted: vi.fn().mockResolvedValue(true),
    executeTool: vi.fn(),
    ...overrides,
  }
}

function Harness({ voice, initialSettings = DEFAULT_SETTINGS }: { voice: PrimeWorkApi['voice'] | null; initialSettings?: AppSettings }) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  return <VoiceSettings settings={settings} voice={voice} onUpdate={(patch) => { setSettings((current) => ({ ...current, ...patch })) }} />
}

describe('Voice settings setup flow', () => {
  it('shows only the selected provider model picker and switches to curated Groq models', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation service"]')!
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation model"]')!
    expect(service.value).toBe('openai-live')
    expect([...model.options].map((option) => option.value)).toEqual(['gpt-live-transcribe', 'gpt-realtime-whisper'])
    expect(container.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()

    await choose(service, 'groq')
    const groqModel = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation model"]')!
    expect([...groqModel.options].map((option) => option.value)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(container.textContent).not.toContain('OpenAI file model')
  })

  it('opens an enabled API-key flow and saves through the voice bridge', async () => {
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'saved' },
      storage: { available: true },
      codexSubscription: false,
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ saveApiKey })} />)

    const openAiCard = [...container.querySelectorAll<HTMLElement>('.voice-connection-card')].find((card) => card.textContent?.includes('OpenAI'))!
    const addKey = [...openAiCard.querySelectorAll('button')].find((button) => button.textContent?.includes('Add key'))!
    expect(addKey.disabled).toBe(false)
    await click(addKey)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'sk-test-key')
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save API key'))!
    await click(save)

    expect(saveApiKey).toHaveBeenCalledWith('openai', 'sk-test-key')
  })

  it('lets the user choose the realtime connection and explains its requirement', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const realtime = container.querySelector<HTMLElement>('[aria-labelledby="voice-realtime-title"]')!
    const connection = realtime.querySelector<HTMLSelectElement>('select[aria-label="Realtime connection"]')!
    expect(connection.value).toBe('openai')
    expect(realtime.textContent).toContain('OpenAI API key required')
    await choose(connection, 'openai-codex')
    expect(realtime.textContent).toContain('ChatGPT Plus/Pro login required')
    expect(realtime.textContent).toContain('Connect OpenAI Codex under Prime Work → Providers')
  })

  it('uses the selected Codex subscription without removing API realtime controls', async () => {
    const credentialStatus = vi.fn().mockResolvedValue({ ...emptyStatus, codexSubscription: true })
    await render(<Harness voice={voiceBridge({ credentialStatus })} initialSettings={{ ...DEFAULT_SETTINGS, voiceRealtimeProvider: 'openai-codex' }} />)

    const realtime = container.querySelector<HTMLElement>('[aria-labelledby="voice-realtime-title"]')!
    expect(realtime.textContent).toContain('ChatGPT subscription connected')
    expect(realtime.textContent).toContain('GPT Live Codex realtime model and Cove voice')
    expect(realtime.querySelector('select[aria-label="Realtime model"]')).toBeNull()
    await choose(realtime.querySelector<HTMLSelectElement>('select[aria-label="Realtime connection"]')!, 'openai')
    expect(realtime.querySelector('select[aria-label="Realtime model"]')).not.toBeNull()
    expect(realtime.querySelector('select[aria-label="Speaking voice"]')).not.toBeNull()
  })

  it('allows a session key and warns that it will not persist without secure Linux storage', async () => {
    const message = 'GooeyPi will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.'
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'session' },
      storage: { available: false, message },
      codexSubscription: false,
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({
      credentialStatus: vi.fn().mockResolvedValue({
        configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
        source: { openai: 'saved' },
        storage: { available: false, message },
        codexSubscription: false,
      } satisfies VoiceCredentialStatus),
      saveApiKey,
    })} />)

    expect(container.textContent).toContain('Keys will work only until GooeyPi quits')
    expect(container.textContent).toContain('GNOME Keyring (libsecret) or KWallet')
    expect(container.textContent).toContain('will not save it to disk')
    expect(container.textContent).toContain('Storage locked')
    const openAiCard = [...container.querySelectorAll<HTMLElement>('.voice-connection-card')].find((card) => card.textContent?.includes('OpenAI'))!
    const addKey = [...openAiCard.querySelectorAll('button')].find((button) => button.textContent?.includes('Add key'))!
    expect(addKey.disabled).toBe(false)
    await click(addKey)

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('only in desktop memory')
    expect(dialog.textContent).toContain('will not write the key to disk')
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'sk-session-key')
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save API key'))!
    await click(save)

    expect(saveApiKey).toHaveBeenCalledWith('openai', 'sk-session-key')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(openAiCard.textContent).toContain('Session only')
    expect(container.textContent).toContain('Keys will work only until GooeyPi quits')
  })

  it('explains how to recover an older desktop process instead of showing disabled key buttons', async () => {
    await render(<Harness voice={null} />)

    expect(container.textContent).toContain('Restart GooeyPi to finish enabling Voice')
    expect(container.textContent).toContain('⌘Q')
    expect([...container.querySelectorAll('button')].some((button) => button.disabled && button.textContent?.includes('Add key'))).toBe(false)
  })

  it('connects and tests a self-hosted Parakeet or Whisper endpoint with an optional token', async () => {
    const testSelfHosted = vi.fn().mockResolvedValue(true)
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': true },
      source: { 'self-hosted': 'saved' },
      storage: { available: true },
      codexSubscription: false,
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ testSelfHosted, saveApiKey })} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation service"]')!
    await choose(service, 'self-hosted')
    const dictation = container.querySelector<HTMLElement>('[aria-labelledby="voice-dictation-title"]')!
    expect(dictation.textContent).toContain('Connect your transcription server')
    expect(dictation.textContent).toContain('Parakeet, Whisper')
    expect(dictation.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()
    expect(dictation.textContent).not.toContain('API key required')

    const url = container.querySelector<HTMLInputElement>('input[aria-label="Self-hosted server URL"]')!
    const model = container.querySelector<HTMLInputElement>('input[aria-label="Self-hosted model ID"]')!
    await enter(url, 'http://127.0.0.1:9000')
    await enter(model, 'nvidia/parakeet-tdt-0.6b-v3')

    const addToken = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add token'))!
    await click(addToken)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('optional bearer token')
    await enter(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, 'local-token')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save token'))!)
    expect(saveApiKey).toHaveBeenCalledWith('self-hosted', 'local-token')

    await click([...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Connect & test'))!)
    expect(testSelfHosted).toHaveBeenCalledWith({ url: 'http://127.0.0.1:9000', model: 'nvidia/parakeet-tdt-0.6b-v3' })
    expect(container.textContent).toContain('Connected. GooeyPi successfully transcribed a test audio clip.')
  })

  it('turns a missing Voice IPC handler into a restart state instead of checking forever', async () => {
    const credentialStatus = vi.fn().mockRejectedValue(new Error("No handler registered for 'voice:credential-status'"))
    await render(<Harness voice={voiceBridge({ credentialStatus })} />)

    expect(container.textContent).toContain('Restart GooeyPi to finish enabling Voice')
    expect(container.textContent).toContain('Restart required')
    expect(container.textContent).not.toContain('Checking…')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Add key'))).toBe(false)
  })
})
