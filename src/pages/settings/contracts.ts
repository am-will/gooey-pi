import type { AppMeta, AppSettings, PrimeModelCatalog, PrimeWorkApi } from '@/types/api'

export type SettingsSection = 'general' | 'appearance' | 'agent' | 'providers' | 'voice' | 'pets' | 'browser' | 'terminal' | 'privacy' | 'about'

export type SettingsUpdate = (patch: Partial<AppSettings>) => Promise<void> | void

export interface SettingsSectionProps {
  settings: AppSettings
  onUpdate: SettingsUpdate
}

export interface SettingsMetaSectionProps extends SettingsSectionProps {
  meta?: AppMeta | null
  onRefreshHarnesses(): Promise<void>
  /** Harness-owned model-role configuration; absent outside the desktop app. */
  agentConfig?: PrimeWorkApi['agentConfig'] | null
  /** Active harness catalog, used to label and validate model-role choices. */
  providerCatalog?: PrimeModelCatalog | null
}

export const SETTINGS_FIELD_SECTIONS = {
  theme: 'appearance',
  locale: 'appearance',
  interfaceFontScale: 'appearance',
  sidebarOpen: 'general',
  inspectorOpen: 'general',
  showFileChangesPopup: 'general',
  keepRunningInBackground: 'general',
  launchAtLogin: 'general',
  terminalOpen: 'terminal',
  defaultInspectorTab: 'general',
  browserHome: 'browser',
  browserAskForDownloads: 'browser',
  terminalShell: 'terminal',
  reduceMotion: 'appearance',
  showReasoningSummaries: 'agent',
  showToolCalls: 'agent',
  messageEnterAction: 'agent',
  runtimePaths: 'agent',
  enabledHarnesses: 'agent',
  telemetry: 'privacy',
  askUserEnabled: 'agent',
  browserEnabled: 'agent',
  computerUseEnabled: 'agent',
  disabledProviders: 'providers',
  disabledModels: 'providers',
  ompDisabledProviders: 'providers',
  ompDisabledModels: 'providers',
  piDisabledProviders: 'providers',
  piDisabledModels: 'providers',
  activeHarness: 'agent',
  ompApprovalMode: 'agent',
  petEnabled: 'pets',
  petId: 'pets',
  petSize: 'pets',
  voiceTranscriptionProvider: 'voice',
  voiceOpenAiLiveTranscriptionModel: 'voice',
  voiceOpenAiTranscriptionModel: 'voice',
  voiceGroqTranscriptionModel: 'voice',
  voiceDeepgramTranscriptionModel: 'voice',
  voiceSelfHostedUrl: 'voice',
  voiceSelfHostedModel: 'voice',
  voiceLocalWhisperExecutable: 'voice',
  voiceLocalWhisperModel: 'voice',
  voiceRealtimeProvider: 'voice',
  voiceRealtimeModel: 'voice',
  voiceRealtimeVoice: 'voice',
} as const satisfies Record<keyof AppSettings, SettingsSection>
