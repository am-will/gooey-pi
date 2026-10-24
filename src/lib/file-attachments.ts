// Text files attached in the composer reach the harness inside the prompt as a delimited block,
// the same channel terminal selections and annotations use, so every harness can read them.

export const FILE_ATTACHMENTS_BEGIN = '===== BEGIN ATTACHED FILES ====='
export const FILE_ATTACHMENTS_END = '===== END ATTACHED FILES ====='
/** Per-file cap; the shared RPC frame limit still bounds the composed message as a whole. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024

export interface TextFileAttachment {
  name: string
  text: string
}

const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/x-ndjson', 'application/xml', 'application/yaml',
  'application/x-yaml', 'application/toml', 'application/javascript', 'application/x-javascript',
  'application/typescript', 'application/x-typescript', 'application/x-sh', 'application/sql', 'application/graphql',
])

// Chromium leaves `File.type` empty for many source files, so extensions decide those.
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org', 'tex', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r',
  'scala', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'zig', 'nix', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'graphql', 'gql', 'proto', 'diff', 'patch',
])
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'license', 'readme', '.gitignore', '.editorconfig'])

/** Whether a staged file should be read as text rather than treated as an unsupported binary. */
export function isTextAttachmentFile({ name, type }: { name: string; type: string }): boolean {
  const mimeType = type.toLowerCase().split(';')[0].trim()
  if (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType)) return true
  const basename = name.toLowerCase()
  if (TEXT_BASENAMES.has(basename)) return true
  const dot = basename.lastIndexOf('.')
  return dot > 0 && TEXT_EXTENSIONS.has(basename.slice(dot + 1))
}

/** Decodes strict UTF-8 text; returns null for bytes that are not text, such as a binary renamed `.txt`. */
export function decodeTextAttachment(buffer: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

const singleLine = (value: string) => value.replace(/\s+/g, ' ').trim()
// Lines that would read as this block's own structure are prefixed so file contents can never close
// the block early or fabricate another file's header.
const STRUCTURE = String.raw`(?:===== (?:BEGIN|END) ATTACHED FILES =====|--- (?:File \d+ of \d+: .*|End of file \d+) ---)`
const STRUCTURE_LINE = new RegExp(`^${STRUCTURE}$`, 'gm')
const ESCAPED_STRUCTURE_LINE = new RegExp(String.raw`^\[escaped\] (?=${STRUCTURE}$)`, 'gm')
const escapeStructure = (text: string) => text.replace(STRUCTURE_LINE, (line) => `[escaped] ${line}`)

export function serializeFileAttachments(files: readonly TextFileAttachment[]): string {
  const lines = [FILE_ATTACHMENTS_BEGIN, `The user attached ${files.length} text file${files.length === 1 ? '' : 's'}. Contents follow verbatim between the file markers.`]
  files.forEach((file, index) => {
    lines.push('', `--- File ${index + 1} of ${files.length}: ${singleLine(file.name)} ---`, escapeStructure(file.text.replace(/\r\n?/g, '\n').replace(/\n$/, '')), `--- End of file ${index + 1} ---`)
  })
  lines.push('', FILE_ATTACHMENTS_END)
  return lines.join('\n')
}

export function appendFileAttachmentsToPrompt(prompt: string, files: readonly TextFileAttachment[]): string {
  if (files.length === 0) return prompt
  return `${prompt}\n\n${serializeFileAttachments(files)}`
}

export interface FileAttachmentBlockSplit {
  /** The user's own message text with the attached-files block removed. */
  text: string
  /** The raw serialized block, or null when the text has none. */
  block: string | null
  files: TextFileAttachment[]
}

/** Splits a sent prompt back into the user's text and its attached files so the transcript can collapse them. */
export function splitFileAttachmentBlock(text: string): FileAttachmentBlockSplit {
  // Markers count only as whole lines: escaped copies inside file contents still contain them.
  const begin = new RegExp(`^${FILE_ATTACHMENTS_BEGIN}$`, 'm').exec(text)?.index ?? -1
  if (begin === -1) return { text, block: null, files: [] }
  const endMatch = new RegExp(`^${FILE_ATTACHMENTS_END}$`, 'gm')
  endMatch.lastIndex = begin
  const end = endMatch.exec(text)?.index ?? -1
  if (end === -1) return { text, block: null, files: [] }
  const block = text.slice(begin, end + FILE_ATTACHMENTS_END.length)
  const rest = `${text.slice(0, begin)}${text.slice(end + FILE_ATTACHMENTS_END.length)}`.trim()
  const files = [...block.matchAll(/^--- File (\d+) of \d+: (.*) ---\n([\s\S]*?)\n--- End of file \1 ---$/gm)]
    .map(([, , name, body]) => ({ name, text: body.replace(ESCAPED_STRUCTURE_LINE, '') }))
  return { text: rest, block, files }
}
