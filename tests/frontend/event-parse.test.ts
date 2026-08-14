import { describe, expect, it } from 'vitest'
import { agentMessagePart, record, resultText, string } from '../../src/lib/events/parse'

describe('raw event coercion', () => {
  it('narrows records and strings', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record([1, 2])).toEqual([1, 2])
    expect(record(null)).toBeUndefined()
    expect(record('text')).toBeUndefined()
    expect(record(undefined)).toBeUndefined()
    expect(string('text')).toBe('text')
    expect(string(7)).toBeUndefined()
  })
})

describe('resultText', () => {
  it('returns strings and the preferred record fields in order', () => {
    expect(resultText('done')).toBe('done')
    expect(resultText({ output: 'from output', text: 'from text' })).toBe('from output')
    expect(resultText({ text: 'from text' })).toBe('from text')
  })

  it('joins text content blocks and skips other block types', () => {
    expect(resultText({ content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'x' }, { type: 'text', text: 'second' }] })).toBe('first\nsecond')
    expect(resultText({ content: [{ type: 'text', text: '' }, 'not a block'] })).toBe('')
  })

  it('falls back to pretty JSON for other shapes and to String for unserializable ones', () => {
    expect(resultText({ status: 'ok' })).toBe('{\n  "status": "ok"\n}')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(resultText(circular)).toBe('[object Object]')
  })

  it('returns an empty string for values that are neither strings nor records', () => {
    expect(resultText(undefined)).toBe('')
    expect(resultText(null)).toBe('')
    expect(resultText(42)).toBe('')
  })
})

describe('agentMessagePart', () => {
  it('reads the message text and the sending session name', () => {
    expect(agentMessagePart({ customType: 'agent_message', details: { message: 'ready', from: { sessionName: 'Planner' } } }))
      .toEqual({ type: 'agentMessage', text: 'ready', agentName: 'Planner' })
  })

  it('falls back to the raw content and tolerates a missing sender', () => {
    expect(agentMessagePart({ customType: 'agent_message', content: 'inline text' })).toEqual({ type: 'agentMessage', text: 'inline text', agentName: undefined })
    expect(agentMessagePart({ customType: 'agent_message', details: { from: 'Planner' } })).toEqual({ type: 'agentMessage', text: '', agentName: undefined })
  })

  it('ignores parts that are not agent messages', () => {
    expect(agentMessagePart({ customType: 'tool_call' })).toBeUndefined()
    expect(agentMessagePart({})).toBeUndefined()
  })
})
