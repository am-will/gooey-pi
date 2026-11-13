import type { VoiceCredentialProvider, VoiceTranscriptionProvider } from '@/types/api'
import type { MessageKey } from '@/lib/locales/types'

export interface VoiceOption {
  value: string
  /** Product/model name shown verbatim; localized only when `labelKey` is set. */
  label: string
  /** Copy shown under the option; `detailKey` supplies the localized version. */
  detail: string
  detailKey?: MessageKey
  labelKey?: MessageKey
  recommended?: boolean
}

export interface VoiceProviderOption extends VoiceOption {
  value: VoiceTranscriptionProvider
  credential?: 'openai' | 'groq' | 'deepgram'
}

export const VOICE_PROVIDER_OPTIONS: VoiceProviderOption[] = [
  { value: 'openai-live', label: 'OpenAI · Live', labelKey: 'settings.voice.provider.openaiLive.label', detail: 'Words appear while you speak.', detailKey: 'settings.voice.provider.openaiLive.detail', credential: 'openai', recommended: true },
  { value: 'openai', label: 'OpenAI · Recorded', labelKey: 'settings.voice.provider.openai.label', detail: 'Records first, then transcribes the complete clip.', detailKey: 'settings.voice.provider.openai.detail', credential: 'openai' },
  { value: 'groq', label: 'Groq', labelKey: 'settings.voice.provider.groq.label', detail: 'Fast recorded transcription with Whisper.', detailKey: 'settings.voice.provider.groq.detail', credential: 'groq' },
  { value: 'deepgram', label: 'Deepgram', labelKey: 'settings.voice.provider.deepgram.label', detail: 'Recorded transcription with Nova speech models.', detailKey: 'settings.voice.provider.deepgram.detail', credential: 'deepgram' },
  { value: 'self-hosted', label: 'Self-hosted · Parakeet / Whisper', labelKey: 'settings.voice.provider.selfHosted.label', detail: 'Connect to your own OpenAI-compatible transcription server.', detailKey: 'settings.voice.provider.selfHosted.detail' },
  { value: 'local-whisper', label: 'Local · whisper.cpp', labelKey: 'settings.voice.provider.localWhisper.label', detail: 'Runs entirely on this Mac with your own model file.', detailKey: 'settings.voice.provider.localWhisper.detail' },
]

export type NativeDictationFallback = 'system' | 'windows-voice-typing'

/**
 * Without the selected provider's key, dictation falls back to what the OS offers: macOS Dictation can be
 * started for the user, while Windows voice typing only opens from its own Win+H shortcut. Providers that
 * need no key, and platforms without built-in dictation, keep their normal flow.
 */
export function nativeDictationFallback(
  provider: VoiceTranscriptionProvider,
  configured: Partial<Record<VoiceCredentialProvider, boolean>>,
  platform: NodeJS.Platform,
): NativeDictationFallback | null {
  const credential = VOICE_PROVIDER_OPTIONS.find((option) => option.value === provider)?.credential
  if (!credential || configured[credential]) return null
  if (platform === 'darwin') return 'system'
  if (platform === 'win32') return 'windows-voice-typing'
  return null
}

export const OPENAI_LIVE_MODELS: VoiceOption[] = [
  { value: 'gpt-live-transcribe', label: 'GPT Live Transcribe', detail: 'Lowest-latency live dictation.', detailKey: 'settings.voice.model.gptLiveTranscribe', recommended: true },
  { value: 'gpt-realtime-whisper', label: 'GPT Realtime Whisper', detail: 'Streaming transcription with tunable latency and accuracy.', detailKey: 'settings.voice.model.gptRealtimeWhisper' },
]

