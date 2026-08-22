import {
  AlertTriangle,
  ArrowLeft,
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
  PrimeModelDescriptor,
  PrimeThinkingLevel,
  ProjectRecord,
  ScheduleExecution,
  ScheduleInput,
  SchedulePatch,
  SchedulePreview,
  ScheduleRunRecord,
  ScheduleTarget,
  ScheduleTiming,
  SessionRecord,
} from '@/types/api'
import { PRIME_THINKING_LEVELS } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { errorMessage } from '@/lib/errors'
import { EmptyState, Modal, Segmented } from '@/components/ui'

type ScheduleFilter = 'active' | 'paused' | 'attention' | 'all'
type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced'
type EditorMode = 'create' | 'edit'

type ScheduleForm = {
  title: string
  prompt: string
  targetKind: 'project' | 'session'
  projectId: string
  sessionId: string
  timingKind: 'once' | 'recurring'
  date: string
  time: string
  timeZone: string
  frequency: Frequency
  interval: string
  weekdays: string[]
  advancedRrule: string
  model: string
  thinking: 'auto' | PrimeThinkingLevel
  fast: boolean
}

interface ScheduledPageProps {
  harness: HarnessId
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
  onCreate(input: ScheduleInput): Promise<void>
  onUpdate(id: string, patch: SchedulePatch): Promise<void>
  onPause(id: string): Promise<void>
  onResume(id: string): Promise<void>
  onDelete(id: string): Promise<void>
  onRunNow(id: string): Promise<void>
  onPreview(timing: ScheduleTiming): Promise<SchedulePreview>
  onOpenSession(sessionFile: string): void
  onManageHeartbeat(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void>
}

const DEVICE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const WEEKDAYS = [
  { value: 'MO', label: 'M', long: 'Monday' },
  { value: 'TU', label: 'T', long: 'Tuesday' },
  { value: 'WE', label: 'W', long: 'Wednesday' },
  { value: 'TH', label: 'T', long: 'Thursday' },
  { value: 'FR', label: 'F', long: 'Friday' },
  { value: 'SA', label: 'S', long: 'Saturday' },
  { value: 'SU', label: 'S', long: 'Sunday' },
] as const
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const THINKING_LEVELS: readonly PrimeThinkingLevel[] = PRIME_THINKING_LEVELS
const FREQUENCIES: Array<{ value: Frequency; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'advanced', label: 'Advanced' },
]

const pad = (value: number) => String(value).padStart(2, '0')

function localParts(value: Date) {
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  }
}

function defaultStart() {
  const value = new Date(Date.now() + 60 * 60 * 1000)
  value.setMinutes(0, 0, 0)
  return localParts(value)
}

function isAuthorized(project: ProjectRecord) {
  return !project.inferred
}

function projectForSession(session: SessionRecord, projects: ProjectRecord[]) {
  return projects.find((project) => project.path === session.projectPath)
}

function defaultScheduleModel(models: PrimeModelDescriptor[], lastSelectedModel: string): string {
  return models.find((model) => model.key === lastSelectedModel && model.enabled !== false && model.available)?.key
    ?? models.find((model) => model.enabled !== false && model.available)?.key
    ?? ''
}

function defaultForm(projects: ProjectRecord[], sessions: SessionRecord[], models: PrimeModelDescriptor[], lastSelectedModel: string, initialProjectId?: string, initialSessionId?: string): ScheduleForm {
  const authorizedProjects = projects.filter(isAuthorized)
  const initialSession = sessions.find((session) => session.id === initialSessionId && !session.archived)
  const sessionProject = initialSession ? projectForSession(initialSession, authorizedProjects) : undefined
  const selectedProject = sessionProject
    ?? authorizedProjects.find((project) => project.id === initialProjectId)
    ?? authorizedProjects[0]
  const start = defaultStart()
  return {
    title: '',
    prompt: '',
    targetKind: initialSession && sessionProject ? 'session' : 'project',
    projectId: selectedProject?.id ?? '',
    sessionId: initialSession && sessionProject ? initialSession.id : '',
    timingKind: 'recurring',
    date: start.date,
    time: start.time,
    timeZone: DEVICE_TIME_ZONE,
    frequency: 'daily',
    interval: '1',
    weekdays: [DAY_CODES[new Date().getDay()]],
    advancedRrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    model: defaultScheduleModel(models, lastSelectedModel),
    thinking: 'auto',
    fast: false,
  }
}

