const PLAIN_HTTP_HOST = /^(?:localhost|(?:[a-z\d-]+\.)+localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:[/?#]|$)/i

/** Normalize address-bar input; callers still enforce the shared navigation policy. */
export function normalizeBrowserAddress(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  // Preserve explicit schemes for admission to reject, rather than sending
  // potentially sensitive local paths or credentials to the search engine.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[^/:?#]+:\d+(?:[/?#]|$)/.test(trimmed)) return trimmed
  if (PLAIN_HTTP_HOST.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
