import { MarkdownText } from '@/components/MarkdownText'
import { ActivityMessage, UserMessage } from '@/components/transcript/messages'
import { SyntaxText } from '@/components/transcript/syntax'
import { useI18n } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import type { MessagePart, TranscriptMessage } from '@/types/api'

type ToolCall = Extract<MessagePart, { type: 'toolCall' }>

function ChildTool({ call, result }: { call?: ToolCall; result?: Extract<MessagePart, { type: 'toolResult' }> }) {
  const { t } = useI18n()
  const input = call?.args === undefined ? '' : typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)
  return <details className="child-history-tool">
    <summary>{call?.name ?? result?.name ?? t('transcript.toolFallback')}{result?.isError ? ` · ${t('transcript.state.failed')}` : ''}</summary>
    {input ? <section><h4>{t('children.toolInput')}</h4><pre><SyntaxText text={boundText(input, 200_000, `\n${t('transcript.truncatedOutput')}`)} /></pre></section> : null}
    {result ? <section><h4>{t('children.toolOutput')}</h4><pre><SyntaxText text={boundText(result.text, 200_000, `\n${t('transcript.truncatedOutput')}`)} /></pre></section> : <p>{t('children.waitingTool')}</p>}
  </details>
}

/** Read-only child activity keeps available reasoning and tool details alongside the reply. */
export function ChildHistoryMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useI18n()
  if (message.role === 'user') return <UserMessage message={message} />
  if (message.role !== 'assistant') return <ActivityMessage message={message} harness="omp" />
  return <article className="child-history-message">
    <h3>{t('children.assistant')}</h3>
    {message.parts.map((part, index) => {
      const key = part.partId ?? `${part.type}-${index}`
      if (part.type === 'text') return <MarkdownText key={key} text={boundText(part.text, 200_000, `\n${t('transcript.truncatedOutput')}`)} streaming={message.streaming} />
      if (part.type === 'thinking') return <details key={key} className="child-history-thinking" open><summary>{t('children.thinking')}</summary><MarkdownText text={boundText(part.text, 40_000, `\n${t('transcript.truncatedReasoning')}`)} /></details>
      if (part.type === 'toolCall') {
        const next = message.parts[index + 1]
        return <ChildTool key={key} call={part} result={next?.type === 'toolResult' ? next : undefined} />
      }
      if (part.type === 'toolResult') return message.parts[index - 1]?.type === 'toolCall' ? null : <ChildTool key={key} result={part} />
      return <ActivityMessage key={key} message={{ ...message, role: 'tool', parts: [part] }} harness="omp" />
    })}
  </article>
}
