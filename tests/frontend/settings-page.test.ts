import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { confirmedPanelSettings } from '../../src/lib/settings-state'
import { SETTINGS_FIELD_SECTIONS } from '../../src/pages/settings/contracts'
import {
  browserHomeValidation,
  createDraftState,
  normalizeBrowserHome,
  reduceDraftState,
  terminalShellValidation,
} from '../../src/pages/settings/draft-state'

describe('settings draft synchronization', () => {
  it('keeps edits local until an explicit commit action', () => {
    const initial = createDraftState('https://old.example/')
    const edited = reduceDraftState(initial, { type: 'edit', value: 'https://new.example', error: '' })

    expect(edited.value).toBe('https://new.example')
    expect(edited.dirty).toBe(true)
    expect(edited.pending).toBeNull()

    const committing = reduceDraftState(edited, { type: 'commit', id: 1, value: 'https://new.example/' })
    expect(committing.pending).toMatchObject({ id: 1, value: 'https://new.example/' })
  })

  it('synchronizes clean drafts from committed props but does not overwrite an active edit', () => {
    const clean = reduceDraftState(createDraftState('/bin/zsh'), { type: 'sync', value: '/bin/bash' })
    expect(clean.value).toBe('/bin/bash')

    const edited = reduceDraftState(clean, { type: 'edit', value: '/bin/fish', error: '' })
    const externalUpdate = reduceDraftState(edited, { type: 'sync', value: '/bin/sh' })
    expect(externalUpdate.value).toBe('/bin/fish')
    expect(externalUpdate.baseline).toBe('/bin/sh')
    expect(externalUpdate.dirty).toBe(true)
  })

  it('preserves a rejected draft and exposes the rejection inline', () => {
    const edited = reduceDraftState(createDraftState('/bin/zsh'), { type: 'edit', value: '/not/allowed', error: '' })
    const committing = reduceDraftState(edited, { type: 'commit', id: 4, value: '/not/allowed' })
    const rejected = reduceDraftState(committing, { type: 'reject', id: 4, error: 'shell is not executable' })

    expect(rejected.value).toBe('/not/allowed')
    expect(rejected.dirty).toBe(true)
    expect(rejected.pending).toBeNull()
    expect(rejected.error).toBe('shell is not executable')
  })

  it('recognizes an optimistic prop rollback without replacing the submitted draft', () => {
    const edited = reduceDraftState(createDraftState('/bin/zsh'), { type: 'edit', value: '/bin/bash', error: '' })
    const committing = reduceDraftState(edited, { type: 'commit', id: 8, value: '/bin/bash' })
    const optimistic = reduceDraftState(committing, { type: 'sync', value: '/bin/bash' })
    const rolledBack = reduceDraftState(optimistic, { type: 'sync', value: '/bin/zsh' })
    const resolved = reduceDraftState(rolledBack, { type: 'resolve', id: 8 })

    expect(resolved.value).toBe('/bin/bash')
    expect(resolved.baseline).toBe('/bin/zsh')
    expect(resolved.dirty).toBe(true)
    expect(resolved.error).toContain('could not be saved')
  })

  it('recognizes a prop rollback that renders just after the update promise resolves', () => {
    const edited = reduceDraftState(createDraftState('/bin/zsh'), { type: 'edit', value: '/bin/bash', error: '' })
    const committing = reduceDraftState(edited, { type: 'commit', id: 9, value: '/bin/bash' })
    const optimistic = reduceDraftState(committing, { type: 'sync', value: '/bin/bash' })
    const resolved = reduceDraftState(optimistic, { type: 'resolve', id: 9 })
    const rolledBack = reduceDraftState(resolved, { type: 'sync', value: '/bin/zsh' })

    expect(rolledBack.value).toBe('/bin/bash')
    expect(rolledBack.dirty).toBe(true)
    expect(rolledBack.error).toContain('could not be saved')
  })

  it('does not let stale completion or rollback replace a newer draft', () => {
    const edited = reduceDraftState(createDraftState('/bin/zsh'), { type: 'edit', value: '/bin/bash', error: '' })
    const committing = reduceDraftState(edited, { type: 'commit', id: 7, value: '/bin/bash' })
    const newerEdit = reduceDraftState(committing, { type: 'edit', value: '/bin/fish', error: '' })
    const optimisticProp = reduceDraftState(newerEdit, { type: 'sync', value: '/bin/bash' })
    const resolved = reduceDraftState(optimisticProp, { type: 'resolve', id: 7 })
    const staleReject = reduceDraftState(resolved, { type: 'reject', id: 6, error: 'old failure' })

    expect(resolved.value).toBe('/bin/fish')
    expect(resolved.baseline).toBe('/bin/bash')
    expect(resolved.dirty).toBe(true)
    expect(staleReject).toBe(resolved)
  })

  it('keeps a newer edit while suppressing an error from the older rejected value', () => {
    const edited = reduceDraftState(createDraftState('/bin/zsh'), { type: 'edit', value: '/bad', error: '' })
    const committing = reduceDraftState(edited, { type: 'commit', id: 3, value: '/bad' })
    const newerEdit = reduceDraftState(committing, { type: 'edit', value: '/bin/bash', error: '' })
    const rejected = reduceDraftState(newerEdit, { type: 'reject', id: 3, error: 'shell is not executable' })

    expect(rejected.value).toBe('/bin/bash')
    expect(rejected.error).toBe('')
    expect(rejected.dirty).toBe(true)
  })
})


describe('queued settings reconciliation', () => {
  it('restores every pending panel field without replacing unrelated transient panel state', () => {
    const optimisticPanels = { sidebarOpen: false, inspectorOpen: true, terminalOpen: false }
    const savedAfterQueue = {
      ...DEFAULT_SETTINGS,
      sidebarOpen: true,
      inspectorOpen: false,
      terminalOpen: true,
    }
    const reconciledPanels = {
      ...optimisticPanels,
      ...confirmedPanelSettings(savedAfterQueue, ['sidebarOpen', 'terminalOpen']),
    }

    expect(reconciledPanels).toEqual({
      sidebarOpen: true,
      inspectorOpen: true,
      terminalOpen: true,
    })
  })
})

describe('free-text settings validation', () => {
  it('accepts and canonicalizes safe web homes', () => {
    expect(browserHomeValidation(' https://example.com/path ')).toBe('')
    expect(normalizeBrowserHome(' https://example.com/path ')).toBe('https://example.com/path')
  })

  it('rejects incomplete, credentialed, and non-web homes locally', () => {
    expect(browserHomeValidation('example.com')).toContain('complete')
    expect(browserHomeValidation('file:///tmp/home')).toContain('http://')
    expect(browserHomeValidation('https://user:secret@example.com')).toContain('credentials')
    expect(browserHomeValidation('')).toContain('Enter')
  })

  it('performs deterministic local shell validation before privileged validation', () => {
    expect(terminalShellValidation('/bin/zsh')).toBe('')
    expect(terminalShellValidation('bin/zsh')).toContain('absolute')
    expect(terminalShellValidation('')).toContain('Enter')
    expect(terminalShellValidation(`/bin/zsh\0suffix`)).toContain('NUL')
  })
})

describe('settings field ownership', () => {
  it('assigns every AppSettings field to a focused section', () => {
    expect(SETTINGS_FIELD_SECTIONS).toEqual({
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
      lastSelectedModels: 'providers',
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
    })
  })
})
