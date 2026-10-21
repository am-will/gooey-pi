import { useStableCallback } from '@/hooks/useStableCallback'
import { DEVICE_TIME_ZONE, defaultForm, formFromSchedule, timingFromForm, targetFromForm, executionFromForm, validTimeZone, rruleParts, isAuthorized, type Frequency, type ScheduleForm } from '@/lib/schedule-form'
import {
  AlertTriangle,
  ArrowLeft,
  Archive,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FolderKanban,
  Gauge,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat2,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AutomationScheduleRecord,
  HarnessId,
  NativeHeartbeatRecord,
  PrimeImplementation,
  PrimeModelDescriptor,
  PrimeThinkingLevel,
  ProjectRecord,
  ScheduleInput,
  SchedulePatch,
  SchedulePreview,
  ScheduleRunRecord,
  ScheduleTiming,
  SessionRecord,
} from '@/types/api'
import { PRIME_THINKING_LEVELS } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { archivableScheduleSessions } from '@/lib/schedule-archive'
import { errorMessage } from '@/lib/errors'
import { RUST_PRIME_HEARTBEAT_PAUSE_DETAIL } from '@/lib/prime-compat'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { sessionTitleText } from '@/lib/session-title'
import { CREATED_BY_KEYS, DEFINITION_STATUS_KEYS, EXECUTION_SPEED_KEYS, EXECUTION_THINKING_KEYS, RUN_STATUS_KEYS, RUN_TRIGGER_KEYS } from '@/lib/schedule-labels'
import { EmptyState, Modal, Segmented } from '@/components/ui'

type ScheduleFilter = 'active' | 'paused' | 'attention' | 'all'
type ScheduleEditor = { mode: 'create' } | { mode: 'edit'; scheduleId: string; revision: number }

type ScheduleConfirmation =
  | { kind: 'discard' }
  | { kind: 'delete'; id: string; title: string }
  | { kind: 'stop'; heartbeat: NativeHeartbeatRecord }
  | { kind: 'archive'; id: string; files: string[] }

