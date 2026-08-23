import { CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectRecord } from '@/types/api'

export type ProjectScriptKind = 'setup' | 'run'

interface ProjectRunControlProps {
  project: ProjectRecord
  activeKind?: ProjectScriptKind
  onRun(kind: ProjectScriptKind): Promise<void> | void
  onStop(): void
  onSave(scripts: { setup: string; run: string }): Promise<void>
}

export function ProjectRunControl({ project, activeKind, onRun, onStop, onSave }: ProjectRunControlProps) {
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const runInputRef = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [setup, setSetup] = useState(project.scripts?.setup ?? '')
  const [run, setRun] = useState(project.scripts?.run ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const running = activeKind !== undefined

  useEffect(() => {
    setSetup(project.scripts?.setup ?? '')
    setRun(project.scripts?.run ?? '')
    setError('')
    setOpen(false)
  }, [project.id, project.scripts?.run, project.scripts?.setup])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [open])

  const startScript = (kind: ProjectScriptKind) => {
    setError('')
    void Promise.resolve(onRun(kind)).catch((cause) => {
      setError(cause instanceof Error ? cause.message : `Could not start the ${kind} script`)
      setOpen(true)
    })
  }

  const runPrimary = () => {
    if (running) { onStop(); return }
    if (!project.scripts?.run.trim()) {
      setOpen(true)
      requestAnimationFrame(() => runInputRef.current?.focus())
      return
    }
    startScript('run')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave({ setup, run })
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save project scripts')
    } finally {
      setSaving(false)
    }
  }

  const setupStatus = (() => {
    const scripts = project.scripts
    if (!setup.trim()) return null
    if (activeKind === 'setup') return <span className="project-run-menu__status is-running"><LoaderCircle className="spin" size={12} /> Setup running</span>
    if (scripts?.setup !== setup.trim() || scripts.setupLastRun !== scripts.setup) return <span className="project-run-menu__status">Runs automatically after save</span>
    if (scripts.setupLastExitCode === 0) return <span className="project-run-menu__status is-success"><CheckCircle2 size={12} /> Setup completed</span>
    if (scripts.setupLastExitCode !== undefined) return <span className="project-run-menu__status is-error"><CircleAlert size={12} /> Setup exited with code {scripts.setupLastExitCode}</span>
    return <span className="project-run-menu__status is-error"><CircleAlert size={12} /> Setup was interrupted</span>
  })()

  return (
    <div ref={rootRef} className="project-run-control">
      <div className={`project-run-split ${running ? 'is-running' : ''}`}>
        <button type="button" title={running ? (activeKind === 'setup' ? 'Stop setup' : 'Stop project') : 'Run project'} className="project-run-split__primary" aria-label={running ? `Stop ${activeKind} script` : 'Run project'} onClick={runPrimary}>
          {running ? <Square size={11} fill="currentColor" /> : <Play size={15} />}
        </button>
        <button type="button" title="Configure project scripts" className="project-run-split__menu" aria-label="Configure project scripts" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={13} />
        </button>
      </div>
      {open ? (
        <section id={menuId} className="project-run-menu" role="dialog" aria-label={`Scripts for ${project.name}`}>
          <header><strong>Project scripts</strong><small>{project.name}</small></header>
          <label htmlFor={`${menuId}-setup`}>
            <span>Setup command</span>
            <textarea id={`${menuId}-setup`} className="mono" rows={2} value={setup} placeholder="npm install" spellCheck={false} onChange={(event) => setSetup(event.target.value)} />
            <small>Runs once when first configured, and again whenever this command changes.</small>
          </label>
          {setupStatus}
          <label htmlFor={`${menuId}-run`}>
            <span>Run command</span>
            <textarea ref={runInputRef} id={`${menuId}-run`} className="mono" rows={2} value={run} placeholder="npm run dev" spellCheck={false} onChange={(event) => setRun(event.target.value)} />
          </label>
          {error ? <p className="project-run-menu__error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" className="button button--quiet" disabled={!project.scripts?.setup.trim() || running || saving} onClick={() => startScript('setup')}><RotateCcw size={13} /> Run setup again</button>
            <button type="button" className="button button--primary" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={13} /> : null} Save</button>
          </footer>
        </section>
      ) : null}
    </div>
  )
}
