import type { VoiceTranscriptionProvider } from '@/types/api'

export interface VoiceOption {
  value: string
  label: string
  detail: string
  recommended?: boolean
}

export interface VoiceProviderOption extends VoiceOption {
  value: VoiceTranscriptionProvider
  credential?: 'openai' | 'groq' | 'deepgram'
}

export const VOICE_PROVIDER_OPTIONS: VoiceProviderOption[] = [
  { value: 'openai-live', label: 'OpenAI · Live', detail: 'Words appear while you speak.', credential: 'openai', recommended: true },
  { value: 'openai', label: 'OpenAI · Recorded', detail: 'Records first, then transcribes the complete clip.', credential: 'openai' },
  { value: 'groq', label: 'Groq', detail: 'Fast recorded transcription with Whisper.', credential: 'groq' },
  { value: 'deepgram', label: 'Deepgram', detail: 'Recorded transcription with Nova speech models.', credential: 'deepgram' },
  { value: 'self-hosted', label: 'Self-hosted · OpenAI compatible', detail: 'Connect to your own OpenAI-compatible transcription server.' },
  { value: 'local-whisper', label: 'Local · whisper.cpp', detail: 'Runs entirely on this Mac with your own model file.' },
]

export const OPENAI_LIVE_MODELS: VoiceOption[] = [
  { value: 'gpt-live-transcribe', label: 'GPT Live Transcribe', detail: 'Lowest-latency live dictation.', recommended: true },
  { value: 'gpt-realtime-whisper', label: 'GPT Realtime Whisper', detail: 'Streaming transcription with tunable latency and accuracy.' },
]

export const OPENAI_FILE_MODELS: VoiceOption[] = [
  { value: 'gpt-transcribe', label: 'GPT Transcribe', detail: 'Current high-accuracy transcription model.', recommended: true },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', detail: 'Accurate multilingual transcription.' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', detail: 'Lower-cost GPT-4o transcription.' },
  { value: 'whisper-1', label: 'Whisper', detail: 'Legacy general-purpose speech recognition.' },
]

export const GROQ_MODELS: VoiceOption[] = [
  { value: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo', detail: 'Best price and speed for multilingual dictation.', recommended: true },
  { value: 'whisper-large-v3', label: 'Whisper Large V3', detail: 'Higher accuracy for error-sensitive transcription.' },
]

export const DEEPGRAM_MODELS: VoiceOption[] = [
  { value: 'nova-3', label: 'Nova-3 General', detail: 'Best general-purpose accuracy.', recommended: true },
  { value: 'nova-3-medical', label: 'Nova-3 Medical', detail: 'Medical vocabulary and clinical audio.' },
  { value: 'nova-2-meeting', label: 'Nova-2 Meeting', detail: 'Conference rooms and multiple speakers.' },
  { value: 'nova-2-phonecall', label: 'Nova-2 Phone Call', detail: 'Low-bandwidth phone audio.' },
  { value: 'nova-2-conversationalai', label: 'Nova-2 Conversational AI', detail: 'Voice assistants and automated conversations.' },
]

export const REALTIME_MODELS: VoiceOption[] = [
  { value: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', detail: 'Best voice orchestration and tool use.', recommended: true },
  { value: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', detail: 'Lower-cost realtime voice orchestration.' },
]

export const REALTIME_VOICES: VoiceOption[] = [
  { value: 'marin', label: 'Marin', detail: 'Natural and conversational.', recommended: true },
  { value: 'cedar', label: 'Cedar', detail: 'Warm and grounded.', recommended: true },
  { value: 'alloy', label: 'Alloy', detail: 'Balanced and neutral.' },
  { value: 'ash', label: 'Ash', detail: 'Clear and direct.' },
  { value: 'ballad', label: 'Ballad', detail: 'Expressive and measured.' },
  { value: 'coral', label: 'Coral', detail: 'Bright and friendly.' },
  { value: 'echo', label: 'Echo', detail: 'Smooth and steady.' },
  { value: 'sage', label: 'Sage', detail: 'Calm and composed.' },
  { value: 'shimmer', label: 'Shimmer', detail: 'Light and energetic.' },
  { value: 'verse', label: 'Verse', detail: 'Dynamic and articulate.' },
]

export function optionsWithCurrent(options: VoiceOption[], current: string): VoiceOption[] {
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: `${current} (previous setting)`, detail: 'Kept from an earlier configuration.' }, ...options]
}
