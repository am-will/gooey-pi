import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpExtensionApi as BrowserExtensionApi } from '../../assets/extensions/omp-work-browser'
import type { OmpExtensionApi as ScheduleExtensionApi } from '../../assets/extensions/omp-work-schedules'
import type { OmpExtensionApi as AskUserExtensionApi } from '../../assets/extensions/omp-work-ask-user'
import type { OmpExtensionApi as CollaborationExtensionApi } from '../../assets/extensions/omp-work-collaboration'

/**
 * Base pi host simulation: unlike OMP, pi injects no `pi.typebox` shim.
 * Extensions must fall back to resolving schema builders from the host's
 * `typebox` package (pi's loader aliases that specifier to its bundled copy;
 * under vitest it resolves from node_modules) and register the same tool
 * surface. Pi awaits the factory, so these tests await the returned promise.
 */

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
}

interface TestSchema {
  type?: string
  enum?: unknown[]
  required?: string[]
  properties: Record<string, TestSchema>
  items: TestSchema
}

function piHost() {
  const tools: RegisteredTool[] = []
  return {
    tools,
    pi: { registerTool: (tool: RegisteredTool) => { tools.push(tool) } },
  }
}

function schemaOf(tool: RegisteredTool): TestSchema {
  return tool.parameters as TestSchema
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadBrowserExtension() {
  vi.resetModules()
  vi.stubEnv('PRIME_WORK_BROWSER_URL', 'http://127.0.0.1:1/')
  vi.stubEnv('PRIME_WORK_BROWSER_TOKEN', 'token')
  return (await import('../../assets/extensions/omp-work-browser')).default
}

async function loadScheduleExtension() {
  vi.resetModules()
  vi.stubEnv('PRIME_WORK_SCHEDULE_URL', 'http://127.0.0.1:1/')
  vi.stubEnv('PRIME_WORK_SCHEDULE_TOKEN', 'token')
  return (await import('../../assets/extensions/omp-work-schedules')).default
}

describe('extensions on a base pi host (no injected pi.typebox)', () => {
  it('browser extension registers the full tool surface with host-resolved schemas', async () => {
    const factory = await loadBrowserExtension()
    const { tools, pi } = piHost()
    await factory(pi as unknown as BrowserExtensionApi)
    expect(tools.map((tool) => tool.name)).toEqual([
      'terminal_read',
      'browser_tabs',
      'browser_navigate',
      'browser_screenshot',
      'browser_read_page',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_evaluate',
    ])
    const tabs = schemaOf(tools.find((tool) => tool.name === 'browser_tabs')!)
    expect(tabs.type).toBe('object')
    expect(tabs.required).toEqual(['action'])
    expect(tabs.properties.action.enum).toEqual(['list', 'open', 'close', 'select'])
    expect(tabs.properties.action.type).toBe('string')
    const click = schemaOf(tools.find((tool) => tool.name === 'browser_click')!)
    expect(click.required ?? []).toEqual([])
    expect(click.properties.ref.type).toBe('number')
    expect(click.properties.double.type).toBe('boolean')
    const type = schemaOf(tools.find((tool) => tool.name === 'browser_type')!)
    expect(type.required).toEqual(['text'])
    const pressKey = schemaOf(tools.find((tool) => tool.name === 'browser_press_key')!)
    expect(pressKey.properties.modifiers.type).toBe('array')
    expect(pressKey.properties.modifiers.items.enum).toEqual(['shift', 'control', 'alt', 'meta'])
  })

  it('browser extension still registers nothing without the broker environment', async () => {
    vi.resetModules()
    vi.stubEnv('PRIME_WORK_BROWSER_URL', undefined as unknown as string)
    vi.stubEnv('PRIME_WORK_BROWSER_TOKEN', undefined as unknown as string)
    const factory = (await import('../../assets/extensions/omp-work-browser')).default
    const { tools, pi } = piHost()
    await factory(pi as unknown as BrowserExtensionApi)
    expect(tools).toHaveLength(0)
  })

  it('schedules extension registers the full tool surface with host-resolved schemas', async () => {
    const factory = await loadScheduleExtension()
    const { tools, pi } = piHost()
    await factory(pi as unknown as ScheduleExtensionApi)
    expect(tools.map((tool) => tool.name)).toEqual([
      'scheduled_tasks_list',
      'scheduled_task_create_once',
      'scheduled_task_create_recurring',
      'scheduled_task_update',
      'scheduled_task_manage',
    ])
    const manage = schemaOf(tools.find((tool) => tool.name === 'scheduled_task_manage')!)
    expect(manage.required).toEqual(['id', 'action'])
    expect(manage.properties.action.enum).toEqual(['pause', 'resume', 'run_now', 'delete'])
    const createOnce = schemaOf(tools.find((tool) => tool.name === 'scheduled_task_create_once')!)
    expect(createOnce.required).toEqual(['prompt', 'at'])
    expect(createOnce.properties.target.enum).toEqual(['current_project', 'current_session'])
  })

  it('ask-user extension registers ask_user with host-resolved schemas', async () => {
    vi.resetModules()
    const factory = (await import('../../assets/extensions/omp-work-ask-user')).default
    const { tools, pi } = piHost()
    await factory(pi as unknown as AskUserExtensionApi)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('ask_user')
    const schema = schemaOf(tools[0])
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['questions'])
    expect(schema.properties.questions.type).toBe('array')
    expect(schema.properties.questions.items.required).toEqual(['question', 'options'])
  })

  it('collaboration extension registers the same session tools on base pi', async () => {
    vi.resetModules()
    vi.stubEnv('GOOEYPI_COLLABORATION_URL', 'http://127.0.0.1:1/')
    vi.stubEnv('GOOEYPI_COLLABORATION_TOKEN', 'token')
    const factory = (await import('../../assets/extensions/omp-work-collaboration')).default
    const { tools, pi } = piHost()
    await factory(pi as unknown as CollaborationExtensionApi)
    expect(tools.map((tool) => tool.name)).toEqual(['gooeypi_session_list', 'gooeypi_session_models', 'gooeypi_session_create', 'gooeypi_session_read', 'gooeypi_session_send', 'gooeypi_session_wait'])
    expect(schemaOf(tools[1]).required).toBeUndefined()
    expect(schemaOf(tools[2]).required).toEqual(['prompt'])
    expect(schemaOf(tools[2]).properties).toHaveProperty('model')
    expect(schemaOf(tools[2]).properties).toHaveProperty('reasoning')
    expect(schemaOf(tools[2]).properties.fast.type).toBe('boolean')
    expect(schemaOf(tools[3]).required).toEqual(['target_session_id'])
    expect(schemaOf(tools[4]).required).toEqual(['target_session_id', 'message'])
    expect(tools[4].description).toContain('reply directly to its from_session_id')
    expect(JSON.stringify(schemaOf(tools[4]).properties.target_session_id)).toContain('from_session_id')
    expect(schemaOf(tools[5]).properties.timeout_ms.type).toBe('number')
  })
})
