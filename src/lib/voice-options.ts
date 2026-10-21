import type { VoiceTranscriptionProvider } from '@/types/api'
import type { MessageKey } from '@/lib/i18n'

// This plain module cannot read the React context, so helpers take the translator
// as an argument and all copy is stored as MessageKeys.
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

export interface VoiceOption {
  value: string
  /** Model and voice names (`GPT-4o Transcribe`, `Marin`) are product names and stay as-is. */
  label: string
  /** The descriptive line under the selected option; translated at render time. */
  detail: MessageKey
  recommended?: boolean
}

export interface VoiceProviderOption {
  value: VoiceTranscriptionProvider
  /** Service names are UI copy ("Self-hosted · Parakeet / Whisper"), so they are keys. */
  label: MessageKey
  detail: MessageKey
  recommended?: boolean
  credential?: 'openai' | 'groq' | 'deepgram'
}

/** An option with its copy already translated, ready to render. */
export interface ResolvedVoiceOption {
  value: string
  label: string
  detail: string
  recommended?: boolean
}

export const VOICE_PROVIDER_OPTIONS: VoiceProviderOption[] = [
  { value: 'openai-live', label: 'settings.voice.provider.openaiLive.label', detail: 'settings.voice.provider.openaiLive.detail', credential: 'openai', recommended: true },
  { value: 'openai', label: 'settings.voice.provider.openai.label', detail: 'settings.voice.provider.openai.detail', credential: 'openai' },
  { value: 'groq', label: 'settings.voice.provider.groq.label', detail: 'settings.voice.provider.groq.detail', credential: 'groq' },
  { value: 'deepgram', label: 'settings.voice.provider.deepgram.label', detail: 'settings.voice.provider.deepgram.detail', credential: 'deepgram' },
  { value: 'self-hosted', label: 'settings.voice.provider.selfHosted.label', detail: 'settings.voice.provider.selfHosted.detail' },
  { value: 'local-whisper', label: 'settings.voice.provider.localWhisper.label', detail: 'settings.voice.provider.localWhisper.detail' },
]

export const OPENAI_LIVE_MODELS: VoiceOption[] = [
  { value: 'gpt-live-transcribe', label: 'GPT Live Transcribe', detail: 'settings.voice.model.gptLiveTranscribe', recommended: true },
  { value: 'gpt-realtime-whisper', label: 'GPT Realtime Whisper', detail: 'settings.voice.model.gptRealtimeWhisper' },
]

export const OPENAI_FILE_MODELS: VoiceOption[] = [
  { value: 'gpt-transcribe', label: 'GPT Transcribe', detail: 'settings.voice.model.gptTranscribe', recommended: true },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', detail: 'settings.voice.model.gpt4oTranscribe' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', detail: 'settings.voice.model.gpt4oMiniTranscribe' },
  { value: 'whisper-1', label: 'Whisper', detail: 'settings.voice.model.whisper' },
]

export const GROQ_MODELS: VoiceOption[] = [
  { value: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo', detail: 'settings.voice.model.whisperLargeV3Turbo', recommended: true },
  { value: 'whisper-large-v3', label: 'Whisper Large V3', detail: 'settings.voice.model.whisperLargeV3' },
]

export const DEEPGRAM_MODELS: VoiceOption[] = [
  { value: 'nova-3', label: 'Nova-3 General', detail: 'settings.voice.model.nova3', recommended: true },
  { value: 'nova-3-medical', label: 'Nova-3 Medical', detail: 'settings.voice.model.nova3Medical' },
  { value: 'nova-2-meeting', label: 'Nova-2 Meeting', detail: 'settings.voice.model.nova2Meeting' },
  { value: 'nova-2-phonecall', label: 'Nova-2 Phone Call', detail: 'settings.voice.model.nova2PhoneCall' },
  { value: 'nova-2-conversationalai', label: 'Nova-2 Conversational AI', detail: 'settings.voice.model.nova2ConversationalAi' },
]

export const REALTIME_MODELS: VoiceOption[] = [
  { value: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', detail: 'settings.voice.model.realtime', recommended: true },
  { value: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', detail: 'settings.voice.model.realtimeMini' },
]

export const REALTIME_VOICES: VoiceOption[] = [
  { value: 'marin', label: 'Marin', detail: 'settings.voice.realtimeVoice.marin', recommended: true },
  { value: 'cedar', label: 'Cedar', detail: 'settings.voice.realtimeVoice.cedar', recommended: true },
  { value: 'alloy', label: 'Alloy', detail: 'settings.voice.realtimeVoice.alloy' },
  { value: 'ash', label: 'Ash', detail: 'settings.voice.realtimeVoice.ash' },
  { value: 'ballad', label: 'Ballad', detail: 'settings.voice.realtimeVoice.ballad' },
  { value: 'coral', label: 'Coral', detail: 'settings.voice.realtimeVoice.coral' },
  { value: 'echo', label: 'Echo', detail: 'settings.voice.realtimeVoice.echo' },
  { value: 'sage', label: 'Sage', detail: 'settings.voice.realtimeVoice.sage' },
  { value: 'shimmer', label: 'Shimmer', detail: 'settings.voice.realtimeVoice.shimmer' },
  { value: 'verse', label: 'Verse', detail: 'settings.voice.realtimeVoice.verse' },
]

export function optionsWithCurrent(options: VoiceOption[], current: string, t: Translate): ResolvedVoiceOption[] {
  const resolved = options.map((option) => ({ ...option, detail: t(option.detail) }))
  return options.some((option) => option.value === current)
    ? resolved
    : [{ value: current, label: t('settings.voice.previousOption', { value: current }), detail: t('settings.voice.previousOption.detail') }, ...resolved]
}
