import { homedir } from 'node:os'
import { join } from 'node:path'
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
  }
}