interface ScheduledPageProps {
  harness: HarnessId
  /** Rust Prime cannot pause or resume native heartbeats from GooeyPi; it can still stop them. */
  primeImplementation?: PrimeImplementation
  schedules: AutomationScheduleRecord[]
  nativeHeartbeats: NativeHeartbeatRecord[]
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  models: PrimeModelDescriptor[]
  lastSelectedModel: string
  error?: string
  initialProjectId?: string
  initialSessionId?: string
  selectedScheduleId?: string | null
  onFocusHandled?(id: string): void
  onCreate(input: ScheduleInput): Promise<void>
  onUpdate(id: string, patch: SchedulePatch): Promise<void>
  onPause(id: string): Promise<void>
  onResume(id: string): Promise<void>
  onDelete(id: string): Promise<void>
  onRunNow(id: string): Promise<void>
  onPreview(timing: ScheduleTiming): Promise<SchedulePreview>
  onArchiveSessions?(sessions: SessionRecord[]): Promise<void>
  onOpenSession(sessionFile: string): void
  onManageHeartbeat(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void>
}

// Module-level helpers below only build display text, so they receive `t` from
// the component instead of calling useI18n() outside a component body.
type Translate = ReturnType<typeof useI18n>['t']


const WEEKDAYS = [
  { value: 'MO', label: 'schedule.weekday.short.monday', long: 'schedule.weekday.monday' },
  { value: 'TU', label: 'schedule.weekday.short.tuesday', long: 'schedule.weekday.tuesday' },
  { value: 'WE', label: 'schedule.weekday.short.wednesday', long: 'schedule.weekday.wednesday' },
  { value: 'TH', label: 'schedule.weekday.short.thursday', long: 'schedule.weekday.thursday' },
  { value: 'FR', label: 'schedule.weekday.short.friday', long: 'schedule.weekday.friday' },
  { value: 'SA', label: 'schedule.weekday.short.saturday', long: 'schedule.weekday.saturday' },
  { value: 'SU', label: 'schedule.weekday.short.sunday', long: 'schedule.weekday.sunday' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey; long: MessageKey }>

const THINKING_LEVELS: readonly PrimeThinkingLevel[] = PRIME_THINKING_LEVELS
const THINKING_LEVEL_KEYS = {
  off: 'schedule.thinking.off',
  minimal: 'schedule.thinking.minimal',
  low: 'schedule.thinking.low',
  medium: 'schedule.thinking.medium',
  high: 'schedule.thinking.high',
  xhigh: 'schedule.thinking.xhigh',
  max: 'schedule.thinking.max',
} as const satisfies Record<PrimeThinkingLevel, MessageKey>
const FREQUENCIES: Array<{ value: Frequency; label: MessageKey }> = [
  { value: 'hourly', label: 'schedule.frequency.hourly' },
  { value: 'daily', label: 'schedule.frequency.daily' },
  { value: 'weekly', label: 'schedule.frequency.weekly' },
  { value: 'monthly', label: 'schedule.frequency.monthly' },
  { value: 'advanced', label: 'schedule.frequency.advanced' },
]
const EMPTY_TITLE_KEYS: Record<ScheduleFilter, MessageKey> = {
  active: 'schedule.empty.active',
  paused: 'schedule.empty.paused',
  attention: 'schedule.empty.attention',
  all: 'schedule.empty.all',
}
// The cadence pairs a singular phrasing ("Every day") with a counted one
// ("Every 2 days"); English pluralises with an "s", Japanese does not, so the
// two phrasings stay separate keys instead of one plural message.
type CadenceUnit = 'hour' | 'day' | 'week' | 'month' | 'cycle'
const CADENCE_UNIT_KEYS: Record<CadenceUnit, MessageKey> = {
  hour: 'schedule.timing.everyHour',
  day: 'schedule.timing.everyDay',
  week: 'schedule.timing.everyWeek',
  month: 'schedule.timing.everyMonth',
  cycle: 'schedule.timing.everyCycle',
}
const CADENCE_INTERVAL_KEYS: Record<CadenceUnit, MessageKey> = {
  hour: 'schedule.timing.everyHours',
  day: 'schedule.timing.everyDays',
  week: 'schedule.timing.everyWeeks',
  month: 'schedule.timing.everyMonths',
  cycle: 'schedule.timing.everyCycles',
}

// Date order, month names, and clock style follow the device's regional format.
function formatDateTime(t: Translate, value?: string) {
  if (!value) return t('schedule.notScheduled')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatRunDate(t: Translate, value?: string) {
  if (!value) return t('schedule.pending')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date)
}

function timingLabel(t: Translate, timing: ScheduleTiming) {
  if (timing.kind === 'once') return t('schedule.timing.once', { time: formatDateTime(t, timing.at) })
  const parts = rruleParts(timing.rrule)
  const frequency = parts.get('FREQ')?.toLowerCase()
  const interval = Number(parts.get('INTERVAL') ?? '1')
  const unit: CadenceUnit = frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : frequency === 'hourly' ? 'hour' : 'cycle'
  const cadence = interval > 1
    ? t(CADENCE_INTERVAL_KEYS[unit], { interval })
    : t(CADENCE_UNIT_KEYS[unit])
  const days = parts.get('BYDAY')
  return `${cadence}${days ? ` · ${days}` : ''} ${t('schedule.timing.at', { time: timing.dtstartLocal.slice(11, 16), timeZone: timing.timeZone })}`
}

function needsAttention(item: AutomationScheduleRecord) {
  const latest = item.runs.at(-1)
  return item.status === 'blocked' || latest?.status === 'failed' || latest?.status === 'interrupted'
}

function statusLabel(t: Translate, item: AutomationScheduleRecord) {
  return needsAttention(item) ? t('schedule.status.attention') : t(DEFINITION_STATUS_KEYS[item.status])
}

function statusIcon(item: AutomationScheduleRecord, size = 16) {
  if (needsAttention(item)) return <AlertTriangle size={size} />
  if (item.status === 'paused') return <Pause size={size} />
  if (item.status === 'completed') return <Check size={size} />
  return <RotateCw size={size} />
}

function runIcon(status: ScheduleRunRecord['status']) {
  if (status === 'failed' || status === 'interrupted') return <AlertTriangle size={14} />
  if (status === 'succeeded') return <CheckCircle2 size={14} />
  if (status === 'running') return <RotateCw size={14} />
  if (status === 'queued') return <Clock3 size={14} />
  return <CircleDot size={14} />
}


export function ScheduledPage({
  harness, primeImplementation, schedules, nativeHeartbeats, projects, sessions, models, lastSelectedModel, error, initialProjectId, initialSessionId, selectedScheduleId, onFocusHandled,
  onCreate, onUpdate, onPause, onResume, onDelete, onRunNow, onPreview, onOpenSession, onManageHeartbeat, onArchiveSessions,
}: ScheduledPageProps) {
  const { t } = useI18n()
  const previewTiming = useStableCallback(onPreview)
  const focusHandled = useStableCallback((id: string) => onFocusHandled?.(id))
  const appliedFocusRef = useRef<string | null>(null)
  const [filter, setFilter] = useState<ScheduleFilter>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<ScheduleEditor | null>(null)
  const [form, setForm] = useState<ScheduleForm>(() => defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId))
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const actionPendingRef = useRef(false)
  const [confirmation, setConfirmation] = useState<ScheduleConfirmation | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const previewRequest = useRef(0)
  const heartbeatPauseUnavailable = primeImplementation === 'rust' ? RUST_PRIME_HEARTBEAT_PAUSE_DETAIL : undefined

  const authorizedProjects = useMemo(() => projects.filter(isAuthorized), [projects])
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const selected = schedules.find((item) => item.id === selectedId) ?? null
  useEffect(() => {
    if (!selectedScheduleId) { appliedFocusRef.current = null; return }
    if (appliedFocusRef.current === selectedScheduleId || !schedules.some((item) => item.id === selectedScheduleId)) return
    appliedFocusRef.current = selectedScheduleId
    setSelectedId(selectedScheduleId)
    focusHandled(selectedScheduleId)
  }, [focusHandled, schedules, selectedScheduleId])
  const selectedProject = projectMap.get(form.projectId)
  const eligibleSessions = useMemo(() => {
    const project = projects.find((item) => item.id === form.projectId)
    return project ? sessions.filter((session) => session.projectPath === project.path && !session.archived) : []
  }, [form.projectId, projects, sessions])
  const selectedModel = models.find((model) => model.key === form.model)
  const availableModels = models.filter((model) => model.enabled !== false && model.available)
  const currentTiming = useMemo(() => timingFromForm(form), [
    form.timingKind, form.date, form.time, form.timeZone, form.frequency,
    form.interval, form.weekdays, form.advancedRrule,
  ])
  const visible = schedules.filter((item) => filter === 'all'
    || (filter === 'attention' ? needsAttention(item) : item.status === filter))
  const counts = schedules.reduce((result, item) => {
    if (item.status === 'active') result.active += 1
    if (item.status === 'paused') result.paused += 1
    if (needsAttention(item)) result.attention += 1
    return result
  }, { active: 0, paused: 0, attention: 0 })

  useEffect(() => {
    if (!editor || !currentTiming) {
      setPreview(null); setPreviewError(''); setPreviewing(false)
      return
    }
    const request = ++previewRequest.current
    setPreviewing(true); setPreviewError('')
    const timer = window.setTimeout(() => {
      void previewTiming(currentTiming).then((result) => {
        if (previewRequest.current === request) { setPreview(result); setPreviewing(false) }
      }).catch((reason) => {
        if (previewRequest.current === request) { setPreview(null); setPreviewError(errorMessage(reason)); setPreviewing(false) }
      })
    }, 350)
    return () => {
      // Invalidate any in-flight preview so it cannot repopulate state after
      // the editor resets, the timing changes, or the page unmounts.
      previewRequest.current += 1
      window.clearTimeout(timer)
    }
  }, [currentTiming, editor, previewTiming])

  const openCreate = () => {
    const next = defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId)
    setForm(next); setBaseline(JSON.stringify(next)); setFormError(''); setPreview(null); setEditor({ mode: 'create' })
  }
  const openEdit = (item: AutomationScheduleRecord) => {
    const next = formFromSchedule(item, models, lastSelectedModel)
    setForm(next); setBaseline(JSON.stringify(next)); setFormError(''); setPreview(null); setEditor({ mode: 'edit', scheduleId: item.id, revision: item.revision })
  }
  const closeEditor = () => {
    if (saving) return
    if (JSON.stringify(form) !== baseline) { setConfirmation({ kind: 'discard' }); return }
    setEditor(null); setFormError('')
  }
  const setProject = (projectId: string) => {
    const project = projectMap.get(projectId)
    const firstSession = project ? sessions.find((session) => session.projectPath === project.path && !session.archived) : undefined
    setForm((current) => ({ ...current, projectId, sessionId: firstSession?.id ?? '' }))
  }
  const selectModel = (modelKey: string) => {
    const model = models.find((item) => item.key === modelKey)
    setForm((current) => ({
      ...current,
      model: modelKey,
      thinking: model && current.thinking !== 'auto' && !model.availableThinkingLevels.includes(current.thinking) ? 'auto' : current.thinking,
      fast: model && !model.fastModeSupported ? false : current.fast,
    }))
  }
  const validate = () => {
    if (!form.title.trim()) return t('schedule.error.title')
    if (!form.prompt.trim()) return t('schedule.error.prompt', { harness: HARNESS_SHORT_NAMES[harness] })
    if (!form.model || !availableModels.some((model) => model.key === form.model)) return t('schedule.error.model')
    if (!form.projectId || !authorizedProjects.some((project) => project.id === form.projectId)) return t('schedule.error.project')
    if (form.targetKind === 'session' && !eligibleSessions.some((session) => session.id === form.sessionId)) return t('schedule.error.session')
    if (!currentTiming) {
      if (form.timingKind === 'once') return t('schedule.error.dateTime')
      if (form.timingKind === 'recurring' && !validTimeZone(form.timeZone.trim())) return t('schedule.error.timeZone')
      if (form.frequency === 'weekly' && !form.weekdays.length) return t('schedule.error.weekday')
      return form.frequency === 'advanced' ? t('schedule.error.rrule') : t('schedule.error.dateTime')
    }
    return ''
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !editor) return
    const validationError = validate()
    if (validationError || !currentTiming) { setFormError(validationError); return }
    setSaving(true); setFormError('')
    const values = {
      title: form.title.trim(), prompt: form.prompt.trim(), target: targetFromForm(form),
      timing: currentTiming, execution: executionFromForm(form),
    }
    try {
      if (editor.mode === 'edit') await onUpdate(editor.scheduleId, { revision: editor.revision, ...values })
      else await onCreate(values)
      setEditor(null)
    } catch (reason) { setFormError(errorMessage(reason)) }
    finally { setSaving(false) }
  }
  const perform = async (key: string, work: () => Promise<void>, success: string, after?: () => void) => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setAction(key); setActionError(''); setActionNotice('')
    try { await work(); setActionNotice(success); after?.() }
    catch (reason) { setActionError(errorMessage(reason)) }
    finally { actionPendingRef.current = false; setAction(null) }
  }
  const deleteSchedule = (item: AutomationScheduleRecord) => setConfirmation({ kind: 'delete', id: item.id, title: item.title })
  const confirmAction = () => {
    const pending = confirmation
    if (!pending) return
    setConfirmation(null)
    if (pending.kind === 'discard') { setEditor(null); setFormError(''); return }
    if (pending.kind === 'delete') {
      void perform(`delete:${pending.id}`, () => onDelete(pending.id), t('schedule.notice.deleted'), () => setSelectedId(null))
    } else if (pending.kind === 'stop') {
      void perform(`heartbeat:${pending.heartbeat.id}`, () => onManageHeartbeat(pending.heartbeat.id, 'stop'), t('schedule.notice.heartbeatStopped'))
    } else {
      const current = schedules.find((item) => item.id === pending.id)
      const eligible = current ? archivableScheduleSessions(current, sessions).filter((session) => pending.files.includes(session.filePath)) : []
      if (eligible.length && onArchiveSessions) void perform(`archive:${pending.id}`, () => onArchiveSessions(eligible), '')
    }
  }
  const confirmationModal = confirmation ? (
    <Modal title={t('common.confirm')} onClose={() => setConfirmation(null)} footer={<>
      <button type="button" className="button" onClick={() => setConfirmation(null)}>{t('common.cancel')}</button>
      <button type="button" className="button button--danger" onClick={confirmAction}>{confirmation.kind === 'delete' ? t('common.delete') : confirmation.kind === 'stop' ? t('schedule.action.stop') : confirmation.kind === 'discard' ? t('schedule.confirm.discardAction') : t('common.confirm')}</button>
    </>}>
      <p>{confirmation.kind === 'discard' ? t('schedule.confirm.discard') : confirmation.kind === 'delete' ? t('schedule.confirm.delete', { title: confirmation.title }) : confirmation.kind === 'stop' ? t('schedule.confirm.stop', { title: confirmation.heartbeat.label || t(confirmation.heartbeat.source === 'heartbeat' ? 'schedule.heartbeats.thread' : 'schedule.heartbeats.agent') }) : t('schedule.history.archiveConfirm', { count: confirmation.files.length })}</p>
    </Modal>
  ) : null

  const editorModal = editor ? (
    <Modal title={editor.mode === 'create' ? t('schedule.editor.create') : t('schedule.editor.editTitle')} onClose={closeEditor} footer={(
      <>
        <span className="schedule-editor__save-status" aria-live="polite">{saving ? t('schedule.editor.savingDraft') : ''}</span>
        <button type="button" className="button" disabled={saving} onClick={closeEditor}>{t('common.cancel')}</button>
        <button type="submit" form="schedule-editor-form" className="button button--primary" disabled={saving}>
          {saving ? t('schedule.editor.saving') : editor.mode === 'create' ? t('schedule.editor.create') : t('schedule.editor.saveChanges')}
        </button>
      </>
    )}>
      <form id="schedule-editor-form" className="schedule-editor" onSubmit={(event) => void save(event)}>
        <div className="schedule-editor__lead">
          <Sparkles size={15} />
          <p>{t('schedule.editor.lead', { harness: HARNESS_SHORT_NAMES[harness] })}</p>
        </div>
        <div className="schedule-editor__copy">
          <label className="field"><span>{t('schedule.editor.title')}</span><input autoFocus required value={form.title} disabled={saving} placeholder={t('schedule.editor.titlePlaceholder')} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
          <label className="field"><span>{t('schedule.editor.prompt')}</span><textarea required rows={4} value={form.prompt} disabled={saving} placeholder={t('schedule.editor.promptPlaceholder')} onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} /></label>
        </div>
        <div className="schedule-editor__grid">
          <fieldset className="schedule-fieldset">
            <legend><FolderKanban size={14} /> {t('schedule.editor.destination')}</legend>
            <div className="schedule-radio-grid">
              <label className={form.targetKind === 'project' ? 'is-selected' : ''}><input type="radio" name="target" checked={form.targetKind === 'project'} onChange={() => setForm((current) => ({ ...current, targetKind: 'project' }))} /><span><strong>{t('schedule.target.newSession')}</strong><small>{t('schedule.target.newSessionHint')}</small></span></label>
              <label className={form.targetKind === 'session' ? 'is-selected' : ''}><input type="radio" name="target" checked={form.targetKind === 'session'} onChange={() => setForm((current) => ({ ...current, targetKind: 'session' }))} /><span><strong>{t('schedule.target.existingSession')}</strong><small>{t('schedule.target.existingSessionHint')}</small></span></label>
            </div>
            <label className="field"><span>{t('schedule.editor.authorizedProject')}</span><select value={form.projectId} disabled={saving || !authorizedProjects.length} onChange={(event) => setProject(event.target.value)}><option value="">{t('schedule.editor.chooseProject')}</option>{authorizedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            {form.targetKind === 'session' ? <label className="field"><span>{t('schedule.editor.session')}</span><select value={form.sessionId} disabled={saving || !eligibleSessions.length} onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}><option value="">{t('schedule.editor.chooseSession')}</option>{eligibleSessions.map((session) => <option key={session.id} value={session.id}>{sessionTitleText(session.title, t)}</option>)}</select></label> : null}
            {!authorizedProjects.length ? <p className="schedule-field-note schedule-field-note--warning"><AlertTriangle size={13} /> {t('schedule.editor.noProject')}</p> : <p className="schedule-field-note">{selectedProject?.primaryFolder}</p>}
          </fieldset>

          <fieldset className="schedule-fieldset">
            <legend><CalendarClock size={14} /> {t('schedule.timing.title')}</legend>
            <div className="schedule-radio-grid schedule-radio-grid--timing">
              <label className={form.timingKind === 'once' ? 'is-selected' : ''}><input type="radio" name="timing" checked={form.timingKind === 'once'} onChange={() => setForm((current) => ({ ...current, timingKind: 'once' }))} /><span><strong>{t('schedule.editor.once')}</strong><small>{t('schedule.editor.onceHint')}</small></span></label>
              <label className={form.timingKind === 'recurring' ? 'is-selected' : ''}><input type="radio" name="timing" checked={form.timingKind === 'recurring'} onChange={() => setForm((current) => ({ ...current, timingKind: 'recurring' }))} /><span><strong>{t('schedule.editor.recurring')}</strong><small>{t('schedule.editor.recurringHint')}</small></span></label>
            </div>
            {form.timingKind === 'recurring' ? <>
              <div className="schedule-frequency" role="group" aria-label={t('schedule.frequency.aria')}>{FREQUENCIES.map((option) => <button key={option.value} type="button" className={form.frequency === option.value ? 'is-active' : ''} aria-pressed={form.frequency === option.value} onClick={() => setForm((current) => ({ ...current, frequency: option.value }))}>{t(option.label)}</button>)}</div>
              {form.frequency !== 'advanced' ? <div className="schedule-inline-fields">
                <label className="field"><span>{t('schedule.editor.every')}</span><input type="number" min="1" max="999" value={form.interval} onChange={(event) => setForm((current) => ({ ...current, interval: event.target.value }))} /></label>
                <span>{form.frequency === 'hourly' ? t('schedule.editor.unitHours') : form.frequency === 'daily' ? t('schedule.editor.unitDays') : form.frequency === 'weekly' ? t('schedule.editor.unitWeeks') : t('schedule.editor.unitMonths')}</span>
              </div> : <label className="field"><span>RRULE</span><textarea className="schedule-rrule" rows={3} spellCheck={false} value={form.advancedRrule} placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" onChange={(event) => setForm((current) => ({ ...current, advancedRrule: event.target.value }))} /></label>}
              {form.frequency === 'weekly' ? <fieldset className="weekday-fieldset"><legend>{t('schedule.editor.onDays')}</legend><div className="weekday-chips">{WEEKDAYS.map((day) => { const active = form.weekdays.includes(day.value); return <label key={day.value} className={active ? 'is-active' : ''} title={t(day.long)}><input type="checkbox" checked={active} onChange={() => setForm((current) => ({ ...current, weekdays: active ? current.weekdays.filter((value) => value !== day.value) : [...current.weekdays, day.value] }))} /><span>{t(day.label)}</span></label> })}</div></fieldset> : null}
            </> : null}
            <div className="schedule-date-fields">
              <label className="field"><span>{form.timingKind === 'once' ? t('schedule.editor.date') : t('schedule.editor.starts')}</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} /></label>
              <label className="field"><span>{t('schedule.editor.localTime')}</span><input type="time" value={form.time} onChange={(event) => setForm((current) => ({ ...current, time: event.target.value }))} /></label>
            </div>
            {form.timingKind === 'recurring' ? <label className="field"><span>{t('schedule.editor.timeZone')}</span><input list="schedule-time-zones" value={form.timeZone} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} /><datalist id="schedule-time-zones"><option value={DEVICE_TIME_ZONE} /><option value="UTC" /><option value="America/Los_Angeles" /><option value="America/New_York" /><option value="Europe/London" /><option value="Asia/Tokyo" /></datalist></label> : <p className="schedule-field-note">{t('schedule.editor.deviceTimeZone', { timeZone: DEVICE_TIME_ZONE })}</p>}
          </fieldset>
        </div>

        <fieldset className="schedule-fieldset schedule-fieldset--execution">
          <legend><Gauge size={14} /> {t('schedule.execution.title')}</legend>
          <div className="schedule-execution-grid">
            <label className="field"><span>{t('schedule.model.label')}</span><select value={form.model} onChange={(event) => selectModel(event.target.value)}>{!form.model ? <option value="" disabled>{t('schedule.editor.noModel')}</option> : null}{form.model && !models.some((model) => model.key === form.model && model.enabled !== false && model.available) ? <option value={form.model}>{t('schedule.editor.modelUnavailable', { model: form.model })}</option> : null}{availableModels.map((model) => <option key={model.key} value={model.key}>{model.name} · {model.provider}</option>)}</select></label>
            <label className="field"><span>{t('schedule.reasoning.label')}</span><select value={form.thinking} onChange={(event) => setForm((current) => ({ ...current, thinking: event.target.value as ScheduleForm['thinking'] }))}><option value="auto">{t('schedule.thinking.auto')}</option>{THINKING_LEVELS.filter((level) => !selectedModel || selectedModel.availableThinkingLevels.includes(level) || level === form.thinking).map((level) => <option key={level} value={level}>{t(THINKING_LEVEL_KEYS[level])}</option>)}</select></label>
            <label className={`schedule-fast-toggle ${selectedModel && !selectedModel.fastModeSupported ? 'is-disabled' : ''}`}><input type="checkbox" checked={form.fast} disabled={Boolean(selectedModel && !selectedModel.fastModeSupported)} onChange={(event) => setForm((current) => ({ ...current, fast: event.target.checked }))} /><span><Play size={13} /><strong>{t('schedule.editor.fast')}</strong><small>{selectedModel && !selectedModel.fastModeSupported ? t('schedule.editor.fastUnavailable') : t('schedule.editor.fastHint')}</small></span></label>
          </div>
        </fieldset>

        <section className="schedule-preview" aria-live="polite" aria-label={t('schedule.preview.title')}>
          <div><span><Clock3 size={14} /> {t('schedule.preview.next')}</span>{previewing ? <small>{t('schedule.preview.checking')}</small> : null}</div>
          {previewError ? <p className="schedule-preview__error">{t('schedule.preview.unavailable', { error: previewError })}</p> : preview?.occurrences.length ? <ol>{preview.occurrences.slice(0, 5).map((occurrence) => <li key={occurrence}><i /><span>{formatDateTime(t, occurrence)}</span><small>{formatRelative(occurrence)}</small></li>)}</ol> : <p>{currentTiming ? t('schedule.preview.none') : t('schedule.preview.incomplete')}</p>}
        </section>
        {formError ? <p className="page-inline-error" role="alert">{formError}</p> : null}
      </form>
    </Modal>
  ) : null

  if (selected) {
    const project = projectMap.get(selected.target.projectId)
    const targetSession = selected.target.kind === 'session' ? sessionMap.get(selected.target.sessionId) : undefined
    const finishedSessions = archivableScheduleSessions(selected, sessions)
    const recentRuns = [...selected.runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 8)
    const busy = Boolean(action)
    return (
      <div className="page scroll-area"><div className="page-container schedule-page schedule-page--detail">
        <button type="button" className="schedule-back" onClick={() => { setSelectedId(null); setActionError(''); setActionNotice('') }}><ArrowLeft size={15} /> {t('schedule.detail.all')}</button>
        <header className="schedule-detail__header">
          <div className={`schedule-detail__mark schedule-detail__mark--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusIcon(selected, 18)}</div>
          <div><span className={`schedule-state schedule-state--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusLabel(t, selected)}</span><h1>{selected.title}</h1><p>{t('schedule.detail.revision', { revision: selected.revision, updated: formatRelative(selected.updatedAt) })}</p></div>
        </header>
        <div className="schedule-detail__actions" aria-label={t('schedule.actions.aria')}>
          <button type="button" className="button button--primary" disabled={busy || selected.status === 'completed'} onClick={() => void perform(`run:${selected.id}`, () => onRunNow(selected.id), t('schedule.notice.runQueued'))}><Play size={13} />{action === `run:${selected.id}` ? t('schedule.action.queuing') : t('schedule.action.runNow')}</button>
          <button type="button" className="button" disabled={busy} onClick={() => openEdit(selected)}><Pencil size={13} /> {t('common.edit')}</button>
          {selected.status === 'active' || selected.status === 'blocked' ? <button type="button" className="button" disabled={busy} onClick={() => void perform(`pause:${selected.id}`, () => onPause(selected.id), t('schedule.notice.paused'))}><Pause size={13} />{action === `pause:${selected.id}` ? t('schedule.action.pausing') : t('schedule.action.pause')}</button> : selected.status === 'paused' ? <button type="button" className="button" disabled={busy} onClick={() => void perform(`resume:${selected.id}`, () => onResume(selected.id), t('schedule.notice.resumed'))}><RotateCw size={13} />{action === `resume:${selected.id}` ? t('schedule.action.resuming') : t('schedule.action.resume')}</button> : null}
          <button type="button" className="button schedule-delete" disabled={busy} onClick={() => deleteSchedule(selected)}><Trash2 size={13} /> {t('common.delete')}</button>
        </div>
        {error ? <p className="page-inline-error" role="alert">{t('schedule.error.catalog', { error })}</p> : null}
        {actionError ? <p className="page-inline-error" role="alert">{actionError}</p> : null}
        {actionNotice ? <p className="schedule-action-notice" role="status"><CheckCircle2 size={14} />{actionNotice}</p> : null}
        {selected.blockedReason ? <div className="schedule-blocked" role="status"><AlertTriangle size={16} /><div><strong>{t('schedule.detail.needsAttention')}</strong><p>{selected.blockedReason}</p></div></div> : null}

        <div className="schedule-detail__grid">
          <section className="schedule-detail__card schedule-detail__card--prompt"><span className="schedule-detail__eyebrow">{t('schedule.detail.instruction')}</span><p>{selected.prompt}</p></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">{t('schedule.detail.delivery')}</span><dl><div><dt>{t('schedule.detail.target')}</dt><dd>{targetSession?.title ?? project?.name ?? t('schedule.target.unavailable')}</dd></div><div><dt>{t('schedule.detail.mode')}</dt><dd>{selected.target.kind === 'session' ? t('schedule.target.existingSession') : t('schedule.target.newSession')}</dd></div><div><dt>{t('schedule.detail.createdBy')}</dt><dd>{t(CREATED_BY_KEYS[selected.createdBy])}</dd></div></dl></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">{t('schedule.detail.cadence')}</span><dl><div><dt>{t('schedule.timing.title')}</dt><dd>{timingLabel(t, selected.timing)}</dd></div><div><dt>{t('schedule.detail.nextRun')}</dt><dd>{selected.nextRunAt ? `${formatDateTime(t, selected.nextRunAt)} · ${formatRelative(selected.nextRunAt)}` : t('schedule.detail.noneScheduled')}</dd></div>{selected.timing.kind === 'rrule' ? <div><dt>{t('schedule.detail.rule')}</dt><dd><code>{selected.timing.rrule}</code></dd></div> : null}</dl></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">{t('schedule.execution.title')}</span><dl><div><dt>{t('schedule.model.label')}</dt><dd>{models.find((model) => model.key === selected.execution.model)?.name ?? selected.execution.model}</dd></div><div><dt>{t('schedule.reasoning.label')}</dt><dd>{t(EXECUTION_THINKING_KEYS[selected.execution.thinking])}</dd></div><div><dt>{t('schedule.detail.speed')}</dt><dd>{t(EXECUTION_SPEED_KEYS[selected.execution.speed])}</dd></div></dl></section>
        </div>

        <section className="schedule-history">
          <header><div><History size={15} /><h2>{t('schedule.history.title')}</h2></div><span>{t('schedule.history.summary', { count: selected.runs.length })}</span>{onArchiveSessions && finishedSessions.length > 0 ? <button type="button" className="button" disabled={busy} onClick={() => {
            setConfirmation({ kind: 'archive', id: selected.id, files: finishedSessions.map((session) => session.filePath) })
          }}><Archive size={13} />{action === `archive:${selected.id}` ? t('schedule.history.archiving') : t('schedule.history.archiveFinished', { count: finishedSessions.length })}</button> : null}</header>
          {recentRuns.length ? <div className="schedule-history__list">{recentRuns.map((run) => {
            const runSession = sessions.find((session) => session.filePath === run.sessionFile) ?? (run.sessionId ? sessionMap.get(run.sessionId) : undefined)
            return <article key={run.id} className={`schedule-run schedule-run--${run.status}`}>
              <div className="schedule-run__icon">{runIcon(run.status)}</div>
              <div className="schedule-run__main"><div><strong>{t(RUN_STATUS_KEYS[run.status])}</strong><span>{t(RUN_TRIGGER_KEYS[run.trigger])}</span>{runSession?.archived ? <span>{t('schedule.history.archived')}</span> : null}</div><p>{run.error ?? t('schedule.history.scheduledFor', { date: formatRunDate(t, run.scheduledFor) })}</p></div>
              <time dateTime={run.queuedAt}>{formatRunDate(t, run.finishedAt ?? run.startedAt ?? run.queuedAt)}</time>
              {run.sessionFile ? <button type="button" className="schedule-session-link" onClick={() => onOpenSession(run.sessionFile!)}>{t('schedule.open', { title: runSession?.title ?? t('schedule.history.sessionFallback') })} <ChevronRight size={13} /></button> : <span className="schedule-run__no-session">{t('schedule.history.noSession')}</span>}
            </article>
          })}</div> : <div className="schedule-history__empty"><History size={20} /><p>{t('schedule.history.empty')}</p></div>}
        </section>
        {editorModal}
        {confirmationModal}
      </div></div>
    )
  }

  return (
    <div className="page scroll-area"><div className="page-container schedule-page">
      <header className="page-header schedule-page__header"><div><span className="schedule-page__kicker"><span /> {t('schedule.page.kicker')}</span><h1>{t('nav.scheduled')}</h1><p>{t('schedule.page.subtitle', { harness: HARNESS_SHORT_NAMES[harness] })}</p></div><button type="button" className="button button--primary" onClick={openCreate}><Plus size={14} /> {t('schedule.page.new')}</button></header>
      <div className="schedule-ledger-summary" aria-label={t('schedule.summary.aria')}>
        <span><i className="is-active" /> <strong>{counts.active}</strong> {t('schedule.summary.active')}</span>
        <span><i className="is-paused" /> <strong>{counts.paused}</strong> {t('schedule.summary.paused')}</span>
        <span><i className="is-attention" /> <strong>{counts.attention}</strong> {t('schedule.summary.attention')}</span>
      </div>
      <div className="page-tools schedule-tools"><Segmented value={filter} label={t('schedule.filter.aria')} onChange={(value) => setFilter(value as ScheduleFilter)} options={[{ value: 'active', label: t('schedule.filter.active') }, { value: 'paused', label: t('schedule.filter.paused') }, { value: 'attention', label: t('schedule.status.attention') }, { value: 'all', label: t('common.all') }]} /><span>{t('schedule.count', { count: visible.length })}</span></div>
      {error ? <p className="page-inline-error" role="alert">{t('schedule.error.catalog', { error })}</p> : null}
      {actionError ? <p className="page-inline-error" role="alert">{actionError}</p> : null}
      {visible.length ? <div className="schedule-ledger">{visible.map((item) => {
        const project = projectMap.get(item.target.projectId)
        const targetSession = item.target.kind === 'session' ? sessionMap.get(item.target.sessionId) : undefined
        return <button type="button" key={item.id} className="schedule-row" onClick={() => { setSelectedId(item.id); setActionError(''); setActionNotice('') }} aria-label={t('schedule.open', { title: item.title })}>
          <span className={`schedule-row__status schedule-row__status--${needsAttention(item) ? 'attention' : item.status}`}>{statusIcon(item)}</span>
          <span className="schedule-row__main"><span><strong>{item.title}</strong><i className={`schedule-state schedule-state--${needsAttention(item) ? 'attention' : item.status}`}>{statusLabel(t, item)}</i></span><small>{item.prompt}</small><span className="schedule-row__tags"><span><FolderKanban size={11} />{targetSession?.title ?? project?.name ?? t('schedule.target.unavailable')}</span><span><Repeat2 size={11} />{timingLabel(t, item.timing)}</span><span><Gauge size={11} />{models.find((model) => model.key === item.execution.model)?.name ?? item.execution.model}</span></span></span>
          <span className="schedule-row__next"><small>{t('schedule.row.next')}</small><strong>{item.nextRunAt ? formatDateTime(t, item.nextRunAt) : '—'}</strong><span>{item.nextRunAt ? formatRelative(item.nextRunAt) : t('schedule.row.noFutureRun')}</span></span>
          <ChevronRight className="schedule-row__chevron" size={16} />
        </button>
      })}</div> : <EmptyState icon={<CalendarClock size={24} />} title={t(EMPTY_TITLE_KEYS[filter])} action={schedules.length ? undefined : <button type="button" className="button button--primary" onClick={openCreate}><Plus size={13} /> {t('schedule.editor.create')}</button>}> {schedules.length ? t('schedule.empty.filterHint') : t('schedule.empty.createHint', { harness: HARNESS_SHORT_NAMES[harness] })}</EmptyState>}
      {nativeHeartbeats.length ? <section className="native-heartbeats" aria-labelledby="native-heartbeats-title">
        <div className="native-heartbeats__header"><div><span className="schedule-page__kicker">Prime Agent</span><h2 id="native-heartbeats-title">Agent heartbeats</h2></div><small>Auto-discovered; the owning runtime is authoritative</small></div>
        {heartbeatPauseUnavailable ? <p className="native-heartbeats__note">{heartbeatPauseUnavailable}</p> : null}
        <div className="native-heartbeats__list">{nativeHeartbeats.map((heartbeat) => <article key={heartbeat.id} className="native-heartbeat">
          <span className={`schedule-row__status schedule-row__status--${heartbeat.status}`}><CalendarClock size={15} /></span>
          <div className="native-heartbeat__main"><span><strong>{heartbeat.label || (heartbeat.source === 'heartbeat' ? 'Thread heartbeat' : 'Agent heartbeat')}</strong><i className={`schedule-state schedule-state--${heartbeat.status}`}>{heartbeat.status}</i></span><p>{heartbeat.prompt}</p><small>{heartbeat.schedule}{heartbeat.nextRunAt ? ` · next ${formatRelative(heartbeat.nextRunAt)}` : ''}</small></div>
          <div className="native-heartbeat__actions">{heartbeat.status === 'active' ? <button type="button" className="button" disabled={Boolean(action || heartbeatPauseUnavailable)} title={heartbeatPauseUnavailable} onClick={() => void perform(`heartbeat:${heartbeat.id}`, () => onManageHeartbeat(heartbeat.id, 'pause'), 'Heartbeat paused.')}>Pause</button> : <button type="button" className="button" disabled={Boolean(action || heartbeatPauseUnavailable)} title={heartbeatPauseUnavailable} onClick={() => void perform(`heartbeat:${heartbeat.id}`, () => onManageHeartbeat(heartbeat.id, 'resume'), 'Heartbeat resumed.')}>Resume</button>}<button type="button" className="button" disabled={Boolean(action)} onClick={() => setConfirmation({ kind: 'stop', heartbeat })}>Stop</button></div>
        </article>)}</div>
      </section> : null}
      {editorModal}
      {confirmationModal}
    </div></div>
  )
}
