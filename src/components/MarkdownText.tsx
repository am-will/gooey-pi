import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalUrl } from '@/lib/desktop-actions'

interface MarkdownTextProps {
  text: string
  /** Actively streaming text throttles Markdown re-parses to a coherent committed snapshot. */
  streaming?: boolean
}

function openMarkdownLink(event: MouseEvent<HTMLAnchorElement>, href?: string): void {
  if (!href) return
  event.preventDefault()
  if (href.startsWith('#')) {
    try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' }) } catch { /* malformed fragment */ }
    return
  }
  if (!/^(https?:|mailto:)/i.test(href)) return
  if (window.prime) {
    void openExternalUrl(window.prime.app, href).then((failure) => {
      // Transcript links have no toast surface of their own; the refusal still
      // has to leave a trace instead of looking like a dead link.
      if (failure) console.error('Opening a transcript link failed:', failure)
    })
    return
  }
  window.open(href, '_blank', 'noopener,noreferrer')
}

const markdownPlugins = [remarkGfm]
const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => href && (/^(https?:|mailto:|#)/i.test(href))
    ? <a {...props} href={href} rel="noreferrer" onClick={(event) => openMarkdownLink(event, href)}>{children}</a>
    : <span className="markdown-link-unsupported" title={href ? `Project-relative link: ${href}` : undefined}>{children}</span>,
  img: ({ alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
}

export const STREAMING_PARSE_INTERVAL_MS = 100

export interface StreamingParseState {
  /** How much of the text is committed to the Markdown parser. */
  boundary: number
  lastParseAt: number
}

/**
 * Decides how much of a streaming message to hand to the Markdown parser: the
 * boundary advances at most every STREAMING_PARSE_INTERVAL_MS, or immediately
 * when the unparsed tail crossed a newline; otherwise the caller keeps the
 * previous coherent snapshot visible and retries after `delayMs`.
 */
export function advanceStreamingParse(
  state: StreamingParseState,
  textLength: number,
  newlineInTail: boolean,
  now: number,
): { state: StreamingParseState; delayMs?: number } {
  if (state.boundary >= textLength) {
    return state.boundary === textLength ? { state } : { state: { boundary: textLength, lastParseAt: now } }
  }
  const elapsed = now - state.lastParseAt
  if (newlineInTail || elapsed >= STREAMING_PARSE_INTERVAL_MS) {
    return { state: { boundary: textLength, lastParseAt: now } }
  }
  return { state, delayMs: STREAMING_PARSE_INTERVAL_MS - elapsed }
}

/** Render model-authored Markdown without enabling raw HTML or remote images. */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: MarkdownTextProps) {
  const parseStateRef = useRef<StreamingParseState>({ boundary: text.length, lastParseAt: 0 })
  const [, setParseRevision] = useState(0)

  useEffect(() => {
    if (!streaming) {
      if (parseStateRef.current.boundary !== text.length) {
        parseStateRef.current = { boundary: text.length, lastParseAt: parseStateRef.current.lastParseAt }
        setParseRevision((revision) => revision + 1)
      }
      return
    }
    const decide = (): number | undefined => {
      const current = parseStateRef.current
      const newlineInTail = text.indexOf('\n', Math.min(current.boundary, text.length)) !== -1
      const result = advanceStreamingParse(current, text.length, newlineInTail, Date.now())
      if (result.state !== current) {
        parseStateRef.current = result.state
        setParseRevision((revision) => revision + 1)
      }
      return result.delayMs
    }
    const delayMs = decide()
    if (delayMs === undefined) return
    const timer = window.setTimeout(() => { decide() }, delayMs)
    return () => window.clearTimeout(timer)
  }, [streaming, text])

  const boundary = streaming ? Math.min(parseStateRef.current.boundary, text.length) : text.length
  const parsedText = boundary === text.length ? text : text.slice(0, boundary)
  // Keep the committed Markdown subtree intact between parses. Rendering the
  // unparsed suffix as a sibling block makes punctuation and partial words
  // jump onto separate lines while tokens are still arriving.
  const markdown = useMemo(
    () => <ReactMarkdown remarkPlugins={markdownPlugins} skipHtml components={markdownComponents}>{parsedText}</ReactMarkdown>,
    [parsedText],
  )
  return <div className="prose">{markdown}</div>
})
