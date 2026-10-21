// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  composerDraftStorageKey,
  composerDraftScope,
  readComposerDraft,
  restoreComposerDraft,
  saveComposerDraft,
  saveComposerDraftFromDom,
} from '../../src/lib/composer-draft'

afterEach(() => {
  window.sessionStorage.clear()
})

describe('composer draft storage', () => {
  it('defines the shared project/new-session scope without changing persisted keys', () => {
    expect(composerDraftScope('project')).toBe('project:new')
    expect(composerDraftScope('project', 'session')).toBe('project:session')
    expect(composerDraftScope(undefined, '')).toBe('no-project:new')
  })

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

  it('restores a failed draft only into an empty scope, ignoring another scope\'s crash snapshot', () => {
    saveComposerDraft('project:other', { text: 'typed elsewhere' })
    restoreComposerDraft('project:session', { text: 'failed send', model: 'openai:gpt-5.2' })
    expect(readComposerDraft('project:session')).toEqual({ text: 'failed send', model: 'openai:gpt-5.2' })

    saveComposerDraft('project:session', { text: 'typed since' })
    restoreComposerDraft('project:session', { text: 'failed send' })
    expect(readComposerDraft('project:session')?.text).toBe('typed since')
  })

  it('preserves unowned legacy text without importing it into any scope', () => {
    window.sessionStorage.setItem('prime-work.composer-draft', 'recovered after crash')
    expect(readComposerDraft('project:new')).toBeNull()
    saveComposerDraft('project:other', { text: 'other draft' })
    clearComposerDraft('project:other')
    expect(window.sessionStorage.getItem('prime-work.composer-draft')).toBe('recovered after crash')
    expect(readComposerDraft('project:new')).toBeNull()
  })

  it('writes crash DOM snapshots only into their matching scope', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div data-draft-scope="project:session" class="composer"><textarea>unsaved edit</textarea></div>'
    document.body.append(host)
    saveComposerDraftFromDom()
    host.remove()
    expect(readComposerDraft('project:session')?.text).toBe('unsaved edit')
    expect(readComposerDraft('project:other')).toBeNull()
  })
})
