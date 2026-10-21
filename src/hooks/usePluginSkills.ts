import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createScopedRequestGuard } from '@/app/scoped-request'
import type { HarnessId, PluginWarning, PrimeWorkApi, SkillRecord } from '@/types/api'

interface UsePluginSkillsOptions {
  bridge: PrimeWorkApi | null
  harness: HarnessId
  scope?: string
  generation: number
  initialSkills: SkillRecord[]
  reportError(error: unknown): void
}

export function usePluginSkills({ bridge, harness, scope, generation, initialSkills, reportError }: UsePluginSkillsOptions) {
  const [skills, setSkills] = useState(initialSkills)
  const [warnings, setWarnings] = useState<PluginWarning[]>([])
  const [loading, setLoading] = useState(false)
  const requestGuardRef = useRef(createScopedRequestGuard())
  const scopeKey = `${harness}:${scope ?? ''}`
  const scopeRef = useRef(scopeKey)
  const generationRef = useRef(generation)
  const catalogScopeRef = useRef<{ key: string; bridge: PrimeWorkApi | null } | null>(null)
  useLayoutEffect(() => {
    scopeRef.current = scopeKey
    generationRef.current = generation
  })

  const load = useCallback(async (requestedScope: string | undefined, requestedHarness: HarnessId, showLoading = false) => {
    if (!bridge) return
    const requestedKey = `${requestedHarness}:${requestedScope ?? ''}`
    const request = requestGuardRef.current.begin(generationRef.current, requestedKey)
    if (showLoading) setLoading(true)
    try {
      const catalog = await bridge.plugins.list(requestedScope, requestedHarness)
      if (requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) {
        setSkills(catalog.skills)
        setWarnings(catalog.warnings)
      }
    } catch (error) {
      if (requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) reportError(error)
    } finally {
      if (showLoading && requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) setLoading(false)
    }
  }, [bridge, reportError])

  useEffect(() => {
    setLoading(false)
    const previous = catalogScopeRef.current
    catalogScopeRef.current = { key: scopeKey, bridge }
    if (bridge && (previous?.key !== scopeKey || previous.bridge !== bridge)) { setSkills([]); setWarnings([]) }
    void load(scope, harness)
    return () => { requestGuardRef.current.invalidate() }
  }, [bridge, generation, harness, load, scope, scopeKey])

  const refresh = useCallback(async () => { await load(scope, harness, true) }, [harness, load, scope])
  return { skills, warnings, loading, refresh }
}
