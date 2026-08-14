import type {
  AppSettings,
  GitStatus,
  ProjectRecord,
  AutomationScheduleRecord,
  SessionRecord,
  SkillRecord,
  TranscriptMessage,
} from '@/types/api'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  interfaceFontScale: 110,
  activeHarness: 'omp',
  ompApprovalMode: 'inherit',
  harnessUpdateChecks: true,
  lastSeenHarnessNotes: { prime: '', omp: '', pi: '' },
  petEnabled: true,
  petId: 'orb',
  petSize: 75,
  sidebarOpen: true,
  inspectorOpen: true,
  showFileChangesPopup: true,
  terminalOpen: false,
  defaultInspectorTab: 'summary',
  browserHome: 'http://localhost:3000',
  browserAskForDownloads: true,
  terminalShell: '/bin/zsh',
  reduceMotion: false,
  showReasoningSummaries: true,
  showToolCalls: true,
  messageEnterAction: 'queue',
  runtimePaths: { prime: '', omp: '', pi: '' },
  enabledHarnesses: ['omp', 'prime', 'pi'],
  telemetry: false,
  askUserEnabled: false,
  browserEnabled: true,
  computerUseEnabled: false,
  disabledProviders: [],
  disabledModels: [],
  ompDisabledProviders: [],
  ompDisabledModels: [],
  piDisabledProviders: [],
  piDisabledModels: [],
  voiceTranscriptionProvider: 'openai-live',
  voiceOpenAiLiveTranscriptionModel: 'gpt-live-transcribe',
  voiceOpenAiTranscriptionModel: 'gpt-4o-transcribe',
  voiceGroqTranscriptionModel: 'whisper-large-v3-turbo',
  voiceDeepgramTranscriptionModel: 'nova-3',
  voiceSelfHostedUrl: '',
  voiceSelfHostedModel: '',
  voiceLocalWhisperExecutable: '',
  voiceLocalWhisperModel: '',
  voiceRealtimeModel: 'gpt-realtime-2.1',
  voiceRealtimeVoice: 'marin',
}

export const SAMPLE_PROJECTS: ProjectRecord[] = [
  {
    id: 'prime-work',
    harness: 'prime',
    name: 'prime-work',
    path: '/Users/you/Projects/prime-work',
    folders: ['/Users/you/Projects/prime-work'],
    primaryFolder: '/Users/you/Projects/prime-work',
    pinned: true,
    createdAt: new Date(Date.now() - 864e5 * 18).toISOString(),
    lastOpenedAt: new Date().toISOString(),
    sessionCount: 4,
    gitBranch: 'main',
  },
  {
    id: 'storefront',
    harness: 'prime',
    name: 'storefront-redesign',
    path: '/Users/you/Projects/storefront-redesign',
    folders: ['/Users/you/Projects/storefront-redesign'],
    primaryFolder: '/Users/you/Projects/storefront-redesign',
    pinned: false,
    createdAt: new Date(Date.now() - 864e5 * 30).toISOString(),
    lastOpenedAt: new Date(Date.now() - 864e5).toISOString(),
    sessionCount: 2,
    gitBranch: 'feature/search',
  },
]

export const SAMPLE_SESSIONS: SessionRecord[] = [
  {
    id: 'demo-session',
    harness: 'prime',
    filePath: '/Users/you/.prime/agent/sessions/demo.jsonl',
    projectPath: SAMPLE_PROJECTS[0].path,
    title: 'Build the workspace shell',
    createdAt: new Date(Date.now() - 36e5).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60e3).toISOString(),
    status: 'complete',
    model: 'Prime Intellect',
    thinkingLevel: 'high',
    depth: 0,
    pinned: true,
    preview: 'Implemented the renderer workspace and inspector.',
  },
  {
    id: 'running-session',
    harness: 'prime',
    filePath: '/Users/you/.prime/agent/sessions/running.jsonl',
    projectPath: SAMPLE_PROJECTS[0].path,
    title: 'Polish browser annotations',
    createdAt: new Date(Date.now() - 7200e3).toISOString(),
    updatedAt: new Date(Date.now() - 12 * 60e3).toISOString(),
    status: 'running',
    model: 'Prime Intellect',
    thinkingLevel: 'medium',
    depth: 0,
    unread: true,
    preview: 'Reviewing the in-app browser controls.',
  },
  {
    id: 'old-session',
    harness: 'prime',
    filePath: '/Users/you/.prime/agent/sessions/old.jsonl',
    projectPath: SAMPLE_PROJECTS[1].path,
    title: 'Debug hydration error',
    createdAt: new Date(Date.now() - 864e5).toISOString(),
    updatedAt: new Date(Date.now() - 864e5).toISOString(),
    status: 'waiting',
    model: 'Prime Intellect',
    depth: 0,
    preview: 'Waiting for permission to run the dev server.',
  },
]

