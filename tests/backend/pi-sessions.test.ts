import { appendFileSync, createReadStream, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { METADATA_VERIFY_TAIL_BYTES } from '../../electron/main/sessions/metadata'
import {
  createPiSessionMetadataReader,
  isPiSessionPath,
  piSessionServiceOptions,
  piTimestampFromSessionName,
} from '../../electron/main/sessions/pi'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function piEntry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}, timestamp = '2026-08-10T22:42:00.000Z'): string {
  return JSON.stringify({ type, id, parentId, timestamp, ...extra })
}

function writePiSession(file: string, options: {
  id?: string
  cwd?: string
  timestamp?: string
  entries?: string[]
} = {}): void {
  const timestamp = options.timestamp ?? '2026-08-10T22:41:20.246Z'
  writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id: options.id ?? '019fedd6-6b76-7129-8688-a1cdde54255b', timestamp, cwd: options.cwd ?? '/tmp' }),
    ...options.entries ?? [],
    '',
  ].join('\n'))
}

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-pi-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles, piSessionServiceOptions(root))
  return { root, project, service }
}

const NAME_A = '2026-08-08T02-12-49-414Z_019fdf24-f686-7000-86fd-e1eaf84626c6.jsonl'
const NAME_B = '2026-08-09T10-00-00-000Z_019fdf24-0000-7000-8000-000000000001.jsonl'
const NAME_C = '2026-08-10T22-41-20-246Z_019fedd6-6b76-7129-8688-a1cdde54255b.jsonl'
// A real pi bucket name: a lossy cwd encoding that must never be decoded back.
const BUCKET = '--Users-am.will-Applications-prime--'

describe('pi session file names', () => {
  it('derives ordering timestamps from the ISO file-name prefix, with or without a bucket prefix', () => {
    expect(piTimestampFromSessionName(NAME_C)).toBe(Date.parse('2026-08-10T22:41:20.246Z'))
    expect(piTimestampFromSessionName(`${BUCKET}/${NAME_A}`)).toBe(Date.parse('2026-08-08T02:12:49.414Z'))
    expect(piTimestampFromSessionName('legacy.jsonl')).toBeUndefined()
    expect(piTimestampFromSessionName('01900000-0001-7000-8000-000000000000.jsonl')).toBeUndefined()
  })
})

describe('pi metadata reader', () => {
  it('parses the header, split model_change, thinking level, session_info, and user activity into a SessionRecord', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_C)
    writePiSession(file, {
      id: 'pi-session-1',
      cwd: project,
      entries: [
        piEntry('model_change', '090e7d4b', null, { provider: 'anthropic', modelId: 'claude-opus-4-8' }, '2026-08-10T22:41:20.300Z'),
        piEntry('thinking_level_change', '77ca5df2', '090e7d4b', { thinkingLevel: 'high' }, '2026-08-10T22:41:20.300Z'),
        piEntry('model_change', '9e21e960', '77ca5df2', { provider: 'openai-codex', modelId: 'gpt-5.6-luna' }, '2026-08-10T22:41:25.000Z'),
        piEntry('session_info', '15f3a4e9', '9e21e960', { name: 'First name' }, '2026-08-10T22:41:26.000Z'),
        piEntry('message', 'aa11bb22', '15f3a4e9', { message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: 1786155361373 } }, '2026-08-10T22:42:01.000Z'),
        piEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }], timestamp: 1786155362489 } }, '2026-08-10T22:42:02.495Z'),
        piEntry('session_info', 'ee55ff66', 'cc33dd44', { name: 'Latest name wins' }, '2026-08-10T22:42:03.000Z'),
      ],
    })

    const records = await service.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'pi-session-1',
      // The header cwd is authoritative; the bucket name is never decoded.
      projectPath: realpathSync(project),
      title: 'Latest name wins',
      createdAt: '2026-08-10T22:41:20.246Z',
      updatedAt: '2026-08-10T22:42:03.000Z',
      lastUserMessageAt: new Date(1786155361373).toISOString(),
      status: 'complete',
      model: 'gpt-5.6-luna',
      provider: 'openai-codex',
      thinkingLevel: 'high',
      depth: 0,
      preview: 'the answer',
    })
  })

  it('falls back to the first user message when there is no session_info or its name is empty', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const untitled = join(root, BUCKET, NAME_A)
    writePiSession(untitled, {
      cwd: project,
      entries: [piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'name me by prompt' } })],
    })
    const cleared = join(root, BUCKET, NAME_B)
    writePiSession(cleared, {
      cwd: project,
      entries: [
        piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'original prompt' } }),
        piEntry('session_info', 'bb22cc33', 'aa11bb22', { name: 'Named in tail' }),
        piEntry('session_info', 'cc33dd44', 'bb22cc33', { name: '' }),
      ],
    })

    const titles = new Map((await service.list()).map((record) => [record.filePath.endsWith(NAME_B) ? 'cleared' : 'untitled', record.title]))
    expect(titles.get('untitled')).toBe('name me by prompt')
    expect(titles.get('cleared')).toBe('original prompt')
  })

  it('resumes appended tails incrementally and picks up a session_info rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-pi-rename-')); dirs.push(dir)
    const file = join(dir, NAME_A)
    const bulk = Array.from({ length: 8 }, (_, index) => piEntry('message', `aa11bb2${index}`, index ? `aa11bb2${index - 1}` : null, {
      message: { role: 'user', content: `filler ${'x'.repeat(600)}` },
    }))
    writePiSession(file, { entries: [piEntry('session_info', '00aa11bb', null, { name: 'Before rename' }), ...bulk] })
    expect(statSync(file).size).toBeGreaterThan(METADATA_VERIFY_TAIL_BYTES)
    const opens: Array<{ start: number; end: number }> = []
    const reader = createPiSessionMetadataReader({
      inspect: stat,
      openStream: (path, start, end) => {
        opens.push({ start, end })
        return createReadStream(path, { start, end })
      },
    })

    const first = await reader(file)
    const firstSize = statSync(file).size
    expect(first.title).toBe('Before rename')
    expect(opens).toEqual([{ start: 0, end: firstSize - 1 }])

    // An appended rename resumes from the verification window, never from byte zero.
    appendFileSync(file, [
      `${piEntry('session_info', 'dd44ee55', 'aa11bb27', { name: 'After rename' }, '2026-08-10T23:00:00.000Z')}\n`,
      `${piEntry('message', 'ee55ff66', 'dd44ee55', { message: { role: 'assistant', content: 'caught up' } }, '2026-08-10T23:00:01.000Z')}\n`,
    ].join(''))
    const second = await reader(file)
    expect(second.title).toBe('After rename')
    expect(second.preview).toBe('caught up')
    expect(second.updatedAt).toBe('2026-08-10T23:00:01.000Z')
    expect(opens).toHaveLength(2)
    expect(opens[1]).toEqual({ start: firstSize - METADATA_VERIFY_TAIL_BYTES, end: statSync(file).size - 1 })
  })

  it('survives malformed and non-record lines without failing the session', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-hostile', timestamp: '2026-08-10T22:41:20.246Z', cwd: project }),
      'not json at all',
      '{"type":"message","id":"tru', // truncated record
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ type: 'model_change', id: 'a1', parentId: null, provider: 42, modelId: { nested: true } }),
      piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'still readable' } }),
      '',
    ].join('\n'))

    const records = await service.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: 'pi-hostile', title: 'still readable', model: undefined, provider: undefined })
  })
})

