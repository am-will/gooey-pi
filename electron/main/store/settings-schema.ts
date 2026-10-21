import { isAbsolute } from 'node:path'
import { DEFAULT_SETTINGS } from '../../../src/lib/default-settings'
import { THEME_MODES, CHECKOUT_STRATEGIES, INSPECTOR_TABS, MESSAGE_ENTER_ACTIONS, HARNESS_IDS, OMP_APPROVAL_MODES, INTERFACE_FONT_SCALES, LOCALE_PREFERENCES, PROJECT_SORT_MODES, type AppSettings } from '../../../src/types/api'
import { MAX_CATALOG_PROVIDERS } from '../model-catalog'
import { isBoundedString, isProviderId, isModelKey, isOneOf, isRecord } from '../validation'

export function defaultSettings(): AppSettings {
  const defaultShell = process.platform === 'win32'
    ? (process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : 'C:\\Windows\\System32\\cmd.exe')
    : (process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/zsh')
  return { ...structuredClone(DEFAULT_SETTINGS), terminalShell: defaultShell }
}

export function parseSettings(value: unknown, legacyState = false): AppSettings {
  const defaults = defaultSettings()
  if (!isRecord(value)) return defaults
  const parseRuntimePath = (path: unknown, fallback: string): string => (
    typeof path === 'string' && path.length <= 4_096 && (!path || isAbsolute(path)) ? path : fallback
  )
  const runtimePaths = isRecord(value.runtimePaths)
    ? {
        prime: parseRuntimePath(value.runtimePaths.prime, defaults.runtimePaths.prime),
        omp: parseRuntimePath(value.runtimePaths.omp, defaults.runtimePaths.omp),
        pi: parseRuntimePath(value.runtimePaths.pi, defaults.runtimePaths.pi),
      }
    : defaults.runtimePaths
  const activeHarness = isOneOf(HARNESS_IDS, value.activeHarness)
    ? value.activeHarness
    : legacyState ? 'prime' : defaults.activeHarness
  const parseLastSelectedModel = (model: unknown, fallback: string): string => (
    typeof model === 'string' && model.length <= 385 && (!model || isModelKey(model))
      ? model
      : fallback
  )
  const lastSelectedModels = isRecord(value.lastSelectedModels)
    ? {
        prime: parseLastSelectedModel(value.lastSelectedModels.prime, defaults.lastSelectedModels.prime),
        omp: parseLastSelectedModel(value.lastSelectedModels.omp, defaults.lastSelectedModels.omp),
        pi: parseLastSelectedModel(value.lastSelectedModels.pi, defaults.lastSelectedModels.pi),
      }
    : defaults.lastSelectedModels
  return {
    theme: isOneOf(THEME_MODES, value.theme) ? value.theme : defaults.theme,
    // Derived from the shared tuple so a locale the renderer can select is never
    // rewritten to the default when the state file is read back.
    locale: isOneOf(LOCALE_PREFERENCES, value.locale) ? value.locale : defaults.locale,
    interfaceFontScale: isOneOf(INTERFACE_FONT_SCALES, value.interfaceFontScale) ? value.interfaceFontScale : defaults.interfaceFontScale,
    projectSortMode: isOneOf(PROJECT_SORT_MODES, value.projectSortMode) ? value.projectSortMode : defaults.projectSortMode,
    sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : defaults.sidebarOpen,
    inspectorOpen: typeof value.inspectorOpen === 'boolean' ? value.inspectorOpen : defaults.inspectorOpen,
    showFileChangesPopup: typeof value.showFileChangesPopup === 'boolean' ? value.showFileChangesPopup : defaults.showFileChangesPopup,
    checkoutStrategy: isOneOf(CHECKOUT_STRATEGIES, value.checkoutStrategy) ? value.checkoutStrategy : defaults.checkoutStrategy,
    keepRunningInBackground: typeof value.keepRunningInBackground === 'boolean' ? value.keepRunningInBackground : defaults.keepRunningInBackground,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : defaults.launchAtLogin,
    terminalOpen: typeof value.terminalOpen === 'boolean' ? value.terminalOpen : defaults.terminalOpen,
    defaultInspectorTab: isOneOf(INSPECTOR_TABS, value.defaultInspectorTab) ? value.defaultInspectorTab : defaults.defaultInspectorTab,
    browserHome: typeof value.browserHome === 'string' ? value.browserHome : defaults.browserHome,
    browserAskForDownloads: typeof value.browserAskForDownloads === 'boolean' ? value.browserAskForDownloads : defaults.browserAskForDownloads,
    terminalShell: typeof value.terminalShell === 'string' ? value.terminalShell : defaults.terminalShell,
    reduceMotion: typeof value.reduceMotion === 'boolean' ? value.reduceMotion : defaults.reduceMotion,
    showReasoningSummaries: typeof value.showReasoningSummaries === 'boolean' ? value.showReasoningSummaries : defaults.showReasoningSummaries,
    showToolCalls: typeof value.showToolCalls === 'boolean' ? value.showToolCalls : defaults.showToolCalls,
    messageEnterAction: isOneOf(MESSAGE_ENTER_ACTIONS, value.messageEnterAction) ? value.messageEnterAction : defaults.messageEnterAction,
    runtimePaths,
    askUserEnabled: typeof value.askUserEnabled === 'boolean' ? value.askUserEnabled : defaults.askUserEnabled,
    askUserTimeoutMs: typeof value.askUserTimeoutMs === 'number' && Number.isInteger(value.askUserTimeoutMs) && value.askUserTimeoutMs >= 0 && value.askUserTimeoutMs <= 1_800_000 ? value.askUserTimeoutMs : defaults.askUserTimeoutMs,
    browserEnabled: typeof value.browserEnabled === 'boolean' ? value.browserEnabled : defaults.browserEnabled,
    computerUseEnabled: typeof value.computerUseEnabled === 'boolean' ? value.computerUseEnabled : defaults.computerUseEnabled,
    disabledProviders: parseDisabledProviders(value.disabledProviders, defaults.disabledProviders),
    disabledModels: parseDisabledModels(value.disabledModels, defaults.disabledModels),
    ompDisabledProviders: parseDisabledProviders(value.ompDisabledProviders, defaults.ompDisabledProviders),
    ompDisabledModels: parseDisabledModels(value.ompDisabledModels, defaults.ompDisabledModels),
    piDisabledProviders: parseDisabledProviders(value.piDisabledProviders, defaults.piDisabledProviders),
    piDisabledModels: parseDisabledModels(value.piDisabledModels, defaults.piDisabledModels),
    lastSelectedModels,
    activeHarness,
    ompApprovalMode: isOneOf(OMP_APPROVAL_MODES, value.ompApprovalMode) ? value.ompApprovalMode : defaults.ompApprovalMode,
    petEnabled: typeof value.petEnabled === 'boolean' ? value.petEnabled : defaults.petEnabled,
    petId: isBoundedString(value.petId, 128) && /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value.petId) ? value.petId : defaults.petId,
    petSize: Number.isInteger(value.petSize) && (value.petSize as number) >= 50 && (value.petSize as number) <= 125 ? value.petSize as number : defaults.petSize,
    voiceTranscriptionProvider: value.voiceTranscriptionProvider === 'openai-live' || value.voiceTranscriptionProvider === 'openai' || value.voiceTranscriptionProvider === 'groq' || value.voiceTranscriptionProvider === 'deepgram' || value.voiceTranscriptionProvider === 'self-hosted' || value.voiceTranscriptionProvider === 'local-whisper' ? value.voiceTranscriptionProvider : defaults.voiceTranscriptionProvider,
    voiceOpenAiLiveTranscriptionModel: isBoundedString(value.voiceOpenAiLiveTranscriptionModel, 128) ? value.voiceOpenAiLiveTranscriptionModel : defaults.voiceOpenAiLiveTranscriptionModel,
    voiceOpenAiTranscriptionModel: isBoundedString(value.voiceOpenAiTranscriptionModel, 128) ? value.voiceOpenAiTranscriptionModel : defaults.voiceOpenAiTranscriptionModel,
    voiceGroqTranscriptionModel: isBoundedString(value.voiceGroqTranscriptionModel, 128) ? value.voiceGroqTranscriptionModel : defaults.voiceGroqTranscriptionModel,
    voiceDeepgramTranscriptionModel: isBoundedString(value.voiceDeepgramTranscriptionModel, 128) ? value.voiceDeepgramTranscriptionModel : defaults.voiceDeepgramTranscriptionModel,
    voiceSelfHostedUrl: isBoundedString(value.voiceSelfHostedUrl, 2_048, true) ? value.voiceSelfHostedUrl : defaults.voiceSelfHostedUrl,
    voiceSelfHostedModel: isBoundedString(value.voiceSelfHostedModel, 128, true) ? value.voiceSelfHostedModel : defaults.voiceSelfHostedModel,
    voiceLocalWhisperExecutable: isBoundedString(value.voiceLocalWhisperExecutable, 4096, true) ? value.voiceLocalWhisperExecutable : defaults.voiceLocalWhisperExecutable,
    voiceLocalWhisperModel: isBoundedString(value.voiceLocalWhisperModel, 4096, true) ? value.voiceLocalWhisperModel : defaults.voiceLocalWhisperModel,
    voiceRealtimeModel: isBoundedString(value.voiceRealtimeModel, 128) ? value.voiceRealtimeModel : defaults.voiceRealtimeModel,
    voiceRealtimeVoice: isBoundedString(value.voiceRealtimeVoice, 64) ? value.voiceRealtimeVoice : defaults.voiceRealtimeVoice,
  }
}

function parseDisabledProviders(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && isProviderId(item)
  )))].slice(0, MAX_CATALOG_PROVIDERS)
}

function parseDisabledModels(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && isModelKey(item)
  )))].slice(0, 5_000)
}

