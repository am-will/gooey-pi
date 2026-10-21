import { useCallback, useMemo, useRef, useState } from 'react'

interface PreviewLocation { url?: string; history: readonly string[] }
export interface PreviewLocationStore {
  snapshot(): PreviewLocation
  record(url: string): void
  clearHistory(): void
}

/** Retain the Preview location across inspector panels without render-driven guest reloads. */
export function useBrowserPreviewState() {
  const [generation, setGeneration] = useState(0)
  const current = useRef<PreviewLocation>({ history: [] })
  const location = useMemo<PreviewLocationStore>(() => ({
    snapshot: () => current.current,
    record: (url) => {
      const history = current.current.history
      current.current = { url, history: history.at(-1) === url ? history : [...history.slice(-19), url] }
    },
    clearHistory: () => { current.current = { ...current.current, history: [] } },
  }), [])
  const reset = useCallback(() => {
    current.current = { history: [] }
    setGeneration((value) => value + 1)
  }, [])
  return { generation, location, reset }
}
