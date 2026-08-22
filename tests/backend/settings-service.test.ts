import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn(), defaultSession: {} } }))

import { SettingsService } from '../../electron/main/settings-schedules'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
function makeService(validateShell: (shell: unknown) => string = () => '/bin/zsh', onDidUpdate?: ConstructorParameters<typeof SettingsService>[3]) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-settings-'))
  dirs.push(dir)
  return new SettingsService(new JsonStateStore(join(dir, 'state.json')), validateShell, undefined, onDidUpdate)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('SettingsService.update', () => {
  it('applies every field of a full valid patch', async () => {
    const service = makeService()
    const next = await service.update({
      theme: 'dark',
      locale: 'zh-CN',
      interfaceFontScale: 105,
      sidebarOpen: false,
      inspectorOpen: true,
      showFileChangesPopup: false,
      keepRunningInBackground: true,
      launchAtLogin: true,
      terminalOpen: true,
      defaultInspectorTab: 'changes',
      browserHome: 'https://example.test/',
      browserAskForDownloads: false,
      terminalShell: '/bin/zsh',
      reduceMotion: true,
      showReasoningSummaries: false,
      showToolCalls: false,
      messageEnterAction: 'steer',
      runtimePaths: { prime: '/opt/prime-agent', omp: '/opt/omp', pi: '/opt/pi' },
      enabledHarnesses: ['prime', 'omp', 'prime'],
      telemetry: false,
      askUserEnabled: false,
      disabledProviders: ['openai', 'openai', 'google'],
      disabledModels: ['openai/gpt-5.6', 'openai/gpt-5.6'],
      ompDisabledProviders: ['anthropic', 'anthropic'],
      ompDisabledModels: ['anthropic/claude-sonnet-4'],
      piDisabledProviders: [],
      piDisabledModels: ['openai/gpt-5.6-codex'],
      activeHarness: 'omp',
      ompApprovalMode: 'always-ask',
      petEnabled: true,
      petId: 'codex/rocky',
      petSize: 65,
      voiceTranscriptionProvider: 'groq',
      voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper',
      voiceOpenAiTranscriptionModel: 'gpt-4o-mini-transcribe',
      voiceGroqTranscriptionModel: 'whisper-large-v3',
      voiceDeepgramTranscriptionModel: 'nova-3-general',
      voiceSelfHostedUrl: 'https://speech.example.test/v1',
      voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3',
      voiceLocalWhisperExecutable: '/opt/whisper-cli',
      voiceLocalWhisperModel: '/opt/ggml-model.bin',
      voiceRealtimeProvider: 'openai-codex',
      voiceRealtimeModel: 'gpt-realtime-2.1',
      voiceRealtimeVoice: 'cedar',
    })
    expect(next).toMatchObject({
      theme: 'dark', locale: 'zh-CN', interfaceFontScale: 105, sidebarOpen: false, inspectorOpen: true, showFileChangesPopup: false, keepRunningInBackground: true, launchAtLogin: true, terminalOpen: true,
      defaultInspectorTab: 'changes', browserHome: 'https://example.test/',
      browserAskForDownloads: false, terminalShell: '/bin/zsh', reduceMotion: true,
      showReasoningSummaries: false, showToolCalls: false, messageEnterAction: 'steer',
      runtimePaths: { prime: '/opt/prime-agent', omp: '/opt/omp', pi: '/opt/pi' }, enabledHarnesses: ['prime', 'omp'],
      telemetry: false, askUserEnabled: false, disabledProviders: ['openai', 'google'], disabledModels: ['openai/gpt-5.6'], ompDisabledProviders: ['anthropic'],
      ompDisabledModels: ['anthropic/claude-sonnet-4'], piDisabledModels: ['openai/gpt-5.6-codex'],
      activeHarness: 'omp', ompApprovalMode: 'always-ask', petEnabled: true, petId: 'codex/rocky', petSize: 65,
      voiceTranscriptionProvider: 'groq', voiceSelfHostedUrl: 'https://speech.example.test/v1', voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3', voiceRealtimeProvider: 'openai-codex', voiceRealtimeVoice: 'cedar',
    })
    expect(service.get()).toEqual(next)
  })

  it('leaves unrelated settings untouched on a partial patch', async () => {
    const service = makeService()
    const before = service.get()
    const next = await service.update({ theme: 'light' })
    expect(next.theme).toBe('light')
    expect(next.sidebarOpen).toBe(before.sidebarOpen)
    expect(next.terminalShell).toBe(before.terminalShell)
  })

  it('rejects unknown keys, invalid enums, and malformed values without persisting', async () => {
    const service = makeService()
    const before = service.get()
    await expect(service.update({ nope: true })).rejects.toThrow(/not supported/)
    await expect(service.update('dark')).rejects.toThrow(/must be an object/)
    await expect(service.update({ theme: 'solarized' })).rejects.toThrow(/Invalid theme/)
    await expect(service.update({ locale: 'fr' })).rejects.toThrow(/Invalid locale/)
    await expect(service.update({ interfaceFontScale: 111 })).rejects.toThrow(/Invalid interface font scale/)
    await expect(service.update({ defaultInspectorTab: 'tools' })).rejects.toThrow(/Invalid inspector tab/)
    await expect(service.update({ messageEnterAction: 'send' })).rejects.toThrow(/Invalid message Enter action/)
    await expect(service.update({ runtimePaths: { prime: 'relative/prime-agent', omp: '', pi: '' } })).rejects.toThrow(/must be absolute/)
    await expect(service.update({ runtimePaths: { prime: '/opt/prime-agent', omp: '', pi: '', extra: '/tmp/evil' } })).rejects.toThrow(/not supported/)
    await expect(service.update({ enabledHarnesses: [] })).rejects.toThrow(/At least one harness/)
    await expect(service.update({ enabledHarnesses: ['prime', 'codex'] })).rejects.toThrow(/is invalid/)
    await expect(service.update({ sidebarOpen: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ keepRunningInBackground: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ launchAtLogin: 1 })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ askUserEnabled: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ browserHome: 'javascript:alert(1)' })).rejects.toThrow(/scheme/)
    await expect(service.update({ disabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ disabledProviders: Array.from({ length: 129 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ disabledModels: ['../evil'] })).rejects.toThrow(/model key/)
    await expect(service.update({ disabledModels: Array.from({ length: 5_001 }, () => 'openai/gpt') })).rejects.toThrow(/bounded/)
    await expect(service.update({ ompDisabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ ompDisabledProviders: Array.from({ length: 257 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ ompDisabledModels: ['missing-slash'] })).rejects.toThrow(/model key/)
    await expect(service.update({ piDisabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ piDisabledProviders: Array.from({ length: 257 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ piDisabledModels: ['provider/model with spaces'] })).rejects.toThrow(/model key/)
    await expect(service.update({ activeHarness: 'codex' })).rejects.toThrow(/Invalid harness/)
    await expect(service.update({ ompApprovalMode: 'sudo' })).rejects.toThrow(/Invalid OMP approval mode/)
    await expect(service.update({ petId: '../escape' })).rejects.toThrow(/Invalid pet id/)
    await expect(service.update({ petSize: 49 })).rejects.toThrow(/integer from 50 to 125/)
    await expect(service.update({ voiceTranscriptionProvider: 'carrier-pigeon' })).rejects.toThrow(/Invalid voice transcription provider/)
    await expect(service.update({ voiceRealtimeProvider: 'whichever-works' })).rejects.toThrow(/Invalid realtime voice provider/)
    await expect(service.update({ voiceRealtimeModel: '../bad model' })).rejects.toThrow(/not valid/)
    await expect(service.update({ voiceSelfHostedUrl: 'ftp://speech.example.test' })).rejects.toThrow(/scheme/)
    await expect(service.update({ voiceSelfHostedUrl: 'http://8.8.8.8:9000' })).rejects.toThrow(/use HTTPS for public hosts/)
    await expect(service.update({ voiceSelfHostedUrl: 'https://user:secret@speech.example.test' })).rejects.toThrow(/credentials/)
    await expect(service.update({ voiceSelfHostedUrl: 'https://speech.example.test/#secret' })).rejects.toThrow(/query or fragment/)
    await expect(service.update({ voiceSelfHostedModel: '../bad model' })).rejects.toThrow(/not valid/)
    expect(service.get()).toEqual(before)
  })

  it('accepts loopback HTTP and remote HTTPS self-hosted transcription servers', async () => {
    const service = makeService()
    await expect(service.update({ voiceTranscriptionProvider: 'self-hosted', voiceSelfHostedUrl: 'http://127.0.0.1:9000', voiceSelfHostedModel: 'mlx-community/whisper-large-v3' })).resolves.toMatchObject({
      voiceTranscriptionProvider: 'self-hosted',
      voiceSelfHostedUrl: 'http://127.0.0.1:9000/',
      voiceSelfHostedModel: 'mlx-community/whisper-large-v3',
    })
    await expect(service.update({ voiceSelfHostedUrl: 'https://speech.example.test/v1' })).resolves.toMatchObject({ voiceSelfHostedUrl: 'https://speech.example.test/v1' })
  })

  it('accepts the pi harness and dedupes piDisabledProviders', async () => {
    const service = makeService()
    const next = await service.update({ activeHarness: 'pi', piDisabledProviders: ['openai', 'openai', 'anthropic'] })
    expect(next.activeHarness).toBe('pi')
    expect(next.piDisabledProviders).toEqual(['openai', 'anthropic'])
  })

  it('keeps the active harness independent from the legacy enabled set', async () => {
    const service = makeService()
    const onlyPi = await service.update({ enabledHarnesses: ['pi'] })
    expect(onlyPi.enabledHarnesses).toEqual(['pi'])
    expect(onlyPi.activeHarness).toBe('omp')

    const stillPi = await service.update({ enabledHarnesses: ['prime', 'pi'] })
    expect(stillPi.activeHarness).toBe('omp')

    const fallback = await service.update({ enabledHarnesses: ['prime'] })
    expect(fallback.activeHarness).toBe('omp')
  })

  it('routes terminalShell through the injected shell validator', async () => {
    const validateShell = vi.fn(() => '/bin/bash')
    const service = makeService(validateShell)
    const next = await service.update({ terminalShell: '/bin/bash' })
    expect(validateShell).toHaveBeenCalledWith('/bin/bash')
    expect(next.terminalShell).toBe('/bin/bash')
    validateShell.mockImplementation(() => { throw new TypeError('shell is not allowed') })
    await expect(service.update({ terminalShell: '/tmp/evil' })).rejects.toThrow(/not allowed/)
  })

  it('reports the persisted previous and next settings to lifecycle integrations', async () => {
    const onDidUpdate = vi.fn()
    const service = makeService(undefined, onDidUpdate)
    const before = service.get()
    const next = await service.update({ keepRunningInBackground: true })
    expect(onDidUpdate).toHaveBeenCalledWith(before, next)
    expect(next.keepRunningInBackground).toBe(true)
  })
})
