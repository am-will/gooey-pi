import { record, string } from './parse'

export interface FallbackModel {
  provider?: string
  id: string
  label: string
}

export function fallbackModelFromRecord(value: unknown): FallbackModel | null {
  const event = record(value)
  if (!event) return null
  const type = string(event.type)
  if (type !== 'model_change' && type !== 'model_changed') return null
  const role = string(event.role)
  if (role && role !== 'fallback') return null
  if (role !== 'fallback' && event.resolvedModelIsFallback !== true) return null

  const singleModel = string(event.model)?.trim()
  let provider: string | undefined
  let id: string | undefined
  if (singleModel) {
    const separator = singleModel.indexOf('/')
    if (separator > 0) {
      provider = singleModel.slice(0, separator).trim() || undefined
      id = singleModel.slice(separator + 1).trim() || undefined
    } else {
      id = singleModel
    }
  } else {
    provider = string(event.provider)?.trim() || undefined
    id = string(event.modelId)?.trim() || undefined
  }
  if (!id) return null
  return { provider, id, label: provider ? `${provider}/${id}` : id }
}

export function fallbackNoticeText(label: string): string {
  return `Switched to ${label} due to a provider fallback`
}