function rruleParts(rrule: string) {
  return new Map(rrule.replace(/^RRULE:/i, '').split(';').map((part) => {
    const [key, ...value] = part.split('=')
    return [key.toUpperCase(), value.join('=')]
  }))
}

function formFromSchedule(item: AutomationScheduleRecord, models: PrimeModelDescriptor[], lastSelectedModel: string): ScheduleForm {
  const start = item.timing.kind === 'once'
    ? localParts(new Date(item.timing.at))
    : { date: item.timing.dtstartLocal.slice(0, 10), time: item.timing.dtstartLocal.slice(11, 16) }
  const parts = item.timing.kind === 'rrule' ? rruleParts(item.timing.rrule) : new Map<string, string>()
  const rawFrequency = parts.get('FREQ')?.toLowerCase()
  const frequency = rawFrequency === 'hourly' || rawFrequency === 'daily' || rawFrequency === 'weekly' || rawFrequency === 'monthly'
    ? rawFrequency
    : 'advanced'
  return {
    title: item.title,
    prompt: item.prompt,
    targetKind: item.target.kind,
    projectId: item.target.projectId,
    sessionId: item.target.kind === 'session' ? item.target.sessionId : '',
    timingKind: item.timing.kind === 'once' ? 'once' : 'recurring',
    date: start.date,
    time: start.time,
    timeZone: item.timing.kind === 'rrule' ? item.timing.timeZone : DEVICE_TIME_ZONE,
    frequency,
    interval: parts.get('INTERVAL') ?? '1',
    weekdays: parts.get('BYDAY')?.split(',').filter(Boolean) ?? [DAY_CODES[new Date().getDay()]],
    advancedRrule: item.timing.kind === 'rrule' ? item.timing.rrule : 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    model: item.execution.model === 'auto' ? defaultScheduleModel(models, lastSelectedModel) : item.execution.model,
    thinking: item.execution.thinking,
    fast: item.execution.speed === 'fast',
  }
}

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).format()
    return true
  } catch {
    return false
  }
}

function timingFromForm(form: ScheduleForm): ScheduleTiming | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !/^\d{2}:\d{2}$/.test(form.time)) return null
  if (form.timingKind === 'once') {
    const at = new Date(`${form.date}T${form.time}:00`)
    return Number.isNaN(at.getTime()) ? null : { kind: 'once', at: at.toISOString() }
  }
  if (!validTimeZone(form.timeZone.trim())) return null
  let rrule = form.advancedRrule.trim().replace(/^RRULE:/i, '')
  if (form.frequency !== 'advanced') {
    const interval = Math.max(1, Number.parseInt(form.interval, 10) || 1)
    rrule = `FREQ=${form.frequency.toUpperCase()};INTERVAL=${interval}`
    if (form.frequency === 'weekly') {
      if (!form.weekdays.length) return null
      rrule += `;BYDAY=${form.weekdays.join(',')}`
    }
  }
  if (!/(^|;)FREQ=[A-Z]+/i.test(rrule)) return null
  return {
    kind: 'rrule',
    dtstartLocal: `${form.date}T${form.time}:00`,
    timeZone: form.timeZone.trim(),
    rrule,
  }
}

function targetFromForm(form: ScheduleForm): ScheduleTarget {
  return form.targetKind === 'session'
    ? { kind: 'session', projectId: form.projectId, sessionId: form.sessionId }
    : { kind: 'project', projectId: form.projectId }
}

function executionFromForm(form: ScheduleForm): ScheduleExecution {
  return { model: form.model, thinking: form.thinking, speed: form.fast ? 'fast' : 'normal' }
}

function formatDateTime(value?: string) {
  if (!value) return 'Not scheduled'
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

function formatRunDate(value?: string) {
  if (!value) return 'Pending'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date)
}

