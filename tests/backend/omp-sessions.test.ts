import { appendFileSync, closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { METADATA_VERIFY_TAIL_BYTES } from '../../electron/main/sessions/metadata'
import {
  createOmpSessionMetadataReader,
  isOmpSessionPath,
  OMP_TITLE_SLOT_BYTES,
  ompSessionServiceOptions,
  ompTimestampFromSessionName,
  writeOmpTitleSlot,
} from '../../electron/main/sessions/omp'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function titleSlot(title: string, updatedAt = '2026-08-08T02:12:49.414Z'): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: '' })
  const padding = OMP_TITLE_SLOT_BYTES - 1 - Buffer.byteLength(unpadded, 'utf8')
  if (padding < 0) throw new Error('Fixture title does not fit the slot')
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: ' '.repeat(padding) })
}

function ompEntry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}, timestamp = '2026-08-08T02:13:00.000Z'): string {
  return JSON.stringify({ type, id, parentId, timestamp, ...extra })
}

function writeOmpSession(file: string, options: {
  id?: string
  cwd?: string
  title?: string
  timestamp?: string
  entries?: string[]
} = {}): void {
  const timestamp = options.timestamp ?? '2026-08-08T02:12:49.414Z'
  const slot = titleSlot(options.title ?? '', timestamp)
  expect(Buffer.byteLength(`${slot}\n`, 'utf8')).toBe(OMP_TITLE_SLOT_BYTES)
  writeFileSync(file, [
    slot,
    JSON.stringify({ type: 'session', version: 3, id: options.id ?? '019fdf24-f686-7000-86fd-e1eaf84626c6', timestamp, cwd: options.cwd ?? '/tmp' }),
    ...options.entries ?? [],
    '',
  ].join('\n'))
}

function rewriteTitleSlot(file: string, title: string): void {
  const slot = Buffer.from(`${titleSlot(title)}\n`, 'utf8')
  expect(slot.length).toBe(OMP_TITLE_SLOT_BYTES)
  const fd = openSync(file, 'r+')
  try { writeSync(fd, slot, 0, slot.length, 0) } finally { closeSync(fd) }
}

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-omp-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles, ompSessionServiceOptions(root))
  return { root, project, service }
}

const NAME_A = '2026-08-08T02-12-49-414Z_019fdf24-f686-7000-86fd-e1eaf84626c6.jsonl'
const NAME_B = '2026-08-09T10-00-00-000Z_019fdf24-0000-7000-8000-000000000001.jsonl'
const NAME_C = '2026-08-10T12-30-15-250Z_019fdf24-0000-7000-8000-000000000002.jsonl'

describe('OMP session file names', () => {
  it('derives ordering timestamps from the ISO file-name prefix, with or without a bucket prefix', () => {
    expect(ompTimestampFromSessionName(NAME_A)).toBe(Date.parse('2026-08-08T02:12:49.414Z'))
    expect(ompTimestampFromSessionName(`-tmp/${NAME_C}`)).toBe(Date.parse('2026-08-10T12:30:15.250Z'))
    expect(ompTimestampFromSessionName('legacy.jsonl')).toBeUndefined()
    expect(ompTimestampFromSessionName('01900000-0001-7000-8000-000000000000.jsonl')).toBeUndefined()
  })
})