describe('pi catalog discovery', () => {
  it('recurses exactly one bucket level and ignores root files, deep files, and hidden names', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    mkdirSync(join(root, BUCKET, 'nested'))
    mkdirSync(join(root, '.hidden-bucket'))
    writePiSession(join(root, BUCKET, NAME_A), { id: 'visible', cwd: project })
    writePiSession(join(root, NAME_B), { id: 'root-level', cwd: project })
    writePiSession(join(root, BUCKET, 'nested', NAME_C), { id: 'too-deep', cwd: project })
    writePiSession(join(root, '.hidden-bucket', NAME_C), { id: 'hidden-bucket', cwd: project })
    writePiSession(join(root, BUCKET, `.${NAME_C}`), { id: 'hidden-file', cwd: project })
    writeFileSync(join(root, BUCKET, 'notes.txt'), 'not a session')

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['visible'])
  })

  it('admits the newest files by file-name timestamp, not directory or mtime order', async () => {
    const { root, project, service } = setup(2)
    mkdirSync(join(root, '--bucket-a--'))
    mkdirSync(join(root, '--bucket-b--'))
    const oldest = join(root, '--bucket-b--', NAME_A)
    const middle = join(root, '--bucket-a--', NAME_B)
    const newest = join(root, '--bucket-b--', NAME_C)
    writePiSession(oldest, { id: 'oldest', cwd: project })
    writePiSession(middle, { id: 'middle', cwd: project })
    writePiSession(newest, { id: 'newest', cwd: project })
    // The oldest-named file gets the newest mtime: the pre-I/O admission bound
    // must still be decided by the file-name timestamp.
    const past = new Date('2026-08-01T00:00:00.000Z')
    utimesSync(middle, past, past)
    utimesSync(newest, past, past)

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['middle', 'newest'])
  })
})

