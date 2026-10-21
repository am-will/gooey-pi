import { useCallback } from 'react'

/** Reserve transcript space for the current dock, including a growing composer. */
export function useComposerDockHeight() {
  return useCallback((dock: HTMLDivElement | null) => {
    const pane = dock?.parentElement
    if (!dock || !pane) return
    const sync = () => pane.style.setProperty('--dock-h', `${Math.ceil(dock.getBoundingClientRect().height)}px`)
    sync()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync)
    observer?.observe(dock)
    return () => {
      observer?.disconnect()
      pane.style.removeProperty('--dock-h')
    }
  }, [])
}
