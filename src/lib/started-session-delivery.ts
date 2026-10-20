import type { PrimeWorkApi, RuntimeInfo, SessionRecord } from '@/types/api'

export interface StartedSessionDelivery {
  bridge: PrimeWorkApi
  /** The runtime GooeyPi started for this submission; no other submission shares it. */
  runtime: RuntimeInfo
  /** The workspace the submission was admitted for; the runtime must serve exactly it. */
  cwd: string
  sessionFile?: string
  agentName: string
  /** The prompt or compact command that carries the submission. */
  request: Record<string, unknown>
  /** Runtime-to-session map that keeps sidebar lifecycle state current while detached. */
  runtimeSessions: Map<string, string>
  /** Makes the started session part of the visible session catalog. */
  indexSession(): Promise<SessionRecord | undefined>
  /** Persists a prompt-derived title; omitted for submissions that are not a user task. */
  titleSession?(): Promise<void>
  /**
   * Attaches the runtime and shows the submission in the workspace that
   * admitted it. Implementations ignore a workspace that has since changed.
   */
  present(): void
}

/**
 * Once GooeyPi has started a runtime for a submission, that runtime belongs
 * to the submission rather than to whichever workspace is visible. Switching
 * away only detaches the UI: the submission is still delivered and the new
 * session keeps running in the background, where the sidebar tracks it.
 */
export async function deliverToStartedSession(delivery: StartedSessionDelivery): Promise<void> {
  const { bridge, runtime } = delivery
  if (runtime.cwd !== delivery.cwd || (delivery.sessionFile && runtime.sessionFile !== delivery.sessionFile)) {
    await bridge.agent.stop(runtime.runtimeId).catch(() => false)
    throw new Error(`${delivery.agentName} returned a runtime for a different workspace or session.`)
  }
  if (runtime.sessionFile) delivery.runtimeSessions.set(runtime.runtimeId, runtime.sessionFile)
  // The session watcher indexes the file later anyway, so a failed catalog
  // read must not strand a started runtime without its submission.
  const indexedSession = await delivery.indexSession().catch(() => undefined)
  delivery.present()
  await bridge.agent.command(runtime.runtimeId, delivery.request)
  if (delivery.titleSession && (!indexedSession || indexedSession.title === 'Untitled session')) void delivery.titleSession()
}
