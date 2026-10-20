import type { Stats } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { mapLimit } from '../lib/async'
import { isPathWithin, isRecord } from '../validation'
import { fallbackModelFromRecord, fallbackNoticeText } from '../../../src/lib/events/model-fallback'
import type { SessionCatalogEntry, SessionCatalogIo } from './catalog'
import {
  ingestMessageActivity,
  MAX_METADATA_RECORDS,
  statusFrom,
  type JsonRecord,
  type MetadataLineParser,
  type SessionMetadata,
} from './metadata'
import {
  boundedString,
  compactText,
  createTranscriptReader,
  MAX_PART_TEXT_CHARS,
  textFromContent,
  validTimestamp,
  type TranscriptFileReader,
} from './transcript'

/**
 * Shared machinery for the bucketed JSONL session layouts the pi and OMP
 * harnesses use: `<root>/<bucket>/<ISO timestamp with dashes>_<uuid>.jsonl`,
 * a `{"type":"session","version":3,...}` header, then append-only entries with
 * `id`/`parentId` forming a branch tree. Only the display-name and
 * `model_change` record shapes differ between the two dialects.
 */
const MAX_BUCKET_DIRECTORIES = 4_096
const MAX_BUCKET_CONCURRENCY = 8

const BUCKETED_SESSION_FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f][0-9a-f-]*\.jsonl$/i

