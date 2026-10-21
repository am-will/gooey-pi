import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

class FragmentedLineBuffer {
  private fragments: string[] = []
  private bytes = 0

  constructor(private readonly maxUnframedBytes: number, private readonly recordName: string) {}

  append(fragment: string, fragmentBytes: number): void {
    if (!fragment && !fragmentBytes) return
    if (this.bytes + fragmentBytes > this.maxUnframedBytes) this.tooLarge()
    if (fragment) this.fragments.push(fragment)
    this.bytes += fragmentBytes
  }

  takeLine(fragment: string, fragmentBytes: number): string {
    const totalBytes = this.bytes + fragmentBytes
    // A CR immediately before LF is framing, so it does not count toward the record limit.
    if (totalBytes > this.maxUnframedBytes + 1) this.tooLarge()
    if (fragment) this.fragments.push(fragment)
    const line = this.fragments.join('')
    this.fragments = []
    this.bytes = 0
    const framed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (totalBytes - Number(line.endsWith('\r')) > this.maxUnframedBytes) this.tooLarge()
    return framed
  }

  finish(): string | undefined {
    if (!this.fragments.length) return undefined
    const line = this.fragments.join('')
    this.fragments = []
    this.bytes = 0
    return line.endsWith('\r') ? line.slice(0, -1) : line
  }

  private tooLarge(): never { throw new Error(`${this.recordName} record exceeded the maximum frame size`) }
}

/**
 * Splits an encoded chunk on LF (unambiguous in UTF-8) and accounts record
 * size from the consumed input bytes, so no decoded string is re-measured.
 */
function* encodedLines(chunk: Buffer, decoder: StringDecoder, buffer: FragmentedLineBuffer): Generator<string> {
  let start = 0
  while (true) {
    const index = chunk.indexOf(0x0a, start)
    if (index < 0) break
    yield buffer.takeLine(decoder.write(chunk.subarray(start, index)), index - start)
    start = index + 1
  }
  const rest = chunk.subarray(start)
  buffer.append(decoder.write(rest), rest.length)
}

function asBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
}

/** Strict JSONL parser: only LF is a delimiter; U+2028/U+2029 stay inside JSON strings. */
export async function* strictJsonLines(stream: Readable, maxUnframedBytes: number): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  const buffer = new FragmentedLineBuffer(maxUnframedBytes, 'JSONL')
  for await (const raw of stream) {
    for (const line of encodedLines(asBuffer(raw as Buffer | string), decoder, buffer)) yield line
  }
  // Any bytes a dangling partial sequence flushes were already accounted.
  buffer.append(decoder.end(), 0)
  const finalLine = buffer.finish()
  if (finalLine !== undefined) yield finalLine
}

export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private readonly buffer: FragmentedLineBuffer

  constructor(private readonly onLine: (line: string) => void, maxUnframedBytes: number) {
    this.buffer = new FragmentedLineBuffer(maxUnframedBytes, 'RPC')
  }

  push(chunk: Buffer | string): void {
    for (const line of encodedLines(asBuffer(chunk), this.decoder, this.buffer)) if (line) this.onLine(line)
  }

  end(): void {
    this.buffer.append(this.decoder.end(), 0)
    const finalLine = this.buffer.finish()
    if (finalLine !== undefined) this.onLine(finalLine)
  }
}