export const OPENAI_FILE_MODELS: VoiceOption[] = [
  { value: 'gpt-transcribe', label: 'GPT Transcribe', detail: 'Current high-accuracy transcription model.', detailKey: 'settings.voice.model.gptTranscribe', recommended: true },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', detail: 'Accurate multilingual transcription.', detailKey: 'settings.voice.model.gpt4oTranscribe' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', detail: 'Lower-cost GPT-4o transcription.', detailKey: 'settings.voice.model.gpt4oMiniTranscribe' },
  { value: 'whisper-1', label: 'Whisper', detail: 'Legacy general-purpose speech recognition.', detailKey: 'settings.voice.model.whisper' },
]

export const GROQ_MODELS: VoiceOption[] = [
  { value: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo', detail: 'Best price and speed for multilingual dictation.', detailKey: 'settings.voice.model.whisperLargeV3Turbo', recommended: true },
  { value: 'whisper-large-v3', label: 'Whisper Large V3', detail: 'Higher accuracy for error-sensitive transcription.', detailKey: 'settings.voice.model.whisperLargeV3' },
]

export const DEEPGRAM_MODELS: VoiceOption[] = [
  { value: 'nova-3', label: 'Nova-3 General', detail: 'Best general-purpose accuracy.', detailKey: 'settings.voice.model.nova3', recommended: true },
  { value: 'nova-3-medical', label: 'Nova-3 Medical', detail: 'Medical vocabulary and clinical audio.', detailKey: 'settings.voice.model.nova3Medical' },
  { value: 'nova-2-meeting', label: 'Nova-2 Meeting', detail: 'Conference rooms and multiple speakers.', detailKey: 'settings.voice.model.nova2Meeting' },
  { value: 'nova-2-phonecall', label: 'Nova-2 Phone Call', detail: 'Low-bandwidth phone audio.', detailKey: 'settings.voice.model.nova2PhoneCall' },
  { value: 'nova-2-conversationalai', label: 'Nova-2 Conversational AI', detail: 'Voice assistants and automated conversations.', detailKey: 'settings.voice.model.nova2ConversationalAi' },
]

export const REALTIME_MODELS: VoiceOption[] = [
  { value: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', detail: 'Best voice orchestration and tool use.', detailKey: 'settings.voice.model.realtime', recommended: true },
  { value: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', detail: 'Lower-cost realtime voice orchestration.', detailKey: 'settings.voice.model.realtimeMini' },
]

export const REALTIME_VOICES: VoiceOption[] = [
  { value: 'marin', label: 'Marin', detail: 'Natural and conversational.', detailKey: 'settings.voice.realtimeVoice.marin', recommended: true },
  { value: 'cedar', label: 'Cedar', detail: 'Warm and grounded.', detailKey: 'settings.voice.realtimeVoice.cedar', recommended: true },
  { value: 'alloy', label: 'Alloy', detail: 'Balanced and neutral.', detailKey: 'settings.voice.realtimeVoice.alloy' },
  { value: 'ash', label: 'Ash', detail: 'Clear and direct.', detailKey: 'settings.voice.realtimeVoice.ash' },
  { value: 'ballad', label: 'Ballad', detail: 'Expressive and measured.', detailKey: 'settings.voice.realtimeVoice.ballad' },
  { value: 'coral', label: 'Coral', detail: 'Bright and friendly.', detailKey: 'settings.voice.realtimeVoice.coral' },
  { value: 'echo', label: 'Echo', detail: 'Smooth and steady.', detailKey: 'settings.voice.realtimeVoice.echo' },
  { value: 'sage', label: 'Sage', detail: 'Calm and composed.', detailKey: 'settings.voice.realtimeVoice.sage' },
  { value: 'shimmer', label: 'Shimmer', detail: 'Light and energetic.', detailKey: 'settings.voice.realtimeVoice.shimmer' },
  { value: 'verse', label: 'Verse', detail: 'Dynamic and articulate.', detailKey: 'settings.voice.realtimeVoice.verse' },
]

export function optionsWithCurrent(options: VoiceOption[], current: string): VoiceOption[] {
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: `${current} (previous setting)`, labelKey: 'settings.voice.previousOption', detail: 'Kept from an earlier configuration.', detailKey: 'settings.voice.previousOption.detail' }, ...options]
}
