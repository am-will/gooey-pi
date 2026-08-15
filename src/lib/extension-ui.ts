export interface ExtensionUiQuestionnaireMeta {
  groupId: string
  index: number
  total: number
}

export interface ExtensionUiQuestion {
  id: string
  title: string
  options: string[]
  index: number
}

export interface ExtensionUiQuestionnaireRequest {
  method: 'questionnaire'
  id: string
  title: string
  questions: ExtensionUiQuestion[]
  total: number
  complete: boolean
  timeout?: number
}

export type ExtensionUiRequest =
  | { method: 'select'; id: string; title: string; options: string[]; timeout?: number; questionnaire?: ExtensionUiQuestionnaireMeta }
  | { method: 'confirm'; id: string; title: string; message: string; timeout?: number }
  | { method: 'input'; id: string; title: string; placeholder?: string; timeout?: number }
  | { method: 'editor'; id: string; title: string; prefill?: string }
  | ExtensionUiQuestionnaireRequest

const MAX_TITLE_LENGTH = 4_000
const MAX_OPTION_LENGTH = 500
const MAX_OPTIONS = 32
const ASK_USER_RPC_MARKER = '__prime_ask_user__'
export const ASK_USER_TIMEOUT_MS = 120_000

function stringValue(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined
}

function timeoutValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 * 60 * 1_000 ? value : undefined
}

function questionnaireMeta(value: string): ExtensionUiQuestionnaireMeta | undefined {
  if (!value.startsWith(ASK_USER_RPC_MARKER)) return undefined
  const parts = value.slice(ASK_USER_RPC_MARKER.length).split(':')
  if (parts.length !== 3) return undefined
  const [groupId, indexText, totalText] = parts
  const index = Number(indexText)
  const total = Number(totalText)
  if (!groupId || !/^[A-Za-z0-9_-]{1,80}$/.test(groupId)) return undefined
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || total > 5 || index >= total) return undefined
  return { groupId, index, total }
}

export function parseExtensionUiRequest(raw: Record<string, unknown>): ExtensionUiRequest | undefined {
  if (raw.type !== 'extension_ui_request') return undefined
  const id = stringValue(raw.id, 200)
  const title = stringValue(raw.title, MAX_TITLE_LENGTH)
  const method = raw.method
  if (!id || !title || typeof method !== 'string') return undefined

  if (method === 'select') {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > MAX_OPTIONS) return undefined
    const options = raw.options.map((option) => stringValue(option, MAX_OPTION_LENGTH))
    if (options.some((option): option is undefined => option === undefined)) return undefined
    const parsedOptions = options as string[]
    const questionnaire = questionnaireMeta(parsedOptions[0])
    const visibleOptions = questionnaire ? parsedOptions.slice(1) : parsedOptions
    if (visibleOptions.length < 1) return undefined
    return { method, id, title, options: visibleOptions, timeout: timeoutValue(raw.timeout), ...(questionnaire ? { questionnaire } : {}) }
  }
  if (method === 'confirm') {
    const message = stringValue(raw.message, MAX_TITLE_LENGTH)
    if (!message) return undefined
    return { method, id, title, message, timeout: timeoutValue(raw.timeout) }
  }
  if (method === 'input') {
    const placeholder = raw.placeholder === undefined ? undefined : stringValue(raw.placeholder, MAX_TITLE_LENGTH)
    if (raw.placeholder !== undefined && placeholder === undefined) return undefined
    return { method, id, title, placeholder, timeout: timeoutValue(raw.timeout) }
  }
  if (method === 'editor') {
    const prefill = raw.prefill === undefined ? undefined : typeof raw.prefill === 'string' && raw.prefill.length <= 32_000 ? raw.prefill : undefined
    if (raw.prefill !== undefined && prefill === undefined) return undefined
    return { method, id, title, prefill }
  }
  return undefined
}
