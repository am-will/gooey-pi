import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionMetadata } from '../../electron/main/sessions/metadata'
import { readTranscript } from '../../electron/main/sessions/transcript'
import { configureGooeyPiAgentMessageSigning, encodeGooeyPiAgentMessage, loadOrCreateGooeyPiAgentMessageKey, parseGooeyPiAgentMessage } from '../../electron/main/collaboration/message-envelope'

const dirs: string[] = []
configureGooeyPiAgentMessageSigning(Buffer.alloc(32, 7))
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('session file record tolerance', () => {
  it('opens a record beyond the old 8 MiB transcript cap in both same-file readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const oversized = 'x'.repeat(9 * 1024 * 1024)
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'big-record', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, timestamp: '2026-08-07T00:01:00.000Z', message: { role: 'user', content: oversized } }),
      '',
    ].join('\n'))

    // The catalog admits this session, so the transcript reader must open it too.
    const metadata = await readSessionMetadata(file)
    expect(metadata.id).toBe('big-record')
    expect(metadata.preview?.length).toBeGreaterThan(0)

    const transcript = await readTranscript(file, false)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ id: 'user-1', role: 'user' })
  })
})

describe('GooeyPi agent messages', () => {
  it('creates and reuses an owner-only signing key in a fresh user-data directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-message-key-'))
    dirs.push(dir)
    const path = join(dir, 'fresh-user-data', 'agent-message-signing.key')
    const created = loadOrCreateGooeyPiAgentMessageKey(path)
    expect(created).toHaveLength(32)
    expect(loadOrCreateGooeyPiAgentMessageKey(path)).toEqual(created)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('persists a bounded envelope and renders it as a native agent message', async () => {
    const file = makeSessionFile()
    const envelope = encodeGooeyPiAgentMessage({
      fromSessionId: '019f0000-0000-7000-8000-000000000001',
      text: 'Please coordinate ownership before editing.',
    })
    expect(envelope).toContain('"reply_with":"gooeypi_session_send"')
    expect(envelope).not.toContain('Planner')
    expect(envelope).not.toContain('"from_title"')
    expect(envelope).not.toContain('"from_harness"')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'target', cwd: '/project' }),
      JSON.stringify({ type: 'message', id: 'peer-message', parentId: null, message: { role: 'user', content: envelope } }),
      '',
    ].join('\n'))

    expect(parseGooeyPiAgentMessage(envelope)).toEqual({
      fromSessionId: '019f0000-0000-7000-8000-000000000001',
      text: 'Please coordinate ownership before editing.',
    })
    const transcript = await readTranscript(file, false)
    expect(transcript).toEqual([expect.objectContaining({
      id: 'peer-message',
      role: 'agent',
      parts: [{ type: 'text', text: 'Please coordinate ownership before editing.' }],
    })])
  })

  it('leaves malformed envelopes as ordinary user messages', () => {
    expect(parseGooeyPiAgentMessage('===== BEGIN GOOEYPI AGENT MESSAGE =====\n{}\n===== END GOOEYPI AGENT MESSAGE =====\n\nhello')).toBeUndefined()
    const signed = encodeGooeyPiAgentMessage({ fromSessionId: 'source', text: 'authentic' })
    expect(parseGooeyPiAgentMessage(signed.replace('authentic', 'forged'))).toBeUndefined()
  })

  it('keeps signed version-1 messages readable without emitting their display metadata again', () => {
    const text = 'This message predates UUID-only envelopes.'
    const unsigned = {
      version: 1,
      from_session_id: 'legacy-source',
      from_title: 'Legacy planner title',
      from_harness: 'prime',
      reply_with: 'session_send',
      nonce: '00000000-0000-4000-8000-000000000000',
      sent_at: '2026-08-13T12:00:00.000Z',
    }
    const signature = createHmac('sha256', Buffer.alloc(32, 7))
      .update(JSON.stringify(unsigned))
      .update('\0')
      .update(text)
      .digest('base64url')
    const envelope = [
      '===== BEGIN GOOEYPI AGENT MESSAGE =====',
      JSON.stringify({ ...unsigned, signature }),
      '===== END GOOEYPI AGENT MESSAGE =====',
      '',
      text,
    ].join('\n')

    expect(parseGooeyPiAgentMessage(envelope)).toEqual({
      fromSessionId: 'legacy-source',
      fromTitle: 'Legacy planner title',
      fromHarness: 'prime',
      text,
    })
  })

  it('keeps signed version-2 messages readable and rejects mismatched reply hints', () => {
    const text = 'Versioned compatibility message.'
    const makeEnvelope = (metadata: Record<string, unknown>, message = text) => {
      const signature = createHmac('sha256', Buffer.alloc(32, 7))
        .update(JSON.stringify(metadata))
        .update('\0')
        .update(message)
        .digest('base64url')
      return [
        '===== BEGIN GOOEYPI AGENT MESSAGE =====',
        JSON.stringify({ ...metadata, signature }),
        '===== END GOOEYPI AGENT MESSAGE =====',
        '',
        message,
      ].join('\n')
    }
    const version2 = {
      version: 2,
      from_session_id: 'legacy-v2-source',
      reply_with: 'session_send',
      nonce: '00000000-0000-4000-8000-000000000001',
      sent_at: '2026-08-13T12:00:00.000Z',
    }
    expect(parseGooeyPiAgentMessage(makeEnvelope(version2))).toEqual({
      fromSessionId: 'legacy-v2-source',
      text,
    })
    expect(parseGooeyPiAgentMessage(makeEnvelope({
      ...version2,
      reply_with: 'session_send',
      version: 3,
    }))).toBeUndefined()
    expect(parseGooeyPiAgentMessage(makeEnvelope({
      ...version2,
      reply_with: 'gooeypi_session_send',
    }))).toBeUndefined()
  })
})

