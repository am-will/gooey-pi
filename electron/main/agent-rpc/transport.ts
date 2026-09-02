import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { RPC_READ_FRAME_LIMIT_BYTES } from '../jsonl-limits'
import { StrictJsonlDecoder } from '../jsonl'
import { errorMessage } from '../validation'
import { MAX_RPC_WRITE_FRAME_BYTES } from './limits'

export interface QueuedRpcWrite {
  /** Settles when the line has been flushed to the child (or failed). */
  done: Promise<void>
  /**
   * Withdraws the line when it has not started writing: it will never reach
   * the child and its byte budget is released immediately. Returns 'flushed'
   * when the line already reached (or is reaching) the child, in which case
   * delivery is uncertain and the caller must not blindly retry.
   */
  cancel(): 'cancelled' | 'flushed'
}

/** Owns JSONL frame decoding and serialized, byte-bounded writes for one RPC child. */
export class FramedRpcTransport {
  private readonly decoder: StrictJsonlDecoder
  private frameFailed = false
  private recentStderr = ''
  private writeQueue: Promise<void> = Promise.resolve()
  private queuedWriteBytes = 0

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onLine: (line: string) => void,
    private readonly onFatalTransportError: (error: unknown) => void,
    private readonly isAvailable: () => boolean,
    private readonly writeDeadlineMs = 30_000,
  ) {
    this.decoder = new StrictJsonlDecoder(onLine, RPC_READ_FRAME_LIMIT_BYTES)
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.decoder.push(chunk) } catch (error) {
        this.frameFailed = true
        onFatalTransportError(error)
      }
    })
    this.child.stdout.on('end', () => {
      if (this.frameFailed) return
      try { this.decoder.end() } catch (error) { onFatalTransportError(error) }
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.recentStderr += chunk.toString('utf8')
      if (this.recentStderr.length > 4096) this.recentStderr = this.recentStderr.slice(-4096)
    }) // stderr can contain secrets; never forward it live to the renderer
    // A SIGKILLed child surfaces EPIPE/ECONNRESET on its pipes; without listeners that error crashes the whole app.
    const failPipe = (error: unknown): void => {
      if (this.frameFailed) return
      this.frameFailed = true
      onFatalTransportError(error)
    }
    this.child.stdout.on('error', failPipe)
    this.child.stderr.on('error', failPipe)
  }

  writable(): boolean { return this.isAvailable() && this.child.stdin.writable }

  enqueue(line: string): QueuedRpcWrite {
    const rejected = (error: Error): QueuedRpcWrite => ({ done: Promise.reject(error), cancel: () => 'cancelled' })
    if (!this.writable()) return rejected(new Error('Runtime is not available'))
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_RPC_WRITE_FRAME_BYTES) return rejected(new Error('RPC write exceeded the per-message byte limit'))
    if (this.queuedWriteBytes + bytes > 32 * 1024 * 1024) return rejected(new Error('RPC write queue byte budget exceeded'))
    this.queuedWriteBytes += bytes
    let state: 'queued' | 'writing' | 'settled' | 'cancelled' = 'queued'
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - bytes)
    }
    const operation = this.writeQueue.catch(() => undefined).then(() => new Promise<void>((resolveWrite, rejectWrite) => {
      if (state === 'cancelled') { rejectWrite(new Error('RPC write was cancelled before it was sent')); return }
      if (!this.writable()) { state = 'settled'; rejectWrite(new Error('Runtime is not available')); return }
      state = 'writing'
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        state = 'settled'
        clearTimeout(deadline)
        if (error) rejectWrite(error)
        else resolveWrite()
      }
      // A child that stops reading stdin must fail the transport rather than
      // pin the write queue (and its byte budget) forever.
      const deadline = setTimeout(() => {
        const stall = new Error('Prime Agent stopped reading RPC input')
        finish(stall)
        this.onFatalTransportError(stall)
      }, this.writeDeadlineMs)
      deadline.unref()
      try { this.child.stdin.write(line, finish) } catch (error) { finish(error instanceof Error ? error : new Error(errorMessage(error))) }
    }))
    const tracked = operation.finally(release)
    this.writeQueue = tracked.catch(() => undefined)
    return {
      done: tracked,
      cancel: () => {
        if (state === 'queued' || state === 'cancelled') {
          state = 'cancelled'
          release()
          return 'cancelled'
        }
        return 'flushed'
      },
    }
  }

  endInput(): void { this.child.stdin.end() }
  destroyInput(): void { this.child.stdin.destroy() }
  pauseOutput(): void { this.child.stdout.pause() }
  stderrTail(): string { return this.recentStderr }
}
