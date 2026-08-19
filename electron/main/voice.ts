import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VOICE_CREDENTIAL_PROVIDERS } from '../../src/types/api'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import { streamingBehaviorForIntent } from '../../src/lib/session-actions'
import type {
  AppSettings,
  HarnessId,
  PrimeModelDescriptor,
  ProjectRecord,
  VoiceCredentialProvider,
  VoiceCredentialStorageStatus,
  VoiceCredentialStatus,
  VoiceRealtimeCallResult,
  VoiceTaskStarted,
  VoiceToolResult,
} from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import { HARNESSES } from './harness'
import type { ModelCatalogProvider } from './model-catalog'
import { availableModels, rankedModelMatches, resolveModel, resolveReasoning } from './model-selection'
import type { ProcessResult } from './process-utils'
import type { ProjectService } from './projects'
import { isRecord, requireExistingPath, requireId, requireRecord, requireSelfHostedVoiceUrl, requireString } from './validation'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_SECRET_BYTES = 16 * 1024
const MAX_SDP_BYTES = 256 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const REMOTE_TIMEOUT_MS = 90_000

interface SecretCodec {
  status(): VoiceCredentialStorageStatus
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface SecretFile {
  version: 1
  secrets: Partial<Record<VoiceCredentialProvider, string>>
}

interface VoiceServiceOptions {
  secretPath: string
  secretCodec: SecretCodec
  settings(): AppSettings
  projects: Record<HarnessId, ProjectService>
  agents: Record<HarnessId, AgentRpcManager>
  catalogs: Record<HarnessId, ModelCatalogProvider>
  fetch?: typeof fetch
  runProcess(file: string, args: readonly string[], options?: { timeoutMs?: number; maxBytes?: number }): Promise<ProcessResult>
  environment?: NodeJS.ProcessEnv
}

function voiceSecretStorageStatus(platform: NodeJS.Platform, encryptionAvailable: boolean, backend?: string): VoiceCredentialStorageStatus {
  if (platform === 'linux' && backend === 'basic_text') {
    return {
      available: false,
      message: 'GooeyPi will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.',
    }
  }
  if (platform === 'linux' && backend === 'unknown') {
    return {
      available: false,
      message: 'GooeyPi cannot access a secure Linux credential store yet. Start it from a desktop session with GNOME Keyring (libsecret) or KWallet installed and unlocked, then restart GooeyPi.',
    }
  }
  if (!encryptionAvailable) {
    return platform === 'linux'
      ? {
          available: false,
          message: 'GooeyPi cannot find a secure Linux credential store. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.',
        }
      : {
          available: false,
          message: 'GooeyPi cannot access your operating system’s secure credential store. Unlock or repair it, then restart GooeyPi.',
        }
  }
  return { available: true }
}

function credentialProvider(value: unknown): VoiceCredentialProvider {
  if (value !== 'openai' && value !== 'groq' && value !== 'deepgram' && value !== 'self-hosted' && value !== 'self-hosted-realtime') throw new TypeError('Invalid voice credential provider')
  return value
}

function selfHostedConfiguration(urlValue: unknown, modelValue: unknown): { endpoint: string; model: string } {
  const url = new URL(requireSelfHostedVoiceUrl(urlValue))
  const suffix = '/v1/audio/transcriptions'
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith(suffix)) url.pathname = path.endsWith('/v1') ? `${path}/audio/transcriptions` : `${path}${suffix}`
  const model = requireString(modelValue, 'self-hosted voice model', { max: 128, trim: true })
  if (model && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) throw new TypeError('Self-hosted voice model is not valid')
  return { endpoint: url.toString(), model }
}

