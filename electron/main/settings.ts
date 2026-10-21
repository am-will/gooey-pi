import { session } from 'electron'
import { isAbsolute } from 'node:path'
import { THEME_MODES, CHECKOUT_STRATEGIES, INSPECTOR_TABS, MESSAGE_ENTER_ACTIONS, OMP_APPROVAL_MODES, BROWSER_PARTITION, HARNESS_IDS, INTERFACE_FONT_SCALES, LOCALE_PREFERENCES, PROJECT_SORT_MODES, type AppSettings, } from '../../src/types/api'
import { MAX_CATALOG_PROVIDERS } from './model-catalog'
import { createKeyedMutex } from './lib/async'
import type { JsonStateStore } from './store'
import { isProviderId, isModelKey, isOneOf, isRecord, rejectUnknownKeys, requireBoolean, requireInteger, requireSelfHostedVoiceUrl, requireString, requireWebUrl } from './validation'

export class SettingsService {
  private readonly updates = createKeyedMutex<'settings'>()
  constructor(
    private readonly store: JsonStateStore,
    private readonly validateShell: (shell: unknown) => string,
    private readonly cancelBrowserDownloads: () => void = () => undefined,
    private readonly onDidUpdate: (previous: AppSettings, next: AppSettings) => void | Promise<void> = () => undefined,
  ) {}

  get(): AppSettings { return this.store.getSettings() }

