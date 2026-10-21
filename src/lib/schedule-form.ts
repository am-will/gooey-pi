import { preferredModel } from '@/lib/models'
import type { AutomationScheduleRecord, PrimeModelDescriptor, PrimeThinkingLevel, ProjectRecord, ScheduleExecution, ScheduleTarget, ScheduleTiming, SessionRecord } from '@/types/api'

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced'

export type ScheduleForm = {
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

export const DEVICE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

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

export function isAuthorized(project: ProjectRecord) {
  return !project.inferred
}

function projectForSession(session: SessionRecord, projects: ProjectRecord[]) {
  return projects.find((project) => project.path === session.projectPath)
}

export function defaultForm(projects: ProjectRecord[], sessions: SessionRecord[], models: PrimeModelDescriptor[], lastSelectedModel: string, initialProjectId?: string, initialSessionId?: string): ScheduleForm {
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
    model: preferredModel(models, lastSelectedModel)?.key ?? '',
    thinking: 'auto',
    fast: false,
  }
}

export function rruleParts(rrule: string) {
  return new Map(rrule.replace(/^RRULE:/i, '').split(';').map((part) => {
    const [key, ...value] = part.split('=')
    return [key.toUpperCase(), value.join('=')]
  }))
}

function representableFrequency(rrule: string): Frequency {
  const parts = rruleParts(rrule)
  const frequency = parts.get('FREQ')?.toLowerCase()
  if (frequency !== 'hourly' && frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') return 'advanced'
  const keys = rrule.replace(/^RRULE:/i, '').split(';').map((part) => part.split('=')[0].toUpperCase())
  if (keys.length !== parts.size || keys.some((key) => !['FREQ', 'INTERVAL', ...(frequency === 'weekly' ? ['BYDAY'] : [])].includes(key))) return 'advanced'
  const interval = parts.get('INTERVAL')
  if (interval !== undefined && (!/^[1-9]\d*$/.test(interval) || !Number.isSafeInteger(Number(interval)))) return 'advanced'
  if (frequency === 'weekly') {
    const days = parts.get('BYDAY')?.split(',') ?? []
    if (!days.length || days.some((day) => !DAY_CODES.some((code) => code === day)) || new Set(days).size !== days.length) return 'advanced'
  }
  return frequency
}

export function formFromSchedule(item: AutomationScheduleRecord, models: PrimeModelDescriptor[], lastSelectedModel: string): ScheduleForm {
  const start = item.timing.kind === 'once'
    ? localParts(new Date(item.timing.at))
    : { date: item.timing.dtstartLocal.slice(0, 10), time: item.timing.dtstartLocal.slice(11, 16) }
  const parts = item.timing.kind === 'rrule' ? rruleParts(item.timing.rrule) : new Map<string, string>()
  const frequency = item.timing.kind === 'rrule' ? representableFrequency(item.timing.rrule) : 'advanced'
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
    model: item.execution.model === 'auto' ? preferredModel(models, lastSelectedModel)?.key ?? '' : item.execution.model,
    thinking: item.execution.thinking,
    fast: item.execution.speed === 'fast',
  }
}

export function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).format()
    return true
  } catch {
    return false
  }
}

export function timingFromForm(form: ScheduleForm): ScheduleTiming | null {
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

export function targetFromForm(form: ScheduleForm): ScheduleTarget {
  return form.targetKind === 'session'
    ? { kind: 'session', projectId: form.projectId, sessionId: form.sessionId }
    : { kind: 'project', projectId: form.projectId }
}

export function executionFromForm(form: ScheduleForm): ScheduleExecution {
  return { model: form.model, thinking: form.thinking, speed: form.fast ? 'fast' : 'normal' }
}
