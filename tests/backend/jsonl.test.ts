import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from '../../electron/main/jsonl-limits'
import { StrictJsonlDecoder, strictJsonLines } from '../../electron/main/jsonl'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function collect(stream: Readable, maxUnframedBytes = SESSION_FILE_RECORD_LIMIT_BYTES): Promise<string[]> {
  const lines: string[] = []
  for await (const line of strictJsonLines(stream, maxUnframedBytes)) lines.push(line)
  return lines
}

describe('StrictJsonlDecoder', () => {
  it('frames only on LF across UTF-8 chunks', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), SESSION_FILE_RECORD_LIMIT_BYTES)
    const input = Buffer.from('{"text":"a\u2028b"}\n{"ok":true}\r\n')
    decoder.push(input.subarray(0, 8))
    decoder.push(input.subarray(8, 17))
    decoder.push(input.subarray(17))
    decoder.end()
    expect(lines).toEqual(['{"text":"a\u2028b"}', '{"ok":true}'])
  })

  it('rejects oversized records', () => {
    const decoder = new StrictJsonlDecoder(() => undefined, 8)
    expect(() => decoder.push('123456789')).toThrow(/maximum frame size/)
  })

  it('accounts each encoded input byte exactly once across chunk boundaries', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), 5)
    const record = Buffer.from('€xy') // 5 encoded bytes, 3 characters
    decoder.push(record.subarray(0, 1))
    decoder.push(record.subarray(1, 2))
    decoder.push(record.subarray(2))
    decoder.push('\n')
    decoder.end()
    expect(lines).toEqual(['€xy'])
  })

  it('rejects a record whose encoded bytes exceed the limit even when decoded characters are few', () => {
    const decoder = new StrictJsonlDecoder(() => undefined, 5)
    expect(() => decoder.push(Buffer.from('€€'))).toThrow(/maximum frame size/)
  })

  it('replaces an incomplete trailing UTF-8 sequence at end of input', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), SESSION_FILE_RECORD_LIMIT_BYTES)
    decoder.push(Buffer.from('{"ok":true}\n"a'))
    decoder.push(Buffer.from([0xe2, 0x82])) // first two bytes of a three-byte sequence
    decoder.end()
    expect(lines).toEqual(['{"ok":true}', '"a�'])
  })

  it('reassembles a multi-byte character split across chunk boundaries', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), SESSION_FILE_RECORD_LIMIT_BYTES)
    const euro = Buffer.from('{"text":"€"}\n')
    const splitAt = euro.indexOf(0xe2) + 1
    decoder.push(euro.subarray(0, splitAt))
    decoder.push(euro.subarray(splitAt))
    decoder.end()
    expect(lines).toEqual(['{"text":"€"}'])
  })

  it('drops blank framed lines instead of forwarding empty records', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), SESSION_FILE_RECORD_LIMIT_BYTES)
    decoder.push('{"a":1}\n\n\r\n{"b":2}\n')
    decoder.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('assembles highly fragmented records without repeatedly copying the buffered prefix', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), 100_000)
    for (let index = 0; index < 50_000; index += 1) decoder.push('x')
    decoder.push('\n')
    decoder.end()
    expect(lines).toEqual(['x'.repeat(50_000)])
  })
})

describe('strictJsonLines', () => {
  it('resumes a partial line across chunks, including split multi-byte characters', async () => {
    const record = Buffer.from('{"text":"héllo €"}\n{"next":1}')
    const splitInsideEuro = record.indexOf(0xe2) + 1
    const stream = Readable.from([
      record.subarray(0, 5),
      record.subarray(5, splitInsideEuro),
      record.subarray(splitInsideEuro),
    ])
    expect(await collect(stream)).toEqual(['{"text":"héllo €"}', '{"next":1}'])
  })

  it('substitutes U+FFFD for invalid UTF-8 byte sequences instead of failing', async () => {
    const stream = Readable.from([
      Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]),
    ])
    // Pins current behavior: StringDecoder replaces invalid sequences, so the
    // record survives framing and fails later at JSON.parse instead.
    expect(await collect(stream)).toEqual(['{"bad":"��"}'])
  })

  it('yields an unterminated final line after the stream ends', async () => {
    expect(await collect(Readable.from(['{"a":1}\n{"unterminated":true}']))).toEqual(['{"a":1}', '{"unterminated":true}'])
    expect(await collect(Readable.from(['{"a":1}\n{"crlf":true}\r']))).toEqual(['{"a":1}', '{"crlf":true}'])
  })

  it('yields empty strings for blank framed lines, unlike the decoder', async () => {
    expect(await collect(Readable.from(['{"a":1}\n\n{"b":2}\n']))).toEqual(['{"a":1}', '', '{"b":2}'])
  })

  it('rejects a record above the frame limit even when split across chunks', async () => {
    await expect(collect(Readable.from(['12345', '6789']), 8)).rejects.toThrow(/maximum frame size/)
    await expect(collect(Readable.from(['123456789\n']), 8)).rejects.toThrow(/maximum frame size/)
    // A CR that is immediately followed by LF is framing, not record bytes.
    expect(await collect(Readable.from(['12345678\r\n']), 8)).toEqual(['12345678'])
  })

  it('destroys the underlying file stream when iteration aborts early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-jsonl-'))
    dirs.push(dir)
    const file = join(dir, 'records.jsonl')
    writeFileSync(file, `${'{"line":1}\n'.repeat(10_000)}`)
    const stream = createReadStream(file, { highWaterMark: 64 })
    // Early abort destroys the stream, which surfaces as an AbortError 'error'
    // event on some Node versions; the caller-visible contract is teardown.
    stream.on('error', () => undefined)
    const lines: string[] = []
    for await (const line of strictJsonLines(stream, SESSION_FILE_RECORD_LIMIT_BYTES)) {
      lines.push(line)
      break
    }
    expect(lines).toEqual(['{"line":1}'])
    if (!stream.closed) await new Promise<void>((resolve) => stream.once('close', () => resolve()))
    expect(stream.destroyed).toBe(true)
  })

  it('propagates a frame-limit abort as stream teardown for file descriptors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-jsonl-'))
    dirs.push(dir)
    const file = join(dir, 'oversized.jsonl')
    writeFileSync(file, `{"ok":1}\n${'x'.repeat(4_096)}\n`)
    const stream = createReadStream(file, { highWaterMark: 64 })
    stream.on('error', () => undefined)
    await expect(collect(stream, 64)).rejects.toThrow(/maximum frame size/)
    if (!stream.closed) await new Promise<void>((resolve) => stream.once('close', () => resolve()))
    expect(stream.destroyed).toBe(true)
  })
})
