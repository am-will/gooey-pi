import { Fragment } from 'react'
import { tokenizeSyntaxText, type SyntaxTokenKind } from '@/lib/syntax-text'

export interface SyntaxToken {
  kind: SyntaxTokenKind
  text: string
}

// Bound styled fragments even though the shared tokenizer scans the admitted
// 200k-character tool output once for classification.
export const MAX_SYNTAX_HIGHLIGHTS = 10_000

export function tokenizeSyntax(text: string): SyntaxToken[] {
  const tokens = tokenizeSyntaxText(text)
  const bounded: SyntaxToken[] = []
  let highlights = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'plain') {
      if (highlights >= MAX_SYNTAX_HIGHLIGHTS) {
        bounded.push({ kind: 'plain', text: text.slice(token.start) })
        break
      }
      highlights += 1
    }
    const previous = bounded.at(-1)
    if (token.kind === 'plain' && previous?.kind === 'plain') previous.text += token.text
    else bounded.push({ kind: token.kind, text: token.text })
  }
  return bounded
}

export function SyntaxText({ text }: { text: string }) {
  return <>{tokenizeSyntax(text).map((token, index) => (
    <span className={token.kind === 'plain' ? undefined : `syntax-${token.kind}`} key={`${index}-${token.text.slice(0, 8)}`}>{token.text}</span>
  ))}</>
}

export function InlineText({ text }: { text: string }) {
  const lines = text.split('\n')
  return <>{lines.map((line, lineIndex) => (
    <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>
      {line.split(/(`[^`]+`)/g).map((fragment, index) => fragment.startsWith('`') && fragment.endsWith('`')
        ? <code key={index}>{fragment.slice(1, -1)}</code>
        : <Fragment key={index}>{fragment}</Fragment>)}
      {lineIndex < lines.length - 1 ? <br /> : null}
    </Fragment>
  ))}</>
}
