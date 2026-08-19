import { Check, KeyRound, Laptop, LoaderCircle, Mic2, Radio, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { waitForDataChannelOpen, waitForIceGathering } from '@/lib/realtime-webrtc'
import {
  DEEPGRAM_MODELS,
  GROQ_MODELS,
  OPENAI_FILE_MODELS,
  OPENAI_LIVE_MODELS,
  REALTIME_MODELS,
  REALTIME_VOICES,
  VOICE_PROVIDER_OPTIONS,
  optionsWithCurrent,
  type VoiceOption,
} from '@/lib/voice-options'
import type { AppSettings, PrimeWorkApi, VoiceCredentialProvider, VoiceCredentialStatus, VoiceRealtimeProvider, VoiceTranscriptionProvider } from '@/types/api'
import type { SettingsSectionProps } from './contracts'

const CREDENTIALS: Array<{ id: VoiceCredentialProvider; name: string; monogram: string; detail: string }> = [
  { id: 'openai', name: 'OpenAI', monogram: 'OA', detail: 'Required for live dictation and the realtime orb.' },
  { id: 'groq', name: 'Groq', monogram: 'GQ', detail: 'Used only when Groq is your dictation provider.' },
  { id: 'deepgram', name: 'Deepgram', monogram: 'DG', detail: 'Used only when Deepgram is your dictation provider.' },
  { id: 'self-hosted', name: 'Self-hosted endpoint', monogram: 'SH', detail: 'Optional bearer token for your Parakeet or Whisper server.' },
  { id: 'self-hosted-realtime', name: 'Self-hosted realtime endpoint', monogram: 'RT', detail: 'Optional bearer token used only by the realtime orb.' },
]

const CONNECTION_CREDENTIALS = CREDENTIALS.filter((item) => item.id !== 'self-hosted' && item.id !== 'self-hosted-realtime')

interface VoiceSettingsProps extends SettingsSectionProps {
  voice: PrimeWorkApi['voice'] | null
  platform?: NodeJS.Platform
}

type VoiceServiceState = 'checking' | 'ready' | 'restart-required' | 'error'
type SelfHostedTestState = 'idle' | 'testing' | 'connected' | 'error'

function needsDesktopRestart(error: unknown): boolean {
  return /No handler registered for ['"]voice:/i.test(errorMessage(error))
}

function ModelSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: VoiceOption[]; onChange(value: string): void }) {
  const choices = optionsWithCurrent(options, value)
  const selected = choices.find((option) => option.value === value)
  return (
    <label className="voice-choice-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="voice-choice-control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {choices.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · Recommended' : ''}</option>)}
        </select>
        {selected ? <small>{selected.detail}</small> : null}
      </span>
    </label>
  )
}

function PathInput({ label, description, placeholder, value, onCommit }: { label: string; description: string; placeholder: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="voice-path-field">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input aria-label={label} value={draft} placeholder={placeholder} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
    </label>
  )
}

export function VoiceSettings({ settings, onUpdate, voice, platform = 'darwin' }: VoiceSettingsProps) {
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null)
  const [serviceState, setServiceState] = useState<VoiceServiceState>(voice ? 'checking' : 'restart-required')
  const [credential, setCredential] = useState<VoiceCredentialProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [selfHostedUrl, setSelfHostedUrl] = useState(settings.voiceSelfHostedUrl)
  const [selfHostedModel, setSelfHostedModel] = useState(settings.voiceSelfHostedModel)
  const [selfHostedTestState, setSelfHostedTestState] = useState<SelfHostedTestState>('idle')
  const [selfHostedMessage, setSelfHostedMessage] = useState('')
  const [realtimeSelfHostedUrl, setRealtimeSelfHostedUrl] = useState(settings.voiceRealtimeSelfHostedUrl)
  const [realtimeSelfHostedModel, setRealtimeSelfHostedModel] = useState(settings.voiceRealtimeSelfHostedModel)
  const [realtimeSelfHostedVoice, setRealtimeSelfHostedVoice] = useState(settings.voiceRealtimeSelfHostedVoice)
  const [realtimeTestState, setRealtimeTestState] = useState<SelfHostedTestState>('idle')
  const [realtimeMessage, setRealtimeMessage] = useState('')

  useEffect(() => setSelfHostedUrl(settings.voiceSelfHostedUrl), [settings.voiceSelfHostedUrl])
  useEffect(() => setSelfHostedModel(settings.voiceSelfHostedModel), [settings.voiceSelfHostedModel])
  useEffect(() => setRealtimeSelfHostedUrl(settings.voiceRealtimeSelfHostedUrl), [settings.voiceRealtimeSelfHostedUrl])
  useEffect(() => setRealtimeSelfHostedModel(settings.voiceRealtimeSelfHostedModel), [settings.voiceRealtimeSelfHostedModel])
  useEffect(() => setRealtimeSelfHostedVoice(settings.voiceRealtimeSelfHostedVoice), [settings.voiceRealtimeSelfHostedVoice])

  useEffect(() => {
    let active = true
    if (!voice) { setServiceState('restart-required'); return }
    setServiceState('checking')
    void voice.credentialStatus().then((next) => {
      if (active) { setStatus(next); setServiceState('ready') }
    }).catch((error) => {
      if (!active) return
      setStatus(null)
      if (needsDesktopRestart(error)) { setCredential(null); setFailure(''); setServiceState('restart-required') }
      else { setFailure(errorMessage(error)); setServiceState('error') }
    })
    return () => { active = false }
  }, [voice])

  const saveCredential = async () => {
    if (!voice || !credential || !apiKey.trim()) return
    setBusy(true); setFailure('')
    try {
      setStatus(await voice.saveApiKey(credential, apiKey))
      setApiKey(''); setCredential(null)
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const removeCredential = async (provider: VoiceCredentialProvider) => {
    if (!voice) return
    setBusy(true); setFailure('')
    try { setStatus(await voice.deleteApiKey(provider)) } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const closeCredential = () => { if (!busy) { setCredential(null); setApiKey(''); setFailure('') } }
  const openCredential = (provider: VoiceCredentialProvider) => { setFailure(''); setCredential(provider) }
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { void onUpdate({ [key]: value } as Pick<AppSettings, K>) }
  const testSelfHosted = async () => {
    if (!voice || !selfHostedUrl.trim()) return
    setSelfHostedTestState('testing'); setSelfHostedMessage('')
    const url = selfHostedUrl.trim()
    const model = selfHostedModel.trim()
    try {
      await voice.testSelfHosted({ url, model })
      await onUpdate({ voiceSelfHostedUrl: url, voiceSelfHostedModel: model })
      setSelfHostedTestState('connected')
      setSelfHostedMessage('Connected. GooeyPi successfully transcribed a test audio clip.')
    } catch (error) {
      setSelfHostedTestState('error')
      setSelfHostedMessage(errorMessage(error))
    }
  }
  const testRealtimeSelfHosted = async () => {
    if (!voice || !realtimeSelfHostedUrl.trim()) return
    setRealtimeTestState('testing'); setRealtimeMessage('')
    const values = {
      voiceRealtimeProvider: 'self-hosted' as const,
      voiceRealtimeSelfHostedUrl: realtimeSelfHostedUrl.trim(),
      voiceRealtimeSelfHostedModel: realtimeSelfHostedModel.trim(),
      voiceRealtimeSelfHostedVoice: realtimeSelfHostedVoice.trim(),
    }
    let peer: RTCPeerConnection | null = null
    let setupPending = false
    const setupId = crypto.randomUUID()
    try {
      await onUpdate(values)
      peer = new RTCPeerConnection()
      peer.addTransceiver('audio', { direction: 'recvonly' })
      const channel = peer.createDataChannel('oai-events')
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const localDescription = await waitForIceGathering(peer)
      setupPending = true
      const answer = await voice.createRealtimeCall({
        mode: 'test',
        setupId,
        sdp: localDescription.sdp ?? '',
        harness: settings.activeHarness,
      })
      setupPending = false
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await waitForDataChannelOpen(channel)
      setRealtimeTestState('connected')
      setRealtimeMessage('Connected. GooeyPi established an OpenAI-compatible realtime session.')
    } catch (error) {
      if (setupPending) await voice.cancelRealtimeCall(setupId).catch(() => undefined)
      setRealtimeTestState('error')
      setRealtimeMessage(errorMessage(error))
    } finally {
      peer?.close()
    }
  }
  const provider = VOICE_PROVIDER_OPTIONS.find((option) => option.value === settings.voiceTranscriptionProvider) ?? VOICE_PROVIDER_OPTIONS[0]
  const selectedCredential = provider.credential
  const selectedConfigured = selectedCredential ? status?.configured[selectedCredential] ?? false : true
  const secureStorageAvailable = status?.storage.available ?? false
  const realtimeProvider = settings.voiceRealtimeProvider
  const realtimeConfigured = realtimeProvider === 'openai'
    ? status?.configured.openai ?? false
    : Boolean(realtimeSelfHostedUrl.trim())
  const tokenCredential = credential === 'self-hosted' || credential === 'self-hosted-realtime'

  return (
    <>
      <header className="voice-settings-header">
        <span className="voice-settings-header__icon"><Mic2 size={19} /></span>
        <div><h1>Voice</h1><p>Connect a speech service, choose a model, then use the microphone or realtime orb.</p></div>
      </header>

      {serviceState === 'restart-required' ? (
        <div className="voice-bridge-notice" role="status">
          <RefreshCw size={17} />
          <span><strong>Restart GooeyPi to finish enabling Voice</strong><small>This app window is connected to an older desktop process without the Voice handlers. Quit GooeyPi completely with {shortcutLabel(platform, ['Primary', 'Q'])}, then reopen it.</small></span>
        </div>
      ) : null}

      <section className="voice-section" aria-labelledby="voice-connections-title">
        <div className="voice-section__heading">
          <span><ShieldCheck size={15} /></span>
          <div><h2 id="voice-connections-title">Connections</h2><p>Add a key for any hosted service you want to use. Secure storage keeps keys encrypted between app sessions; otherwise they stay only in memory until GooeyPi quits.</p></div>
        </div>
        {serviceState === 'ready' && status && !secureStorageAvailable ? (
          <div className="voice-storage-notice" role="alert">
            <ShieldAlert size={17} />
            <span><strong>Keys will work only until GooeyPi quits</strong><small>{status.storage.message} You can still add a key for this session. GooeyPi will keep it only in desktop memory and will not save it to disk.</small></span>
          </div>
        ) : null}
        {voice ? <div className="voice-connection-grid">
          {CONNECTION_CREDENTIALS.map((item) => {
            const configured = status?.configured[item.id] ?? false
            const source = status?.source[item.id]
            return (
              <article className={`voice-connection-card${configured ? ' is-connected' : ''}`} key={item.id}>
                <span className="voice-provider-mark" aria-hidden="true">{item.monogram}</span>
                <div className="voice-connection-card__body">
                  <span className="voice-connection-card__title"><strong>{item.name}</strong><i>{serviceState === 'checking' ? 'Checking…' : serviceState === 'restart-required' ? 'Restart required' : serviceState === 'error' ? 'Unavailable' : configured ? source === 'environment' ? 'Environment key' : source === 'session' ? 'Session only' : 'Connected' : source === 'saved' && !secureStorageAvailable ? 'Storage locked' : 'Not connected'}</i></span>
                  <small>{item.detail}</small>
                </div>
                {serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential(item.id)}><KeyRound size={13} /> {configured ? 'Replace key' : 'Add key'}</button> : null}
                {serviceState === 'ready' && (source === 'saved' || source === 'session') ? <button type="button" className="button button--icon" aria-label={`Remove ${item.name} API key`} disabled={busy} onClick={() => void removeCredential(item.id)}><Trash2 size={13} /></button> : null}
              </article>
            )
          })}
        </div> : null}
        {failure && !credential ? <p className="settings-error" role="alert">{failure}</p> : null}
      </section>

      <section className="voice-section" aria-labelledby="voice-dictation-title">
        <div className="voice-section__heading">
          <span><Waves size={15} /></span>
          <div><h2 id="voice-dictation-title">Dictation</h2><p>This controls the microphone beside Send.</p></div>
        </div>
        <div className="voice-setup-card">
          <label className="voice-choice-row">
            <span><strong>Service</strong><small>Choose where your microphone audio is transcribed.</small></span>
            <span className="voice-choice-control">
              <select aria-label="Dictation service" value={settings.voiceTranscriptionProvider} onChange={(event) => update('voiceTranscriptionProvider', event.target.value as VoiceTranscriptionProvider)}>
                {VOICE_PROVIDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · Recommended' : ''}</option>)}
              </select>
              <small>{provider.detail}</small>
            </span>
          </label>

          {settings.voiceTranscriptionProvider === 'openai-live' ? <ModelSelect label="Dictation model" description="Streams text while you are speaking." value={settings.voiceOpenAiLiveTranscriptionModel} options={OPENAI_LIVE_MODELS} onChange={(value) => update('voiceOpenAiLiveTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'openai' ? <ModelSelect label="Dictation model" description="Transcribes after you stop recording." value={settings.voiceOpenAiTranscriptionModel} options={OPENAI_FILE_MODELS} onChange={(value) => update('voiceOpenAiTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'groq' ? <ModelSelect label="Dictation model" description="Choose speed or maximum Whisper accuracy." value={settings.voiceGroqTranscriptionModel} options={GROQ_MODELS} onChange={(value) => update('voiceGroqTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'deepgram' ? <ModelSelect label="Dictation model" description="Choose a general or audio-specific Nova model." value={settings.voiceDeepgramTranscriptionModel} options={DEEPGRAM_MODELS} onChange={(value) => update('voiceDeepgramTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className="voice-self-hosted-setup">
              <span className="voice-local-setup__intro"><Server size={15} /><span><strong>Connect your transcription server</strong><small>Works with Parakeet, Whisper, and other servers that implement the OpenAI transcription API.</small></span></span>
              <label className="voice-path-field">
                <span><strong>Server URL</strong><small>Enter the server base URL or its full /v1/audio/transcriptions endpoint.</small></span>
                <input aria-label="Self-hosted server URL" type="url" value={selfHostedUrl} placeholder="http://127.0.0.1:9000" spellCheck={false} onChange={(event) => { setSelfHostedUrl(event.target.value); setSelfHostedTestState('idle'); setSelfHostedMessage('') }} onBlur={() => { const value = selfHostedUrl.trim(); if (value !== settings.voiceSelfHostedUrl) update('voiceSelfHostedUrl', value) }} />
              </label>
              <label className="voice-path-field">
                <span><strong>Model ID</strong><small>Optional. Leave blank to ask the server for its default English model.</small></span>
                <input aria-label="Self-hosted model ID" value={selfHostedModel} placeholder="nvidia/parakeet-tdt-0.6b-v3" spellCheck={false} onChange={(event) => { setSelfHostedModel(event.target.value); setSelfHostedTestState('idle'); setSelfHostedMessage('') }} onBlur={() => { const value = selfHostedModel.trim(); if (value !== settings.voiceSelfHostedModel) update('voiceSelfHostedModel', value) }} />
              </label>
              <div className="voice-self-hosted-auth">
                <span><strong>Access token</strong><small>Optional. Stored with the same OS-backed protection as your other voice keys.</small></span>
                <span className="voice-self-hosted-auth__actions">
                  <i>{status?.configured['self-hosted'] ? status.source['self-hosted'] === 'session' ? 'Session only' : status.source['self-hosted'] === 'environment' ? 'Environment token' : 'Token saved' : status?.source['self-hosted'] === 'saved' ? 'Storage locked' : 'No token'}</i>
                  {voice && serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential('self-hosted')}><KeyRound size={13} /> {status?.configured['self-hosted'] ? 'Replace token' : 'Add token'}</button> : null}
                  {voice && serviceState === 'ready' && (status?.source['self-hosted'] === 'saved' || status?.source['self-hosted'] === 'session') ? <button type="button" className="button button--icon" aria-label="Remove self-hosted access token" disabled={busy} onClick={() => void removeCredential('self-hosted')}><Trash2 size={13} /></button> : null}
                </span>
              </div>
              <div className="voice-self-hosted-connect">
                <span><strong>Connection check</strong><small>Uploads a tenth of a second of silence to verify the actual transcription route and model.</small></span>
                <button type="button" className="button button--primary" disabled={!voice || !selfHostedUrl.trim() || selfHostedTestState === 'testing'} onClick={() => void testSelfHosted()}>{selfHostedTestState === 'testing' ? <LoaderCircle className="is-spinning" size={13} /> : <Server size={13} />} {selfHostedTestState === 'testing' ? 'Testing…' : 'Connect & test'}</button>
              </div>
              {selfHostedMessage ? <p className={`voice-self-hosted-result is-${selfHostedTestState}`} role={selfHostedTestState === 'error' ? 'alert' : 'status'}>{selfHostedTestState === 'connected' ? <Check size={13} /> : <ShieldAlert size={13} />}{selfHostedMessage}</p> : null}
              <p className="voice-self-hosted-note">Plain HTTP is allowed on this computer and private-network addresses. Use HTTPS for public hosts.</p>
            </div>
          ) : null}
          {settings.voiceTranscriptionProvider === 'local-whisper' ? (
            <div className="voice-local-setup">
              <span className="voice-local-setup__intro"><Laptop size={15} /><span><strong>Local whisper.cpp setup</strong><small>These are file paths because GooeyPi runs your installed whisper.cpp directly. Hosted services do not need them.</small></span></span>
              <PathInput label="whisper-cli executable" description="Path to the whisper.cpp command-line program." placeholder="/opt/homebrew/bin/whisper-cli" value={settings.voiceLocalWhisperExecutable} onCommit={(value) => update('voiceLocalWhisperExecutable', value)} />
              <PathInput label="GGML model file" description="Path to the downloaded whisper.cpp model." placeholder="/path/to/ggml-large-v3-turbo.bin" value={settings.voiceLocalWhisperModel} onCommit={(value) => update('voiceLocalWhisperModel', value)} />
            </div>
          ) : null}

          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className={`voice-requirement${selfHostedUrl.trim() ? ' is-ready' : ''}`}>
              <span>{selfHostedUrl.trim() ? <Check size={13} /> : <Server size={13} />}{selfHostedUrl.trim() ? 'Self-hosted server configured' : 'Server URL required'}</span>
            </div>
          ) : selectedCredential ? (
            <div className={`voice-requirement${selectedConfigured ? ' is-ready' : ''}`}>
              <span>{selectedConfigured ? <Check size={13} /> : <KeyRound size={13} />}{selectedConfigured ? `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} is connected` : `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} key required`}</span>
              {!selectedConfigured && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential(selectedCredential)}>Add key</button> : null}
            </div>
          ) : <div className="voice-requirement is-ready"><span><Check size={13} />Runs locally with no API key</span></div>}
        </div>
      </section>

      <section className="voice-section" aria-labelledby="voice-realtime-title">
        <div className="voice-section__heading">
          <span><Radio size={15} /></span>
          <div><h2 id="voice-realtime-title">Realtime orb</h2><p>The draggable voice agent can use OpenAI or an OpenAI-compatible server.</p></div>
        </div>
        <div className="voice-setup-card">
          <label className="voice-choice-row">
            <span><strong>Connection</strong><small>Choose the independent connection used by the orb.</small></span>
            <span className="voice-choice-control">
              <select aria-label="Realtime connection" value={realtimeProvider} onChange={(event) => { update('voiceRealtimeProvider', event.target.value as VoiceRealtimeProvider); setRealtimeTestState('idle'); setRealtimeMessage('') }}>
                <option value="openai">OpenAI API key</option>
                <option value="self-hosted">Self-hosted · OpenAI compatible</option>
              </select>
              <small>{realtimeProvider === 'openai'
                ? 'Uses GooeyPi’s existing realtime API connection.'
                : 'Uses your own OpenAI-compatible Realtime WebRTC endpoint.'}</small>
            </span>
          </label>
          {realtimeProvider === 'openai' ? <>
            <ModelSelect label="Realtime model" description="Handles conversation, web search, and task delegation." value={settings.voiceRealtimeModel} options={REALTIME_MODELS} onChange={(value) => update('voiceRealtimeModel', value)} />
            <ModelSelect label="Speaking voice" description="The voice you hear when the orb responds." value={settings.voiceRealtimeVoice} options={REALTIME_VOICES} onChange={(value) => update('voiceRealtimeVoice', value)} />
          </> : null}
          {realtimeProvider === 'self-hosted' ? (
            <div className="voice-self-hosted-setup">
              <span className="voice-local-setup__intro"><Server size={15} /><span><strong>Connect your realtime server</strong><small>This configuration is separate from the self-hosted dictation service.</small></span></span>
              <label className="voice-path-field">
                <span><strong>Server URL</strong><small>Enter a base URL or the full /v1/realtime/calls endpoint.</small></span>
                <input aria-label="Self-hosted realtime server URL" type="url" value={realtimeSelfHostedUrl} placeholder="https://api.example.com" spellCheck={false} onChange={(event) => { setRealtimeSelfHostedUrl(event.target.value); setRealtimeTestState('idle'); setRealtimeMessage('') }} onBlur={() => { const value = realtimeSelfHostedUrl.trim(); if (value !== settings.voiceRealtimeSelfHostedUrl) update('voiceRealtimeSelfHostedUrl', value) }} />
              </label>
              <label className="voice-path-field">
                <span><strong>Model ID</strong><small>Optional. Leave blank to use the server default.</small></span>
                <input aria-label="Self-hosted realtime model ID" value={realtimeSelfHostedModel} placeholder="Server default" spellCheck={false} onChange={(event) => { setRealtimeSelfHostedModel(event.target.value); setRealtimeTestState('idle'); setRealtimeMessage('') }} onBlur={() => { const value = realtimeSelfHostedModel.trim(); if (value !== settings.voiceRealtimeSelfHostedModel) update('voiceRealtimeSelfHostedModel', value) }} />
              </label>
              <label className="voice-path-field">
                <span><strong>Speaking voice</strong><small>Optional. Leave blank to use the server default.</small></span>
                <input aria-label="Self-hosted realtime voice ID" value={realtimeSelfHostedVoice} placeholder="Server default" spellCheck={false} onChange={(event) => { setRealtimeSelfHostedVoice(event.target.value); setRealtimeTestState('idle'); setRealtimeMessage('') }} onBlur={() => { const value = realtimeSelfHostedVoice.trim(); if (value !== settings.voiceRealtimeSelfHostedVoice) update('voiceRealtimeSelfHostedVoice', value) }} />
              </label>
              <div className="voice-self-hosted-auth">
                <span><strong>Access token</strong><small>Optional and separate from the self-hosted dictation token.</small></span>
                <span className="voice-self-hosted-auth__actions">
                  <i>{status?.configured['self-hosted-realtime'] ? status.source['self-hosted-realtime'] === 'session' ? 'Session only' : status.source['self-hosted-realtime'] === 'environment' ? 'Environment token' : 'Token saved' : status?.source['self-hosted-realtime'] === 'saved' ? 'Storage locked' : 'No token'}</i>
                  {voice && serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential('self-hosted-realtime')}><KeyRound size={13} /> {status?.configured['self-hosted-realtime'] ? 'Replace token' : 'Add token'}</button> : null}
                  {voice && serviceState === 'ready' && (status?.source['self-hosted-realtime'] === 'saved' || status?.source['self-hosted-realtime'] === 'session') ? <button type="button" className="button button--icon" aria-label="Remove self-hosted realtime access token" disabled={busy} onClick={() => void removeCredential('self-hosted-realtime')}><Trash2 size={13} /></button> : null}
                </span>
              </div>
              <div className="voice-self-hosted-connect">
                <span><strong>Connection check</strong><small>Creates a microphone-free WebRTC session against this exact endpoint.</small></span>
                <button type="button" className="button button--primary" disabled={!voice || !realtimeSelfHostedUrl.trim() || realtimeTestState === 'testing'} onClick={() => void testRealtimeSelfHosted()}>{realtimeTestState === 'testing' ? <LoaderCircle className="is-spinning" size={13} /> : <Radio size={13} />} {realtimeTestState === 'testing' ? 'Testing…' : 'Connect & test'}</button>
              </div>
              {realtimeMessage ? <p className={`voice-self-hosted-result is-${realtimeTestState}`} role={realtimeTestState === 'error' ? 'alert' : 'status'}>{realtimeTestState === 'connected' ? <Check size={13} /> : <ShieldAlert size={13} />}{realtimeMessage}</p> : null}
              <p className="voice-self-hosted-note">Plain HTTP is allowed on this computer and private-network addresses. Use HTTPS for public hosts. GooeyPi never falls back to a hosted voice provider.</p>
            </div>
          ) : null}
          <div className={`voice-requirement${realtimeConfigured ? ' is-ready' : ''}`}>
            <span>{realtimeConfigured ? <Check size={13} /> : realtimeProvider === 'self-hosted' ? <Server size={13} /> : <KeyRound size={13} />}{realtimeProvider === 'openai'
              ? realtimeConfigured ? 'OpenAI API key connected' : 'OpenAI API key required'
              : realtimeConfigured ? 'Self-hosted realtime server configured' : 'Self-hosted realtime server URL required'}</span>
            {realtimeProvider === 'openai' && !realtimeConfigured && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential('openai')}>Add key</button> : null}
          </div>
          {secureStorageAvailable ? <p className="voice-realtime-note">Saved API keys are encrypted using your operating system’s internal keychain. When you open the voice agent, your system may ask for your password to retrieve the key.</p> : null}
        </div>
      </section>

      {credential ? <Modal title={`Connect ${CREDENTIALS.find((item) => item.id === credential)?.name ?? credential}`} onClose={closeCredential} footer={<><button type="button" className="button" disabled={busy} onClick={closeCredential}>Cancel</button><button type="button" className="button button--primary" disabled={busy || !apiKey.trim()} onClick={() => void saveCredential()}>{busy ? 'Saving…' : tokenCredential ? 'Save token' : 'Save API key'}</button></>}>
        <p className="modal-intro">{secureStorageAvailable ? `Paste the ${tokenCredential ? 'optional bearer token' : 'provider API key'}. GooeyPi encrypts it with your operating system’s secure credential store and never reads it back into this screen.` : `Secure credential storage is unavailable. GooeyPi will keep this ${tokenCredential ? 'token' : 'key'} only in desktop memory for the current app session. It will not write the ${tokenCredential ? 'token' : 'key'} to disk, and it will be cleared when GooeyPi quits.`}</p>
        {failure ? <p className="settings-error" role="alert">{failure}</p> : null}
        <label className="field"><span>{tokenCredential ? 'Access token' : 'API key'}</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder={tokenCredential ? 'Paste access token' : 'Paste API key'} onChange={(event) => setApiKey(event.target.value)} /></label>
      </Modal> : null}
    </>
  )
}