export const SAMPLE_TRANSCRIPT: TranscriptMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    timestamp: Date.now() - 420000,
    parts: [{ type: 'text', text: 'Build the renderer for Prime Work. Keep the interface native, calm, and focused, with a real browser and terminal.' }],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: Date.now() - 410000,
    startedAt: Date.now() - 410000,
    completedAt: Date.now() - 185000,
    parts: [
      { type: 'text', text: 'I’ll map the renderer to the preload contract first, then assemble the workspace around the session transcript.' },
      { type: 'thinking', text: 'The shell needs to preserve the conversation as the primary surface while the inspector remains contextual. I’ll keep tool output compact and expand details on demand.' },
      { type: 'toolCall', id: 'tool-1', name: 'Read files', args: { paths: ['src/types/api.ts', '.superdesign/design-system.md'] } },
      { type: 'toolResult', name: 'Read files', text: 'Read 2 files in 96ms' },
      { type: 'toolCall', id: 'tool-2', name: 'Write renderer', args: { paths: ['src/App.tsx', 'src/styles.css'] } },
      { type: 'toolResult', name: 'Write renderer', text: 'Updated 12 files in 1.4s' },
      { type: 'text', text: 'The three-pane workspace is in place. Browser, Git review, terminal, and plugin surfaces all use the native bridge and retain useful empty states when a service is unavailable.' },
    ],
  },
]

export const SAMPLE_GIT: GitStatus = {
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  files: [
    { path: 'src/App.tsx', status: 'M', staged: false, additions: 84, deletions: 14 },
    { path: 'src/components/Inspector.tsx', status: 'M', staged: false, additions: 118, deletions: 9 },
    { path: 'src/styles.css', status: 'M', staged: true, additions: 203, deletions: 31 },
    { path: 'src/components/TerminalDrawer.tsx', status: 'A', staged: false, additions: 96, deletions: 0 },
  ],
}

export const SAMPLE_SKILLS: SkillRecord[] = [
  { id: 'browser', name: 'Browser', description: 'Preview local apps, inspect pages, and work with browser annotations.', kind: 'extension', location: 'bundled', enabled: true, icon: 'globe' },
  { id: 'github', name: 'GitHub', description: 'Read repositories, review pull requests, and coordinate changes.', kind: 'mcp', location: 'user', enabled: true, icon: 'github' },
  { id: 'frontend', name: 'Frontend design', description: 'Create refined, production-ready interfaces with intentional visual systems.', kind: 'skill', location: 'user', enabled: true, icon: 'palette' },
  { id: 'docs', name: 'Docs search', description: 'Search product and API documentation from inside a session.', kind: 'skill', location: 'system', enabled: false, icon: 'book-open' },
  { id: 'linear', name: 'Linear', description: 'Turn issues and project updates into focused implementation work.', kind: 'mcp', location: 'project', enabled: false, icon: 'list-checks' },
  { id: 'release', name: 'Release notes', description: 'Draft release notes from commits, diffs, and project context.', kind: 'prompt', location: 'project', enabled: true, icon: 'file-text' },
]

export const SAMPLE_SCHEDULES: AutomationScheduleRecord[] = [
  {
    schemaVersion: 1, id: 'morning', harness: 'prime', revision: 1, title: 'Morning issue triage',
    prompt: 'Review new high-priority issues and propose owners.',
    target: { kind: 'project', projectId: 'prime-work' },
    timing: { kind: 'rrule', dtstartLocal: '2026-08-06T09:00:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    execution: { model: 'auto', thinking: 'auto', speed: 'normal' }, status: 'active', createdBy: 'user',
    createdAt: new Date(Date.now() - 7 * 864e5).toISOString(), updatedAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 16 * 3600e3).toISOString(), runs: [],
  },
]

export function formatRelative(value?: string | number): string {
  if (!value) return ''
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'now'
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  if (abs < 604800) return formatter.format(Math.round(seconds / 86400), 'day')
  return formatter.format(Math.round(seconds / 604800), 'week')
}

export function basename(path: string): string {
  return path.split(/[/]/).filter(Boolean).at(-1) ?? path
}
