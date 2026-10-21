import { isAbsolutePathForPlatform } from '@/lib/platform-paths'
import { formattingLocaleTag, translate, type MessageKey } from '@/lib/i18n'

// This reducer and its validators run outside React, so they resolve their copy
// through the interface locale mirrored by the i18n provider. Callers keep
// receiving plain strings, which lets server error text and these messages share
// the same `DraftState.error` field. English output is unchanged.
const copy = (key: MessageKey): string => translate(formattingLocaleTag(), key)

export interface DraftCommit {
  id: number
  value: string
  baseline: string
  revision: number
}

export interface DraftState {
  value: string
  source: string
  baseline: string
  dirty: boolean
  revision: number
  pending: DraftCommit | null
  error: string
}

export type DraftAction =
  | { type: 'sync'; value: string }
  | { type: 'edit'; value: string; error: string }
  | { type: 'commit'; id: number; value: string }
  | { type: 'resolve'; id: number }
  | { type: 'reject'; id: number; error: string }

export function createDraftState(value: string): DraftState {
  return { value, source: value, baseline: value, dirty: false, revision: 0, pending: null, error: '' }
}

export function reduceDraftState(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'sync': {
      if (state.pending) return { ...state, source: action.value }
      if (!state.dirty) return { ...state, value: action.value, source: action.value, baseline: action.value }
      if (action.value === state.value) {
        return { ...state, source: action.value, baseline: action.value, dirty: false }
      }
      return { ...state, source: action.value, baseline: action.value, dirty: true }
    }
    case 'edit': {
      const revision = state.revision + 1
      return {
        ...state,
        value: action.value,
        dirty: action.value !== state.baseline,
        revision,
        error: action.error,
      }
    }
    case 'commit':
      return {
        ...state,
        pending: { id: action.id, value: action.value, baseline: state.baseline, revision: state.revision },
        error: '',
      }
    case 'resolve': {
      if (state.pending?.id !== action.id) return state
      const submitted = state.pending
      const committed = state.source !== submitted.baseline ? state.source : submitted.value
      if (state.revision === submitted.revision) {
        return {
          ...state,
          value: committed,
          baseline: committed,
          dirty: false,
          pending: null,
          error: '',
        }
      }
      return {
        ...state,
        baseline: committed,
        dirty: state.value !== committed,
        pending: null,
        error: '',
      }
    }
    case 'reject': {
      if (state.pending?.id !== action.id) return state
      const isCurrentDraft = state.revision === state.pending.revision
      return {
        ...state,
        baseline: state.pending.baseline,
        dirty: state.value !== state.pending.baseline,
        pending: null,
        error: isCurrentDraft ? action.error : '',
      }
    }
  }
}

export function browserHomeValidation(value: string): string {
  if (value.trim().length === 0) return copy('settings.draft.homeRequired')
  if (value.trim().length > 8192) return copy('settings.draft.homeTooLong')
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return copy('settings.draft.homeInvalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return copy('settings.draft.homeProtocol')
  if (parsed.username || parsed.password) return copy('settings.draft.homeCredentials')
  return ''
}

export function normalizeBrowserHome(value: string): string {
  return new URL(value.trim()).toString()
}

export function terminalShellValidation(value: string, platform: NodeJS.Platform = 'darwin'): string {
  if (value.length === 0) return copy('settings.draft.shellRequired')
  if (value.includes('\0')) return copy('settings.draft.shellNul')
  if (value.length > 4096) return copy('settings.draft.shellTooLong')
  if (!isAbsolutePathForPlatform(value, platform)) return copy('settings.draft.shellAbsolute')
  return ''
}
