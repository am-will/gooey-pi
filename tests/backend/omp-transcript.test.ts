import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OMP_TITLE_SLOT_BYTES, readOmpTranscript } from '../../electron/main/sessions/omp'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function titleSlot(title = ''): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-08T02:12:49.414Z', pad: '' })
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-08T02:12:49.414Z', pad: ' '.repeat(OMP_TITLE_SLOT_BYTES - 1 - Buffer.byteLength(unpadded, 'utf8')) })
}

function ompSessionFile(entries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-omp-transcript-'))
  dirs.push(dir)
  const file = join(dir, '2026-08-08T02-12-49-414Z_019fdf24-f686-7000-86fd-e1eaf84626c6.jsonl')
  writeFileSync(file, [
    titleSlot(),
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-f686-7000-86fd-e1eaf84626c6', timestamp: '2026-08-08T02:12:49.414Z', cwd: '/tmp' }),
    ...entries,
    '',
  ].join('\n'))
  return file
}

function userEntry(id: string, parentId: string | null, text = `text-${id}`): string {
  return JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-08-08T02:13:00.000Z', message: { role: 'user', content: text } })
}

describe('OMP transcript branch walk', () => {
  it('renders only the branch ending at the last entry when the active leaf is not the first branch', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'root prompt'),
      userEntry('aa000002', 'aa000001', 'first branch, abandoned'),
      userEntry('aa000003', 'aa000002', 'first branch continues'),
      userEntry('bb000001', 'aa000001', 'second branch'),
      userEntry('bb000002', 'bb000001', 'active leaf'),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['aa000001', 'bb000001', 'bb000002'])
    expect(transcript.at(-1)?.parts).toEqual([{ type: 'text', text: 'active leaf' }])
  })

  it('walks through non-renderable config entries without letting them anchor the leaf', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'question'),
      JSON.stringify({ type: 'model_change', id: 'aa000002', parentId: 'aa000001', timestamp: '2026-08-08T02:13:01.000Z', model: 'anthropic/claude-opus-4-8' }),
      JSON.stringify({ type: 'message', id: 'aa000003', parentId: 'aa000002', timestamp: '2026-08-08T02:13:02.000Z', message: { role: 'assistant', content: 'answer' } }),
      JSON.stringify({ type: 'thinking_level_change', id: 'aa000004', parentId: 'aa000003', timestamp: '2026-08-08T02:13:03.000Z', thinkingLevel: 'high' }),
      JSON.stringify({ type: 'credential_pin', id: 'aa000005', parentId: 'aa000004', timestamp: '2026-08-08T02:13:04.000Z', provider: 'anthropic', hash: 'ffff' }),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => [message.id, message.role])).toEqual([
      ['aa000001', 'user'],
      ['aa000003', 'assistant'],
    ])
  })

  it('merges assistant tool calls with toolResult replies like the prime walk', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'run the tool'),
      JSON.stringify({ type: 'message', id: 'aa000002', parentId: 'aa000001', message: { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
      ] } }),
      JSON.stringify({ type: 'message', id: 'aa000003', parentId: 'aa000002', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: 'listing' } }),
      JSON.stringify({ type: 'message', id: 'aa000004', parentId: 'aa000003', message: { role: 'assistant', content: 'done' } }),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(transcript[1]?.parts).toEqual([
      { type: 'text', text: 'calling' },
      { type: 'toolCall', id: 'call-1', name: 'bash', args: { command: 'ls' } },
      { type: 'toolResult', name: 'bash', text: 'listing', isError: false },
      { type: 'text', text: 'done' },
    ])
  })
})

describe('OMP transcript system entries', () => {
  it('renders fallback model changes while leaving ordinary model changes out of the active branch', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'before fallback'),
      JSON.stringify({ type: 'model_change', id: 'aa000002', parentId: 'aa000001', timestamp: '2026-08-08T02:14:00.000Z', model: 'anthropic/claude-sonnet', resolvedModelIsFallback: true }),
      JSON.stringify({ type: 'message', id: 'aa000003', parentId: 'aa000002', timestamp: '2026-08-08T02:14:01.000Z', message: { role: 'assistant', content: 'continued response' } }),
      JSON.stringify({ type: 'model_change', id: 'aa000004', parentId: 'aa000003', timestamp: '2026-08-08T02:14:02.000Z', model: 'anthropic/claude-haiku', role: 'default' }),
      JSON.stringify({ type: 'model_change', id: 'aa000005', parentId: 'aa000004', timestamp: '2026-08-08T02:14:03.000Z', model: 'anthropic/claude-haiku', role: 'compaction' }),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => [message.id, message.role])).toEqual([
      ['aa000001', 'user'],
      ['aa000002', 'system'],
      ['aa000003', 'assistant'],
    ])
    expect(transcript[1]).toMatchObject({
      timestamp: '2026-08-08T02:14:00.000Z',
      parts: [{ type: 'text', text: 'Switched to anthropic/claude-sonnet due to a provider fallback' }],
    })
  })

  it('renders branch_summary entries as readable system messages in branch position', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'before the branch'),
      JSON.stringify({ type: 'branch_summary', id: 'aa000002', parentId: 'aa000001', timestamp: '2026-08-08T02:14:00.000Z', summary: 'The abandoned branch explored an alternative fix.' }),
      userEntry('aa000003', 'aa000002', 'after the branch'),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => message.role)).toEqual(['user', 'system', 'user'])
    expect(transcript[1]).toMatchObject({
      id: 'aa000002',
      timestamp: '2026-08-08T02:14:00.000Z',
      parts: [{ type: 'text', text: 'The abandoned branch explored an alternative fix.' }],
    })
  })

  it('renders compaction entries and displayed custom messages, skipping undisplayed ones', async () => {
    const file = ompSessionFile([
      userEntry('aa000001', null, 'long conversation'),
      JSON.stringify({ type: 'compaction', id: 'aa000002', parentId: 'aa000001', timestamp: '2026-08-08T02:14:00.000Z', summary: 'Earlier work, summarized.', tokensBefore: 120_000, firstKeptEntryId: 'aa000001' }),
      JSON.stringify({ type: 'custom_message', id: 'aa000003', parentId: 'aa000002', customType: 'session_note', content: 'internal-only note' }),
      JSON.stringify({ type: 'custom_message', id: 'aa000004', parentId: 'aa000003', customType: 'session_note', display: true, content: 'A note worth showing.' }),
    ])

    const transcript = await readOmpTranscript(file, false)
    expect(transcript.map((message) => [message.id, message.role])).toEqual([
      ['aa000001', 'user'],
      ['aa000002', 'system'],
      ['aa000004', 'tool'],
    ])
    expect(transcript[1]?.parts[0]).toMatchObject({ type: 'compaction', status: 'done', summary: 'Earlier work, summarized.', tokensBefore: 120_000 })
    expect(transcript[2]?.parts).toEqual([
      { type: 'toolCall', id: 'aa000004', name: 'Session Note' },
      { type: 'toolResult', name: 'Session Note', text: 'A note worth showing.' },
    ])
  })
})