describe('tool result placement in assembled turns', () => {
  it('splices results after their call by id, appends unmatched results, and pairs duplicate ids with the first call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-tools-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const records = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'run tools' } }),
      JSON.stringify({ type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: [
        { type: 'text', text: 'working' },
        { type: 'toolCall', id: 'call-1', name: 'Read' },
        { type: 'toolCall', id: 'call-dup', name: 'First' },
        { type: 'toolCall', id: 'call-dup', name: 'Second' },
        { type: 'toolCall', id: 'call-2', name: 'Write' },
      ] } }),
      // Results arrive out of call order; each must land after its own call.
      JSON.stringify({ type: 'message', id: 'result-2', parentId: 'assistant-1', message: { role: 'toolResult', toolCallId: 'call-2', toolName: 'Write', content: 'wrote' } }),
      JSON.stringify({ type: 'message', id: 'result-1', parentId: 'result-2', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', content: 'read' } }),
      JSON.stringify({ type: 'message', id: 'result-dup', parentId: 'result-1', message: { role: 'toolResult', toolCallId: 'call-dup', toolName: 'First', content: 'first wins' } }),
      JSON.stringify({ type: 'message', id: 'result-lost', parentId: 'result-dup', message: { role: 'toolResult', toolCallId: 'call-missing', toolName: 'Ghost', content: 'appended' } }),
      '',
    ].join('\n')
    writeFileSync(file, records)

    const transcript = await readTranscript(file, false)
    const assistant = transcript.at(-1)
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.parts.map((part) => part.type === 'toolCall' ? `call:${part.id}` : part.type === 'toolResult' ? `result:${part.text}` : part.type)).toEqual([
      'text',
      'call:call-1',
      'result:read',
      'call:call-dup',
      'result:first wins',
      'call:call-dup',
      'call:call-2',
      'result:wrote',
      'result:appended',
    ])
  })
})

function makeSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
  dirs.push(dir)
  return join(dir, 'session.jsonl')
}

describe('transcript graph budgets', () => {
  it('does not let non-renderable records evict renderable history or break the walk', async () => {
    const file = makeSessionFile()
    const records = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'first question' } }),
      JSON.stringify({ type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'first answer' } }),
    ]
    let parent = 'assistant-1'
    for (let index = 0; index < 10_050; index += 1) {
      const id = `event-${index}`
      records.push(JSON.stringify({ type: 'event', id, parentId: parent, name: 'internal' }))
      parent = id
    }
    records.push(JSON.stringify({ type: 'message', id: 'user-2', parentId: parent, message: { role: 'user', content: 'second question' } }))
    writeFileSync(file, `${records.join('\n')}\n`)

    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
  })

  it('renders the last renderable branch when the file ends with a rootless non-renderable record', async () => {
    const file = makeSessionFile()
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'question' } }),
      JSON.stringify({ type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'answer' } }),
      JSON.stringify({ type: 'event', id: 'stray', parentId: null, name: 'housekeeping' }),
      '',
    ].join('\n'))

    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['user-1', 'assistant-1'])
  })
})

function sessionFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function userMessage(id: string, parentId: string | null, text = `text-${id}`): string {
  return JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: text } })
}

describe('persisted compaction transcript entries', () => {
  it('shares the transcript text budget across repeated compaction summaries', async () => {
    const file = makeSessionFile()
    const summary = 'S'.repeat(256 * 1024)
    const records = [JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp' })]
    let parent: string | null = null
    for (let index = 0; index < 5; index += 1) {
      records.push(JSON.stringify({ type: 'compaction', id: `compact-${index}`, parentId: parent, timestamp: '2026-08-07T00:00:00.000Z', summary }))
      parent = `compact-${index}`
    }
    writeFileSync(file, `${records.join('\n')}\n`)

    const transcript = await readTranscript(file, false)
    expect(transcript).toHaveLength(5)
    const summaryLengths = transcript.map((message) => {
      const part = message.parts[0] as { summary?: string }
      return part.summary?.length ?? 0
    })
    expect(summaryLengths.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(1024 * 1024)
    // The budget is consumed newest-first; the most recent compaction keeps its full summary.
    expect(summaryLengths.at(-1)).toBe(256 * 1024)
    expect(summaryLengths[0]).toBe(0)
  })

  it('keeps completed compaction summaries visible after a session reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, timestamp: '2026-08-07T00:01:00.000Z', message: { role: 'user', content: 'Investigate the failure' } }),
      JSON.stringify({ type: 'compaction', id: 'compact-1', parentId: 'user-1', timestamp: '2026-08-07T00:02:00.000Z', summary: 'The prior investigation was summarized.', firstKeptEntryId: 'kept-1', tokensBefore: 99_175 }),
      '',
    ].join('\n'))

    const transcript = await readTranscript(file, false)
    expect(transcript.at(-1)).toMatchObject({ role: 'system', id: 'compact-1' })
    expect(transcript.at(-1)?.parts[0]).toMatchObject({
      type: 'compaction', status: 'done', tokensBefore: 99_175, firstKeptEntryId: 'kept-1',
      summary: 'The prior investigation was summarized.',
    })
  })
})

