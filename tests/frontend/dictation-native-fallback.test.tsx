// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDictation } from '../../src/hooks/useDictation'
import { detectRendererPlatform } from '../../src/lib/platform-shortcuts'
import { nativeDictationFallback } from '../../src/lib/voice-options'
import type { PrimeWorkApi, VoiceCredentialStatus, VoiceTranscriptionProvider } from '../../src/types/api'

vi.mock('../../src/lib/platform-shortcuts', () => ({ detectRendererPlatform: vi.fn(() => 'darwin') }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const noKeys: VoiceCredentialStatus = { configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false }, source: {}, storage: { available: true } }

let container: HTMLDivElement
let root: Root
let dictation: ReturnType<typeof useDictation>
const getUserMedia = vi.fn(async () => { throw new Error('Add a openai API key in Settings → Voice.') })

function voiceBridge(status = noKeys, systemDictation = true): PrimeWorkApi['voice'] {
  return {
    credentialStatus: vi.fn().mockResolvedValue(status),
    saveApiKey: vi.fn(), deleteApiKey: vi.fn(), createRealtimeCall: vi.fn(), transcribe: vi.fn(), testSelfHosted: vi.fn(), executeTool: vi.fn(),
    startSystemDictation: vi.fn().mockResolvedValue(systemDictation),
  }
}

function Probe({ voice, provider, onError, focusInput }: { voice: PrimeWorkApi['voice']; provider: VoiceTranscriptionProvider; onError(message: string): void; focusInput(): void }) {
  dictation = useDictation(voice, provider, onError, focusInput)
  return null
}

async function startDictation(voice: PrimeWorkApi['voice'], provider: VoiceTranscriptionProvider = 'openai-live') {
  const onError = vi.fn()
  const focusInput = vi.fn()
  act(() => root.render(<Probe voice={voice} provider={provider} onError={onError} focusInput={focusInput} />))
  await act(async () => { await dictation.start() })
  return { onError, focusInput }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.mocked(detectRendererPlatform).mockReturnValue('darwin')
  getUserMedia.mockClear()
})

describe('native dictation fallback', () => {
  it('chooses the platform fallback only when the selected provider is missing its key', () => {
    expect(nativeDictationFallback('openai-live', {}, 'darwin')).toBe('system')
    expect(nativeDictationFallback('groq', { openai: true }, 'darwin')).toBe('system')
    expect(nativeDictationFallback('deepgram', {}, 'win32')).toBe('windows-voice-typing')
    expect(nativeDictationFallback('openai', {}, 'linux')).toBeNull()
    expect(nativeDictationFallback('openai', { openai: true }, 'darwin')).toBeNull()
    expect(nativeDictationFallback('self-hosted', {}, 'darwin')).toBeNull()
    expect(nativeDictationFallback('local-whisper', {}, 'darwin')).toBeNull()
  })

  it('starts macOS Dictation in the composer instead of failing without a key', async () => {
    const voice = voiceBridge()
    const { onError, focusInput } = await startDictation(voice)
    expect(focusInput).toHaveBeenCalledOnce()
    expect(voice.startSystemDictation).toHaveBeenCalledOnce()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('')
    expect(dictation.state).toBe('idle')
  })

  it('points Windows users at voice typing instead of capturing audio', async () => {
    vi.mocked(detectRendererPlatform).mockReturnValue('win32')
    const voice = voiceBridge()
    const { onError, focusInput } = await startDictation(voice, 'groq')
    expect(focusInput).toHaveBeenCalledOnce()
    expect(voice.startSystemDictation).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('Press Win+H'))
    expect(dictation.state).toBe('idle')
  })

  it.each([
    ['a saved key', { ...noKeys, configured: { ...noKeys.configured, openai: true } }, 'darwin', 'openai-live'],
    ['Linux', noKeys, 'linux', 'openai-live'],
    ['a provider that needs no key', noKeys, 'darwin', 'local-whisper'],
  ] as const)('keeps the normal provider flow with %s', async (_label, status, platform, provider) => {
    vi.mocked(detectRendererPlatform).mockReturnValue(platform)
    const voice = voiceBridge(status)
    const { onError } = await startDictation(voice, provider)
    expect(voice.startSystemDictation).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenLastCalledWith('Add a openai API key in Settings → Voice.')
  })

  it('falls back to the provider flow when the platform cannot start dictation', async () => {
    const voice = voiceBridge(noKeys, false)
    await startDictation(voice)
    expect(voice.startSystemDictation).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledOnce()
  })
})