function selfHostedRealtimeConfiguration(
  urlValue: unknown,
  modelValue: unknown,
  voiceValue: unknown,
): { endpoint: string; model: string; voice: string } {
  const url = new URL(requireSelfHostedVoiceUrl(urlValue))
  const suffix = '/v1/realtime/calls'
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith(suffix)) url.pathname = path.endsWith('/v1') ? `${path}/realtime/calls` : `${path}${suffix}`
  const checkedId = (value: unknown, label: string): string => {
    const id = requireString(value, label, { max: 128, trim: true })
    if (id && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(id)) throw new TypeError(`${label} is not valid`)
    return id
  }
  return {
    endpoint: url.toString(),
    model: checkedId(modelValue, 'self-hosted realtime model'),
    voice: checkedId(voiceValue, 'self-hosted realtime voice'),
  }
}

function silentWav(): Uint8Array {
  const samples = 1_600
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, samples * 2, true)
  return bytes
}

function harnessId(value: unknown): HarnessId {
  if (value !== 'prime' && value !== 'omp' && value !== 'pi') throw new TypeError('Invalid voice harness')
  return value
}

function boundedAudio(value: unknown): Uint8Array {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes || bytes.byteLength < 44 || bytes.byteLength > MAX_AUDIO_BYTES) throw new TypeError('Audio must be a WAV buffer no larger than 25 MB')
  return bytes
}

function cleanText(value: unknown, label: string, max = 1_000_000): string {
  return requireString(value, label, { min: 1, max, trim: true })
}

function localContext(harness: HarnessId): Record<string, string> {
  const now = new Date()
  const resolved = Intl.DateTimeFormat().resolvedOptions()
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  const timeZoneParts = resolved.timeZone.split('/')
  const timeZoneCity = timeZoneParts.length > 1 ? timeZoneParts.at(-1)?.replaceAll('_', ' ') : undefined
  const countryCode = new Intl.Locale(resolved.locale).region
  const locationHint = [timeZoneCity, countryCode].filter(Boolean).join(', ')
  return {
    local_time: new Intl.DateTimeFormat(resolved.locale, { dateStyle: 'full', timeStyle: 'long', timeZone: resolved.timeZone }).format(now),
    iso_time: now.toISOString(),
    time_zone: resolved.timeZone,
    utc_offset: `${sign}${hours}:${minutes}`,
    locale: resolved.locale,
    active_harness: harness,
    ...(timeZoneCity ? { time_zone_city: timeZoneCity } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
    ...(locationHint ? { location_hint: locationHint } : {}),
    location_precision: timeZoneCity ? 'time-zone-derived approximation' : 'country or time-zone only',
  }
}

class VoiceSecretStore {
  private loaded = false
  private values: SecretFile['secrets'] = {}
  private sessionValues: Partial<Record<VoiceCredentialProvider, string>> = {}
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.secrets)) return
      for (const provider of VOICE_CREDENTIAL_PROVIDERS) {
        const encrypted = raw.secrets[provider]
        if (typeof encrypted === 'string' && encrypted.length <= MAX_SECRET_BYTES * 4) this.values[provider] = encrypted
      }
    } catch { /* a missing or malformed secret file starts empty */ }
  }

  private environmentKey(provider: VoiceCredentialProvider): string | undefined {
    const key = this.environment[
      provider === 'openai' ? 'OPENAI_API_KEY'
        : provider === 'groq' ? 'GROQ_API_KEY'
          : provider === 'deepgram' ? 'DEEPGRAM_API_KEY'
            : provider === 'self-hosted' ? 'VOICE_SELF_HOSTED_API_KEY' : 'VOICE_REALTIME_SELF_HOSTED_API_KEY'
    ]
    return key?.trim() || undefined
  }

  async status(): Promise<VoiceCredentialStatus> {
    await this.load()
    const storage = this.codec.status()
    const configured = { openai: false, groq: false, deepgram: false, 'self-hosted': false, 'self-hosted-realtime': false }
    const source: VoiceCredentialStatus['source'] = {}
    for (const provider of VOICE_CREDENTIAL_PROVIDERS) {
      if (this.sessionValues[provider]) {
        configured[provider] = true
        source[provider] = 'session'
      } else if (this.values[provider] && storage.available) {
        configured[provider] = true
        source[provider] = 'saved'
      } else if (this.environmentKey(provider)) {
        configured[provider] = true
        source[provider] = 'environment'
      } else if (this.values[provider]) {
        source[provider] = 'saved'
      }
    }
    return { configured, source, storage }
  }

  async get(provider: VoiceCredentialProvider): Promise<string> {
    const value = await this.getOptional(provider)
    if (value) return value
    const storage = this.codec.status()
    if (!storage.available) throw new Error(storage.message ?? 'Secure credential storage is unavailable on this system')
    throw new Error(`Add a ${provider} API key in Settings → Voice.`)
  }

  async getOptional(provider: VoiceCredentialProvider): Promise<string | undefined> {
    await this.load()
    const fromSession = this.sessionValues[provider]
    if (fromSession) return fromSession
    const encrypted = this.values[provider]
    const storage = this.codec.status()
    if (encrypted && storage.available) {
      try { return this.codec.decrypt(Buffer.from(encrypted, 'base64')) }
      catch { throw new Error(`The saved ${provider} voice key could not be decrypted. Save it again in Voice settings.`) }
    }
    const fromEnvironment = this.environmentKey(provider)
    if (fromEnvironment) return fromEnvironment
    if (encrypted && !storage.available) throw new Error(storage.message ?? 'Secure credential storage is unavailable on this system')
    return undefined
  }

  async save(providerValue: unknown, keyValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    const key = requireString(keyValue, 'apiKey', { min: 1, max: MAX_SECRET_BYTES, trim: true })
    await this.load()
    const storage = this.codec.status()
    if (!storage.available) {
      this.sessionValues[provider] = key
      return this.status()
    }
    delete this.sessionValues[provider]
    this.values[provider] = this.codec.encrypt(key).toString('base64')
    await this.persist()
    return this.status()
  }

  async delete(providerValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    await this.load()
    const hadSavedValue = Boolean(this.values[provider])
    delete this.sessionValues[provider]
    delete this.values[provider]
    if (hadSavedValue) await this.persist()
    return this.status()
  }

  private persist(): Promise<void> {
    const snapshot: SecretFile = { version: 1, secrets: { ...this.values } }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }
}

