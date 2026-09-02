import { ArrowDownToLine, File, FileCode2, GitBranch, LoaderCircle, RefreshCw, Sparkles, Undo2 } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { GitStatus } from '@/types/api'
import { boundLines } from '@/lib/render-bounds'
import { EmptyState, IconButton, Modal, Segmented } from '../ui'

const MAX_RENDERED_DIFF_CHARACTERS = 2 * 1024 * 1024
const MAX_RENDERED_DIFF_LINES = 4_000

function generateCommitSummary(files: GitStatus['files']): string {
  const staged = files.filter((file) => file.staged)
  if (!staged.length) return ''
  const verbs = new Set(staged.map((file) => file.status[0]))
  const verb = verbs.size === 1 && verbs.has('A') ? 'Add' : verbs.size === 1 && verbs.has('D') ? 'Remove' : 'Update'
  const names = staged.map((file) => file.path)
  const description = names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, names.length === 2 ? ' and $1' : ', and $1') : `${names.length} files`
  return `${verb} ${description}`
}

const DiffView = memo(function DiffView({ text }: { text: string }) {
  if (!text) return <div className="diff-placeholder"><FileCode2 size={22} /><span>Select a changed file to inspect its diff.</span></div>
  const { lines, truncated } = boundLines(text, MAX_RENDERED_DIFF_CHARACTERS, MAX_RENDERED_DIFF_LINES)
  return <pre className="diff-view">{lines.map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-line diff-line--add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-line diff-line--remove' : line.startsWith('@@') ? 'diff-line diff-line--hunk' : 'diff-line'}><i>{index + 1}</i><code>{line || ' '}</code></span>)}{truncated ? <span className="diff-line diff-line--truncated"><i>…</i><code>Diff truncated in the desktop view. Open the file or use Git for the complete diff.</code></span> : null}</pre>
})

export function ChangesPanel({ cwd, git, readOnly = false, onGrantProject, onRefreshGit }: { cwd?: string; git: GitStatus; readOnly?: boolean; onGrantProject?(): Promise<void> | void; onRefreshGit(): Promise<void> | void }) {
  const [scope, setScope] = useState<'unstaged' | 'staged'>('unstaged')
  const [selectedPath, setSelectedPath] = useState<string | undefined>(git.files[0]?.path)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [confirmUndo, setConfirmUndo] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const visibleFiles = git.files.filter((file) => scope === 'staged' ? file.staged : !file.staged)
  const activeSelectedPath = visibleFiles.some((file) => file.path === selectedPath) ? selectedPath : undefined

  useEffect(() => {
    if (!visibleFiles.some((file) => file.path === selectedPath)) setSelectedPath(visibleFiles[0]?.path)
  }, [git.files, scope, selectedPath])

  useEffect(() => {
    if (!cwd || !activeSelectedPath || !window.prime) {
      setDiff(activeSelectedPath ? `diff --git a/${activeSelectedPath} b/${activeSelectedPath}
--- a/${activeSelectedPath}
+++ b/${activeSelectedPath}
@@ -18,3 +18,6 @@
 const workspace = createWorkspace()
+workspace.open()
+workspace.focus()
 return workspace` : '')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    window.prime.git.diff(cwd, activeSelectedPath, scope === 'staged').then((value) => { if (!cancelled) setDiff(value.text) }).catch(() => { if (!cancelled) setDiff('Unable to load this diff.') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cwd, activeSelectedPath, scope])

  const mutate = async (kind: 'stage' | 'unstage' | 'restore', paths: string[]): Promise<boolean> => {
    if (readOnly || !cwd || !window.prime) return false
    setActionError('')
    try {
      const ok = kind === 'stage'
        ? await window.prime.git.stage(cwd, paths)
        : kind === 'unstage'
          ? await window.prime.git.unstage(cwd, paths)
          : await window.prime.git.restore(cwd, paths)
      if (!ok) throw new Error(`Git could not ${kind} the selected ${paths.length === 1 ? 'file' : 'files'}.`)
      await onRefreshGit()
      return true
    } catch (error) {
      setActionError(errorMessage(error))
      return false
    }
  }

  const fillCommitSummary = () => {
    setActionError('')
    setCommitMessage(generateCommitSummary(git.files))
  }

  const commit = async () => {
    if (readOnly || !cwd || !commitMessage.trim() || !window.prime) return
    setActionError('')
    try {
      const result = await window.prime.git.commit(cwd, commitMessage.trim())
      if (!result.ok) throw new Error(result.output || 'Git could not create the commit.')
      setCommitOpen(false); setCommitMessage(''); await onRefreshGit()
    } catch (error) { setActionError(errorMessage(error)) }
  }

  if (!git.isRepo) return <EmptyState icon={<GitBranch size={24} />} title="No Git repository">Open a project backed by Git to review, stage, and commit changes.</EmptyState>
  if (git.error) {
    return <EmptyState
      icon={<GitBranch size={24} />}
      title="Git status unavailable"
      action={<button type="button" className="button" onClick={() => void onRefreshGit()}><RefreshCw size={13} /> Try again</button>}
    >{git.error}</EmptyState>
  }
  return (
    <div className="changes-panel">
      <div className="changes-toolbar">
        <div><strong><GitBranch size={13} /> {git.branch ?? 'Repository'}</strong>{git.ahead ? <small>{git.ahead} ahead</small> : null}</div>
        <IconButton label="Refresh changes" onClick={() => void onRefreshGit()}><RefreshCw size={14} /></IconButton>
      </div>
      {readOnly ? <div className="changes-read-only" role="note"><span>This project is read-only because it was discovered from session history.</span>{onGrantProject ? <button type="button" className="button button--compact" onClick={() => void onGrantProject()}>Add project</button> : null}</div> : null}
      <div className="changes-scopes"><Segmented value={scope} label="Diff scope" options={[{ value: 'unstaged', label: 'Unstaged' }, { value: 'staged', label: 'Staged' }]} onChange={(value) => { setActionError(''); setScope(value as 'unstaged' | 'staged') }} /><button type="button" className="button button--compact" disabled={readOnly || !git.files.some((file) => file.staged)} onClick={() => setCommitOpen(true)}>Commit</button></div>
      {actionError ? <p className="changes-error" role="alert">{actionError}</p> : null}
      <div className="changes-body">
        <div className="file-changes scroll-area">
          <div className="file-changes__header"><span>{visibleFiles.length} changed {visibleFiles.length === 1 ? 'file' : 'files'}</span>{visibleFiles.length ? <button type="button" disabled={readOnly} onClick={() => void mutate(scope === 'staged' ? 'unstage' : 'stage', visibleFiles.map((file) => file.path))}>{scope === 'staged' ? 'Unstage all' : 'Stage all'}</button> : null}</div>
          {visibleFiles.map((file) => <button type="button" key={file.path} className={selectedPath === file.path ? 'is-selected' : ''} onClick={() => setSelectedPath(file.path)}><File size={13} /><span title={file.path}>{file.path}</span><small className="additions">+{file.additions}</small><small className="deletions">−{file.deletions}</small><span className="file-status">{file.status}</span></button>)}
          {visibleFiles.length === 0 ? <p className="file-changes__empty">No {scope} changes.</p> : null}
        </div>
        <div className="diff-pane scroll-area">
          {selectedPath ? <div className="diff-header"><div><FileCode2 size={13} /><span>{selectedPath}</span></div><div>{scope === 'unstaged' ? <button type="button" disabled={readOnly} onClick={() => void mutate('stage', [selectedPath])}><ArrowDownToLine size={12} /> Stage</button> : <button type="button" disabled={readOnly} onClick={() => void mutate('unstage', [selectedPath])}><Undo2 size={12} /> Unstage</button>}<button type="button" className="danger-action" disabled={readOnly} onClick={() => setConfirmUndo(selectedPath)}><Undo2 size={12} /> Undo changes</button></div></div> : null}
          {loading ? <div className="diff-loading"><LoaderCircle className="spin" size={15} /> Loading diff…</div> : <DiffView text={diff} />}
        </div>
      </div>
      {commitOpen ? <Modal title="Commit staged changes" onClose={() => setCommitOpen(false)} footer={<><button className="button" type="button" onClick={() => setCommitOpen(false)}>Cancel</button><button className="button button--primary" type="button" disabled={readOnly || !commitMessage.trim()} onClick={() => void commit()}>Commit changes</button></>}><label className="field"><span>Commit message</span><div className="commit-message-input"><input autoFocus value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /><button type="button" className="button button--compact" onClick={fillCommitSummary} title="Generate a summary from staged files"><Sparkles size={13} /> Generate summary</button></div></label><p className="muted-copy">This will commit all staged files on <code>{git.branch}</code>.</p></Modal> : null}
      {confirmUndo ? <Modal title="Undo file changes?" onClose={() => setConfirmUndo(null)} footer={<><button className="button" type="button" onClick={() => setConfirmUndo(null)}>Cancel</button><button className="button button--danger" type="button" disabled={readOnly} onClick={() => { const path = confirmUndo; void mutate('restore', [path]).then((ok) => { if (ok) setConfirmUndo(null) }) }}>Undo changes</button></>}><p>This discards the staged and unstaged changes to <code>{confirmUndo}</code> and restores the file to its last commit. A new untracked file will be deleted.</p></Modal> : null}
    </div>
  )
}
