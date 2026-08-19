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
  configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false, 'self-hosted-realtime': false },
  source: {},
  storage: { available: true },
}

let root: Root
let container: HTMLDivElement
const realtimePeerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')

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
  if (realtimePeerDescriptor) Object.defineProperty(globalThis, 'RTCPeerConnection', realtimePeerDescriptor)
  else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
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
    transcribe: vi.fn(),
    testSelfHosted: vi.fn().mockResolvedValue(true),
    executeTool: vi.fn(),
    ...overrides,
  }
}

function Harness({ voice }: { voice: PrimeWorkApi['voice'] | null }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
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
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false, 'self-hosted-realtime': false },
      source: { openai: 'saved' },
      storage: { available: true },
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

  it('explains secure keychain retrieval in the realtime section', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const realtime = container.querySelector<HTMLElement>('[aria-labelledby="voice-realtime-title"]')!
    expect(realtime.textContent).toContain('Saved API keys are encrypted using your operating system’s internal keychain.')
    expect(realtime.textContent).toContain('may ask for your password to retrieve the key')
  })

  it('allows a session key and warns that it will not persist without secure Linux storage', async () => {
    const message = 'GooeyPi will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.'
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false, 'self-hosted-realtime': false },
      source: { openai: 'session' },
      storage: { available: false, message },
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({
      credentialStatus: vi.fn().mockResolvedValue({
        configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false, 'self-hosted-realtime': false },
        source: { openai: 'saved' },
        storage: { available: false, message },
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
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': true, 'self-hosted-realtime': false },
      source: { 'self-hosted': 'saved' },
      storage: { available: true },
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ testSelfHosted, saveApiKey })} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation service"]')!
    await choose(service, 'self-hosted')
    expect(container.textContent).toContain('Connect your transcription server')
    expect(container.textContent).toContain('Parakeet, Whisper')
    expect(container.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()
    expect(container.textContent).not.toContain('API key required')

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

  it('keeps self-hosted realtime settings and credentials separate and performs a WebRTC connection test', async () => {
    class TestChannel extends EventTarget {
      readyState: RTCDataChannelState = 'open'
    }
    class TestPeer extends EventTarget {
      iceGatheringState: RTCIceGatheringState = 'complete'
      localDescription: RTCSessionDescription | null = null
      channel = new TestChannel()
      addTransceiver = vi.fn()
      createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel)
      createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\no=realtime-test-offer' }))
      setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description as RTCSessionDescription })
      setRemoteDescription = vi.fn(async () => undefined)
      close = vi.fn()
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: TestPeer })
    const createRealtimeCall = vi.fn().mockResolvedValue({ sdp: 'v=0\r\no=realtime-test-answer', protocol: 'openai' })
    const saveApiKey = vi.fn().mockResolvedValue({
      ...emptyStatus,
      configured: { ...emptyStatus.configured, 'self-hosted-realtime': true },
      source: { 'self-hosted-realtime': 'saved' },
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ createRealtimeCall, saveApiKey })} />)

    const realtime = container.querySelector<HTMLElement>('[aria-labelledby="voice-realtime-title"]')!
    await choose(realtime.querySelector<HTMLSelectElement>('select[aria-label="Realtime connection"]')!, 'self-hosted')
    expect(realtime.textContent).toContain('separate from the self-hosted dictation service')
    expect(realtime.textContent).toContain('never falls back to a hosted voice provider')
    await enter(realtime.querySelector<HTMLInputElement>('input[aria-label="Self-hosted realtime server URL"]')!, 'https://api.kortexa.ai')
    await enter(realtime.querySelector<HTMLInputElement>('input[aria-label="Self-hosted realtime model ID"]')!, 'lfm2.5-1.2b-instruct')
    await enter(realtime.querySelector<HTMLInputElement>('input[aria-label="Self-hosted realtime voice ID"]')!, 'adrian')

    await click([...realtime.querySelectorAll('button')].find((button) => button.textContent?.includes('Add token'))!)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    await enter(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, 'realtime-token')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save token'))!)
    expect(saveApiKey).toHaveBeenCalledWith('self-hosted-realtime', 'realtime-token')

    await click([...realtime.querySelectorAll('button')].find((button) => button.textContent?.includes('Connect & test'))!)
    await vi.waitFor(() => expect(createRealtimeCall).toHaveBeenCalledWith({
      mode: 'test',
      setupId: expect.any(String),
      sdp: 'v=0\r\no=realtime-test-offer',
      harness: DEFAULT_SETTINGS.activeHarness,
    }))
    expect(realtime.textContent).toContain('Connected. GooeyPi established an OpenAI-compatible realtime session.')
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
