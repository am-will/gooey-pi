/**
 * The single home for JSONL frame (per-record) size limits.
 *
 * Every JSONL channel enforces one of these documented tiers. Readers of the
 * SAME file must share one tier: the session catalog (metadata) reader and
 * the transcript reader previously disagreed (64 MiB vs 8 MiB), which let a
 * session appear in the catalog while its transcript refused to open.
 *
 * Tiers, largest to smallest:
 * - SESSION_FILE_RECORD_LIMIT_BYTES (64 MiB): records in `~/.prime` session
 *   .jsonl files. Session files are produced by the local Prime Agent, so this
 *   tier is deliberately generous; downstream display budgets
 *   (`MAX_TRANSCRIPT_GRAPH_BYTES` and friends) bound retained memory.
 * - RPC_READ_FRAME_LIMIT_BYTES (16 MiB): frames read from an agent RPC child's
 *   stdout. Larger than the write tier because responses embed tool output.
 * - RPC_WRITE_FRAME_LIMIT_BYTES (2 MiB): frames Prime Work writes to an agent
 *   RPC child's stdin (commands, prompts, and base64 image payloads).
 * - DAEMON_FRAME_LIMIT_BYTES (1 MiB): control frames on the Prime Agent
 *   daemon socket; these are small protocol envelopes.
 *
 * It also holds the whole-file session limits, which the catalog (metadata)
 * reader and the transcript reader must share for the same reason: a session
 * the catalog lists must stay openable.
 * - SESSION_FILE_MAX_BYTES (256 MiB): the largest session file either reader opens.
 * - SESSION_FILE_MAX_RECORDS (200,000): the most records either reader accepts.
 */
export const SESSION_FILE_RECORD_LIMIT_BYTES = 64 * 1024 * 1024
export const SESSION_FILE_MAX_BYTES = 256 * 1024 * 1024
export const SESSION_FILE_MAX_RECORDS = 200_000
export const RPC_READ_FRAME_LIMIT_BYTES = 16 * 1024 * 1024
export const RPC_WRITE_FRAME_LIMIT_BYTES = 2 * 1024 * 1024
export const DAEMON_FRAME_LIMIT_BYTES = 1024 * 1024
