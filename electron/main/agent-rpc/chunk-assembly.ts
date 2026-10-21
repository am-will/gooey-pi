import { performance } from 'node:perf_hooks'
import { RPC_READ_FRAME_LIMIT_BYTES } from '../jsonl-limits'
import type { RpcObject } from './types'

interface ChunkAssembly {
  count: number
  nextIndex: number
  bytes: number
  parts: Buffer[]
  expiresAt: number
}

export interface RpcChunkAssemblyTimer {
  unref(): void
}

export interface RpcChunkAssemblyTiming {
  /** Monotonic elapsed time; wall-clock adjustments must not affect expiry. */
  now(): number
  schedule(callback: () => void, delayMs: number): RpcChunkAssemblyTimer
  cancel(timer: RpcChunkAssemblyTimer): void
}

/** The runtime side of a reassembler: where finished frames and limit events go. */
export interface RpcChunkAssemblyHost {
  readonly agentName: string
  /** Handles a frame decoded from a completed chunk sequence. */
  deliver(frame: unknown): void
  emit(event: RpcObject): void
  /** False once the runtime stopped or its transport failed; no sweep timer is armed then. */
  active(): boolean
}

const MAX_RPC_CHUNK_COUNT = 4096
const MAX_CONCURRENT_RPC_CHUNK_IDS = 4
export const RPC_CHUNK_ASSEMBLY_INACTIVITY_MS = 30_000
export const DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING: RpcChunkAssemblyTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timer) => clearTimeout(timer as NodeJS.Timeout),
}

/**
 * v2 chunked frames: base64 rpc_chunk sequences reassembled per chunkId,
 * bounded by the shared read frame limit and small concurrency caps.
 */
export class RpcChunkAssembler {
  private readonly abandoned = new Set<string>()
  private readonly assemblies = new Map<string, ChunkAssembly>()
  private sweepTimer: RpcChunkAssemblyTimer | null = null
  private accepting = true

  constructor(
    private readonly host: RpcChunkAssemblyHost,
    private readonly timing: RpcChunkAssemblyTiming = DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING,
  ) {}

  accept(frame: RpcObject): void {
    if (!this.accepting) return
    const chunkId = frame.chunkId
    if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 128) {
      this.failReassembly(undefined, 'chunked frame carried an invalid chunkId')
      return
    }
    if (this.abandoned.has(chunkId)) return
    const index = frame.index
    const count = frame.count
    if (!Number.isSafeInteger(index) || Number(index) < 0
      || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > MAX_RPC_CHUNK_COUNT
      || typeof frame.data !== 'string') {
      this.failReassembly(chunkId, 'chunked frame carried invalid sequencing')
      return
    }
    if (this.expire(chunkId) && index !== 0) return
    const assembly = this.assemblies.get(chunkId)
    if (!assembly) {
      if (index !== 0) {
        this.failReassembly(chunkId, 'chunk indices arrived out of order')
        return
      }
      if (this.assemblies.size >= MAX_CONCURRENT_RPC_CHUNK_IDS) {
        this.failReassembly(chunkId, 'too many concurrent chunk reassemblies')
        return
      }
    } else if (index !== assembly.nextIndex || count !== assembly.count) {
      this.failReassembly(chunkId, 'chunk indices arrived out of order')
      return
    }
    if (frame.data.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(frame.data)) {
      this.failReassembly(chunkId, 'chunk data was not valid base64')
      return
    }
    const decoded = Buffer.from(frame.data, 'base64')
    if (frame.byteLength !== undefined && frame.byteLength !== decoded.length) {
      this.failReassembly(chunkId, 'chunk byteLength did not match its data')
      return
    }
    const current = assembly ?? { count: Number(count), nextIndex: 0, bytes: 0, parts: [], expiresAt: 0 }
    if (current.bytes + decoded.length > RPC_READ_FRAME_LIMIT_BYTES) {
      this.failReassembly(chunkId, 'chunked frame exceeded the maximum frame size')
      return
    }
    current.bytes += decoded.length
    current.parts.push(decoded)
    current.nextIndex += 1
    // A new prefix always needs an initial deadline, including an empty first
    // chunk. Once admitted, only retained-byte progress extends its lifetime.
    if (!assembly || decoded.length > 0) current.expiresAt = this.timing.now() + RPC_CHUNK_ASSEMBLY_INACTIVITY_MS
    if (current.nextIndex < current.count) {
      this.assemblies.set(chunkId, current)
      this.rescheduleSweep()
      return
    }
    this.assemblies.delete(chunkId)
    this.rescheduleSweep()
    let value: unknown
    try { value = JSON.parse(Buffer.concat(current.parts).toString('utf8')) } catch {
      this.dispose()
      this.host.emit({ type: 'transport_limit', kind: 'frame', error: `${this.host.agentName} emitted a malformed chunked frame` })
      return
    }
    this.host.deliver(value)
  }

  /** Stops accepting chunks for good, dropping every partial frame. */
  close(): void {
    this.accepting = false
    this.dispose()
  }

  /** Drops every partial frame; later chunks start new reassemblies. */
  dispose(): void {
    if (this.sweepTimer) this.timing.cancel(this.sweepTimer)
    this.sweepTimer = null
    this.assemblies.clear()
  }

  /** A broken reassembly is dropped without killing the runtime: the agent is still running, so the renderer reconciles from disk. */
  private failReassembly(chunkId: string | undefined, error: string): void {
    if (chunkId !== undefined) {
      this.assemblies.delete(chunkId)
      this.rememberAbandoned(chunkId)
      this.rescheduleSweep()
    }
    this.host.emit({ type: 'transport_limit', kind: 'chunk', error })
  }

  private rememberAbandoned(chunkId: string): void {
    this.abandoned.add(chunkId)
    while (this.abandoned.size > 16) {
      const oldest = this.abandoned.values().next().value
      if (oldest !== undefined) this.abandoned.delete(oldest)
    }
  }

  /** Keeps one unref'd timer aimed at the earliest inactivity deadline across the bounded assembly map. */
  private rescheduleSweep(): void {
    if (this.sweepTimer) this.timing.cancel(this.sweepTimer)
    this.sweepTimer = null
    if (this.assemblies.size === 0 || !this.host.active()) return
    const deadline = Math.min(...[...this.assemblies.values()].map((assembly) => assembly.expiresAt))
    const timer = this.timing.schedule(() => {
      if (this.sweepTimer !== timer) return
      this.sweepTimer = null
      this.expire()
    }, Math.max(0, deadline - this.timing.now()))
    timer.unref()
    this.sweepTimer = timer
  }

  private expire(wantedChunkId?: string): boolean {
    const now = this.timing.now()
    let expiredAny = false
    let wantedExpired = false
    for (const [chunkId, assembly] of this.assemblies) {
      if (assembly.expiresAt > now) continue
      this.assemblies.delete(chunkId)
      this.rememberAbandoned(chunkId)
      expiredAny = true
      if (chunkId === wantedChunkId) wantedExpired = true
      this.host.emit({
        type: 'transport_limit',
        kind: 'chunk',
        error: 'RPC chunk assembly expired after inactivity',
      })
    }
    if (expiredAny || this.sweepTimer === null) this.rescheduleSweep()
    return wantedExpired
  }
}
