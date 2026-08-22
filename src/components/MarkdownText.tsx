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

const RTL_STRONG_CHARACTER = /[\u05D0-\u05EA\u05F0-\u05F2\u0621-\u064A\u066E-\u066F\u0671-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFC]/u
const LTR_STRONG_CHARACTER = /\p{Letter}/u

/**
 * Removes Markdown code from direction detection: code often starts an
 * otherwise RTL answer, but it must always retain its own LTR rendering.
 */
function proseForDirection(text: string): string {
  let fence: string | undefined
  return text.split('\n').map((line) => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!fence && opening) {
      fence = opening[1]
      return ''
    }
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
      if (closing.test(line)) fence = undefined
      return ''
    }
    return line.replace(/`[^`\n]*`/g, '')
  }).join('\n')
}

/** Find the first strong prose character, defaulting neutral-only text to LTR. */
export function markdownTextDirection(text: string): 'ltr' | 'rtl' {
  for (const character of proseForDirection(text)) {
    if (RTL_STRONG_CHARACTER.test(character)) return 'rtl'
    if (LTR_STRONG_CHARACTER.test(character)) return 'ltr'
  }
  return 'ltr'
}

const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => href && (/^(https?:|mailto:|#)/i.test(href))
    ? <a {...props} href={href} rel="noreferrer" onClick={(event) => openMarkdownLink(event, href)}><bdi>{children}</bdi></a>
    : <span className="markdown-link-unsupported" title={href ? `Project-relative link: ${href}` : undefined}>{children}</span>,
  code: ({ node: _node, children, ...props }) => <code {...props} dir="ltr">{children}</code>,
  img: ({ alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
  pre: ({ node: _node, children, ...props }) => <pre {...props} dir="ltr">{children}</pre>,
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
  return <div className="prose" dir={markdownTextDirection(parsedText)}>{markdown}</div>
})