describe('pi session path authorization', () => {
  it('contains sessions to one bucket level below the realpathed root', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    mkdirSync(join(root, BUCKET, 'nested'))
    const valid = join(root, BUCKET, NAME_A)
    writePiSession(valid, { cwd: project })
    writePiSession(join(root, NAME_B), { cwd: project })
    writePiSession(join(root, BUCKET, 'nested', NAME_C), { cwd: project })
    writeFileSync(join(root, BUCKET, 'notes.txt'), 'not a session')
    const outside = join(dirs.at(-1)!, 'outside.jsonl')
    writePiSession(outside, { cwd: project })
    symlinkSync(outside, join(root, BUCKET, 'escape.jsonl'))

    await expect(service.requireSessionPath(valid)).resolves.toBe(realpathSync(valid))
    await expect(service.requireSessionPath(join(root, NAME_B))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, BUCKET, 'nested', NAME_C))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, BUCKET, 'notes.txt'))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, BUCKET, 'escape.jsonl'))).rejects.toThrow('outside the')
  })

  it('validates candidate shapes without touching the filesystem', () => {
    expect(isPiSessionPath('/root', `/root/${BUCKET}/${NAME_A}`)).toBe(true)
    expect(isPiSessionPath('/root', `/root/${NAME_A}`)).toBe(false)
    expect(isPiSessionPath('/root', `/root/${BUCKET}/deep/${NAME_A}`)).toBe(false)
    expect(isPiSessionPath('/root', `/elsewhere/${BUCKET}/${NAME_A}`)).toBe(false)
    expect(isPiSessionPath('/root', `/root/${BUCKET}/session.txt`)).toBe(false)
  })
})

describe('pi transcript access through the service', () => {
  it('uses the message timestamp as the assistant start and the entry timestamp as completion', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    const startedAt = Date.parse('2026-08-10T22:41:22.000Z')
    const completedAt = '2026-08-10T22:42:02.495Z'
    writePiSession(file, {
      cwd: project,
      entries: [
        piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } }),
        piEntry('message', 'cc33dd44', 'aa11bb22', {
          message: { role: 'assistant', content: 'answer', timestamp: startedAt },
        }, completedAt),
      ],
    })

    const assistant = (await service.read(file)).find((message) => message.role === 'assistant')
    expect(assistant).toMatchObject({ startedAt, completedAt })
  })

  it('reads a pi transcript through the injected reader and authorized path', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writePiSession(file, {
      cwd: project,
      entries: [
        piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } }),
        piEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: 'answer' } }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => [message.role, message.parts])).toEqual([
      ['user', [{ type: 'text', text: 'question' }]],
      ['assistant', [{ type: 'text', text: 'answer' }]],
    ])
  })

  it('renders only the active branch: the parent chain of the last renderable leaf', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writePiSession(file, {
      cwd: project,
      entries: [
        piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'root question' } }),
        piEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: 'first answer' } }),
        // Abandoned branch: superseded by the fork appended after it.
        piEntry('message', 'dd44ee55', 'cc33dd44', { message: { role: 'user', content: 'abandoned follow-up' } }),
        piEntry('message', 'ee55ff66', 'cc33dd44', { message: { role: 'user', content: 'branched follow-up' } }),
        piEntry('message', 'ff667788', 'ee55ff66', { message: { role: 'assistant', content: 'branched answer' } }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => message.parts[0])).toEqual([
      { type: 'text', text: 'root question' },
      { type: 'text', text: 'first answer' },
      { type: 'text', text: 'branched follow-up' },
      { type: 'text', text: 'branched answer' },
    ])
  })

  it('renders branch_summary entries as system messages on the active path', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writePiSession(file, {
      cwd: project,
      entries: [
        piEntry('branch_summary', 'aa11bb22', null, { summary: 'Summary of the branched-away work' }),
        piEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'user', content: 'continue from here' } }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => [message.role, message.parts[0]])).toEqual([
      ['system', { type: 'text', text: 'Summary of the branched-away work' }],
      ['user', { type: 'text', text: 'continue from here' }],
    ])
  })

  it('ignores hostile entries: oversized ids, missing ids, and non-renderable trailing types', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writePiSession(file, {
      cwd: project,
      entries: [
        piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'kept' } }),
        piEntry('message', 'x'.repeat(2_000), 'aa11bb22', { message: { role: 'user', content: 'oversized id' } }),
        JSON.stringify({ type: 'message', parentId: 'aa11bb22', message: { role: 'user', content: 'missing id' } }),
        // A trailing non-renderable record must not steal leaf selection.
        piEntry('label', 'cc33dd44', null, { label: 'bookmark' }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => [message.role, message.parts[0]])).toEqual([
      ['user', { type: 'text', text: 'kept' }],
    ])
  })
})

describe('pi session service harness identity', () => {
  it('stamps every record and change event with the pi harness', async () => {
    const { root, project, service } = setup()
    expect(service.harness).toBe('pi')
    mkdirSync(join(root, BUCKET))
    const file = join(root, BUCKET, NAME_A)
    writePiSession(file, { cwd: project, entries: [piEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })] })

    const records = await service.list()
    expect(records.map((record) => record.harness)).toEqual(['pi'])

    const events: Array<{ filePath?: string; harness?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    try {
      const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
      // Recursive watchers report bucket-relative names one directory deep.
      watcherHarness.queueSessionChange(`${BUCKET}/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toContainEqual({ filePath: realpathSync(file), harness: 'pi' })

      // Deeper or hidden names cannot resolve to one session file and coalesce
      // into a catalog-wide refresh instead.
      events.splice(0)
      watcherHarness.queueSessionChange(`${BUCKET}/nested/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toEqual([{ harness: 'pi' }])
    } finally {
      unsubscribe()
    }
  })
})