describe('OMP metadata reader', () => {
  it('parses the title slot, header, model, thinking level, and user activity into a SessionRecord', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      id: 'omp-session-1',
      cwd: project,
      title: 'Slot title',
      entries: [
        ompEntry('model_change', '090e7d4b', null, { model: 'anthropic/claude-opus-4-8', resolvedModelIsFallback: false }, '2026-08-08T02:12:49.458Z'),
        ompEntry('thinking_level_change', '77ca5df2', '090e7d4b', { thinkingLevel: 'high', configured: null }, '2026-08-08T02:12:49.458Z'),
        ompEntry('model_change', '9e21e960', '77ca5df2', { model: 'openai-codex/gpt-5.6-sol', role: 'default' }, '2026-08-08T02:15:26.437Z'),
        ompEntry('model_change', '15f3a4e9', '9e21e960', { model: 'other/side-model', role: 'compaction' }, '2026-08-08T02:15:27.000Z'),
        ompEntry('message', 'aa11bb22', '15f3a4e9', { message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: 1786155361373 } }, '2026-08-08T02:16:01.414Z'),
        ompEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }], timestamp: 1786155362489 } }, '2026-08-08T02:16:02.495Z'),
      ],
    })

    const records = await service.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'omp-session-1',
      projectPath: realpathSync(project),
      title: 'Slot title',
      createdAt: '2026-08-08T02:12:49.414Z',
      updatedAt: '2026-08-08T02:16:02.495Z',
      lastUserMessageAt: new Date(1786155361373).toISOString(),
      status: 'complete',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      thinkingLevel: 'high',
      depth: 0,
      preview: 'the answer',
    })
  })

  it('falls back to title_change then the first user message when the slot title is empty', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const untitled = join(root, '-bucket', NAME_A)
    writeOmpSession(untitled, {
      cwd: project,
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'name me by prompt' } })],
    })
    const renamed = join(root, '-bucket', NAME_B)
    writeOmpSession(renamed, {
      cwd: project,
      entries: [
        ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'original prompt' } }),
        ompEntry('title_change', 'bb22cc33', 'aa11bb22', { title: 'Renamed in tail' }),
      ],
    })

    const titles = new Map((await service.list()).map((record) => [record.filePath.endsWith(NAME_B) ? 'renamed' : 'untitled', record.title]))
    expect(titles.get('untitled')).toBe('name me by prompt')
    expect(titles.get('renamed')).toBe('Renamed in tail')
  })

  it('picks up an in-place title-slot rewrite without losing incremental tail state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-omp-title-')); dirs.push(dir)
    const file = join(dir, NAME_A)
    const bulk = Array.from({ length: 8 }, (_, index) => ompEntry('message', `aa11bb2${index}`, index ? `aa11bb2${index - 1}` : null, {
      message: { role: 'user', content: `filler ${'x'.repeat(600)}` },
    }))
    writeOmpSession(file, { title: 'Before rename', entries: bulk })
    expect(statSync(file).size).toBeGreaterThan(OMP_TITLE_SLOT_BYTES + METADATA_VERIFY_TAIL_BYTES)
    const opens: Array<{ start: number; end: number }> = []
    const reader = createOmpSessionMetadataReader({
      inspect: stat,
      openStream: (path, start, end) => {
        opens.push({ start, end })
        return createReadStream(path, { start, end })
      },
    })
    const tailOpens = () => opens.filter((open) => !(open.start === 0 && open.end === OMP_TITLE_SLOT_BYTES - 1))

    const first = await reader(file)
    const firstSize = statSync(file).size
    expect(first.title).toBe('Before rename')
    expect(tailOpens()).toEqual([{ start: OMP_TITLE_SLOT_BYTES, end: firstSize - 1 }])

    // The slot is rewritten in place (same byte length) while an entry appends:
    // the tail resumes from the verification window, never from byte zero.
    rewriteTitleSlot(file, 'After rename')
    appendFileSync(file, `${ompEntry('message', 'ee55ff66', 'aa11bb27', { message: { role: 'assistant', content: 'caught up' } }, '2026-08-08T03:00:00.000Z')}\n`)
    const second = await reader(file)
    expect(second.title).toBe('After rename')
    expect(second.preview).toBe('caught up')
    expect(second.updatedAt).toBe('2026-08-08T03:00:00.000Z')
    expect(tailOpens()).toHaveLength(2)
    expect(tailOpens()[1]).toEqual({ start: firstSize - METADATA_VERIFY_TAIL_BYTES, end: statSync(file).size - 1 })
    expect(tailOpens()[1]!.start).toBeGreaterThan(OMP_TITLE_SLOT_BYTES)

    // A rewrite with no append still refreshes the title on the next read.
    rewriteTitleSlot(file, 'Renamed again')
    expect((await reader(file)).title).toBe('Renamed again')
  })
})

describe('OMP catalog discovery', () => {
  it('recurses exactly one bucket level and ignores root files, deep files, and hidden names', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    mkdirSync(join(root, '-bucket', 'nested'))
    mkdirSync(join(root, '.hidden-bucket'))
    writeOmpSession(join(root, '-bucket', NAME_A), { id: 'visible', cwd: project })
    writeOmpSession(join(root, NAME_B), { id: 'root-level', cwd: project })
    writeOmpSession(join(root, '-bucket', 'nested', NAME_C), { id: 'too-deep', cwd: project })
    writeOmpSession(join(root, '.hidden-bucket', NAME_C), { id: 'hidden-bucket', cwd: project })
    writeOmpSession(join(root, '-bucket', `.${NAME_C}`), { id: 'hidden-file', cwd: project })
    writeFileSync(join(root, '-bucket', 'notes.txt'), 'not a session')

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['visible'])
  })

  it('admits the newest files by file-name timestamp, not directory or mtime order', async () => {
    const { root, project, service } = setup(2)
    mkdirSync(join(root, '-bucket-a'))
    mkdirSync(join(root, '-bucket-b'))
    const oldest = join(root, '-bucket-b', NAME_A)
    const middle = join(root, '-bucket-a', NAME_B)
    const newest = join(root, '-bucket-b', NAME_C)
    writeOmpSession(oldest, { id: 'oldest', cwd: project })
    writeOmpSession(middle, { id: 'middle', cwd: project })
    writeOmpSession(newest, { id: 'newest', cwd: project })
    // The oldest-named file gets the newest mtime: the pre-I/O admission bound
    // must still be decided by the file-name timestamp.
    const past = new Date('2026-08-01T00:00:00.000Z')
    utimesSync(middle, past, past)
    utimesSync(newest, past, past)

    const records = await service.list()
    expect(records.map((record) => record.id).sort()).toEqual(['middle', 'newest'])
  })
})

