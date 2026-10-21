import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HarnessId } from '../../../src/types/api'
import { errorCode, isRecord } from '../validation'

const BEGIN = '===== BEGIN GOOEYPI AGENT MESSAGE ====='
const END = '===== END GOOEYPI AGENT MESSAGE ====='
const HARNESSES = new Set<HarnessId>(['prime', 'omp', 'pi'])
const KEY_BYTES = 32
let signingKey: Buffer | undefined

export interface GooeyPiAgentMessage {
  fromSessionId: string
  /** Legacy display metadata is parsed for saved v1 messages, never emitted in new model-facing envelopes. */
  fromTitle?: string
  fromHarness?: HarnessId
  text: string
}

interface SignedMetadataV1 {
  version: 1
  from_session_id: string
  from_title: string
  from_harness: HarnessId
  reply_with?: 'session_send'
  nonce: string
  sent_at: string
}

interface SignedMetadataV2 {
  version: 2
  from_session_id: string
  reply_with: 'session_send'
  nonce: string
  sent_at: string
}

interface SignedMetadataV3 {
  version: 3
  from_session_id: string
  reply_with: 'gooeypi_session_send'
  nonce: string
  sent_at: string
}

type SignedMetadata = SignedMetadataV1 | SignedMetadataV2 | SignedMetadataV3

function signature(metadata: SignedMetadata, text: string): Buffer {
  if (!signingKey) throw new Error('GooeyPi agent-message signing is not initialized')
  return createHmac('sha256', signingKey).update(JSON.stringify(metadata)).update('\0').update(text).digest()
}

/** Invalid-key recovery runs only after Electron's single-instance lock is acquired in index.ts.
 * Fresh creation is atomic even for concurrent creators; invalid-file recovery requires that startup ownership.
 */
export function loadOrCreateGooeyPiAgentMessageKey(path: string): Buffer {
  for (;;) {
    try {
      const observed = lstatSync(path)
      if (!observed.isFile() || observed.size !== KEY_BYTES) {
        const current = lstatSync(path)
        if (current.dev !== observed.dev || current.ino !== observed.ino || current.size !== observed.size
          || current.mtimeMs !== observed.mtimeMs || current.mode !== observed.mode) continue
        renameSync(path, `${path}.invalid-${randomUUID()}`)
        continue
      }
      // Read failures are not evidence of corrupt bytes and must never quarantine the key.
      const descriptor = openSync(path, 'r')
      try {
        const existing = readFileSync(descriptor)
        if (existing.length !== KEY_BYTES) throw new Error('The GooeyPi agent-message signing key changed while loading')
        if (process.platform !== 'win32' && (observed.mode & 0o077) !== 0) fchmodSync(descriptor, 0o600)
        return existing
      } finally { closeSync(descriptor) }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const created = randomBytes(KEY_BYTES)
    const temporary = `${path}.tmp-${randomUUID()}`
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      try { writeFileSync(descriptor, created); fsyncSync(descriptor) }
      finally { closeSync(descriptor) }
      try { linkSync(temporary, path) }
      catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        continue
      }
      return created
    } finally { unlinkSync(temporary) }
  }
}

export function configureGooeyPiAgentMessageSigning(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) throw new Error('The GooeyPi agent-message signing key must be 32 bytes')
  signingKey = Buffer.from(key)
}

export function encodeGooeyPiAgentMessage(message: Pick<GooeyPiAgentMessage, 'fromSessionId' | 'text'>): string {
  const unsigned: SignedMetadataV3 = {
    version: 3,
    from_session_id: message.fromSessionId,
    reply_with: 'gooeypi_session_send',
    nonce: randomUUID(),
    sent_at: new Date().toISOString(),
  }
  const metadata = JSON.stringify({ ...unsigned, signature: signature(unsigned, message.text).toString('base64url') })
  return `${BEGIN}\n${metadata}\n${END}\n\n${message.text}`
}

/** Recognizes only the exact app-owned envelope shape at the start of a user record. */
export function parseGooeyPiAgentMessage(value: string): GooeyPiAgentMessage | undefined {
  if (!value.startsWith(`${BEGIN}\n`)) return undefined
  const metadataEnd = value.indexOf(`\n${END}\n`, BEGIN.length + 1)
  if (metadataEnd < 0) return undefined
  let metadata: unknown
  try { metadata = JSON.parse(value.slice(BEGIN.length + 1, metadataEnd)) } catch { return undefined }
  if (!isRecord(metadata) || (metadata.version !== 1 && metadata.version !== 2 && metadata.version !== 3)) return undefined
  const fromSessionId = metadata.from_session_id
  const replyWith = metadata.reply_with
  const nonce = metadata.nonce
  const sentAt = metadata.sent_at
  const encodedSignature = metadata.signature
  if (typeof fromSessionId !== 'string' || fromSessionId.length < 1 || fromSessionId.length > 128) return undefined
  if (metadata.version === 2 && replyWith !== 'session_send') return undefined
  if (metadata.version === 3 && replyWith !== 'gooeypi_session_send') return undefined
  if (metadata.version === 1 && replyWith !== undefined && replyWith !== 'session_send') return undefined
  if (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) return undefined
  if (typeof sentAt !== 'string' || sentAt.length > 64 || !Number.isFinite(Date.parse(sentAt))) return undefined
  if (typeof encodedSignature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)) return undefined
  const text = value.slice(metadataEnd + END.length + 2).replace(/^\n/, '')
  if (!text) return undefined
  if (!signingKey) return undefined
  let fromTitle: string | undefined
  let fromHarness: HarnessId | undefined
  let unsigned: SignedMetadata
  if (metadata.version === 1) {
    if (typeof metadata.from_title !== 'string' || metadata.from_title.length < 1 || metadata.from_title.length > 200) return undefined
    if (typeof metadata.from_harness !== 'string' || !HARNESSES.has(metadata.from_harness as HarnessId)) return undefined
    fromTitle = metadata.from_title
    fromHarness = metadata.from_harness as HarnessId
    unsigned = {
      version: 1, from_session_id: fromSessionId, from_title: fromTitle, from_harness: fromHarness,
      ...(replyWith === 'session_send' ? { reply_with: replyWith } : {}), nonce, sent_at: sentAt,
    }
  } else if (metadata.version === 2) {
    unsigned = { version: 2, from_session_id: fromSessionId, reply_with: 'session_send', nonce, sent_at: sentAt }
  } else {
    unsigned = { version: 3, from_session_id: fromSessionId, reply_with: 'gooeypi_session_send', nonce, sent_at: sentAt }
  }
  const actual = Buffer.from(encodedSignature, 'base64url')
  const expected = signature(unsigned, text)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  return { fromSessionId, ...(fromTitle ? { fromTitle } : {}), ...(fromHarness ? { fromHarness } : {}), text }
}
