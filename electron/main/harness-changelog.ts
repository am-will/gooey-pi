import { open, realpath, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isNewerVersion } from './harness-updates'

const MAX_CHANGELOG_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_JSON_BYTES = 64 * 1024
const MAX_WALK_UP_LEVELS = 5
const MAX_SECTIONS = 30
const MAX_OUTPUT_CHARS = 120_000
/** `## [0.84.1] - 2026-08-07` and the bracketless/dateless variants. */
const SECTION_HEADING = /^##\s+\[?v?([0-9][0-9A-Za-z.+-]{0,63})\]?.*$/

/**
 * Reads the CHANGELOG.md that ships inside a harness's installed npm package,
 * located by resolving the discovered executable's real path and walking up
 * to the directory whose package.json names the expected package. The name
 * gate keeps an unusual executable override from turning this into an
 * arbitrary-file read; the byte cap keeps a hostile file from ballooning.
 * Returns null whenever the layout does not match (standalone binaries,
 * bundled builds) — a missing changelog is a normal outcome, not an error.
 */
export async function readInstalledChangelog(executablePath: string, expectedPackage: string): Promise<string | null> {
  let current: string
  try { current = dirname(await realpath(executablePath)) } catch { return null }
  for (let level = 0; level < MAX_WALK_UP_LEVELS; level += 1) {
    try {
      const manifest = await readFile(join(current, 'package.json'), { encoding: 'utf8' })
      if (manifest.length <= MAX_PACKAGE_JSON_BYTES && (JSON.parse(manifest) as { name?: unknown }).name === expectedPackage) {
        return await readBounded(join(current, 'CHANGELOG.md'))
      }
    } catch { /* not a package root; keep walking */ }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** Newest sections come first, so a capped head read keeps recent releases and drops only ancient history. */
async function readBounded(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(MAX_CHANGELOG_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_CHANGELOG_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch { return null } finally { await handle?.close().catch(() => undefined) }
}

export interface ChangelogSlice {
  markdown: string
  toVersion: string
}

/**
 * Cuts the release sections newer than `sinceVersion` up to and including
 * `toVersion`. Without a `sinceVersion` (nothing seen yet) only the
 * `toVersion` section is returned rather than the whole history. Returns
 * null when no section matches — for example a changelog that has not
 * caught up with the installed build.
 */
export function sliceChangelog(markdown: string, toVersion: string, sinceVersion?: string): ChangelogSlice | null {
  const lines = markdown.split('\n')
  const sections: Array<{ version: string; lines: string[] }> = []
  let active: { version: string; lines: string[] } | null = null
  for (const line of lines) {
    const heading = line.match(SECTION_HEADING)
    if (heading) {
      if (sections.length >= MAX_SECTIONS) break
      active = { version: heading[1], lines: [line] }
      sections.push(active)
      continue
    }
    active?.lines.push(line)
  }
  const included = sections.filter(({ version }) => {
    if (isNewerVersion(version, toVersion)) return false
    if (sinceVersion) return isNewerVersion(version, sinceVersion)
    return version === toVersion
  })
  if (!included.length) return null
  const joined = included.map((section) => section.lines.join('\n').trim()).join('\n\n')
  return {
    markdown: joined.length > MAX_OUTPUT_CHARS ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n\n…` : joined,
    toVersion: included[0].version,
  }
}
