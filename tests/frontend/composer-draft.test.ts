// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  composerDraftStorageKey,
  readComposerDraft,
  saveComposerDraft,
  takeComposerDraft,
} from '../../src/lib/composer-draft'

afterEach(() => {
  window.sessionStorage.clear()
})

describe('composer draft storage', () => {
  it('round-trips text and model selection for a workspace scope', () => {
    saveComposerDraft('project:new', { text: 'Ship the sidebar', model: 'openai:gpt-5.2', effort: 'high', fast: true })
    expect(readComposerDraft('project:new')).toEqual({
      text: 'Ship the sidebar',
      model: 'openai:gpt-5.2',
      effort: 'high',
      fast: true,
    })
    expect(window.sessionStorage.getItem(composerDraftStorageKey('other'))).toBeNull()
  })

  it('clears a sent draft without leaking another workspace', () => {
    saveComposerDraft('project:new', { text: 'keep me', model: 'openai:gpt-5.2' })
    saveComposerDraft('project:session', { text: 'other' })
    clearComposerDraft('project:new')
    expect(readComposerDraft('project:new')).toBeNull()
    expect(readComposerDraft('project:session')).toEqual({ text: 'other' })
  })

  it('falls back to the crash snapshot when a scoped draft is missing', () => {
    window.sessionStorage.setItem('prime-work.composer-draft', 'recovered after crash')
    expect(readComposerDraft('project:new')).toEqual({ text: 'recovered after crash' })
    expect(takeComposerDraft()).toBe('recovered after crash')
    expect(takeComposerDraft()).toBe('')
  })
})
