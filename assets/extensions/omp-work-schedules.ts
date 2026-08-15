/**
 * GooeyPi durable schedules for OMP and base pi.
 *
 * Loaded as an explicit extension by both harnesses. It is deliberately
 * self-contained and talks only to the runtime-scoped loopback schedule
 * broker. The bearer claim binds every operation to this project/thread, so
 * an agent cannot name or reach another project, thread, or harness.
 *
 * Schema builders come from the injected `pi.typebox` shim when the host
 * provides one (OMP); base pi injects no shim, so builders resolve from the
 * `typebox` package via the host's extension loader, with `StringEnum` from
 * `@earendil-works/pi-ai` for enum parameters per pi guidance. Both imports
 * use runtime specifiers inside try/catch so neither host hard-fails at load.
 */

interface OmpSchemaOptions {
  description?: string
}

interface OmpTypebox {
  Object(properties: Record<string, unknown>): unknown
  String(options?: OmpSchemaOptions): unknown
  Boolean(options?: OmpSchemaOptions): unknown
  Enum(values: readonly string[], options?: OmpSchemaOptions): unknown
  Optional(schema: unknown): unknown
}

interface OmpToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}
export interface OmpExtensionApi {
  typebox?: { Type: OmpTypebox }
  registerTool<Params>(tool: { name: string; label: string; description: string; parameters: unknown; execute(toolCallId: string, params: Params): Promise<OmpToolResult> }): void
}

async function importHostModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(specifier)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function resolveHostTypebox(): Promise<OmpTypebox> {
  const hostType = (await importHostModule('typebox'))?.Type as (OmpTypebox & { Unsafe?(schema: unknown): unknown }) | undefined
  const stringEnum = (await importHostModule('@earendil-works/pi-ai'))?.StringEnum as ((values: readonly string[], options?: OmpSchemaOptions) => unknown) | undefined
  const Enum = (values: readonly string[], options?: OmpSchemaOptions): unknown => {
    if (stringEnum) return stringEnum(values, options)
    const schema = { type: 'string', enum: [...values], ...(options ?? {}) }
    return hostType?.Unsafe ? hostType.Unsafe(schema) : schema
  }
  if (hostType) {
    return {
      Object: (properties) => hostType.Object(properties),
      String: (options) => hostType.String(options),
      Boolean: (options) => hostType.Boolean(options),
      Enum,
      Optional: (schema) => hostType.Optional(schema),
    }
  }
  // Last resort: plain JSON Schema builders covering exactly this file's usage.
  const optionalSchemas = new WeakSet<object>()
  return {
    Object: (properties) => {
      const required = Object.keys(properties).filter((key) => {
        const property = properties[key]
        return !(typeof property === 'object' && property !== null && optionalSchemas.has(property))
      })
      return { type: 'object', properties, ...(required.length ? { required } : {}) }
    },
    String: (options) => ({ type: 'string', ...(options ?? {}) }),
    Boolean: (options) => ({ type: 'boolean', ...(options ?? {}) }),
    Enum,
    Optional: (schema) => {
      if (typeof schema === 'object' && schema !== null) optionalSchemas.add(schema)
      return schema
    },
  }
}

interface BridgeResult {
  ok: boolean
  result?: unknown
  error?: string
}
interface ScheduleRecord {
  id?: string
  title?: string
  prompt?: string
  timing?: Record<string, unknown>
  execution?: { model?: string; thinking?: string; speed?: string }
}

const BRIDGE_URL = process.env.PRIME_WORK_SCHEDULE_URL
const BRIDGE_TOKEN = process.env.PRIME_WORK_SCHEDULE_TOKEN

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) throw new Error('GooeyPi scheduling is not available in this OMP runtime')
  let response: Response
  try {
    response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
  } catch (error) {
    throw new Error(`GooeyPi's scheduling broker is not reachable: ${String(error)}`)
  }
  const body = (await response.json()) as BridgeResult
  if (!body.ok) throw new Error(body.error || `Schedule call failed with status ${response.status}`)
  return body.result
}

function text(value: unknown): OmpToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: {} }
}

function execution(params: { model?: string; thinking?: string; fast?: boolean }, current?: ScheduleRecord) {
  return {
    model: params.model ?? current?.execution?.model ?? 'auto',
    thinking: params.thinking ?? current?.execution?.thinking ?? 'auto',
    speed: params.fast === undefined ? (current?.execution?.speed ?? 'normal') : params.fast ? 'fast' : 'normal',
  }
}

export default function (pi: OmpExtensionApi): void | Promise<void> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) return
  // OMP injects a TypeBox shim and calls the factory without awaiting it, so
  // that path must stay fully synchronous; base pi awaits the factory, so the
  // fallback may resolve builders asynchronously before registering.
  const injected = pi.typebox?.Type
  if (injected) {
    registerTools(pi, injected)
    return
  }
  return resolveHostTypebox().then((hostType) => {
    registerTools(pi, hostType)
  })
}