function orchestrationInstructions(harness: HarnessId): string {
  const harnessName = HARNESSES[harness].agentName
  return [
    'You are the voice orchestrator inside GooeyPi, a desktop client for the Prime Agent, OMP, and Pi harnesses.',
    `This voice session is locked to the currently selected ${harnessName} harness. Never switch harnesses.`,
    'Be concise and conversational. Answer general questions directly.',
    'Use get_local_context for the local date, time, time zone, approximate location, locale, or selected harness. Use search_web for current information. Use list_projects to resolve a project within the selected harness. Use list_models to resolve a requested model and its supported reasoning levels.',
    'For local weather or another location-sensitive lookup when the user did not name a place: first call get_local_context, then call search_web with its location_hint included in the query. Do not ask the user for a location unless get_local_context returns no usable location_hint. Treat the hint as approximate.',
    'Call start_task only when the user explicitly asks you to start, create, kick off, delegate, or run a task.',
    'An explicit request to start work is sufficient authorization. Do not ask for a second confirmation.',
    'Only start tasks inside projects returned by list_projects. Never invent project IDs.',
    'When the user names or describes a model, call list_models with the user’s model wording before start_task. Choose the closest available model and the closest reasoning level that model supports. Model names and reasoning wording may be approximate; do not require exact phrasing. Pass the exact model key returned by list_models to start_task. If the user requests only a reasoning level, omit model and pass the approximate reasoning wording so it can be applied to the harness default model.',
    'If the user does not request a model or reasoning level, omit those fields so the selected harness uses its defaults.',
    'Treat session creation, project selection, and harness selection as orchestration instructions for you, not as part of the delegated prompt.',
    'Rewrite the start_task prompt as a clean, self-contained task containing only the actual goal, useful constraints, and requested output. Do not include phrases such as start a session, create a thread, ask the agent, you are an agent, or working inside the project. Do not add generic process advice the user did not request.',
    'Example: "Start a new session in the Prime project workspace. Ask what the next logical feature to add should be" becomes the task prompt "Determine the next logical feature to add to this project and explain why."',
    'When the user asks to start work, you must call start_task. Never say a task started unless start_task returned started true.',
    'After starting a task, say which project and harness received it.',
  ].join(' ')
}

