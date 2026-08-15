import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { HarnessId } from '../../../src/types/api'
import { requireRecord, requireString } from '../validation'

const MAX_BODY_BYTES = 1_100_000
const TOKEN_TTL_MS = 24 * 60 * 60_000
const RATE_WINDOW_MS = 60_000

export interface CapabilityClaim {
  token: string
  cwd: string
  sessionPath?: string
  harness?: HarnessId
  expiresAt: number
  windowStartedAt: number
  requests: number
}

export interface CapabilityScope {
  cwd: string
  sessionPath?: string
  harness?: HarnessId
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  response.end(payload)
}

/**
 * Loopback capability broker for agent-side tools: a random bearer token per
 * runtime, injected via the child environment, scopes every call to that
 * runtime. The renderer never sees the token. Requests with an Origin header
 * are rejected outright, which blocks browsers (and DNS-rebinding pages) from
 * ever reaching the API.
 */
export abstract class CapabilityBridge {
  private server: Server | null = null
  private port = 0
  private readonly claims = new Map<string, CapabilityClaim>()

  /** Requests allowed per claim per minute. */
  protected abstract readonly rateLimit: number
  protected abstract readonly rateLimitError: string
  /** Environment handed to the agent child; `url` points at this bridge. */
  protected abstract environmentEntries(url: string, token: string): NodeJS.ProcessEnv
  /** Handle one authenticated, rate-limited, parsed call. */
  protected abstract dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown>

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => { void this.handle(request, response) })
    this.server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolveStart, reject) => {
      const server = this.server!
      const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolveStart() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  environmentFor(scope: CapabilityScope): NodeJS.ProcessEnv {
    if (!this.server || !this.port) return {}
    this.pruneClaims()
    const token = randomBytes(32).toString('base64url')
    this.claims.set(token, { token, ...scope, expiresAt: Date.now() + TOKEN_TTL_MS, windowStartedAt: Date.now(), requests: 0 })
    return this.environmentEntries(`http://127.0.0.1:${this.port}/v1/call`, token)
  }

  protected claimForToken(token: string): CapabilityClaim | undefined {
    return this.claims.get(token)
  }

  /** Idempotently revokes a runtime claim. */
  revoke(token: string | undefined): boolean {
    if (!token) return false
    const claim = this.claims.get(token)
    if (!claim) return false
    this.claims.delete(token)
    this.onClaimRevoked(claim)
    return true
  }

  /** Subclasses may release token-keyed bindings when their base claim is removed. */
  protected onClaimRevoked(_claim: CapabilityClaim): void {}

  async stop(): Promise<void> {
    for (const token of [...this.claims.keys()]) this.revoke(token)
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/call' || request.headers.origin !== undefined) {
        send(response, 404, { ok: false, error: 'Not found' }); return
      }
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) { send(response, 401, { ok: false, error: 'Unauthorized' }); return }
      const presented = authorization.slice(7)
      const claim = [...this.claims.values()].find((candidate) => safeEqual(candidate.token, presented))
      if (!claim) { send(response, 401, { ok: false, error: 'Capability expired' }); return }
      if (claim.expiresAt <= Date.now()) { this.revoke(claim.token); send(response, 401, { ok: false, error: 'Capability expired' }); return }
      if (Date.now() - claim.windowStartedAt >= RATE_WINDOW_MS) { claim.windowStartedAt = Date.now(); claim.requests = 0 }
      claim.requests += 1
      if (claim.requests > this.rateLimit) { send(response, 429, { ok: false, error: this.rateLimitError }); return }
      const raw = await this.readBody(request)
      const input = requireRecord(JSON.parse(raw), 'request')
      const method = requireString(input.method, 'method', { min: 1, max: 32, trim: true })
      const params = input.params === undefined ? {} : requireRecord(input.params, 'params')
      // Authentication above happens before an arbitrarily slow body arrives. Re-check
      // the exact claim object at the dispatch boundary so revocation cannot be raced.
      if (this.claims.get(claim.token) !== claim) { send(response, 401, { ok: false, error: 'Capability expired' }); return }
      if (claim.expiresAt <= Date.now()) { this.revoke(claim.token); send(response, 401, { ok: false, error: 'Capability expired' }); return }
      const result = await this.dispatch(method, params, claim)
      send(response, 200, { ok: true, result })
    } catch (error) {
      send(response, error instanceof SyntaxError || error instanceof TypeError ? 400 : 409, {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
      })
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) { reject(new TypeError('Request body is too large')); request.destroy(); return }
        chunks.push(chunk)
      })
      request.once('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      request.once('error', reject)
    })
  }

  private pruneClaims(): void {
    const now = Date.now()
    for (const [token, claim] of this.claims) if (claim.expiresAt <= now) this.revoke(token)
  }
}
