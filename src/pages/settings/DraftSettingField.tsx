import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '@/lib/i18n'
import {
  createDraftState,
  errorMessage,
  reduceDraftState,
  type DraftAction,
  type DraftState,
} from './draft-state'

interface DraftSettingFieldProps {
  id: string
  label: string
  description: string
  committedValue: string
  validate(value: string): string
  normalize?(value: string): string
  onCommit(value: string): Promise<void> | void
  className?: string
}

export function DraftSettingField({
  id,
  label,
  description,
  committedValue,
  validate,
  normalize = (value) => value,
  onCommit,
  className,
}: DraftSettingFieldProps) {
  const { t } = useI18n()
  const [state, setState] = useState<DraftState>(() => createDraftState(committedValue))
  const stateRef = useRef(state)
  const nextCommitId = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)

  const dispatch = useCallback((action: DraftAction) => {
    const next = reduceDraftState(stateRef.current, action)
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    dispatch({ type: 'sync', value: committedValue })
  }, [committedValue, dispatch])

  const commit = useCallback(() => {
    if (inFlight.current) return inFlight.current
    const current = stateRef.current
    const validationError = validate(current.value)
    if (validationError) {
      dispatch({ type: 'edit', value: current.value, error: validationError })
      return Promise.resolve()
    }
    if (!current.dirty) return Promise.resolve()

    const value = normalize(current.value)
    const id = ++nextCommitId.current
    dispatch({ type: 'commit', id, value })
    const operation = Promise.resolve(onCommit(value))
      .then(() => { dispatch({ type: 'resolve', id }) })
      .catch((error: unknown) => { dispatch({ type: 'reject', id, error: errorMessage(error) }) })
      .finally(() => {
        if (inFlight.current === operation) inFlight.current = null
      })
    inFlight.current = operation
    return operation
  }, [dispatch, normalize, onCommit, validate])

  const onChange = (value: string) => {
    dispatch({ type: 'edit', value, error: validate(value) })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void commit()
  }
  const errorId = `${id}-error`

  return (
    <div className="settings-row settings-row--stack">
      <span>
        <label htmlFor={id}><strong>{label}</strong></label>
        <small>{description}</small>
      </span>
      <input
        id={id}
        className={className}
        value={state.value}
        aria-invalid={Boolean(state.error)}
        aria-describedby={state.error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => { void commit() }}
        onKeyDown={onKeyDown}
      />
      {state.error ? <p id={errorId} className="settings-error" role="alert">{state.error}</p> : null}
      <button
        type="button"
        className="button"
        disabled={!state.dirty || Boolean(state.error) || Boolean(state.pending)}
        onClick={() => { void commit() }}
      >
        {state.pending ? t('settings.field.saving') : t('common.save')}
      </button>
    </div>
  )
}