function realtimeSession(settings: AppSettings, harness: HarnessId): Record<string, unknown> {
  const harnessName = HARNESSES[harness].agentName
  return {
    type: 'realtime',
    model: settings.voiceRealtimeModel,
    instructions: orchestrationInstructions(harness),
    audio: { output: { voice: settings.voiceRealtimeVoice } },
    tool_choice: 'auto',
    tools: [
      {
        type: 'function', name: 'list_projects',
        description: `Find explicitly granted projects in the currently selected ${harnessName} harness. Projects from other harnesses are never returned.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Optional project-name search.' },
          },
        },
      },
      {
        type: 'function', name: 'list_models',
        description: `Find task models available from providers currently shown as active in GooeyPi for the selected ${harnessName} harness. Search with the user’s approximate model wording; hidden, disabled, and unavailable models are never returned. Each result includes the exact key and supported reasoning levels.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Optional approximate model name, provider, family, or spoken model wording. Use this whenever the user mentions a model.' },
          },
        },
      },
      {
        type: 'function', name: 'start_task',
        description: `Immediately create and start a new task in the currently selected ${harnessName} harness after an explicit request. The prompt must contain only the delegated work, never voice-orchestration or routing instructions. Optional model and reasoning preferences are resolved against active GUI providers and applied before the prompt.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            project_id: { type: 'string', description: 'An exact ID returned by list_projects.' },
            prompt: { type: 'string', description: 'A concise, self-contained task with the actual goal, useful user constraints, and requested output. Exclude session/thread creation, project/harness routing, agent-role preambles, and generic filler.' },
            title: { type: 'string', description: 'Optional concise title describing only the delegated work.' },
            model: { type: 'string', description: 'Optional exact model key returned by list_models. Approximate wording is also accepted as a fallback.' },
            reasoning: { type: 'string', description: 'Optional requested reasoning intensity in natural language or as a named level. The closest level supported by the selected model is used.' },
          },
          required: ['project_id', 'prompt'],
        },
      },
      {
        type: 'function', name: 'get_local_context',
        description: 'Get the local date, time, time zone, timezone-derived approximate location hint, locale, UTC offset, and selected harness. Call this before local weather or another location-sensitive lookup when the user did not name a place.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        type: 'function', name: 'search_web',
        description: 'Search the live web for a quick current-information question and return a cited answer. For local weather with no named place, first call get_local_context and include its location_hint in this query.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  }
}

function selfHostedRealtimeSession(settings: AppSettings, harness: HarnessId, testOnly: boolean): Record<string, unknown> {
  const { model, voice } = selfHostedRealtimeConfiguration(
    settings.voiceRealtimeSelfHostedUrl,
    settings.voiceRealtimeSelfHostedModel,
    settings.voiceRealtimeSelfHostedVoice,
  )
  const { model: _model, audio: _audio, ...base } = realtimeSession(settings, harness)
  return {
    ...base,
    ...(model ? { model } : {}),
    instructions: testOnly
      ? 'This is a connection check. Do not speak or call tools.'
      : orchestrationInstructions(harness),
    ...(voice ? { audio: { output: { voice } } } : {}),
    tool_choice: testOnly ? 'none' : 'auto',
    tools: testOnly ? [] : base.tools,
  }
}

function transcriptionSession(settings: AppSettings): Record<string, unknown> {
  return {
    type: 'transcription',
    audio: {
      input: {
        transcription: { model: settings.voiceOpenAiLiveTranscriptionModel, delay: 'low' },
        turn_detection: null,
      },
    },
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class VoiceService {
  private readonly secrets: VoiceSecretStore
  private readonly fetchImpl: typeof fetch
  private readonly realtimeSetups = new Map<string, AbortController>()

  constructor(private readonly options: VoiceServiceOptions) {
    this.secrets = new VoiceSecretStore(options.secretPath, options.secretCodec, options.environment ?? process.env)
    this.fetchImpl = options.fetch ?? fetch
  }

  credentialStatus(): Promise<VoiceCredentialStatus> { return this.secrets.status() }
  saveApiKey(provider: unknown, key: unknown): Promise<VoiceCredentialStatus> { return this.secrets.save(provider, key) }
  deleteApiKey(provider: unknown): Promise<VoiceCredentialStatus> { return this.secrets.delete(provider) }

  async createRealtimeCall(raw: unknown): Promise<VoiceRealtimeCallResult> {
    const request = requireRecord(raw, 'realtime call')
    if (request.mode !== 'conversation' && request.mode !== 'test' && request.mode !== 'transcription') throw new TypeError('Invalid realtime call mode')
    const sdp = requireString(request.sdp, 'sdp', { min: 16, max: MAX_SDP_BYTES })
    if (!sdp.startsWith('v=0')) throw new TypeError('Invalid WebRTC session description')
    const setupId = request.mode === 'conversation' || request.mode === 'test' ? requireId(request.setupId, 'setupId') : undefined
    const abort = setupId ? new AbortController() : undefined
    if (setupId) {
      if (this.realtimeSetups.has(setupId)) throw new Error('Realtime setup is already active')
      this.realtimeSetups.set(setupId, abort!)
    }
    try { return await this.establishRealtimeCall(request, sdp, abort?.signal) }
    finally { if (setupId && this.realtimeSetups.get(setupId) === abort) this.realtimeSetups.delete(setupId) }
  }

  cancelRealtimeCall(raw: unknown): void {
    this.realtimeSetups.get(requireId(raw, 'setupId'))?.abort()
  }

  private async establishRealtimeCall(request: Record<string, unknown>, sdp: string, signal?: AbortSignal): Promise<VoiceRealtimeCallResult> {
    const settings = this.options.settings()
    let response: Response
    let providerLabel: string
    if (request.mode === 'transcription' || settings.voiceRealtimeProvider === 'openai') {
      if (request.mode === 'test') throw new Error('Select the self-hosted realtime connection before testing it')
      const key = await this.secrets.get('openai')
      const form = new FormData()
      form.set('sdp', sdp)
      form.set('session', JSON.stringify(request.mode === 'conversation' ? realtimeSession(settings, harnessId(request.harness)) : transcriptionSession(settings)))
      response = await this.withTimeout('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
      }, 30_000, signal)
      providerLabel = 'OpenAI realtime'
    } else {
      const harness = harnessId(request.harness)
      const configuration = selfHostedRealtimeConfiguration(
        settings.voiceRealtimeSelfHostedUrl,
        settings.voiceRealtimeSelfHostedModel,
        settings.voiceRealtimeSelfHostedVoice,
      )
      const token = await this.secrets.getOptional('self-hosted-realtime')
      const form = new FormData()
      form.set('sdp', sdp)
      form.set('session', JSON.stringify(selfHostedRealtimeSession(settings, harness, request.mode === 'test')))
      response = await this.withTimeout(configuration.endpoint, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        redirect: 'error',
      }, 30_000, signal)
      providerLabel = 'Self-hosted realtime'
    }
    const answer = await this.boundedResponseText(response, 'Realtime setup', MAX_SDP_BYTES)
    if (!response.ok) throw new Error(`${providerLabel} setup failed (${response.status}): ${answer.slice(0, 512)}`)
    if (!answer.startsWith('v=0')) throw new Error('Realtime setup returned an invalid session description')
    return { sdp: answer, protocol: 'openai' }
  }

  async transcribe(raw: unknown): Promise<string> {
    const request = requireRecord(raw, 'transcription request')
    const provider = request.provider
    if (provider !== 'openai' && provider !== 'groq' && provider !== 'deepgram' && provider !== 'self-hosted' && provider !== 'local-whisper') throw new TypeError('Invalid transcription provider')
    const audio = boundedAudio(request.audio)
    if (provider === 'local-whisper') return this.transcribeLocal(audio)
    const settings = this.options.settings()
    if (provider === 'self-hosted') {
      return this.transcribeSelfHosted(audio, settings.voiceSelfHostedUrl, settings.voiceSelfHostedModel)
    }
    if (provider === 'deepgram') {
      const key = await this.secrets.get('deepgram')
      const model = encodeURIComponent(settings.voiceDeepgramTranscriptionModel)
      const response = await this.withTimeout(`https://api.deepgram.com/v1/listen?model=${model}&smart_format=true&punctuate=true`, {
        method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: exactArrayBuffer(audio),
      })
      const data = await this.jsonResponse(response, 'Deepgram transcription')
      const text = isRecord(data.results) && Array.isArray(data.results.channels)
        && isRecord(data.results.channels[0]) && Array.isArray(data.results.channels[0].alternatives)
        && isRecord(data.results.channels[0].alternatives[0]) ? data.results.channels[0].alternatives[0].transcript : undefined
      return cleanText(text, 'Deepgram transcript')
    }
    const key = await this.secrets.get(provider)
    const form = new FormData()
    form.set('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/wav' }), 'dictation.wav')
    form.set('model', provider === 'openai' ? settings.voiceOpenAiTranscriptionModel : settings.voiceGroqTranscriptionModel)
    form.set('response_format', 'json')
    const base = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1'
    const response = await this.withTimeout(`${base}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    })
    const data = await this.jsonResponse(response, `${provider} transcription`)
    return cleanText(data.text, `${provider} transcript`)
  }

  async testSelfHosted(raw: unknown): Promise<boolean> {
    const request = requireRecord(raw, 'self-hosted voice test')
    await this.transcribeSelfHosted(silentWav(), request.url, request.model, true)
    return true
  }

  async executeTool(raw: unknown, harnessValue: unknown): Promise<VoiceToolResult> {
    const request = requireRecord(raw, 'voice tool request')
    const name = requireString(request.name, 'tool name', { min: 1, max: 64 })
    const args = requireRecord(request.arguments, 'tool arguments')
    const harness = harnessId(harnessValue)
    if (name === 'list_projects') return this.listProjects(args, harness)
    if (name === 'list_models') return this.listModels(args, harness)
    if (name === 'start_task') return this.startTask(args, harness)
    if (name === 'get_local_context') return this.getLocalContext(harness)
    if (name === 'search_web') return this.searchWeb(args)
    throw new TypeError('Voice tool is not supported')
  }

  private async listProjects(args: Record<string, unknown>, harness: HarnessId): Promise<VoiceToolResult> {
    const query = args.query === undefined ? '' : requireString(args.query, 'query', { max: 256, trim: true }).toLowerCase()
    const projects = (await this.options.projects[harness].list())
      .filter((project) => !project.inferred)
      .filter((project) => !query || project.name.toLowerCase().includes(query))
      .slice(0, 50)
      .map(({ id, name, harness: projectHarness, lastOpenedAt }) => ({ id, name, harness: projectHarness, lastOpenedAt }))
    return { output: JSON.stringify({ projects }) }
  }

  private disabledProviders(harness: HarnessId): ReadonlySet<string> {
    const settings = this.options.settings()
    const disabled: Record<HarnessId, string[]> = {
      prime: settings.disabledProviders,
      omp: settings.ompDisabledProviders,
      pi: settings.piDisabledProviders,
    }
    return new Set(disabled[harness])
  }

  private disabledModels(harness: HarnessId): ReadonlySet<string> {
    const settings = this.options.settings()
    const disabled: Record<HarnessId, string[]> = {
      prime: settings.disabledModels,
      omp: settings.ompDisabledModels,
      pi: settings.piDisabledModels,
    }
    return new Set(disabled[harness])
  }

  private async availableModels(harness: HarnessId): Promise<PrimeModelDescriptor[]> {
    return availableModels(this.options.catalogs[harness], this.disabledProviders(harness), this.disabledModels(harness))
  }

  private async listModels(args: Record<string, unknown>, harness: HarnessId): Promise<VoiceToolResult> {
    const query = args.query === undefined ? '' : requireString(args.query, 'query', { max: 256, trim: true })
    const available = await this.availableModels(harness)
    const matches = query ? rankedModelMatches(query, available) : available
    const models = matches.slice(0, 100).map((model) => ({
      key: model.key,
      name: model.name,
      provider: model.provider,
      reasoning_levels: model.availableThinkingLevels,
    }))
    return { output: JSON.stringify({ models, matched: matches.length, returned: models.length, truncated: matches.length > models.length }) }
  }

  private async startTask(args: Record<string, unknown>, harness: HarnessId): Promise<VoiceToolResult> {
    const projectId = requireId(args.project_id, 'project_id')
    const prompt = cleanText(args.prompt, 'prompt')
    assertNoMcpAuthenticationCommand(prompt, harness)
    const title = args.title === undefined ? undefined : requireString(args.title, 'title', { min: 1, max: 200, trim: true })
    const modelQuery = args.model === undefined ? undefined : requireString(args.model, 'model', { min: 1, max: 512, trim: true })
    const reasoningQuery = args.reasoning === undefined ? undefined : requireString(args.reasoning, 'reasoning', { min: 1, max: 64, trim: true })
    const project: ProjectRecord | undefined = (await this.options.projects[harness].list())
      .find((candidate) => candidate.id === projectId && !candidate.inferred)
    if (!project) throw new Error(`The requested project is not explicitly granted to the selected ${HARNESSES[harness].agentName} harness`)
    const selectedModel = modelQuery ? resolveModel(modelQuery, await this.availableModels(harness)) : undefined
    const selectedReasoning = selectedModel && reasoningQuery
      ? resolveReasoning(reasoningQuery, selectedModel.availableThinkingLevels)
      : undefined
    const manager = this.options.agents[harness]
    const runtime = await manager.start({
      cwd: project.primaryFolder,
      ...(selectedModel ? { model: selectedModel.key } : {}),
      ...(selectedReasoning ? { thinking: selectedReasoning } : {}),
    })
    let appliedReasoning = selectedReasoning
    try {
      if (!selectedModel && reasoningQuery) {
        appliedReasoning = resolveReasoning(reasoningQuery, runtime.availableThinkingLevels ?? [])
        await manager.command(runtime.runtimeId, { type: 'set_thinking_level', level: appliedReasoning })
      }
      await manager.command(runtime.runtimeId, {
        type: 'prompt',
        message: prompt,
        streamingBehavior: streamingBehaviorForIntent('queue'),
      })
      if (title) await manager.command(runtime.runtimeId, { type: 'set_session_name', name: title }).catch(() => undefined)
      await manager.command(runtime.runtimeId, { type: 'get_state' })
    } catch (error) {
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw error
    }
    const current = manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? runtime
    if (!current.sessionFile) {
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw new Error(`${HARNESSES[project.harness].agentName} accepted the prompt but did not create a visible session. The task was not reported as started.`)
    }
    const task: VoiceTaskStarted = {
      projectId: project.id, projectName: project.name, harness: project.harness,
      runtimeId: current.runtimeId, sessionFile: current.sessionFile,
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      ...(selectedModel ? { model: { key: selectedModel.key, provider: selectedModel.provider, id: selectedModel.id, name: selectedModel.name } } : {}),
      ...(appliedReasoning ? { reasoning: appliedReasoning } : {}),
    }
    return { output: JSON.stringify({ started: true, task }), task }
  }

  private getLocalContext(harness: HarnessId): VoiceToolResult {
    return { output: JSON.stringify(localContext(harness)) }
  }

  private async searchWeb(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const query = requireString(args.query, 'query', { min: 1, max: 4_096, trim: true })
    const key = await this.secrets.get('openai')
    const response = await this.withTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        input: query,
      }),
    })
    const data = await this.jsonResponse(response, 'Web search')
    const text = typeof data.output_text === 'string' ? data.output_text : this.responseText(data.output)
    if (!text) throw new Error('Web search returned no answer')
    return { output: JSON.stringify({ answer: text }) }
  }

  private responseText(output: unknown): string {
    if (!Array.isArray(output)) return ''
    const parts: string[] = []
    for (const item of output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue
      for (const content of item.content) if (isRecord(content) && typeof content.text === 'string') parts.push(content.text)
    }
    return parts.join('\n').trim()
  }

  private async transcribeLocal(audio: Uint8Array): Promise<string> {
    const settings = this.options.settings()
    const executable = await requireExistingPath(settings.voiceLocalWhisperExecutable, 'whisper.cpp executable')
    const model = await requireExistingPath(settings.voiceLocalWhisperModel, 'whisper.cpp model')
    const directory = await mkdtemp(join(tmpdir(), 'prime-work-voice-'))
    const input = join(directory, 'dictation.wav')
    const output = join(directory, 'transcript')
    try {
      await writeFile(input, audio)
      const result = await this.options.runProcess(executable, ['-m', model, '-f', input, '-nt', '-otxt', '-of', output], { timeoutMs: 5 * 60_000, maxBytes: 2 * 1024 * 1024 })
      if (result.timedOut) throw new Error('Local Whisper transcription timed out')
      if (result.outputExceeded) throw new Error('Local Whisper produced too much output')
      if (result.code !== 0) throw new Error(`Local Whisper failed: ${result.stderr.trim().slice(0, 512) || `exit ${result.code}`}`)
      return cleanText(await readFile(`${output}.txt`, 'utf8'), 'Local Whisper transcript')
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async transcribeSelfHosted(audio: Uint8Array, urlValue: unknown, modelValue: unknown, allowEmpty = false): Promise<string> {
    const { endpoint, model } = selfHostedConfiguration(urlValue, modelValue)
    const token = await this.secrets.getOptional('self-hosted')
    const form = new FormData()
    form.set('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/wav' }), 'dictation.wav')
    if (model) form.set('model', model)
    else form.set('language', 'en-US')
    form.set('response_format', 'json')
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REMOTE_TIMEOUT_MS)
    timer.unref()
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        redirect: 'error',
        signal: abort.signal,
      })
      const data = await this.jsonResponse(response, 'Self-hosted transcription')
      if (typeof data.text !== 'string') throw new TypeError('Self-hosted transcript must be a string')
      return allowEmpty ? data.text.trim() : cleanText(data.text, 'Self-hosted transcript')
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Self-hosted transcription timed out')
      throw error
    } finally { clearTimeout(timer) }
  }

  private async jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
    const text = await this.boundedResponseText(response, label)
    if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 512)}`)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error(`${label} returned invalid JSON`) }
    return requireRecord(parsed, `${label} response`)
  }

  private async boundedResponseText(response: Response, label: string): Promise<string> {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error(`${label} response was too large`)
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} response was too large`)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  }

  private async withTimeout(url: string, init: RequestInit, timeoutMs = REMOTE_TIMEOUT_MS): Promise<Response> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref()
    try { return await this.fetchImpl(url, { ...init, signal: abort.signal }) }
    catch (error) {
      if (abort.signal.aborted) throw new Error('Voice provider request timed out')
      throw error
    } finally { clearTimeout(timer) }
  }
}

export { voiceSecretStorageStatus }
export type { SecretCodec, VoiceServiceOptions }
