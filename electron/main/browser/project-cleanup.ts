import type { SessionRecord } from '../../../src/types/api'
import type { AgentRpcManager } from '../agent-rpc'
import type { AgentBrowserService } from './agent-service'
import { isPathWithin } from '../validation'

/** Stop producers before releasing guests, so an exiting runtime cannot recreate a tab. */
export async function stopProjectResources(options: {
  stopProcesses(): Promise<unknown>
  roots: readonly string[]
  sessions(): Promise<readonly Pick<SessionRecord, 'filePath' | 'projectPath'>[]>
  runtimes: ReturnType<AgentRpcManager['list']>
  browser: Pick<AgentBrowserService, 'closeForSession'> | null
}): Promise<void> {
  await options.stopProcesses()
  if (!options.browser) return
  const sessions = await options.sessions()
  const owned = new Set(sessions.filter((session) => options.roots.some((root) => isPathWithin(root, session.projectPath))).map((session) => session.filePath))
  for (const runtime of options.runtimes) {
    if (runtime.sessionFile && options.roots.some((root) => isPathWithin(root, runtime.cwd))) owned.add(runtime.sessionFile)
  }
  for (const session of owned) options.browser.closeForSession(session)
}
