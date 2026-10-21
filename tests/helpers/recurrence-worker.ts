import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Run the actual trusted worker in Node without depending on a previous application bundle. */
export async function recurrenceWorkerFixture(): Promise<{ url: URL; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'gooeypi-recurrence-worker-'))
  const output = join(directory, 'worker.cjs')
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('../../electron/main/schedules/recurrence-worker.ts', import.meta.url))],
      outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    })
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  return { url: pathToFileURL(output), dispose: () => rm(directory, { recursive: true, force: true }) }
}
