import { resolve } from 'node:path'
import type { AutomationScheduleRecord, HarnessId, ProjectRecord, SessionRecord, ScheduleInput, SchedulePatch, ScheduleTarget } from '../../../src/types/api'
import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import { isPathWithin, requireRecord, requireString } from '../validation'
import { HARNESSES } from '../harness'
import type { AutomationService } from './service'

interface AgentScheduleScope {
  projectId: string
  sessionId?: string
}

export interface AgentScheduleBridgeOptions {
  service: AutomationService
  harness: HarnessId
  skillPath: string
  resolveScope(input: { cwd: string; sessionPath?: string }): Promise<AgentScheduleScope>
}

/** Resolve agent scope only through explicit grants, preferring the most specific granted folder. */
export function createScheduleScopeResolver(options: {
  harness: HarnessId
  projects: { list(): Promise<Pick<ProjectRecord, 'id' | 'folders' | 'inferred'>[]> }
  sessions: { list(projectPath?: unknown, includeArchived?: unknown): Promise<Pick<SessionRecord, 'id' | 'filePath' | 'projectPath'>[]> }
}): AgentScheduleBridgeOptions['resolveScope'] {
  return async ({ cwd, sessionPath }) => {
    const candidates = (await options.projects.list()).filter((project) => !project.inferred)
      .flatMap((project) => project.folders.filter((folder) => isPathWithin(folder, cwd)).map((folder) => ({ project, folder: resolve(folder) })))
      .sort((left, right) => right.folder.length - left.folder.length)
    const project = candidates[0]?.project
    if (!project) throw new Error(`The agent is not running in an explicitly granted ${HARNESSES[options.harness].productName} project`)
    if (!sessionPath) return { projectId: project.id }
    const session = (await options.sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath)
      && project.folders.some((folder) => isPathWithin(folder, candidate.projectPath)))
    return { projectId: project.id, sessionId: session?.id }
  }
}

function taskInScope(task: AutomationScheduleRecord, scope: AgentScheduleScope, harness: HarnessId): boolean {
  return task.harness === harness && task.target.projectId === scope.projectId && (task.target.kind === 'project' || task.target.sessionId === scope.sessionId)
}

export class AgentScheduleBridge extends CapabilityBridge {
  protected readonly rateLimit = 60
  protected readonly rateLimitError = 'Schedule API rate limit exceeded'

  constructor(private readonly options: AgentScheduleBridgeOptions) { super() }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      PRIME_WORK_SCHEDULE_URL: url,
      PRIME_WORK_SCHEDULE_TOKEN: token,
      PRIME_WORK_SCHEDULE_SKILL_PATH: this.options.skillPath,
    }
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    const scope = await this.options.resolveScope({ cwd: claim.cwd, sessionPath: claim.sessionPath })
    return this.call(method, params, scope)
  }

  private async call(method: string, params: Record<string, unknown>, scope: AgentScheduleScope): Promise<unknown> {
    if (method === 'list') return this.options.service.list(this.options.harness).filter((task) => taskInScope(task, scope, this.options.harness))
    if (method === 'create') {
      const raw = requireRecord(params.input, 'input')
      const targetName = requireString(params.target, 'target', { min: 1, max: 32, trim: true })
      let target: ScheduleTarget
      if (targetName === 'current_project') target = { kind: 'project', projectId: scope.projectId }
      else if (targetName === 'current_session' && scope.sessionId) target = { kind: 'session', projectId: scope.projectId, sessionId: scope.sessionId }
      else throw new TypeError('target must be current_project or an available current_session')
      const input: ScheduleInput = {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        prompt: raw.prompt as string,
        timing: raw.timing as ScheduleInput['timing'],
        execution: raw.execution as ScheduleInput['execution'],
        target,
      }
      return this.options.service.create(input, 'agent', this.options.harness)
    }
    const id = requireString(params.id, 'id', { min: 1, max: 256, trim: true })
    const task = this.options.service.get(id)
    if (!taskInScope(task, scope, this.options.harness)) throw new Error('Scheduled task is outside this agent capability')
    if (method === 'pause') return this.options.service.pause(id)
    if (method === 'resume') return this.options.service.resume(id)
    if (method === 'delete') return this.options.service.delete(id)
    if (method === 'run_now') return this.options.service.runNow(id)
    if (method === 'update') {
      const rawPatch = requireRecord(params.patch, 'patch')
      if (rawPatch.target !== undefined) throw new TypeError('Agents cannot retarget an existing scheduled task')
      const patch: SchedulePatch = { ...rawPatch, revision: task.revision }
      return this.options.service.update(id, patch)
    }
    throw new TypeError(`Unsupported schedule method ${method}`)
  }
}