describe('OMP session path authorization', () => {
  it('contains sessions to one bucket level below the realpathed root', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    mkdirSync(join(root, '-bucket', 'nested'))
    const valid = join(root, '-bucket', NAME_A)
    writeOmpSession(valid, { cwd: project })
    writeOmpSession(join(root, NAME_B), { cwd: project })
    writeOmpSession(join(root, '-bucket', 'nested', NAME_C), { cwd: project })
    writeFileSync(join(root, '-bucket', 'notes.txt'), 'not a session')
    const outside = join(dirs.at(-1)!, 'outside.jsonl')
    writeOmpSession(outside, { cwd: project })
    symlinkSync(outside, join(root, '-bucket', 'escape.jsonl'))

    await expect(service.requireSessionPath(valid)).resolves.toBe(realpathSync(valid))
    await expect(service.requireSessionPath(join(root, NAME_B))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'nested', NAME_C))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'notes.txt'))).rejects.toThrow('outside the')
    await expect(service.requireSessionPath(join(root, '-bucket', 'escape.jsonl'))).rejects.toThrow('outside the')
  })

  it('validates candidate shapes without touching the filesystem', () => {
    expect(isOmpSessionPath('/root', `/root/-bucket/${NAME_A}`)).toBe(true)
    expect(isOmpSessionPath('/root', `/root/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', `/root/-bucket/deep/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', `/elsewhere/-bucket/${NAME_A}`)).toBe(false)
    expect(isOmpSessionPath('/root', '/root/-bucket/session.txt')).toBe(false)
  })
})

describe('OMP transcript access through the service', () => {
  it('reads an OMP transcript through the injected reader and authorized path', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      cwd: project,
      entries: [
        ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } }),
        ompEntry('message', 'cc33dd44', 'aa11bb22', { message: { role: 'assistant', content: 'answer' } }),
      ],
    })

    const transcript = await service.read(file)
    expect(transcript.map((message) => [message.role, message.parts])).toEqual([
      ['user', [{ type: 'text', text: 'question' }]],
      ['assistant', [{ type: 'text', text: 'answer' }]],
    ])
  })
})

describe('OMP session service harness identity', () => {
  it('stamps every record and change event with the omp harness', async () => {
    const { root, project, service } = setup()
    expect(service.harness).toBe('omp')
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, { cwd: project, entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'question' } })] })

    const records = await service.list()
    expect(records.map((record) => record.harness)).toEqual(['omp'])

    const events: Array<{ filePath?: string; harness?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    try {
      const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
      // Recursive watchers report bucket-relative names one directory deep.
      watcherHarness.queueSessionChange(`-bucket/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toContainEqual({ filePath: realpathSync(file), harness: 'omp' })

      // Deeper or hidden names cannot resolve to one session file and coalesce
      // into a catalog-wide refresh instead.
      events.splice(0)
      watcherHarness.queueSessionChange(`-bucket/nested/${NAME_A}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events).toEqual([{ harness: 'omp' }])
    } finally {
      unsubscribe()
    }
  })
})

describe('OMP file-level rename fallback', () => {
  it('rewrites the title slot in place without touching the session header', async () => {
    const { root, project, service } = setup()
    mkdirSync(join(root, '-bucket'))
    const file = join(root, '-bucket', NAME_A)
    writeOmpSession(file, {
      cwd: project,
      title: 'Slot title',
      entries: [ompEntry('message', 'aa11bb22', null, { message: { role: 'user', content: 'first prompt' } })],
    })
    const before = readFileSync(file)
    const header = before.toString('utf8').split('\n')[1]

    expect(writeOmpTitleSlot(file, 'Renamed offline')).toBe(true)
    const after = readFileSync(file)
    expect(after.length).toBe(before.length)
    expect(after.toString('utf8').split('\n')[1]).toBe(header)
    expect((await service.list())[0]?.title).toBe('Renamed offline')
  })

  it('leaves a file whose first line is the session header untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-omp-no-slot-')); dirs.push(dir)
    const file = join(dir, NAME_A)
    const body = `${JSON.stringify({ type: 'session', version: 3, id: 'no-slot', timestamp: '2026-08-08T02:12:49.414Z', cwd: '/tmp' })}\n`
    writeFileSync(file, body)
    expect(writeOmpTitleSlot(file, 'Should not write')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })
})
