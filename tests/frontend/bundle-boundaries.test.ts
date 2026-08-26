import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('renderer bundle boundaries', () => {
  const appSource = readFileSync('src/App.tsx', 'utf8')
  const terminalStyles = readFileSync('src/styles/terminal.css', 'utf8')

  it('keeps Transcript and its Markdown graph out of the initial App module graph', () => {
    expect(appSource).toContain("const Transcript = lazy(() => import('@/components/Transcript')")
    expect(appSource).not.toContain("import { Transcript } from '@/components/Transcript'")
    expect(appSource).toContain('<Suspense fallback={<LoadingPanel label="conversation" />}><Transcript')
  })

  it('continues to lazy-load the terminal dependency graph', () => {
    expect(appSource).toContain("const TerminalDrawer = lazy(() => import('@/components/TerminalDrawer')")
    expect(appSource).not.toContain("import { TerminalDrawer } from '@/components/TerminalDrawer'")
  })

  it('minifies the renderer but keeps the function names React crash stacks are built from', () => {
    const buildConfig = readFileSync('electron.vite.config.ts', 'utf8')
    expect(buildConfig).toContain("minify: 'esbuild'")
    expect(buildConfig).toContain('esbuild: { keepNames: true }')
  })

  it('reserves the terminal drawer height while its lazy bundle loads', () => {
    expect(appSource).toContain('fallback={terminal.id === activeTerminalSession?.id ? <TerminalLoadingPanel /> : null}')
    expect(appSource).not.toContain('<LoadingPanel label="terminal" />')
    expect(terminalStyles).toContain('.terminal-drawer--loading')
  })
})
