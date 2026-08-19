// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleToolbar } from '../../src/components/TitleToolbar'
import { VoiceOrb } from '../../src/components/VoiceOrb'
import type { PetDefinition, PrimeWorkApi, ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open'
  send = vi.fn()
  close = vi.fn()
}

class FakePeer extends EventTarget {
  static latest: FakePeer
  channel = new FakeDataChannel()
  iceGatheringState: RTCIceGatheringState = 'complete'
  localDescription: RTCSessionDescription | null = null
  close = vi.fn()
  addTrack = vi.fn()
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description as RTCSessionDescription
  })
  setRemoteDescription = vi.fn(async () => undefined)
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\no=test-offer-value' }))
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel)
  constructor() { super(); FakePeer.latest = this }
}

describe('realtime voice surface', () => {
  let container: HTMLDivElement
  let root: Root
  let peerDescriptor: PropertyDescriptor | undefined
  const track = { enabled: true, stop: vi.fn() }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }

  beforeEach(() => {
    track.enabled = true; track.stop.mockReset()
    peerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: FakePeer })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.localStorage?.clear()
    if (peerDescriptor) Object.defineProperty(globalThis, 'RTCPeerConnection', peerDescriptor)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
  })

  it('places the waveform toggle immediately before the terminal button', () => {
    act(() => root.render(<TitleToolbar view="session" sidebarOpen inspectorOpen terminalOpen={false} voiceOpen onToggleSidebar={vi.fn()} onToggleInspector={vi.fn()} onToggleTerminal={vi.fn()} onOpenBrowser={vi.fn()} onToggleVoice={vi.fn()} />))
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.title-toolbar__actions button')].map((button) => button.getAttribute('aria-label'))
    expect(labels.slice(0, 2)).toEqual(['Close realtime voice', 'Toggle terminal (⌘J)'])
  })

  it('uses Linux shortcut labels on Linux', () => {
    act(() => root.render(<TitleToolbar platform="linux" view="session" sidebarOpen inspectorOpen terminalOpen={false} onToggleSidebar={vi.fn()} onToggleInspector={vi.fn()} onToggleTerminal={vi.fn()} onOpenBrowser={vi.fn()} />))
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.title-toolbar__actions button')].map((button) => button.getAttribute('aria-label'))
    expect(labels).toContain('Toggle terminal (Ctrl+J)')
    expect(labels).toContain('Open browser (Ctrl+Shift+B)')
  })

  it('prefers the live git branch for the session toolbar pill', () => {
    const project: ProjectRecord = {
      id: 'inferred-project',
      harness: 'prime',
      name: 'Inferred project',
      path: '/project',
      folders: ['/project'],
      primaryFolder: '/project',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      sessionCount: 1,
      inferred: true,
      readOnly: true,
      gitBranch: 'record-branch',
    }
    act(() => root.render(<TitleToolbar project={project} gitBranch="live-branch" view="session" sidebarOpen inspectorOpen terminalOpen={false} onToggleSidebar={vi.fn()} onToggleInspector={vi.fn()} onToggleTerminal={vi.fn()} onOpenBrowser={vi.fn()} />))
    expect(container.querySelector('.branch-pill')?.textContent).toContain('live-branch')
    expect(container.querySelector('.branch-pill')?.textContent).not.toContain('record-branch')
  })

  it('shows mute and close controls and disables the microphone track when muted', async () => {
    const voice = {
      createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'),
      executeTool: vi.fn(),
    } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    expect(voice.createRealtimeCall).toHaveBeenCalledWith({ mode: 'conversation', sdp: 'v=0\r\no=test-offer-value', harness: 'omp' })
    const mute = container.querySelector<HTMLButtonElement>('[aria-label="Mute realtime voice"]')!
    expect(container.querySelector('[aria-label="Close realtime voice"]')).not.toBeNull()
    await act(async () => mute.click())
    expect(track.enabled).toBe(false)
    expect(container.querySelector('[aria-label="Unmute realtime voice"]')).not.toBeNull()
  })

  it('places realtime status and controls on the selected desktop pet', async () => {
    const definitions: PetDefinition[] = [{ id: 'orb', petId: 'orb', displayName: 'Orb', description: 'Orb.', source: 'built-in', kind: 'orb' }]
    const pets = { list: vi.fn(async () => definitions), sprite: vi.fn() } as unknown as PrimeWorkApi['pets']
    const onClose = vi.fn()
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool: vi.fn() } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={onClose} onTaskStarted={vi.fn()} pet={{ pets, petId: 'orb', agentBusy: false, reduceMotion: false }} />))
    expect(container.querySelector('.desktop-pet')).not.toBeNull()
    expect(container.querySelector('.voice-orb')).toBeNull()
    expect(container.textContent).toContain('Connecting')
    const mute = container.querySelector<HTMLButtonElement>('[aria-label="Mute realtime voice"]')!
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close realtime voice"]')!
    await act(async () => mute.click())
    expect(track.enabled).toBe(false)
    expect(container.textContent).toContain('Muted')
    act(() => close.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the remote audio element and stream when the pet surface is toggled', async () => {
    const definitions: PetDefinition[] = [{ id: 'orb', petId: 'orb', displayName: 'Orb', description: 'Orb.', source: 'built-in', kind: 'orb' }]
    const pets = { list: vi.fn(async () => definitions), sprite: vi.fn() } as unknown as PrimeWorkApi['pets']
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool: vi.fn() } as unknown as PrimeWorkApi['voice']
    const props = { voice, harness: 'omp' as const, onClose: vi.fn(), onTaskStarted: vi.fn() }
    await act(async () => root.render(<VoiceOrb {...props} pet={{ pets, petId: 'orb', agentBusy: false, reduceMotion: false }} />))
    const audio = container.querySelector<HTMLAudioElement>('audio')!
    const remoteStream = { id: 'remote-stream' } as unknown as MediaStream
    act(() => FakePeer.latest.dispatchEvent(Object.assign(new Event('track'), { streams: [remoteStream], track: {} })))
    expect(audio.srcObject).toBe(remoteStream)

    await act(async () => root.render(<VoiceOrb {...props} />))
    expect(container.querySelector('audio')).toBe(audio)
    expect(audio.srcObject).toBe(remoteStream)
    expect(container.querySelector('[aria-label="Realtime voice session"]')).not.toBeNull()

    await act(async () => root.render(<VoiceOrb {...props} pet={{ pets, petId: 'orb', agentBusy: false, reduceMotion: false }} />))
    expect(track.enabled).toBe(false)
    expect(container.querySelector('[aria-label="Unmute realtime voice"]')).not.toBeNull()
  })

  it('executes a start_task call and reports the started task to the workspace', async () => {
    const task = { projectId: 'p1', projectName: 'Prime', harness: 'prime' as const, runtimeId: 'r1', sessionFile: '/tmp/session.jsonl' }
    const executeTool = vi.fn(async () => ({ output: '{"started":true}', task }))
    const onTaskStarted = vi.fn(async () => undefined)
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={onTaskStarted} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'start_task', arguments: JSON.stringify({ project_id: 'p1', prompt: 'Build it', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high' }) }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'start_task', arguments: { project_id: 'p1', prompt: 'Build it', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high' } }, 'prime')
    expect(onTaskStarted).toHaveBeenCalledWith(task)
    expect(container.textContent).toContain('Task started')
    expect(container.textContent).toContain('Prime · Prime')
    expect(container.textContent).toContain('Opened in the sidebar')
  })

  it('forwards model discovery calls through the pinned harness', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"models":[]}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-models', name: 'list_models', arguments: JSON.stringify({ query: 'sonnet' }) }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'list_models', arguments: { query: 'sonnet' } }, 'omp')
  })

  it('waits for the active response to finish before continuing after a tool call', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"projects":[]}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created' }) }))
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-projects', name: 'list_projects', arguments: '{}' }) }))
      await Promise.resolve()
    })
    expect(FakePeer.latest.channel.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(FakePeer.latest.channel.send.mock.calls[0]![0])).toMatchObject({ type: 'conversation.item.create', item: { call_id: 'call-projects' } })
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done' }) }))
    })
    expect(FakePeer.latest.channel.send).toHaveBeenCalledTimes(2)
    expect(JSON.parse(FakePeer.latest.channel.send.mock.calls[1]![0])).toMatchObject({ type: 'response.create', event_id: expect.any(String) })
  })

  it('coalesces parallel project and model lookups into one continuation', async () => {
    const resolutions = new Map<string, (result: { output: string }) => void>()
    const executeTool = vi.fn((request: { name: string }) => new Promise<{ output: string }>((resolve) => resolutions.set(request.name, resolve)))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created' }) }))
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-projects', name: 'list_projects', arguments: '{}' }) }))
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-models', name: 'list_models', arguments: '{}' }) }))
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done' }) }))
      resolutions.get('list_models')?.({ output: '{"models":[]}' })
      await Promise.resolve()
    })
    expect(FakePeer.latest.channel.send).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolutions.get('list_projects')?.({ output: '{"projects":[]}' })
      await Promise.resolve()
    })
    const sent = FakePeer.latest.channel.send.mock.calls.map(([value]) => JSON.parse(value))
    expect(sent.filter((message) => message.type === 'conversation.item.create')).toHaveLength(2)
    expect(sent.filter((message) => message.type === 'response.create')).toHaveLength(1)
  })

  it('retries a correlated continuation after the active response finishes', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"projects":[]}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-projects', name: 'list_projects', arguments: '{}' }) }))
      await Promise.resolve()
    })
    const firstMessages = FakePeer.latest.channel.send.mock.calls.map(([value]) => JSON.parse(value))
    const firstCreate = firstMessages.find((message) => message.type === 'response.create')
    expect(firstCreate.event_id).toEqual(expect.any(String))

    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'error',
        error: { code: 'conversation_already_has_active_response', message: 'A response is already in progress.', event_id: firstCreate.event_id },
      }) }))
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done' }) }))
    })

    const creates = FakePeer.latest.channel.send.mock.calls
      .map(([value]) => JSON.parse(value))
      .filter((message) => message.type === 'response.create')
    expect(creates).toHaveLength(2)
    expect(creates[1].event_id).not.toBe(firstCreate.event_id)
    consoleError.mockRestore()
  })

  it('keeps late tool results from an old voice generation out of the new continuation', async () => {
    let resolveOld!: (result: { output: string }) => void
    const oldVoice = {
      createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'),
      executeTool: vi.fn(() => new Promise<{ output: string }>((resolve) => { resolveOld = resolve })),
    } as unknown as PrimeWorkApi['voice']
    const onTaskStarted = vi.fn(async () => undefined)
    await act(async () => root.render(<VoiceOrb voice={oldVoice} harness="prime" onClose={vi.fn()} onTaskStarted={onTaskStarted} />))
    const oldChannel = FakePeer.latest.channel
    await act(async () => {
      oldChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'old-call', name: 'list_projects', arguments: '{}' }) }))
    })

    const resolutions = new Map<string, (result: { output: string }) => void>()
    const newVoice = {
      createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'),
      executeTool: vi.fn((request: { name: string }) => new Promise<{ output: string }>((resolve) => resolutions.set(request.name, resolve))),
    } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={newVoice} harness="prime" onClose={vi.fn()} onTaskStarted={onTaskStarted} />))
    const newChannel = FakePeer.latest.channel
    await act(async () => {
      newChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created' }) }))
      newChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'new-projects', name: 'list_projects', arguments: '{}' }) }))
      newChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'new-models', name: 'list_models', arguments: '{}' }) }))
      newChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done' }) }))
      resolutions.get('list_projects')?.({ output: '{"projects":[]}' })
      await Promise.resolve()
      resolveOld({ output: '{"old":true}' })
      await Promise.resolve()
    })
    expect(newChannel.send.mock.calls.map(([value]) => JSON.parse(value)).filter((message) => message.type === 'response.create')).toHaveLength(0)

    await act(async () => {
      resolutions.get('list_models')?.({ output: '{"models":[]}' })
      await Promise.resolve()
    })
    expect(newChannel.send.mock.calls.map(([value]) => JSON.parse(value)).filter((message) => message.type === 'response.create')).toHaveLength(1)
  })

  it('shows details from realtime errors', async () => {
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool: vi.fn() } as unknown as PrimeWorkApi['voice']
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'A response is already in progress.', param: 'response', event_id: 'evt-123' } }) }))
    })
    expect(container.textContent).toContain('Realtime error (conversation_already_has_active_response): A response is already in progress. [response] [event evt-123]')
    consoleError.mockRestore()
  })

  it('keeps tool calls bound to the harness selected when the orb opened', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"active_harness":"omp"}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    const onClose = vi.fn()
    const onTaskStarted = vi.fn(async () => undefined)
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={onClose} onTaskStarted={onTaskStarted} />))
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={onClose} onTaskStarted={onTaskStarted} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-context', name: 'get_local_context', arguments: '{}' }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'get_local_context', arguments: {} }, 'omp')
  })

  it('shows a durable failure instead of claiming an unconfirmed task started', async () => {
    const executeTool = vi.fn(async () => { throw new Error('OMP did not create a visible session') })
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn(async () => undefined)} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'start_task', arguments: JSON.stringify({ project_id: 'p1', prompt: 'Build it' }) }) }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Task was not started: OMP did not create a visible session')
    expect(container.textContent).not.toContain('Task started')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', error: { code: 'invalid_request_error', message: 'A response is already in progress.' } }) }))
    })
    expect(container.textContent).toContain('Task was not started: OMP did not create a visible session')
    consoleError.mockRestore()
  })
})
