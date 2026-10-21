import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalSessionMount } from '@/app/terminal-sessions'
import type { TerminalDrawerHandle } from '@/components/TerminalDrawer'
import type { TerminalSelectionContext } from '@/types/api'
import { useStableCallback } from './useStableCallback'

interface TerminalSessionsOptions {
  workspaceKey: string
  cwd?: string
  sessionPath?: string
  onOpenChange(open: boolean): void
  beforeClose?(id: string): void
}

export function useTerminalSessions({ workspaceKey, cwd, sessionPath, onOpenChange, beforeClose }: TerminalSessionsOptions) {
  const [terminals, setTerminals] = useState<TerminalSessionMount[]>([])
  const terminalsRef = useRef(terminals)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<TerminalSelectionContext>()
  const drawerRefs = useRef(new Map<string, TerminalDrawerHandle>())
  const notifyOpen = useStableCallback(onOpenChange)
  const notifyClose = useStableCallback((id: string) => beforeClose?.(id))
  const replace = useCallback((next: TerminalSessionMount[]) => { terminalsRef.current = next; setTerminals(next) }, [])
  const active = useMemo(() => terminals.find((terminal) => terminal.workspaceKey === workspaceKey
    || Boolean(sessionPath && terminal.sessionPath === sessionPath)), [sessionPath, terminals, workspaceKey])
  const isOpen = Boolean(active)
  const openTerminal = useCallback((owner: Omit<TerminalSessionMount, 'id'>) => {
    const existing = terminalsRef.current.find((terminal) => terminal.workspaceKey === owner.workspaceKey
      || Boolean(owner.sessionPath && terminal.sessionPath === owner.sessionPath))
    if (existing) return existing
    const terminal = { id: crypto.randomUUID(), ...owner }
    replace([...terminalsRef.current, terminal])
    return terminal
  }, [replace])
  const addTerminal = useCallback((terminal: TerminalSessionMount) => {
    if (!terminalsRef.current.some((existing) => existing.id === terminal.id)) replace([...terminalsRef.current, terminal])
  }, [replace])
  const close = useCallback((id: string) => {
    if (!terminalsRef.current.some((terminal) => terminal.id === id)) return
    notifyClose(id)
    drawerRefs.current.delete(id)
    replace(terminalsRef.current.filter((terminal) => terminal.id !== id))
    if (active?.id === id) setSelection(undefined)
  }, [active?.id, notifyClose, replace])
  const closeForSession = useCallback((path: string) => {
    for (const terminal of terminalsRef.current.filter((item) => item.sessionPath === path)) close(terminal.id)
  }, [close])
  const consumeInitialCommand = useCallback((id: string) => {
    replace(terminalsRef.current.map((terminal) => terminal.id === id ? { ...terminal, initialCommand: undefined } : terminal))
  }, [replace])
  const onReady = useCallback(() => setRevision((current) => current + 1), [])
  const getContext = useStableCallback(() => active ? drawerRefs.current.get(active.id)?.readSelectionContext() : undefined)
  const clearSelection = useStableCallback(() => { if (active) drawerRefs.current.get(active.id)?.clearSelection() })
  useEffect(() => { notifyOpen(isOpen) }, [isOpen, notifyOpen])
  useEffect(() => {
    if (!active) { setSelection(undefined); return }
    replace(terminalsRef.current.map((terminal) => {
      if (terminal.id !== active.id) return terminal
      const ownerPath = sessionPath ?? terminal.sessionPath
      return terminal.cwd === cwd && terminal.sessionPath === ownerPath ? terminal : { ...terminal, cwd, sessionPath: ownerPath }
    }))
    setSelection(drawerRefs.current.get(active.id)?.readSelectionContext())
  }, [active?.id, cwd, replace, sessionPath])
  return { terminals, terminalsRef, active, open: isOpen, drawerRefs, revision, selection, setSelection, openTerminal, addTerminal, close, closeForSession, consumeInitialCommand, onReady, getContext, clearSelection }
}