/** Creation time encoded in a session file name (`2026-08-10T22-41-20-246Z_<uuid>.jsonl`), bucket prefix allowed. */
export function timestampFromBucketedSessionName(name: string): number | undefined {
  const file = name.slice(name.lastIndexOf('/') + 1)
  const match = BUCKETED_SESSION_FILE_NAME.exec(file)
  if (!match) return undefined
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Catalog IO that recurses exactly one bucket-directory level under a session
 * root. Discovered entries carry bucket-relative names so the shared catalog
 * joins, stats, canonicalizes, caches, and bounds them exactly like flat Prime
 * entries.
 */
export function createBucketedCatalogIo(): SessionCatalogIo {
  return {
    async readDirectory(root: string): Promise<readonly SessionCatalogEntry[]> {
      const buckets = (await readdir(root, { withFileTypes: true }))
        .filter((bucket) => bucket.isDirectory() && !bucket.name.startsWith('.'))
        .slice(0, MAX_BUCKET_DIRECTORIES)
      const perBucket = await mapLimit(buckets, MAX_BUCKET_CONCURRENCY, async (bucket): Promise<SessionCatalogEntry[] | null> => {
        try {
          return (await readdir(join(root, bucket.name), { withFileTypes: true }))
            .filter((file) => file.name.endsWith('.jsonl') && !file.name.startsWith('.'))
            .map((file) => ({
              name: `${bucket.name}/${file.name}`,
              isFile: () => file.isFile(),
              isSymbolicLink: () => file.isSymbolicLink(),
            }))
        } catch { return null }
      })
      return perBucket.flat()
    },
    canonicalize: realpath,
    inspect: stat,
    inspectLink: lstat,
  }
}

/** Bucketed session paths sit exactly one bucket directory below the root and end in `.jsonl`. */
export function isBucketedSessionPath(sessionRootRealPath: string, sessionRealPath: string): boolean {
  if (!isPathWithin(sessionRootRealPath, sessionRealPath) || !sessionRealPath.endsWith('.jsonl')) return false
  const segments = relative(sessionRootRealPath, sessionRealPath).split(sep)
  return segments.length === 2 && segments.every((segment) => segment.length > 0)
}

export interface BucketedMetadataAccumulator {
  id: string
  projectPath: string
  createdAt: string
  updatedAt: string
  sawRecordTimestamp: boolean
  lastUserMessageAt?: string
  model?: string
  provider?: string
  thinkingLevel?: string
  /** Harness-reported session title; falls back to the first user prompt. */
  displayName?: string
  firstUser: string
  preview: string
  lastRole?: string
  stopReason?: string
  records: number
}

function idFromBucketedFileName(filePath: string): string {
  const base = basename(filePath, '.jsonl')
  const separator = base.indexOf('_')
  return separator >= 0 ? base.slice(separator + 1) : base
}

function createBucketedAccumulator(filePath: string, fileStat: Stats): BucketedMetadataAccumulator {
  const nameTimestamp = timestampFromBucketedSessionName(basename(filePath))
  return {
    id: idFromBucketedFileName(filePath),
    projectPath: '',
    createdAt: nameTimestamp !== undefined ? new Date(nameTimestamp).toISOString() : fileStat.birthtime.toISOString(),
    updatedAt: fileStat.mtime.toISOString(),
    sawRecordTimestamp: false,
    firstUser: '',
    preview: '',
    records: 0,
  }
}

function bucketedMetadataFromAccumulator(state: BucketedMetadataAccumulator, filePath: string, fallbackUpdated: string): SessionMetadata {
  return {
    id: state.id,
    filePath,
    projectPath: state.projectPath,
    title: compactText(state.displayName ?? '', 100) || compactText(state.firstUser, 100) || 'Untitled session',
    createdAt: state.createdAt,
    updatedAt: state.sawRecordTimestamp ? state.updatedAt : fallbackUpdated,
    lastUserMessageAt: state.lastUserMessageAt ?? state.createdAt,
    status: statusFrom(undefined, undefined, state.lastRole, state.stopReason),
    model: state.model,
    provider: state.provider,
    thinkingLevel: state.thinkingLevel,
    depth: 0,
    pinned: false,
    unread: false,
    preview: compactText(state.preview || state.firstUser),
  }
}

/**
 * Handles the record types whose shape differs between bucketed dialects:
 * `model_change` and the harness's display-name record.
 */
export type BucketedRecordIngest = (state: BucketedMetadataAccumulator, record: JsonRecord) => void

/**
 * Metadata parser over the shared bucketed record set (`session` header,
 * `thinking_level_change`, `message`), delegating dialect-specific records to
 * `ingestRecord`.
 */
export function createBucketedMetadataParser(ingestRecord: BucketedRecordIngest): MetadataLineParser<BucketedMetadataAccumulator> {
  return {
    createAccumulator: createBucketedAccumulator,
    ingestLine: (state, line) => {
      if (!line) return
      if (++state.records > MAX_METADATA_RECORDS) throw new Error('Session file has too many records')
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      if (!isRecord(value)) return
      const recordTimestamp = validTimestamp(value.timestamp, '')
      if (recordTimestamp) {
        state.updatedAt = recordTimestamp
        state.sawRecordTimestamp = true
      }
      if (value.type === 'session') {
        if (typeof value.id === 'string') state.id = value.id
        if (typeof value.cwd === 'string') state.projectPath = value.cwd
        state.createdAt = validTimestamp(value.timestamp, state.createdAt)
      } else if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') state.thinkingLevel = value.thinkingLevel
      else if (value.type === 'message') ingestMessageActivity(state, value)
      else ingestRecord(state, value)
    },
    snapshot: bucketedMetadataFromAccumulator,
  }
}

/**
 * Transcript reader over the shared branch machinery for dialects where
 * `branch_summary` records are renderable (and can anchor the active leaf) in
 * addition to the shared `message`, `compaction`, and displayed
 * `custom_message` types.
 */
export function createBranchSummaryTranscriptReader(): TranscriptFileReader {
  return createTranscriptReader({
    isRenderable: (entry) => entry.type === 'message' || entry.type === 'compaction' || entry.type === 'branch_summary'
      || (entry.type === 'custom_message' && entry.display === true)
      || Boolean(fallbackModelFromRecord(entry)),
    renderEntry: (entry, safeId) => {
      const fallback = fallbackModelFromRecord(entry)
      if (fallback) {
        const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
        return {
          id: safeId,
          role: 'system',
          timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          parts: [{ type: 'text', text: boundedString(fallbackNoticeText(fallback.label), MAX_PART_TEXT_CHARS) }],
        }
      }
      if (entry.type !== 'branch_summary') return undefined
      const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
      const text = typeof entry.summary === 'string' ? entry.summary : textFromContent(entry.content, MAX_PART_TEXT_CHARS)
      return {
        id: safeId,
        role: 'system',
        timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        parts: [{ type: 'text', text: boundedString(text, MAX_PART_TEXT_CHARS) }],
      }
    },
  })
}