function timingLabel(timing: ScheduleTiming) {
  if (timing.kind === 'once') return `Once · ${formatDateTime(timing.at)}`
  const parts = rruleParts(timing.rrule)
  const frequency = parts.get('FREQ')?.toLowerCase()
  const interval = Number(parts.get('INTERVAL') ?? '1')
  const singular = frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : frequency === 'monthly' ? 'month' : frequency === 'hourly' ? 'hour' : 'cycle'
  const cadence = interval > 1 ? `Every ${interval} ${singular}s` : `Every ${singular}`
  const days = parts.get('BYDAY')
  return `${cadence}${days ? ` · ${days}` : ''} at ${timing.dtstartLocal.slice(11, 16)} ${timing.timeZone}`
}

function needsAttention(item: AutomationScheduleRecord) {
  const latest = item.runs.at(-1)
  return item.status === 'blocked' || latest?.status === 'failed' || latest?.status === 'interrupted'
}

function statusLabel(item: AutomationScheduleRecord) {
  return needsAttention(item) ? 'Needs attention' : item.status
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
  harness, schedules, nativeHeartbeats, projects, sessions, models, lastSelectedModel, error, initialProjectId, initialSessionId, selectedScheduleId,
  onCreate, onUpdate, onPause, onResume, onDelete, onRunNow, onPreview, onOpenSession, onManageHeartbeat,
}: ScheduledPageProps) {
  const [filter, setFilter] = useState<ScheduleFilter>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: EditorMode; scheduleId?: string } | null>(null)
  const [form, setForm] = useState<ScheduleForm>(() => defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId))
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const previewRequest = useRef(0)

  const authorizedProjects = useMemo(() => projects.filter(isAuthorized), [projects])
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const selected = schedules.find((item) => item.id === selectedId) ?? null
  useEffect(() => {
    if (selectedScheduleId && schedules.some((item) => item.id === selectedScheduleId)) setSelectedId(selectedScheduleId)
  }, [schedules, selectedScheduleId])
  const editingSchedule = editor?.mode === 'edit' ? schedules.find((item) => item.id === editor.scheduleId) : undefined
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
      void onPreview(currentTiming).then((result) => {
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
  }, [currentTiming, editor, onPreview])

  const openCreate = () => {
    const next = defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId)
    setForm(next); setBaseline(JSON.stringify(next)); setFormError(''); setPreview(null); setEditor({ mode: 'create' })
  }
  const openEdit = (item: AutomationScheduleRecord) => {
    const next = formFromSchedule(item, models, lastSelectedModel)
    setForm(next); setBaseline(JSON.stringify(next)); setFormError(''); setPreview(null); setEditor({ mode: 'edit', scheduleId: item.id })
  }
  const closeEditor = () => {
    if (saving) return
    if (JSON.stringify(form) !== baseline && !window.confirm('Discard your unsaved schedule changes?')) return
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
    if (!form.title.trim()) return 'Give this schedule a title.'
    if (!form.prompt.trim()) return `Add a prompt for ${HARNESS_SHORT_NAMES[harness]} to run.`
    if (!form.model || !availableModels.some((model) => model.key === form.model)) return 'Choose an available model.'
    if (!form.projectId || !authorizedProjects.some((project) => project.id === form.projectId)) return 'Choose an authorized project.'
    if (form.targetKind === 'session' && !eligibleSessions.some((session) => session.id === form.sessionId)) return 'Choose an authorized session.'
    if (!currentTiming) {
      if (form.timingKind === 'recurring' && !validTimeZone(form.timeZone.trim())) return 'Enter a valid IANA timezone.'
      if (form.frequency === 'weekly' && !form.weekdays.length) return 'Choose at least one weekday.'
      return form.frequency === 'advanced' ? 'Enter a valid RRULE containing FREQ.' : 'Choose a valid date and time.'
    }
    return ''
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const validationError = validate()
    if (validationError || !currentTiming) { setFormError(validationError); return }
    setSaving(true); setFormError('')
    const values = {
      title: form.title.trim(), prompt: form.prompt.trim(), target: targetFromForm(form),
      timing: currentTiming, execution: executionFromForm(form),
    }
    try {
      if (editor?.mode === 'edit' && editingSchedule) await onUpdate(editingSchedule.id, { revision: editingSchedule.revision, ...values })
      else await onCreate(values)
      setEditor(null)
    } catch (reason) { setFormError(errorMessage(reason)) }
    finally { setSaving(false) }
  }
  const perform = async (key: string, work: () => Promise<void>, success: string, after?: () => void) => {
    if (action) return
    setAction(key); setActionError(''); setActionNotice('')
    try { await work(); setActionNotice(success); after?.() }
    catch (reason) { setActionError(errorMessage(reason)) }
    finally { setAction(null) }
  }
  const deleteSchedule = (item: AutomationScheduleRecord) => {
    if (!window.confirm(`Delete “${item.title}”? Run history for this schedule will no longer be available here.`)) return
    void perform(`delete:${item.id}`, () => onDelete(item.id), 'Schedule deleted.', () => setSelectedId(null))
  }

  const editorModal = editor ? (
    <Modal title={editor.mode === 'create' ? 'Create schedule' : 'Edit schedule'} onClose={closeEditor} footer={(
      <>
        <span className="schedule-editor__save-status" aria-live="polite">{saving ? 'Saving without closing your draft…' : ''}</span>
        <button type="button" className="button" disabled={saving} onClick={closeEditor}>Cancel</button>
        <button type="submit" form="schedule-editor-form" className="button button--primary" disabled={saving}>
          {saving ? 'Saving…' : editor.mode === 'create' ? 'Create schedule' : 'Save changes'}
        </button>
      </>
    )}>
      <form id="schedule-editor-form" className="schedule-editor" onSubmit={(event) => void save(event)}>
        <div className="schedule-editor__lead">
          <Sparkles size={15} />
          <p>{HARNESS_SHORT_NAMES[harness]} runs this prompt unattended. You can always pause it or open the session produced by a run.</p>
        </div>
        <div className="schedule-editor__copy">
          <label className="field"><span>Title</span><input autoFocus required value={form.title} disabled={saving} placeholder="Morning issue triage" onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
          <label className="field"><span>Prompt</span><textarea required rows={4} value={form.prompt} disabled={saving} placeholder="Review new high-priority issues, identify blockers, and propose owners…" onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} /></label>
        </div>
        <div className="schedule-editor__grid">
          <fieldset className="schedule-fieldset">
            <legend><FolderKanban size={14} /> Destination</legend>
            <div className="schedule-radio-grid">
              <label className={form.targetKind === 'project' ? 'is-selected' : ''}><input type="radio" name="target" checked={form.targetKind === 'project'} onChange={() => setForm((current) => ({ ...current, targetKind: 'project' }))} /><span><strong>New session</strong><small>Start fresh in a project</small></span></label>
              <label className={form.targetKind === 'session' ? 'is-selected' : ''}><input type="radio" name="target" checked={form.targetKind === 'session'} onChange={() => setForm((current) => ({ ...current, targetKind: 'session' }))} /><span><strong>Existing session</strong><small>Continue a thread</small></span></label>
            </div>
            <label className="field"><span>Authorized project</span><select value={form.projectId} disabled={saving || !authorizedProjects.length} onChange={(event) => setProject(event.target.value)}><option value="">Choose a project</option>{authorizedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            {form.targetKind === 'session' ? <label className="field"><span>Session</span><select value={form.sessionId} disabled={saving || !eligibleSessions.length} onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}><option value="">Choose a session</option>{eligibleSessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label> : null}
            {!authorizedProjects.length ? <p className="schedule-field-note schedule-field-note--warning"><AlertTriangle size={13} /> Add or authorize a project before scheduling work.</p> : <p className="schedule-field-note">{selectedProject?.primaryFolder}</p>}
          </fieldset>

          <fieldset className="schedule-fieldset">
            <legend><CalendarClock size={14} /> Timing</legend>
            <div className="schedule-radio-grid schedule-radio-grid--timing">
              <label className={form.timingKind === 'once' ? 'is-selected' : ''}><input type="radio" name="timing" checked={form.timingKind === 'once'} onChange={() => setForm((current) => ({ ...current, timingKind: 'once' }))} /><span><strong>Once</strong><small>One future run</small></span></label>
              <label className={form.timingKind === 'recurring' ? 'is-selected' : ''}><input type="radio" name="timing" checked={form.timingKind === 'recurring'} onChange={() => setForm((current) => ({ ...current, timingKind: 'recurring' }))} /><span><strong>Recurring</strong><small>Repeat on a cadence</small></span></label>
            </div>
            {form.timingKind === 'recurring' ? <>
              <div className="schedule-frequency" role="group" aria-label="Recurrence frequency">{FREQUENCIES.map((option) => <button key={option.value} type="button" className={form.frequency === option.value ? 'is-active' : ''} aria-pressed={form.frequency === option.value} onClick={() => setForm((current) => ({ ...current, frequency: option.value }))}>{option.label}</button>)}</div>
              {form.frequency !== 'advanced' ? <div className="schedule-inline-fields">
                <label className="field"><span>Every</span><input type="number" min="1" max="999" value={form.interval} onChange={(event) => setForm((current) => ({ ...current, interval: event.target.value }))} /></label>
                <span>{form.frequency === 'hourly' ? 'hour(s)' : form.frequency === 'daily' ? 'day(s)' : form.frequency === 'weekly' ? 'week(s)' : 'month(s)'}</span>
              </div> : <label className="field"><span>RRULE</span><textarea className="schedule-rrule" rows={3} spellCheck={false} value={form.advancedRrule} placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" onChange={(event) => setForm((current) => ({ ...current, advancedRrule: event.target.value }))} /></label>}
              {form.frequency === 'weekly' ? <fieldset className="weekday-fieldset"><legend>On days</legend><div className="weekday-chips">{WEEKDAYS.map((day) => { const active = form.weekdays.includes(day.value); return <label key={day.value} className={active ? 'is-active' : ''} title={day.long}><input type="checkbox" checked={active} onChange={() => setForm((current) => ({ ...current, weekdays: active ? current.weekdays.filter((value) => value !== day.value) : [...current.weekdays, day.value] }))} /><span>{day.label}</span></label> })}</div></fieldset> : null}
            </> : null}
            <div className="schedule-date-fields">
              <label className="field"><span>{form.timingKind === 'once' ? 'Date' : 'Starts'}</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} /></label>
              <label className="field"><span>Local time</span><input type="time" value={form.time} onChange={(event) => setForm((current) => ({ ...current, time: event.target.value }))} /></label>
            </div>
            {form.timingKind === 'recurring' ? <label className="field"><span>IANA timezone</span><input list="schedule-time-zones" value={form.timeZone} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} /><datalist id="schedule-time-zones"><option value={DEVICE_TIME_ZONE} /><option value="UTC" /><option value="America/Los_Angeles" /><option value="America/New_York" /><option value="Europe/London" /><option value="Asia/Tokyo" /></datalist></label> : <p className="schedule-field-note">Uses this device’s timezone: {DEVICE_TIME_ZONE}</p>}
          </fieldset>
        </div>

        <fieldset className="schedule-fieldset schedule-fieldset--execution">
          <legend><Gauge size={14} /> Execution</legend>
          <div className="schedule-execution-grid">
            <label className="field"><span>Model</span><select value={form.model} onChange={(event) => selectModel(event.target.value)}>{!form.model ? <option value="" disabled>No model available</option> : null}{form.model && !models.some((model) => model.key === form.model && model.enabled !== false && model.available) ? <option value={form.model}>{form.model} (unavailable)</option> : null}{availableModels.map((model) => <option key={model.key} value={model.key}>{model.name} · {model.provider}</option>)}</select></label>
            <label className="field"><span>Reasoning</span><select value={form.thinking} onChange={(event) => setForm((current) => ({ ...current, thinking: event.target.value as ScheduleForm['thinking'] }))}><option value="auto">Auto</option>{THINKING_LEVELS.filter((level) => !selectedModel || selectedModel.availableThinkingLevels.includes(level) || level === form.thinking).map((level) => <option key={level} value={level}>{level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1)}</option>)}</select></label>
            <label className={`schedule-fast-toggle ${selectedModel && !selectedModel.fastModeSupported ? 'is-disabled' : ''}`}><input type="checkbox" checked={form.fast} disabled={Boolean(selectedModel && !selectedModel.fastModeSupported)} onChange={(event) => setForm((current) => ({ ...current, fast: event.target.checked }))} /><span><Play size={13} /><strong>Fast</strong><small>{selectedModel && !selectedModel.fastModeSupported ? 'Unavailable for model' : 'Prioritize latency'}</small></span></label>
          </div>
        </fieldset>

        <section className="schedule-preview" aria-live="polite" aria-label="Upcoming schedule preview">
          <div><span><Clock3 size={14} /> Next occurrences</span>{previewing ? <small>Checking server…</small> : null}</div>
          {previewError ? <p className="schedule-preview__error">Preview unavailable: {previewError}</p> : preview?.occurrences.length ? <ol>{preview.occurrences.slice(0, 5).map((occurrence) => <li key={occurrence}><i /><span>{formatDateTime(occurrence)}</span><small>{formatRelative(occurrence)}</small></li>)}</ol> : <p>{currentTiming ? 'No future occurrences returned.' : 'Complete the timing fields to preview runs.'}</p>}
        </section>
        {formError ? <p className="page-inline-error" role="alert">{formError}</p> : null}
      </form>
    </Modal>
  ) : null

  if (selected) {
    const project = projectMap.get(selected.target.projectId)
    const targetSession = selected.target.kind === 'session' ? sessionMap.get(selected.target.sessionId) : undefined
    const recentRuns = [...selected.runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 8)
    const busy = Boolean(action)
    return (
      <div className="page scroll-area"><div className="page-container schedule-page schedule-page--detail">
        <button type="button" className="schedule-back" onClick={() => { setSelectedId(null); setActionError(''); setActionNotice('') }}><ArrowLeft size={15} /> All schedules</button>
        <header className="schedule-detail__header">
          <div className={`schedule-detail__mark schedule-detail__mark--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusIcon(selected, 18)}</div>
          <div><span className={`schedule-state schedule-state--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusLabel(selected)}</span><h1>{selected.title}</h1><p>Revision {selected.revision} · Updated {formatRelative(selected.updatedAt)}</p></div>
        </header>
        <div className="schedule-detail__actions" aria-label="Schedule actions">
          <button type="button" className="button button--primary" disabled={busy || selected.status === 'completed'} onClick={() => void perform(`run:${selected.id}`, () => onRunNow(selected.id), 'Run queued.')}><Play size={13} />{action === `run:${selected.id}` ? 'Queuing…' : 'Run now'}</button>
          <button type="button" className="button" disabled={busy} onClick={() => openEdit(selected)}><Pencil size={13} /> Edit</button>
          {selected.status === 'active' || selected.status === 'blocked' ? <button type="button" className="button" disabled={busy} onClick={() => void perform(`pause:${selected.id}`, () => onPause(selected.id), 'Schedule paused.')}><Pause size={13} />{action === `pause:${selected.id}` ? 'Pausing…' : 'Pause'}</button> : selected.status === 'paused' ? <button type="button" className="button" disabled={busy} onClick={() => void perform(`resume:${selected.id}`, () => onResume(selected.id), 'Schedule resumed.')}><RotateCw size={13} />{action === `resume:${selected.id}` ? 'Resuming…' : 'Resume'}</button> : null}
          <button type="button" className="button schedule-delete" disabled={busy} onClick={() => deleteSchedule(selected)}><Trash2 size={13} /> Delete</button>
        </div>
        {error ? <p className="page-inline-error" role="alert">Schedule catalog unavailable: {error}</p> : null}
        {actionError ? <p className="page-inline-error" role="alert">{actionError}</p> : null}
        {actionNotice ? <p className="schedule-action-notice" role="status"><CheckCircle2 size={14} />{actionNotice}</p> : null}
        {selected.blockedReason ? <div className="schedule-blocked" role="status"><AlertTriangle size={16} /><div><strong>Schedule needs attention</strong><p>{selected.blockedReason}</p></div></div> : null}

        <div className="schedule-detail__grid">
          <section className="schedule-detail__card schedule-detail__card--prompt"><span className="schedule-detail__eyebrow">Instruction</span><p>{selected.prompt}</p></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">Delivery</span><dl><div><dt>Target</dt><dd>{targetSession?.title ?? project?.name ?? 'Unavailable target'}</dd></div><div><dt>Mode</dt><dd>{selected.target.kind === 'session' ? 'Existing session' : 'New session'}</dd></div><div><dt>Created by</dt><dd>{selected.createdBy}</dd></div></dl></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">Cadence</span><dl><div><dt>Timing</dt><dd>{timingLabel(selected.timing)}</dd></div><div><dt>Next run</dt><dd>{selected.nextRunAt ? `${formatDateTime(selected.nextRunAt)} · ${formatRelative(selected.nextRunAt)}` : 'None scheduled'}</dd></div>{selected.timing.kind === 'rrule' ? <div><dt>Rule</dt><dd><code>{selected.timing.rrule}</code></dd></div> : null}</dl></section>
          <section className="schedule-detail__card"><span className="schedule-detail__eyebrow">Execution</span><dl><div><dt>Model</dt><dd>{models.find((model) => model.key === selected.execution.model)?.name ?? selected.execution.model}</dd></div><div><dt>Reasoning</dt><dd>{selected.execution.thinking}</dd></div><div><dt>Speed</dt><dd>{selected.execution.speed}</dd></div></dl></section>
        </div>

        <section className="schedule-history">
          <header><div><History size={15} /><h2>Run history</h2></div><span>{selected.runs.length} total · latest 8</span></header>
          {recentRuns.length ? <div className="schedule-history__list">{recentRuns.map((run) => {
            const runSession = run.sessionId ? sessionMap.get(run.sessionId) : undefined
            return <article key={run.id} className={`schedule-run schedule-run--${run.status}`}>
              <div className="schedule-run__icon">{runIcon(run.status)}</div>
              <div className="schedule-run__main"><div><strong>{run.status}</strong><span>{run.trigger}</span></div><p>{run.error ?? `Scheduled for ${formatRunDate(run.scheduledFor)}`}</p></div>
              <time dateTime={run.queuedAt}>{formatRunDate(run.finishedAt ?? run.startedAt ?? run.queuedAt)}</time>
              {run.sessionFile ? <button type="button" className="schedule-session-link" onClick={() => onOpenSession(run.sessionFile!)}>Open {runSession?.title ?? 'session'} <ChevronRight size={13} /></button> : <span className="schedule-run__no-session">No session</span>}
            </article>
          })}</div> : <div className="schedule-history__empty"><History size={20} /><p>No runs yet. Run it now or wait for the first occurrence.</p></div>}
        </section>
        {editorModal}
      </div></div>
    )
  }

  return (
    <div className="page scroll-area"><div className="page-container schedule-page">
      <header className="page-header schedule-page__header"><div><span className="schedule-page__kicker"><span /> Automation desk</span><h1>Scheduled</h1><p>Unattended {HARNESS_SHORT_NAMES[harness]} work, with every run accounted for.</p></div><button type="button" className="button button--primary" onClick={openCreate}><Plus size={14} /> New schedule</button></header>
      <div className="schedule-ledger-summary" aria-label="Schedule summary">
        <span><i className="is-active" /> <strong>{counts.active}</strong> active</span>
        <span><i className="is-paused" /> <strong>{counts.paused}</strong> paused</span>
        <span><i className="is-attention" /> <strong>{counts.attention}</strong> need attention</span>
      </div>
      <div className="page-tools schedule-tools"><Segmented value={filter} label="Schedule filter" onChange={(value) => setFilter(value as ScheduleFilter)} options={[{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'attention', label: 'Needs attention' }, { value: 'all', label: 'All' }]} /><span>{visible.length} {visible.length === 1 ? 'schedule' : 'schedules'}</span></div>
      {error ? <p className="page-inline-error" role="alert">Schedule catalog unavailable: {error}</p> : null}
      {actionError ? <p className="page-inline-error" role="alert">{actionError}</p> : null}
      {visible.length ? <div className="schedule-ledger">{visible.map((item) => {
        const project = projectMap.get(item.target.projectId)
        const targetSession = item.target.kind === 'session' ? sessionMap.get(item.target.sessionId) : undefined
        return <button type="button" key={item.id} className="schedule-row" onClick={() => { setSelectedId(item.id); setActionError(''); setActionNotice('') }} aria-label={`Open ${item.title}`}>
          <span className={`schedule-row__status schedule-row__status--${needsAttention(item) ? 'attention' : item.status}`}>{statusIcon(item)}</span>
          <span className="schedule-row__main"><span><strong>{item.title}</strong><i className={`schedule-state schedule-state--${needsAttention(item) ? 'attention' : item.status}`}>{statusLabel(item)}</i></span><small>{item.prompt}</small><span className="schedule-row__tags"><span><FolderKanban size={11} />{targetSession?.title ?? project?.name ?? 'Unavailable target'}</span><span><Repeat2 size={11} />{timingLabel(item.timing)}</span><span><Gauge size={11} />{models.find((model) => model.key === item.execution.model)?.name ?? item.execution.model}</span></span></span>
          <span className="schedule-row__next"><small>Next</small><strong>{item.nextRunAt ? formatDateTime(item.nextRunAt) : '—'}</strong><span>{item.nextRunAt ? formatRelative(item.nextRunAt) : 'No future run'}</span></span>
          <ChevronRight className="schedule-row__chevron" size={16} />
        </button>
      })}</div> : <EmptyState icon={<CalendarClock size={24} />} title={filter === 'all' ? 'No scheduled work' : `No ${filter === 'attention' ? 'schedules need attention' : `${filter} schedules`}`} action={schedules.length ? undefined : <button type="button" className="button button--primary" onClick={openCreate}><Plus size={13} /> Create schedule</button>}> {schedules.length ? 'Choose another filter to see the rest of your automation ledger.' : `Create a schedule and ${HARNESS_SHORT_NAMES[harness]} will bring every result back here.`}</EmptyState>}
      {nativeHeartbeats.length ? <section className="native-heartbeats" aria-labelledby="native-heartbeats-title">
        <div className="native-heartbeats__header"><div><span className="schedule-page__kicker">Prime Agent</span><h2 id="native-heartbeats-title">Agent heartbeats</h2></div><small>Auto-discovered; the owning runtime is authoritative</small></div>
        <div className="native-heartbeats__list">{nativeHeartbeats.map((heartbeat) => <article key={heartbeat.id} className="native-heartbeat">
          <span className={`schedule-row__status schedule-row__status--${heartbeat.status}`}><CalendarClock size={15} /></span>
          <div className="native-heartbeat__main"><span><strong>{heartbeat.label || (heartbeat.source === 'heartbeat' ? 'Thread heartbeat' : 'Agent heartbeat')}</strong><i className={`schedule-state schedule-state--${heartbeat.status}`}>{heartbeat.status}</i></span><p>{heartbeat.prompt}</p><small>{heartbeat.schedule}{heartbeat.nextRunAt ? ` · next ${formatRelative(heartbeat.nextRunAt)}` : ''}</small></div>
          <div className="native-heartbeat__actions">{heartbeat.status === 'active' ? <button type="button" className="button" disabled={Boolean(action)} onClick={() => void perform(`heartbeat:${heartbeat.id}`, () => onManageHeartbeat(heartbeat.id, 'pause'), 'Heartbeat paused.')}>Pause</button> : <button type="button" className="button" disabled={Boolean(action)} onClick={() => void perform(`heartbeat:${heartbeat.id}`, () => onManageHeartbeat(heartbeat.id, 'resume'), 'Heartbeat resumed.')}>Resume</button>}<button type="button" className="button" disabled={Boolean(action)} onClick={() => void perform(`heartbeat:${heartbeat.id}`, () => onManageHeartbeat(heartbeat.id, 'stop'), 'Heartbeat stopped.')}>Stop</button></div>
        </article>)}</div>
      </section> : null}
      {editorModal}
    </div></div>
  )
}
