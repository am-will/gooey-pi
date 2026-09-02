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

export function fallbackNoticeText(label: string, from?: string): string {
  return `Switched to ${label} due to a provider fallback${from ? ` (original: ${from})` : ''}`
}
