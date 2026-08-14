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
import { compactText, type TranscriptFileReader } from './transcript'

/**
 * OMP session JSONL v3 layout under `~/.omp/agent/sessions/<bucket>/`:
 * - Line 1 is a fixed-width 256-byte title slot (`{"type":"title",...,"pad":"..."}`)
 *   that OMP REWRITES IN PLACE, keeping the byte length constant.
 * - Line 2 is the `{"type":"session","version":3,...}` header; everything after
 *   it is append-only entries with `id`/`parentId` forming a branch tree.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 *
 * Everything except the title slot and the display-name and `model_change`
 * record shapes is shared with pi through `./bucketed`.
 */
export const OMP_TITLE_SLOT_BYTES = 256

export function ompSessionRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions')
}

export const ompTimestampFromSessionName = timestampFromBucketedSessionName

export function createOmpCatalogIo(): SessionCatalogIo {
  return createBucketedCatalogIo()
}

export const isOmpSessionPath = isBucketedSessionPath

const ompMetadataParser = createBucketedMetadataParser((state, value) => {
  if (value.type === 'model_change' && typeof value.model === 'string') {
    // OMP records `model` as a single `provider/id` string; a `role` other
    // than the default selects a task-specific model, not the session model.
    if (value.role === undefined || value.role === 'default') {
      const separator = value.model.indexOf('/')
      state.provider = separator > 0 ? value.model.slice(0, separator) : undefined
      state.model = separator > 0 ? value.model.slice(separator + 1) : value.model
    }
  } else if ((value.type === 'title_change' || value.type === 'title') && typeof value.title === 'string') {
    state.displayName = value.title
  }
})

async function readOmpTitleSlot(io: SessionMetadataReaderIo, filePath: string): Promise<string | undefined> {
  const stream = io.openStream(filePath, 0, OMP_TITLE_SLOT_BYTES - 1)
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer)
  } finally {
    stream.destroy()
  }
  const slot = Buffer.concat(chunks)
  const newline = slot.indexOf(0x0a)
  if (newline < 0) return undefined
  let value: unknown
  try { value = JSON.parse(slot.toString('utf8', 0, newline)) } catch { return undefined }
  if (!isRecord(value) || value.type !== 'title' || typeof value.title !== 'string' || !value.title.trim()) return undefined
  return value.title
}

/**
 * OMP metadata reader: the append-only tail (everything after the 256-byte
 * title slot) reuses the shared incremental machinery, while the slot itself
 * is re-read on every snapshot because OMP rewrites it in place without
 * changing the file size of the parsed range.
 */
export function createOmpSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  const readTail = createIncrementalMetadataReader(ompMetadataParser, io, OMP_TITLE_SLOT_BYTES)
  return async (filePath, knownStat) => {
    const [metadata, title] = await Promise.all([readTail(filePath, knownStat), readOmpTitleSlot(io, filePath)])
    if (title !== undefined) metadata.title = compactText(title, 100)
    return metadata
  }
}

export const readOmpTranscript: TranscriptFileReader = createBranchSummaryTranscriptReader()

/**
 * Fully wired SessionService options for an OMP session root. Construct the
 * service with a null CLI path: OMP has no `prime-agent list` live overlay.
 */
export function ompSessionServiceOptions(sessionRoot = ompSessionRoot()): SessionServiceOptions {
  return {
    harness: 'omp',
    sessionRoot,
    catalogIo: createOmpCatalogIo(),
    catalogNameTimestamp: ompTimestampFromSessionName,
    metadataReader: createOmpSessionMetadataReader(),
    transcriptReader: readOmpTranscript,
    isSessionPathAuthorized: isOmpSessionPath,
    // Session files sit one bucket directory below the root; bounded one-level
    // watchers keep catalog refresh behavior identical across platforms.
    recursiveWatch: true,
  }
}