function registerTools(pi: OmpExtensionApi, Type: OmpTypebox): void {
  const target = Type.Optional(Type.Enum(['current_project', 'current_session'], { description: 'Run in a new project thread or return to this thread' }))
  const title = Type.Optional(Type.String())
  const model = Type.Optional(Type.String({ description: 'OMP provider/model key, or auto' }))
  const thinking = Type.Optional(Type.String({ description: 'Reasoning level, or auto' }))
  const fast = Type.Optional(Type.Boolean())

  pi.registerTool({
    name: 'scheduled_tasks_list',
    label: 'List scheduled tasks',
    description: 'List durable GooeyPi tasks belonging to this OMP project or thread. Use this before editing or managing an existing schedule.',
    parameters: Type.Object({}),
    async execute() {
      return text(await call('list'))
    },
  })

  pi.registerTool({
    name: 'scheduled_task_create_once',
    label: 'Create one-time task',
    description:
      'Create a durable one-time GooeyPi task for the current OMP project or thread. Use current_project for a fresh thread per run and current_session to preserve this thread context. The app must remain running for local scheduled work.',
    parameters: Type.Object({ prompt: Type.String(), at: Type.String({ description: 'ISO timestamp with timezone' }), target, title, model, thinking, fast }),
    async execute(_id, params: { prompt: string; at: string; target?: string; title?: string; model?: string; thinking?: string; fast?: boolean }) {
      return text(
        await call('create', {
          target: params.target ?? 'current_project',
          input: { title: params.title, prompt: params.prompt, timing: { kind: 'once', at: params.at }, execution: execution(params) },
        }),
      )
    },
  })

  pi.registerTool({
    name: 'scheduled_task_create_recurring',
    label: 'Create recurring task',
    description: 'Create a durable recurring GooeyPi task for the current OMP project or thread. RRULE is RFC 5545 without DTSTART; provide a local start time and IANA timezone separately.',
    parameters: Type.Object({ prompt: Type.String(), rrule: Type.String(), dtstart_local: Type.String(), time_zone: Type.String(), target, title, model, thinking, fast }),
    async execute(_id, params: { prompt: string; rrule: string; dtstart_local: string; time_zone: string; target?: string; title?: string; model?: string; thinking?: string; fast?: boolean }) {
      return text(
        await call('create', {
          target: params.target ?? 'current_project',
          input: {
            title: params.title,
            prompt: params.prompt,
            timing: { kind: 'rrule', rrule: params.rrule, dtstartLocal: params.dtstart_local, timeZone: params.time_zone },
            execution: execution(params),
          },
        }),
      )
    },
  })

  pi.registerTool({
    name: 'scheduled_task_update',
    label: 'Update scheduled task',
    description:
      'Update a durable task in this OMP project/thread. List tasks first. Omitted fields retain their current values; pass either at for one-time timing or all three recurring fields for recurring timing.',
    parameters: Type.Object({
      id: Type.String(),
      title,
      prompt: Type.Optional(Type.String()),
      at: Type.Optional(Type.String()),
      rrule: Type.Optional(Type.String()),
      dtstart_local: Type.Optional(Type.String()),
      time_zone: Type.Optional(Type.String()),
      model,
      thinking,
      fast,
    }),
    async execute(
      _toolId,
      params: { id: string; title?: string; prompt?: string; at?: string; rrule?: string; dtstart_local?: string; time_zone?: string; model?: string; thinking?: string; fast?: boolean },
    ) {
      const tasks = (await call('list')) as ScheduleRecord[]
      const current = tasks.find((task) => task.id === params.id)
      if (!current) throw new Error('Scheduled task was not found in this OMP scope')
      const patch: Record<string, unknown> = {}
      if (params.title !== undefined) patch.title = params.title
      if (params.prompt !== undefined) patch.prompt = params.prompt
      if (params.at !== undefined) patch.timing = { kind: 'once', at: params.at }
      else if (params.rrule !== undefined || params.dtstart_local !== undefined || params.time_zone !== undefined) {
        if (!params.rrule || !params.dtstart_local || !params.time_zone) throw new Error('Recurring updates require rrule, dtstart_local, and time_zone together')
        patch.timing = { kind: 'rrule', rrule: params.rrule, dtstartLocal: params.dtstart_local, timeZone: params.time_zone }
      }
      if (params.model !== undefined || params.thinking !== undefined || params.fast !== undefined) patch.execution = execution(params, current)
      return text(await call('update', { id: params.id, patch }))
    },
  })

  pi.registerTool({
    name: 'scheduled_task_manage',
    label: 'Manage scheduled task',
    description:
      "Pause, resume, run now, or delete a durable task in this OMP project/thread. List tasks first and use the exact id. Delete is permanent and should match the user's explicit request.",
    parameters: Type.Object({ id: Type.String(), action: Type.Enum(['pause', 'resume', 'run_now', 'delete']) }),
    async execute(_toolId, params: { id: string; action: 'pause' | 'resume' | 'run_now' | 'delete' }) {
      return text(await call(params.action, { id: params.id }))
    },
  })
}
