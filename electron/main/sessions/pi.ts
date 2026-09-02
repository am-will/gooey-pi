import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '../validation'
import type { SessionServiceOptions } from '../sessions'
import type { SessionCatalogIo } from './catalog'
import {
  createBranchSummaryTranscriptReader,
  createBucketedCatalogIo,
  createBucketedMetadataParser,
  isBucketedSessionPath,
  timestampFromBucketedSessionName,
} from './bucketed'
import {
  createIncrementalMetadataReader,
  nodeMetadataReaderIo,
  type SessionMetadataReader,
  type SessionMetadataReaderIo,
} from './metadata'
import type { TranscriptFileReader } from './transcript'

/**
 * Pi session JSONL v3 layout under `~/.pi/agent/sessions/<bucket>/`:
 * - Line 1 is the `{"type":"session","version":3,...}` header (no OMP-style
 *   title slot); everything after it is append-only entries with `id`/`parentId`
 *   forming a branch tree. The project path comes from the header `cwd` —
 *   decoding the bucket directory name is lossy for paths containing dashes.
 * - The display name rides `session_info` entries (`name`); the latest one in
 *   file order wins. There is no `title_change` entry and no in-place rewrite.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 *
 * Everything except the display-name and `model_change` record shapes is shared
 * with OMP through `./bucketed`.
 */
export function piSessionRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export const piTimestampFromSessionName = timestampFromBucketedSessionName

export function createPiCatalogIo(): SessionCatalogIo {
  return createBucketedCatalogIo()
}

export const isPiSessionPath = isBucketedSessionPath

const piMetadataParser = createBucketedMetadataParser((state, value) => {
  if (value.type === 'model_change') {
    // Pi records split `provider` + `modelId` fields (Prime's shape), unlike
    // OMP's single `provider/id` string.
    if (typeof value.modelId === 'string') state.model = value.modelId
    if (typeof value.provider === 'string') state.provider = value.provider
  } else if (value.type === 'session_info' && typeof value.name === 'string') {
    // The latest session_info name wins; an empty name falls back to the prompt.
    state.displayName = value.name
  }
})

/**
 * Pi metadata reader: the file is append-only from byte zero (no mutable title
 * slot), so the shared incremental machinery covers the whole file.
 */
export function createPiSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  return createIncrementalMetadataReader(piMetadataParser, io)
}
/**
 * Append a `session_info` record to a pi session file as a fallback rename
 * when no live runtime is available. Pi's metadata reader picks up the
 * latest `session_info` name in file order, so the new name takes effect
 * immediately on the next catalog scan.
 *
 * Pi v3 entries are an id/parentId branch tree; every fixture and the
 * header comment above carry both fields. Generate a short hex id and
 * parent it to the current leaf so a later pi resume can load the file.
 */
export function appendPiSessionInfo(filePath: string, title: string): boolean {
  try {
    const parentId = currentPiLeafId(filePath)
    const record = `${JSON.stringify({
      type: 'session_info',
      id: randomBytes(4).toString('hex'),
      parentId,
      timestamp: new Date().toISOString(),
      name: title,
    })}\n`
    appendFileSync(filePath, record, 'utf8')
    return true
  } catch {
    return false
  }
}

function currentPiLeafId(filePath: string): string | null {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    const window = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(window)
    readSync(fd, buf, 0, window, size - window)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      if (!isRecord(value) || value.type === 'session' || typeof value.id !== 'string' || !value.id) continue
      return value.id
    }
    return null
  } finally {
    closeSync(fd)
  }
}
export const readPiTranscript: TranscriptFileReader = createBranchSummaryTranscriptReader()

/**
 * Fully wired SessionService options for a pi session root. Construct the
 * service with a null CLI path: pi has no `prime-agent list` live overlay.
 */
export function piSessionServiceOptions(sessionRoot = piSessionRoot()): SessionServiceOptions {
  return {
    harness: 'pi',
    sessionRoot,
    catalogIo: createPiCatalogIo(),
    catalogNameTimestamp: piTimestampFromSessionName,
    metadataReader: createPiSessionMetadataReader(),
    transcriptReader: readPiTranscript,
    isSessionPathAuthorized: isPiSessionPath,
    // Session files sit one bucket directory below the root; bounded one-level
    // watchers keep catalog refresh behavior identical across platforms.
    recursiveWatch: true,
    renameFile: appendPiSessionInfo,
  }
}
