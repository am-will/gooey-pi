export interface ComposerDraftSnapshot {
  text: string
  model?: string
  effort?: string
  fast?: boolean
}

const COMPOSER_DRAFT_PREFIX = 'prime-work.composer-draft.v2:'

export function composerDraftStorageKey(scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${scope}`
}

/** Model, effort, and fast mode ride along with typed text; alone they are not a draft. */
function emptyDraft(snapshot: ComposerDraftSnapshot): boolean {
  return !snapshot.text
}

/** Snapshot the composer's current DOM value so a crash-and-reload keeps the draft. */
export function saveComposerDraftFromDom(): void {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    const scope = textarea?.closest<HTMLElement>('[data-draft-scope]')?.dataset.draftScope
    if (scope && textarea?.value) saveComposerDraft(scope, { text: textarea.value })
  } catch { /* storage unavailable */ }
}

export function saveComposerDraft(scope: string, snapshot: ComposerDraftSnapshot): void {
  try {
    const key = composerDraftStorageKey(scope)
    const previous = readComposerDraft(scope)
    const next: ComposerDraftSnapshot = {
      text: snapshot.text,
      model: snapshot.model || previous?.model,
      effort: snapshot.effort ?? previous?.effort,
      fast: snapshot.fast ?? previous?.fast,
    }
    if (emptyDraft(next)) {
      window.sessionStorage.removeItem(key)
      return
    }
    window.sessionStorage.setItem(key, JSON.stringify(next))
  } catch { /* storage unavailable */ }
}

/**
 * Puts back the draft of a send that failed after its composer unmounted,
 * unless the scope already holds a newer draft typed since.
 */
export function restoreComposerDraft(scope: string, snapshot: ComposerDraftSnapshot): void {
  try {
    // The scoped key only, not the crash snapshot another scope may have written.
    if (window.sessionStorage.getItem(composerDraftStorageKey(scope))) return
  } catch { return }
  saveComposerDraft(scope, snapshot)
}

export function readComposerDraft(scope: string): ComposerDraftSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(composerDraftStorageKey(scope))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && typeof (parsed as ComposerDraftSnapshot).text === 'string') {
        return parsed as ComposerDraftSnapshot
      }
    }
    return null
  } catch {
    return null
  }
}

export function clearComposerDraft(scope: string): void {
  try {
    window.sessionStorage.removeItem(composerDraftStorageKey(scope))
  } catch { /* storage unavailable */ }
}

