import { Check, ChevronDown, FolderGit2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { CheckoutAction, CheckoutCatalog } from '@/types/api'

interface CheckoutPickerProps {
  catalog?: CheckoutCatalog
  fallbackLabel?: string
  loading?: boolean
  onExecute?(action: CheckoutAction): Promise<void> | void
}

function checkoutLabel(catalog: CheckoutCatalog | undefined, fallback: string | undefined): string {
  if (!catalog) return fallback ?? 'Checkout'
  if (catalog.strategy === 'branch') return catalog.activeName || fallback || 'Checkout'
  const active = catalog.checkouts.find((worktree) => worktree.path === catalog.activePath)
    ?? catalog.checkouts.find((worktree) => worktree.current)
  return active?.branch ?? active?.name ?? fallback ?? 'Checkout'
}

export function CheckoutPicker({ catalog, fallbackLabel, loading = false, onExecute }: CheckoutPickerProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [branch, setBranch] = useState('')
  const [error, setError] = useState('')
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const strategy = catalog?.strategy ?? 'worktree'

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  const execute = async (action: CheckoutAction): Promise<void> => {
    if (!onExecute) return
    setError('')
    try {
      await onExecute(action)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change checkout')
    }
  }

  const create = async (): Promise<void> => {
    const name = branch.trim()
    if (!name || creating || !onExecute) return
    setCreating(true)
    try {
      await execute({ strategy, operation: 'create', branch: name })
      setBranch('')
    } finally {
      setCreating(false)
    }
  }

  const enabled = Boolean(onExecute && catalog && (catalog.checkouts.length > 0 || strategy === 'branch'))
  const label = checkoutLabel(catalog, fallbackLabel)
  return (
    <div className="worktree-picker" ref={rootRef}>
      <button
        type="button"
        className="permissions-chip worktree-picker__trigger"
        aria-label={`Checkout: ${label}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={!enabled}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderGit2 size={12} />
        <span className="worktree-picker__label">{label}</span>
        <ChevronDown className="worktree-picker__chevron" size={11} />
      </button>
      {open && catalog ? (
        <div className="worktree-picker__menu" id={menuId} role="menu" aria-label={strategy === 'worktree' ? 'Git worktrees' : 'Git branches'}>
          <div className="worktree-picker__heading">Checkouts</div>
          <div className="worktree-picker__options">
            {loading ? <span className="worktree-picker__empty">Loading…</span> : catalog.checkouts.length === 0 ? <span className="worktree-picker__empty">No checkouts found</span> : catalog.strategy === 'worktree'
              ? catalog.checkouts.map((worktree) => {
                  const selected = worktree.path === catalog.activePath
                  return (
                    <button type="button" role="menuitemradio" aria-checked={selected} className={`worktree-picker__option ${selected ? 'is-active' : ''}`} key={worktree.path} onClick={() => { if (selected) setOpen(false); else void execute({ strategy: 'worktree', operation: 'open', path: worktree.path }) }}>
                      <span className="worktree-picker__check">{selected ? <Check size={13} /> : null}</span>
                      <span className="worktree-picker__option-copy"><strong>{worktree.branch ?? worktree.name}</strong><span title={worktree.path}>{worktree.path}</span></span>
                    </button>
                  )
                })
              : catalog.checkouts.map((localBranch) => (
                  <button type="button" role="menuitemradio" aria-checked={localBranch.current} className={`worktree-picker__option ${localBranch.current ? 'is-active' : ''}`} key={localBranch.name} onClick={() => { if (localBranch.current) setOpen(false); else void execute({ strategy: 'branch', operation: 'switch', branch: localBranch.name }) }}>
                    <span className="worktree-picker__check">{localBranch.current ? <Check size={13} /> : null}</span>
                    <span className="worktree-picker__option-copy"><strong>{localBranch.name}</strong><span>{localBranch.current ? 'Current branch' : 'Local branch'}</span></span>
                  </button>
                ))}
          </div>
          <form className="worktree-picker__create" onSubmit={(event) => { event.preventDefault(); void create() }}>
            <label htmlFor={`${menuId}-branch`}>Create {strategy}</label>
            <div>
              <input id={`${menuId}-branch`} value={branch} placeholder="New branch name" onChange={(event) => { setBranch(event.target.value); setError('') }} />
              <button type="submit" disabled={!branch.trim() || creating}>{creating ? 'Creating…' : 'Create'}</button>
            </div>
            {error ? <span role="alert">{error}</span> : null}
          </form>
        </div>
      ) : null}
    </div>
  )
}
