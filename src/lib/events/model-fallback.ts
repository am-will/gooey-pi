export interface FallbackModel {
  provider?: string
  id: string
  label: string
  from?: string
}

export function fallbackModelFromRecord(value: unknown): FallbackModel | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : ''
  let model: unknown
  let from: string | undefined
  if (type === 'retry_fallback_applied') {
    model = event.to
    from = typeof event.from === 'string' ? event.from.trim() || undefined : undefined
  } else if (type === 'retry_fallback_succeeded') {
    model = event.model
  } else if (type === 'model_change' && event.resolvedModelIsFallback === true) {
    model = event.model
  } else {
    return null
  }
  if (typeof model !== 'string') return null
  const singleModel = model.trim()
  if (!singleModel) return null
  const separator = singleModel.indexOf('/')
  const provider = separator > 0 ? singleModel.slice(0, separator).trim() || undefined : undefined
  const id = (separator > 0 ? singleModel.slice(separator + 1) : singleModel).trim()
  if (!id) return null
  return { provider, id, label: provider ? `${provider}/${id}` : id, from }
}

const NOTICE_PREFIX = 'Switched to '
const NOTICE_SUFFIX = ' due to a provider fallback'
const NOTICE_ORIGINAL_PREFIX = ' (original: '

export function fallbackNoticeText(label: string, from?: string): string {
  return `${NOTICE_PREFIX}${label}${NOTICE_SUFFIX}${from ? `${NOTICE_ORIGINAL_PREFIX}${from})` : ''}`
}

/**
 * Recovers the notice arguments from the canonical English text.
 *
 * The desktop process composes these rows while reading a session log
 * (`electron/main/sessions/bucketed.ts`), so the renderer receives data rather
 * than a key and cannot re-derive it. `src/lib/transcript-notes.ts` maps the
 * recognised text back onto the `transcript.fallbackSwitched*` catalog entries
 * for display; anything else returns null, so harness or user text is never
 * rewritten. The template constants above stay the single source for both
 * directions.
 */
export function fallbackNoticeFromText(text: string): { label: string; from?: string } | null {
  if (!text.startsWith(NOTICE_PREFIX)) return null
  const rest = text.slice(NOTICE_PREFIX.length)
  const originalIndex = rest.indexOf(NOTICE_ORIGINAL_PREFIX)
  const body = originalIndex === -1 ? rest : rest.slice(0, originalIndex)
  if (!body.endsWith(NOTICE_SUFFIX)) return null
  const label = body.slice(0, -NOTICE_SUFFIX.length)
  if (!label) return null
  if (originalIndex === -1) return { label }
  const original = rest.slice(originalIndex + NOTICE_ORIGINAL_PREFIX.length)
  if (!original.endsWith(')') || original.length < 2) return null
  return { label, from: original.slice(0, -1) }
}
