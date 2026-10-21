import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { ProcessOutcome } from '../../../src/types/api'
import { errorCode, isRecord, requireString } from '../validation'
import { readAtMost } from './file-io'
import { prepareProjectSettingsPath } from './mcp'

const EXTENSION_SUFFIXES = new Set(['.ts', '.js', '.mjs', '.cjs'])
const MAX_EXTENSION_BYTES = 4 * 1024 * 1024

export type ValidatedExtensionInstallInput = { source: string } & (
  | { scope: 'user' }
  | { scope: 'project'; projectPath: string }
)

export function validateExtensionInstallInput(value: unknown): ValidatedExtensionInstallInput {
  if (!isRecord(value)) throw new TypeError('Extension installation must contain an object')
  const requested = requireString(value.source, 'extension source', { min: 1, max: 4_096, trim: true })
  if (!isAbsolute(requested)) throw new TypeError('Extension source must be an absolute local file path')
  let source: string
  try { source = realpathSync(requested) } catch { throw new TypeError('Extension source does not exist') }
  const stat = lstatSync(source)
  if (!stat.isFile()) throw new TypeError('Extension source must be a regular file')
  if (!EXTENSION_SUFFIXES.has(extname(source).toLowerCase())) throw new TypeError('Extension source must be a .ts, .js, .mjs, or .cjs file')
  if (stat.size > MAX_EXTENSION_BYTES) throw new TypeError(`Extension source must not exceed ${MAX_EXTENSION_BYTES} bytes`)
  if (value.scope !== 'user' && value.scope !== 'project') throw new TypeError('Extension scope must be user or project')
  return value.scope === 'project'
    ? { source, scope: 'project', projectPath: requireString(value.projectPath, 'projectPath', { min: 1, max: 4_096 }) }
    : { source, scope: 'user' }
}

function sameFile(path: string, dev: bigint, ino: bigint): boolean {
  try {
    const stat = lstatSync(path, { bigint: true })
    return stat.isFile() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino
  } catch { return false }
}

export async function installOmpExtension(
  input: ValidatedExtensionInstallInput,
  agentDir: string,
): Promise<ProcessOutcome> {
  const { content, truncated } = await readAtMost(input.source, MAX_EXTENSION_BYTES)
  if (truncated) throw new TypeError(`Extension source must not exceed ${MAX_EXTENSION_BYTES} bytes`)
  const name = basename(input.source)
  const target = input.scope === 'project'
    ? await prepareProjectSettingsPath(input.projectPath, { segments: ['.omp', 'extensions'], filename: name })
    : (() => {
        const directory = join(agentDir, 'extensions')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const stat = lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('OMP extension directory must be a real directory')
        return { path: join(directory, name), verify: async () => {
          const current = lstatSync(directory)
          if (current.isSymbolicLink() || !current.isDirectory()) throw new TypeError('OMP extension directory changed during install')
        } }
      })()

  await target.verify()
  try {
    writeFileSync(target.path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { ok: false, reason: 'blocked', output: `An OMP extension named “${name}” already exists in this scope.` }
    throw error
  }
  const installed = lstatSync(target.path, { bigint: true })
  try {
    await target.verify()
  } catch (error) {
    if (sameFile(target.path, installed.dev, installed.ino)) unlinkSync(target.path)
    throw error
  }
  return { ok: true, output: `Installed OMP extension “${name}”. Start a new OMP session to load it.` }
}
