import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { EMPTY_GIT_STATUS, gitStatusForWorkspace, shouldRefreshGitOnSessionTransition, type OwnedGitStatus } from '@/lib/workspace'
import type { PrimeWorkApi, SessionRecord } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface GitStatusOptions {
  bridge: PrimeWorkApi | null
  cwd?: string
  workspaceRef: RefObject<Pick<WorkspaceSnapshot, 'cwd' | 'generation'>>
  sessionStatus?: SessionRecord['status']
  locallyOwnedSession: boolean
  initialSnapshot?: OwnedGitStatus
  reportError(error: unknown): void
}

export function useGitStatus({ bridge, cwd, workspaceRef, sessionStatus, locallyOwnedSession, initialSnapshot, reportError }: GitStatusOptions) {
  const [gitSnapshot, setGitSnapshot] = useState<OwnedGitStatus>(() => initialSnapshot ?? { cwd, status: EMPTY_GIT_STATUS })
  const gitRequestRef = useRef(0)
  const report = useStableCallback(reportError)
  const refreshGit = useCallback(async () => {
    const requestId = ++gitRequestRef.current
    if (!bridge) return
    if (!cwd) { setGitSnapshot({ cwd, status: EMPTY_GIT_STATUS }); return }
    const generation = workspaceRef.current.generation
    const current = () => gitRequestRef.current === requestId && workspaceRef.current.cwd === cwd && workspaceRef.current.generation === generation
    try {
      const next = await bridge.git.status(cwd)
      if (current()) setGitSnapshot({ cwd, status: next })
    } catch (error) { if (current()) report(error) }
  }, [bridge, cwd, report, workspaceRef])
  useEffect(() => { void refreshGit(); return () => { gitRequestRef.current += 1 } }, [refreshGit])
  const previousSessionStatus = useRef<SessionRecord['status'] | undefined>(undefined)
  useEffect(() => {
    const previous = previousSessionStatus.current
    previousSessionStatus.current = sessionStatus
    if (shouldRefreshGitOnSessionTransition(previous, sessionStatus, locallyOwnedSession)) void refreshGit()
  }, [locallyOwnedSession, refreshGit, sessionStatus])
  return { git: gitStatusForWorkspace(gitSnapshot, cwd), gitSnapshot, setGitSnapshot, gitRequestRef, refreshGit }
}
