import type { CheckoutStrategy } from './git'
import type { HarnessId } from './harness'
import type { VoiceTranscriptionProvider } from '../api'
export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
export type WorkspaceView = 'session' | 'projects' | 'activity' | 'scheduled' | 'plugins' | 'settings'
export const INSPECTOR_TABS = ['summary', 'changes', 'browser', 'files'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]
/**
 * OMP tool-approval preference. 'inherit' defers to OMP's own
 * `~/.omp/agent/config.yml`; the other values are passed to the omp CLI as
 * `--approval-mode` when starting an OMP runtime.
 */
export const OMP_APPROVAL_MODES = ['inherit', 'always-ask', 'write', 'yolo'] as const
export type OmpApprovalMode = (typeof OMP_APPROVAL_MODES)[number]
export const MESSAGE_ENTER_ACTIONS = ['queue', 'steer'] as const
export type MessageEnterAction = (typeof MESSAGE_ENTER_ACTIONS)[number]
export const INTERFACE_FONT_SCALES = [105, 110, 115] as const
export type InterfaceFontScale = typeof INTERFACE_FONT_SCALES[number]
export const LOCALE_PREFERENCES = ['system', 'en', 'zh-CN', 'ja'] as const
export type LocalePreference = typeof LOCALE_PREFERENCES[number]
export const PROJECT_SORT_MODES = ['recent', 'alphabetical'] as const
export type ProjectSortMode = typeof PROJECT_SORT_MODES[number]
export interface AppSettings {
  theme: ThemeMode
  locale: LocalePreference
  /** Bounded interface text scale; 110 is the designed default. */
  interfaceFontScale: InterfaceFontScale
  /** Order the renderer derives for project lists; 'recent' keeps launch behaviour unchanged. */
  projectSortMode: ProjectSortMode
  sidebarOpen: boolean
  inspectorOpen: boolean
  showFileChangesPopup: boolean
  checkoutStrategy: CheckoutStrategy
  /** Keep the desktop process available for scheduled work after its window closes. */
  keepRunningInBackground: boolean
  /** Ask the operating system to launch GooeyPi when the user signs in. */
  launchAtLogin: boolean
  terminalOpen: boolean
  defaultInspectorTab: InspectorTab
  browserHome: string
  browserAskForDownloads: boolean
  terminalShell: string
  reduceMotion: boolean
  showReasoningSummaries: boolean
  showToolCalls: boolean
  messageEnterAction: MessageEnterAction
  /** Optional absolute executable overrides; blank keeps automatic discovery. */
  runtimePaths: Record<HarnessId, string>
  /** GooeyPi-managed ask_user tool, shared by every interactive harness. */
  askUserEnabled: boolean
  /** Visible time allowed for app-owned questionnaires; 0 waits until answered. Harness deadlines are unchanged. */
  askUserTimeoutMs: number
  /** Expose GooeyPi's thread-scoped in-app browser controls to new sessions. */
  browserEnabled: boolean
  /** Expose the separately installed TryCUA driver to new sessions through its official CLI. */
  computerUseEnabled: boolean
  /** Providers hidden from GooeyPi's Prime model picker. */
  disabledProviders: string[]
  /** Models hidden from GooeyPi's Prime model picker, stored as provider/model keys. */
  disabledModels: string[]
  /** Providers hidden from GooeyPi's OMP model picker; OMP config is untouched. */
  ompDisabledProviders: string[]
  /** Models hidden from GooeyPi's OMP model picker; OMP config is untouched. */
  ompDisabledModels: string[]
  /** Providers hidden from GooeyPi's pi model picker; pi config is untouched. */
  piDisabledProviders: string[]
  /** Models hidden from GooeyPi's pi model picker; pi config is untouched. */
  piDisabledModels: string[]
  /** Last usable model selected in each harness; blank falls back to the first usable catalog model. */
  lastSelectedModels: Record<HarnessId, string>
  /** Harness whose workspace the renderer shows; new installs default to 'omp'. */
  activeHarness: HarnessId
  /** OMP tool-approval override; 'inherit' leaves OMP's own config in charge. */
  ompApprovalMode: OmpApprovalMode
  /** Desktop companion shown above the workspace. */
  petEnabled: boolean
  /** Built-in or discovered pet selection id. */
  petId: string
  /** Desktop companion size as a percentage of its native workspace size. */
  petSize: number
  /** Speech-to-text path used by the composer microphone. */
  voiceTranscriptionProvider: VoiceTranscriptionProvider
  /** Provider model IDs stay configurable without exposing provider credentials. */
  voiceOpenAiLiveTranscriptionModel: string
  voiceOpenAiTranscriptionModel: string
  voiceGroqTranscriptionModel: string
  voiceDeepgramTranscriptionModel: string
  /** User-managed OpenAI-compatible Parakeet or Whisper transcription server. */
  voiceSelfHostedUrl: string
  voiceSelfHostedModel: string
  /** User-managed whisper.cpp installation for offline transcription. */
  voiceLocalWhisperExecutable: string
  voiceLocalWhisperModel: string
  /** Realtime orb model and synthesized voice. */
  voiceRealtimeModel: string
  voiceRealtimeVoice: string
}