  async update(raw: unknown): Promise<AppSettings> {
    if (!isRecord(raw)) throw new TypeError('settings patch must be an object')
    // One validator per AppSettings field, compiler-enforced: adding a field
    // without a validator (or vice versa) is a type error, so a patch can
    // never be silently rejected or silently dropped.
    const validators: { [K in keyof AppSettings]: (value: unknown) => AppSettings[K] } = {
      theme: (value) => {
        if (!isOneOf(THEME_MODES, value)) throw new TypeError('Invalid theme')
        return value
      },
      locale: (value) => {
        // Derived from the same tuple the renderer's language picker is built
        // from: a locale the picker can offer can never be rejected here.
        if (!isOneOf(LOCALE_PREFERENCES, value)) throw new TypeError('Invalid locale')
        return value
      },
      interfaceFontScale: (value) => {
        if (!isOneOf(INTERFACE_FONT_SCALES, value)) throw new TypeError('Invalid interface font scale')
        return value
      },
      projectSortMode: (value) => {
        if (!isOneOf(PROJECT_SORT_MODES, value)) throw new TypeError('Invalid project sort mode')
        return value
      },
      sidebarOpen: (value) => requireBoolean(value, 'sidebarOpen'),
      inspectorOpen: (value) => requireBoolean(value, 'inspectorOpen'),
      showFileChangesPopup: (value) => requireBoolean(value, 'showFileChangesPopup'),
      checkoutStrategy: (value) => {
        if (!isOneOf(CHECKOUT_STRATEGIES, value)) throw new TypeError('Invalid checkout strategy')
        return value
      },
      keepRunningInBackground: (value) => requireBoolean(value, 'keepRunningInBackground'),
      launchAtLogin: (value) => requireBoolean(value, 'launchAtLogin'),
      terminalOpen: (value) => requireBoolean(value, 'terminalOpen'),
      browserAskForDownloads: (value) => requireBoolean(value, 'browserAskForDownloads'),
      reduceMotion: (value) => requireBoolean(value, 'reduceMotion'),
      showReasoningSummaries: (value) => requireBoolean(value, 'showReasoningSummaries'),
      showToolCalls: (value) => requireBoolean(value, 'showToolCalls'),
      askUserEnabled: (value) => requireBoolean(value, 'askUserEnabled'),
      askUserTimeoutMs: (value) => requireInteger(value, 'askUserTimeoutMs', 0, 1_800_000),
      browserEnabled: (value) => requireBoolean(value, 'browserEnabled'),
      computerUseEnabled: (value) => requireBoolean(value, 'computerUseEnabled'),
      defaultInspectorTab: (value) => {
        if (!isOneOf(INSPECTOR_TABS, value)) throw new TypeError('Invalid inspector tab')
        return value
      },
      messageEnterAction: (value) => {
        if (!isOneOf(MESSAGE_ENTER_ACTIONS, value)) throw new TypeError('Invalid message Enter action')
        return value
      },
      runtimePaths: (value) => {
        if (!isRecord(value)) throw new TypeError('runtimePaths must be an object')
        rejectUnknownKeys(value, HARNESS_IDS, 'runtimePaths')
        const paths = {} as AppSettings['runtimePaths']
        for (const harness of HARNESS_IDS) {
          const path = requireString(value[harness], `runtimePaths.${harness}`, { max: 4_096 })
          if (path && !isAbsolute(path)) throw new TypeError(`runtimePaths.${harness} must be absolute`)
          paths[harness] = path
        }
        return paths
      },
      browserHome: (value) => requireWebUrl(value),
      terminalShell: (value) => this.validateShell(value),
      activeHarness: (value) => {
        if (!isOneOf(HARNESS_IDS, value)) throw new TypeError('Invalid harness')
        return value
      },
      ompApprovalMode: (value) => {
        if (!isOneOf(OMP_APPROVAL_MODES, value)) throw new TypeError('Invalid OMP approval mode')
        return value
      },
      petEnabled: (value) => requireBoolean(value, 'petEnabled'),
      petId: (value) => {
        const id = requireString(value, 'petId', { min: 1, max: 128, trim: true })
        if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(id)) throw new TypeError('Invalid pet id')
        return id
      },
      petSize: (value) => requireInteger(value, 'petSize', 50, 125),
      voiceTranscriptionProvider: (value) => {
        if (value !== 'openai-live' && value !== 'openai' && value !== 'groq' && value !== 'deepgram' && value !== 'self-hosted' && value !== 'local-whisper') throw new TypeError('Invalid voice transcription provider')
        return value
      },
      voiceOpenAiLiveTranscriptionModel: (value) => this.voiceModel(value, 'voiceOpenAiLiveTranscriptionModel'),
      voiceOpenAiTranscriptionModel: (value) => this.voiceModel(value, 'voiceOpenAiTranscriptionModel'),
      voiceGroqTranscriptionModel: (value) => this.voiceModel(value, 'voiceGroqTranscriptionModel'),
      voiceDeepgramTranscriptionModel: (value) => this.voiceModel(value, 'voiceDeepgramTranscriptionModel'),
      voiceSelfHostedUrl: (value) => {
        const url = requireString(value, 'voiceSelfHostedUrl', { max: 2_048, trim: true })
        return url ? requireSelfHostedVoiceUrl(url) : ''
      },
      voiceSelfHostedModel: (value) => {
        const model = requireString(value, 'voiceSelfHostedModel', { max: 128, trim: true })
        if (model && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) throw new TypeError('voiceSelfHostedModel is not valid')
        return model
      },
      voiceLocalWhisperExecutable: (value) => requireString(value, 'voiceLocalWhisperExecutable', { max: 4_096, trim: true }),
      voiceLocalWhisperModel: (value) => requireString(value, 'voiceLocalWhisperModel', { max: 4_096, trim: true }),
      voiceRealtimeModel: (value) => this.voiceModel(value, 'voiceRealtimeModel'),
      voiceRealtimeVoice: (value) => this.voiceModel(value, 'voiceRealtimeVoice'),
      disabledProviders: (value) => this.disabledProviders(value, 'disabledProviders'),
      disabledModels: (value) => this.disabledModels(value, 'disabledModels'),
      ompDisabledProviders: (value) => this.disabledProviders(value, 'ompDisabledProviders'),
      ompDisabledModels: (value) => this.disabledModels(value, 'ompDisabledModels'),
      piDisabledProviders: (value) => this.disabledProviders(value, 'piDisabledProviders'),
      piDisabledModels: (value) => this.disabledModels(value, 'piDisabledModels'),
      lastSelectedModels: (value) => {
        if (!isRecord(value)) throw new TypeError('lastSelectedModels must be an object')
        rejectUnknownKeys(value, HARNESS_IDS, 'lastSelectedModels')
        const models = {} as AppSettings['lastSelectedModels']
        for (const harness of HARNESS_IDS) {
          const model = requireString(value[harness], `lastSelectedModels.${harness}`, { max: 385, trim: true })
          if (model && !isModelKey(model)) throw new TypeError(`lastSelectedModels.${harness} is not a valid model key`)
          models[harness] = model
        }
        return models
      },
    }
    const keys = Object.keys(validators) as Array<keyof AppSettings>
    rejectUnknownKeys(raw, keys, 'settings patch')
    const patch: Partial<AppSettings> = {}
    const applyField = <K extends keyof AppSettings>(key: K): void => {
      if (raw[key] !== undefined) patch[key] = validators[key](raw[key])
    }
    for (const key of keys) applyField(key)
    return this.updates.run('settings', async () => {
      let previous: AppSettings | undefined
      const next = await this.store.update((state) => {
        previous = structuredClone(state.settings)
        Object.assign(state.settings, patch)
        return state.settings
      })
      try {
        await this.onDidUpdate(previous!, next)
      } catch (error) {
        // Tray and other settings have already applied; only the refused login-item change failed.
        if (patch.launchAtLogin !== undefined && previous!.launchAtLogin !== next.launchAtLogin) {
          await this.store.update((state) => { state.settings.launchAtLogin = previous!.launchAtLogin })
        }
        throw error
      }
      return next
    })
  }

  private voiceModel(value: unknown, label: string): string {
    const model = requireString(value, label, { min: 1, max: 128, trim: true })
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(model)) throw new TypeError(`${label} is not valid`)
    return model
  }

  private disabledProviders(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_CATALOG_PROVIDERS) throw new TypeError(`${label} must be a bounded array`)
    return [...new Set(value.map((entry, index) => {
      const id = requireString(entry, `${label}[${index}]`, { min: 1, max: 128, trim: true })
      if (!isProviderId(id)) throw new TypeError(`${label}[${index}] is not a valid provider ID`)
      return id
    }))]
  }

  private disabledModels(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > 5_000) throw new TypeError(`${label} must be a bounded array`)
    return [...new Set(value.map((entry, index) => {
      const key = requireString(entry, `${label}[${index}]`, { min: 3, max: 385, trim: true })
      if (!isModelKey(key)) throw new TypeError(`${label}[${index}] is not a valid model key`)
      return key
    }))]
  }

  async resetBrowserData(): Promise<boolean> {
    try {
      this.cancelBrowserDownloads()
      const browserSession = session.fromPartition(BROWSER_PARTITION)
      await Promise.all([
        browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache(),
        session.defaultSession.clearStorageData(), session.defaultSession.clearCache(), session.defaultSession.clearAuthCache(),
      ])
      return true
    } catch (error) {
      console.warn('Browser data reset failed:', error instanceof Error ? error.message : error)
      return false
    }
  }
}
