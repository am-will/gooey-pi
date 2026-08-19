import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { defaultSettings } from '../../electron/main/store'
import { VoiceService, voiceToolContracts, type VoiceServiceOptions } from '../../electron/main/voice'
import type { ProjectRecord } from '../../src/types/api'

const apiKey = process.env.OPENAI_API_KEY?.trim()
const liveRequested = process.env.npm_lifecycle_event === 'test:openai-realtime-tools'
  || process.env.GOOEYPI_LIVE_OPENAI_REALTIME === '1'
const liveTest = liveRequested ? it : it.skip

function testService(): VoiceService {
  const project: ProjectRecord = {
    id: 'live-test-project', harness: 'prime', name: 'Realtime live test', path: '/tmp/realtime-live-test',
    folders: ['/tmp/realtime-live-test'], primaryFolder: '/tmp/realtime-live-test', pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
  }
  return new VoiceService({
    secretPath: join(tmpdir(), `gooeypi-openai-realtime-${randomUUID()}.json`),
    secretCodec: { status: () => ({ available: true }), encrypt: Buffer.from, decrypt: (value) => value.toString() },
    settings: defaultSettings,
    projects: {
      prime: { list: vi.fn(async () => [project]) },
      omp: { list: vi.fn(async () => []) },
      pi: { list: vi.fn(async () => []) },
    } as unknown as VoiceServiceOptions['projects'],
    agents: {} as VoiceServiceOptions['agents'],
    catalogs: {} as VoiceServiceOptions['catalogs'],
    collaboration: {
      listAccessibleSessions: vi.fn(async () => [{
        id: 'live-test-session', harness: 'prime', projectPath: project.path, title: 'Realtime tool canary', status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z', live: true, preview: 'Testing the native OpenAI function-call round trip.',
      }]),
      readAccessibleSession: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as VoiceServiceOptions['collaboration'],
    runProcess: vi.fn(),
    environment: { OPENAI_API_KEY: apiKey },
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a realtime event object')
  return value as Record<string, unknown>
}

liveTest('completes a native OpenAI Realtime function-call round trip through the voice executor', async () => {
  if (!apiKey) throw new Error('Set OPENAI_API_KEY to run the native OpenAI Realtime tool test')
  const service = testService()
  const listAgents = voiceToolContracts('prime').find((tool) => tool.name === 'list_agents')
  expect(listAgents).toBeDefined()
  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || defaultSettings().voiceRealtimeModel
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  await new Promise<void>((resolveTest, rejectTest) => {
    let settled = false
    let promptSent = false
    let toolCallHandled = false
    let toolOutputSent = false
    let firstResponseDone = false
    let continuationSent = false
    const timeout = setTimeout(() => finish(new Error('OpenAI Realtime tool test timed out')), 30_000)
    timeout.unref()

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      if (error) rejectTest(error)
      else resolveTest()
    }

    const continueAfterTool = () => {
      if (!toolOutputSent || !firstResponseDone || continuationSent) return
      continuationSent = true
      socket.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['text'],
          tool_choice: 'none',
          instructions: 'Confirm briefly that the agent list was received.',
        },
      }))
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime', output_modalities: ['text'], tools: [listAgents], tool_choice: 'required',
          instructions: 'Call list_agents with filter active and without project_id or query. Do not answer before calling the tool.',
        },
      }))
    })

    socket.on('message', (data) => {
      void (async () => {
        const event = asRecord(JSON.parse(data.toString()) as unknown)
        if (event.type === 'error') throw new Error(`OpenAI Realtime error: ${JSON.stringify(event.error)}`)
        if (event.type === 'session.updated' && !promptSent) {
          promptSent = true
          socket.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the active agents now.' }] },
          }))
          socket.send(JSON.stringify({ type: 'response.create' }))
          return
        }
        const outputItem = event.type === 'response.output_item.done' ? asRecord(event.item) : undefined
        const functionCall = event.type === 'response.function_call_arguments.done'
          ? event
          : outputItem?.type === 'function_call' ? outputItem : undefined
        if (functionCall && !toolCallHandled) {
          toolCallHandled = true
          expect(functionCall.name).toBe('list_agents')
          const args = typeof functionCall.arguments === 'string'
            ? asRecord(JSON.parse(functionCall.arguments) as unknown)
            : asRecord(functionCall.arguments)
          const result = await service.executeTool({ name: 'list_agents', arguments: args }, 'prime')
          expect(JSON.parse(result.output)).toMatchObject({
            filter: 'active', agents: [expect.objectContaining({ session_id: 'live-test-session', status: 'running' })],
          })
          socket.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: functionCall.call_id, output: result.output },
          }))
          toolOutputSent = true
          continueAfterTool()
          return
        }
        if (event.type === 'response.done') {
          if (!continuationSent) {
            firstResponseDone = true
            continueAfterTool()
            return
          }
          expect(asRecord(event.response).status).toBe('completed')
          expect(toolCallHandled).toBe(true)
          finish()
        }
      })().catch(finish)
    })
    socket.on('error', finish)
    socket.on('close', () => {
      if (!settled) finish(new Error('OpenAI Realtime socket closed before the tool round trip completed'))
    })
  })
}, 35_000)