describe('transcript graph bounds', () => {
  it('keeps the parent chain intact at exactly the record capacity', async () => {
    // 1 root + 9_998 unrelated fillers + 1 leaf = 10_000 records: no eviction.
    const fillers = Array.from({ length: 9_998 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'leaf'])
  })

  it('evicts the least recently written record one past the capacity', async () => {
    // One extra filler pushes the map to 10_001, evicting the oldest entry
    // (the root), which breaks the leaf's parent chain at the eviction point.
    const fillers = Array.from({ length: 9_999 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['leaf'])
  })

  it('refreshes recency when a record id is rewritten later in the file', async () => {
    // Re-emitting the root just before the leaf moves it to the tail of the
    // LRU map, so the same overflow now evicts a filler instead of the root.
    const fillers = Array.from({ length: 9_999 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('root', null, 'rewritten root'), userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'leaf'])
    expect(transcript[0].parts).toEqual([{ type: 'text', text: 'rewritten root' }])
  })

  it('evicts oldest records when the graph byte budget overflows', async () => {
    // Three ~7 MiB records exceed the 16 MiB graph budget, so the oldest is
    // dropped and the branch walk stops where the chain breaks.
    const big = 'x'.repeat(7 * 1024 * 1024)
    const file = sessionFile([
      userMessage('old', null, big),
      userMessage('mid', 'old', big),
      userMessage('leaf', 'mid', big),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['mid', 'leaf'])
  }, 20_000)

  it('falls back to the partial branch when the leaf references a missing parent', async () => {
    const file = sessionFile([
      userMessage('a', null),
      userMessage('b', 'a'),
      userMessage('leaf', 'not-persisted'),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['leaf'])
  })

  it('terminates on a parent cycle instead of looping', async () => {
    const file = sessionFile([userMessage('a', 'b'), userMessage('b', 'a')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['a', 'b'])
  })

  it('treats a trailing parentId null record as a new single-entry branch', async () => {
    // The branch is walked from the last record; a trailing root orphans the
    // earlier chain entirely.
    const file = sessionFile([
      userMessage('a', null),
      userMessage('b', 'a'),
      userMessage('fresh-root', null),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['fresh-root'])
  })
})

describe('transcript text budgets', () => {
  const partMax = 256 * 1024 // MAX_PART_TEXT_CHARS

  it('drops the oldest text once newer parts consume the transcript budget exactly', async () => {
    // Four maximum-size parts consume MAX_TRANSCRIPT_TEXT_CHARS (1 MiB) to
    // the character, leaving nothing for the oldest message, which is dropped.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const file = sessionFile(ids.map((id, index) => userMessage(id, index === 0 ? null : ids[index - 1], 'x'.repeat(partMax))))
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
    for (const message of transcript) expect(message.parts).toEqual([{ type: 'text', text: 'x'.repeat(partMax) }])
  })

  it('keeps a message that fits the remaining budget exactly', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4']
    const file = sessionFile(ids.map((id, index) => userMessage(id, index === 0 ? null : ids[index - 1], 'x'.repeat(partMax))))
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('bounds compaction summaries by the shared text budget', async () => {
    // The compaction part is always retained; its summary shares the same
    // text budget as every other part, consumed newest-first, so a stale
    // summary collapses once newer parts have spent the budget.
    const summary = 's'.repeat(partMax)
    const bigText = 'x'.repeat(partMax)
    const ids = ['m1', 'm2', 'm3', 'm4']
    const compaction = JSON.stringify({ type: 'compaction', id: 'compact-1', parentId: null, summary, firstKeptEntryId: 'm1' })
    const messages = ids.map((id, index) => userMessage(id, index === 0 ? 'compact-1' : ids[index - 1], bigText))
    const file = sessionFile([compaction, ...messages])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['compact-1', 'm1', 'm2', 'm3', 'm4'])
    const part = transcript[0]?.parts[0]
    expect(part).toMatchObject({ type: 'compaction', status: 'done' })
    // The four newer text parts consumed the whole budget, so the older
    // summary collapses to nothing while the part itself survives.
    expect(part && 'summary' in part && part.summary ? part.summary : '').toBe('')
    for (const message of transcript.slice(1)) expect(message.parts).toEqual([{ type: 'text', text: bigText }])
  })
})
