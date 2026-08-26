import { Brain, Check, ChevronDown, Search } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PrimeModelDescriptor, PrimeProviderDescriptor } from '@/types/api'

interface ModelPickerProps {
  value: string
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  onChange(value: string): void
}

interface ModelGroup {
  provider: PrimeProviderDescriptor
  models: PrimeModelDescriptor[]
}

export const ModelPicker = memo(function ModelPicker({ value, modelsByProvider, providers, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // null, not a string sentinel: harness catalogs are user-authored, so a
  // provider whose id is literally "all" must still filter to itself.
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const groups = useMemo<ModelGroup[]>(() => providers
    .filter((provider) => provider.enabled && (modelsByProvider.get(provider.id)?.length ?? 0) > 0)
    .map((provider) => ({ provider, models: modelsByProvider.get(provider.id) ?? [] })), [modelsByProvider, providers])
  const selected = useMemo(() => groups.flatMap((group) => group.models).find((model) => model.key === value), [groups, value])
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return groups.flatMap((group) => {
      if (providerFilter !== null && providerFilter !== group.provider.id) return []
      const providerText = `${group.provider.name} ${group.provider.id}`.toLocaleLowerCase()
      const models = needle
        ? group.models.filter((model) => `${model.name} ${model.id} ${model.key} ${providerText}`.toLocaleLowerCase().includes(needle))
        : group.models
      return models.length ? [{ provider: group.provider, models }] : []
    })
  }, [groups, providerFilter, query])
  const visibleModels = useMemo(() => visibleGroups.flatMap((group) => group.models), [visibleGroups])
  const navigableModels = useMemo(() => visibleModels.filter((model) => model.available), [visibleModels])
  // The open reset reads the catalog through a ref: a background catalog
  // refresh must not wipe a query the user is still typing.
  const catalogRef = useRef({ groups, selected })
  catalogRef.current = { groups, selected }

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (model: PrimeModelDescriptor | undefined) => {
    if (!model?.available) return
    onChange(model.key)
    close(true)
  }
  const moveActive = (direction: 1 | -1) => {
    if (!navigableModels.length) return
    const current = navigableModels.findIndex((model) => model.key === activeKey)
    const next = current < 0
      ? direction > 0 ? 0 : navigableModels.length - 1
      : (current + direction + navigableModels.length) % navigableModels.length
    setActiveKey(navigableModels[next].key)
  }

  useEffect(() => {
    if (!open) return
    const { groups: openGroups, selected: openSelected } = catalogRef.current
    setQuery('')
    setProviderFilter(null)
    setActiveKey(openSelected?.available
      ? openSelected.key
      : openGroups.flatMap((group) => group.models).find((model) => model.available)?.key ?? null)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!navigableModels.some((model) => model.key === activeKey)) setActiveKey(navigableModels[0]?.key ?? null)
  }, [activeKey, navigableModels, open])

  useEffect(() => {
    if (!open || !activeKey) return
    document.getElementById(`${listId}-${activeKey}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeKey, listId, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1) }
    else if (event.key === 'Home') { event.preventDefault(); setActiveKey(navigableModels[0]?.key ?? null) }
    else if (event.key === 'End') { event.preventDefault(); setActiveKey(navigableModels.at(-1)?.key ?? null) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(navigableModels.find((model) => model.key === activeKey)) }
    // Escape is owned by the popover container so it also dismisses from the
    // provider filters and the options, matching the native select it replaces.
  }

  const resultCount = visibleModels.length
  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="permissions-chip model-picker__trigger"
        aria-label={`Model: ${selected?.name ?? 'No model available'}`}
        title={selected?.name ?? 'No model available'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={!groups.length}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Brain size={14} />
        <span>{selected?.name ?? 'No model available'}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="model-picker__popover"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            close(true)
          }}
          onBlur={(event) => {
            // Tabbing past the filters must dismiss like the native select did.
            // A null relatedTarget means focus left the document entirely (app
            // switch), which keeps the popover and the typed query alive.
            const next = event.relatedTarget
            if (next instanceof Node && !rootRef.current?.contains(next)) close()
          }}
        >
          <div className="model-picker__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-label="Search models"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeKey ? `${listId}-${activeKey}` : undefined}
              placeholder="Search models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <span className="model-picker__count" aria-live="polite">
              <span aria-hidden="true">{resultCount}</span>
              <span className="sr-only">{resultCount} {resultCount === 1 ? 'model' : 'models'} listed</span>
            </span>
          </div>
          <div className="model-picker__providers" role="group" aria-label="Filter models by provider">
            <button type="button" className={providerFilter === null ? 'is-active' : ''} aria-pressed={providerFilter === null} onClick={() => setProviderFilter(null)}>All</button>
            {groups.map(({ provider }) => (
              <button
                type="button"
                key={provider.id}
                className={providerFilter === provider.id ? 'is-active' : ''}
                aria-pressed={providerFilter === provider.id}
                onClick={() => setProviderFilter(provider.id)}
              >{provider.name}</button>
            ))}
          </div>
          <div className="model-picker__results" id={listId} role="listbox" aria-label="Models">
            {visibleGroups.map(({ provider, models }) => (
              <div className="model-picker__group" role="group" aria-label={provider.name} key={provider.id}>
                <div className="model-picker__group-heading">
                  <span>{provider.name}</span>
                  <small>{provider.configured ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'Not connected'}</small>
                </div>
                {models.map((candidate) => {
                  const isSelected = candidate.key === value
                  const isActive = candidate.key === activeKey
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      role="option"
                      id={`${listId}-${candidate.key}`}
                      key={candidate.key}
                      aria-selected={isSelected}
                      aria-disabled={!candidate.available}
                      className={`model-picker__option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                      onMouseMove={() => { if (candidate.available) setActiveKey(candidate.key) }}
                      onClick={() => choose(candidate)}
                    >
                      <span className="model-picker__check">{isSelected ? <Check size={13} /> : null}</span>
                      <span className="model-picker__identity">
                        <strong>{candidate.name}</strong>
                        {candidate.id !== candidate.name ? <small>{candidate.id}</small> : null}
                      </span>
                      {!candidate.available ? <span className="model-picker__availability">Connect</span> : null}
                    </button>
                  )
                })}
              </div>
            ))}
            {!resultCount ? <div className="model-picker__empty">{query.trim() ? 'No models match this search.' : 'No models for this provider.'}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
})
