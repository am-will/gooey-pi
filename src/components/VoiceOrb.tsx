import { Mic, MicOff, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { HarnessId, PrimeWorkApi, VoiceTaskStarted, VoiceToolRequest } from '@/types/api'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { DesktopPet, type DesktopPetProps } from './DesktopPet'
import type { PetActivity } from './PetAvatar'

type OrbState = 'connecting' | 'listening' | 'user-speaking' | 'thinking' | 'agent-speaking' | 'error'

interface VoiceOrbProps {
  voice: PrimeWorkApi['voice']
  harness: HarnessId
  projectId?: string
  onClose(): void
  onTaskStarted(task: VoiceTaskStarted): Promise<void>
  pet?: Pick<DesktopPetProps, 'pets' | 'petId' | 'agentBusy' | 'reduceMotion' | 'petSize' | 'onDismiss'>
  focusPetControl?: boolean
  onPetControlFocused?(): void
}

interface OrbPosition { x: number; y: number }

function initialPosition(): OrbPosition {
  try {
    const saved = JSON.parse(localStorage.getItem('prime-work:voice-orb-position') ?? '') as Partial<OrbPosition>
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: Number(saved.x), y: Number(saved.y) }
  } catch { /* use the default */ }
  return { x: Math.max(20, window.innerWidth - 178), y: 78 }
}

function clampPosition(position: OrbPosition): OrbPosition {
  return {
    x: Math.max(12, Math.min(window.innerWidth - 148, position.x)),
    y: Math.max(58, Math.min(window.innerHeight - 172, position.y)),
  }
}

function toolRequest(name: unknown, args: unknown): VoiceToolRequest | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  if (name === 'list_projects') return { name, arguments: args as { query?: string } }
  if (name === 'list_models') return { name, arguments: args as { query?: string } }
  if (name === 'start_task') return { name, arguments: args as { project_id: string; prompt: string; title?: string; model?: string; reasoning?: string } }
  if (name === 'get_local_context') return { name, arguments: {} }
  if (name === 'search_web') return { name, arguments: args as { query: string } }
  return null
}

function boundedErrorField(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
}

function realtimeErrorMessage(message: Record<string, unknown>): string {
  if (typeof message.message === 'string' && message.message.trim()) return `Realtime error: ${message.message.trim().slice(0, 500)}`
  if (!message.error || typeof message.error !== 'object' || Array.isArray(message.error)) return 'The realtime voice session reported an error.'
  const error = message.error as Record<string, unknown>
  const detail = boundedErrorField(error.message)
  const code = boundedErrorField(error.code)
  const param = boundedErrorField(error.param)
  const eventId = boundedErrorField(error.event_id)
  if (!detail) return 'The realtime voice session reported an error.'
  return `Realtime error${code ? ` (${code})` : ''}: ${detail}${param ? ` [${param}]` : ''}${eventId ? ` [event ${eventId}]` : ''}`
}

function delegationInput(message: Record<string, unknown>): { id: string; input: string } | null {
  if (message.type !== 'delegation.created' || !message.item || typeof message.item !== 'object' || Array.isArray(message.item)) return null
  const item = message.item as Record<string, unknown>
  if (item.type !== 'delegation' || item.target !== 'client' || typeof item.id !== 'string' || item.id.length > 512 || !Array.isArray(item.content)) return null
  const input = item.content.flatMap((part) => part && typeof part === 'object' && !Array.isArray(part)
    && (part as Record<string, unknown>).type === 'input_text' && typeof (part as Record<string, unknown>).text === 'string'
    ? [(part as Record<string, unknown>).text as string] : []).join('').trim()
  return input && new TextEncoder().encode(input).byteLength <= 32 * 1024 ? { id: item.id, input } : null
}

function utf8Chunks(value: string, maxBytes = 500): string[] {
  const chunks: string[] = []
  let current = ''
  for (const character of value) {
    if (current && new TextEncoder().encode(current + character).byteLength > maxBytes) { chunks.push(current); current = character }
    else current += character
  }
  if (current) chunks.push(current)
  return chunks
}

function delegatedToolRequest(input: string): VoiceToolRequest | null {
  try {
    const value = JSON.parse(input) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return toolRequest(record.name, record.arguments)
  } catch { return null }
}

export function VoiceOrb({ voice, harness, projectId, onClose, onTaskStarted, pet, focusPetControl = false, onPetControlFocused }: VoiceOrbProps) {
  const [orbState, setOrbState] = useState<OrbState>('connecting')
  const [muted, setMuted] = useState(false)
  const [sessionError, setSessionError] = useState('')
  const [taskError, setTaskError] = useState('')
  const [taskReceipt, setTaskReceipt] = useState<VoiceTaskStarted | null>(null)
  const [taskOpened, setTaskOpened] = useState(false)
  const [position, setPosition] = useState(initialPosition)
  const streamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null)
  const mutedRef = useRef(muted)
  const onTaskStartedRef = useRef(onTaskStarted)
  const petVisibleRef = useRef(Boolean(pet))
  mutedRef.current = muted
  onTaskStartedRef.current = onTaskStarted
  const error = taskError || sessionError

  useEffect(() => {
    const wasVisible = petVisibleRef.current
    const isVisible = Boolean(pet)
    petVisibleRef.current = isVisible
    if (wasVisible || !isVisible) return
    mutedRef.current = true
    setMuted(true)
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = false
    setOrbState((current) => current === 'error' ? current : 'listening')
  }, [pet])

  useEffect(() => {
    let active = true
    let setupPending = true
    const setupId = crypto.randomUUID()
    const handledCalls = new Set<string>()
    const handledDelegations = new Set<string>()
    setSessionError('')
    setOrbState('connecting')
    let responseActive = false
    let pendingToolCalls = 0
    let continuationPending = false
    let pendingResponseCreateEventId: string | null = null
    let clientEventSequence = 0
    let realtimeProtocol: 'openai' | 'codex-v3' = 'openai'
    const peer = new RTCPeerConnection()
    const channel = peer.createDataChannel('oai-events')
    channelRef.current = channel

    const continueAfterTools = () => {
      if (!active || channel.readyState !== 'open' || responseActive || pendingToolCalls > 0 || !continuationPending) return
      continuationPending = false
      responseActive = true
      pendingResponseCreateEventId = `gooeypi-response-${Date.now().toString(36)}-${++clientEventSequence}`
      channel.send(JSON.stringify({ type: 'response.create', event_id: pendingResponseCreateEventId }))
    }

    const sendToolOutput = (callId: string, output: string) => {
      if (!active) return
      pendingToolCalls = Math.max(0, pendingToolCalls - 1)
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } }))
        continuationPending = true
      }
      continueAfterTools()
    }

    const runTool = async (request: VoiceToolRequest): Promise<{ output: string; failed?: boolean; opened?: boolean; openError?: string }> => {
      if (active) setOrbState('thinking')
      if (request.name === 'start_task') setTaskError('')
      try {
        const result = await voice.executeTool(request, harness)
        if (!result.task) return { output: result.output }
        if (active) {
          setTaskReceipt(result.task)
          setTaskOpened(false)
        }
        try {
          await onTaskStartedRef.current(result.task)
          if (active) setTaskOpened(true)
          return { output: result.output, opened: true }
        } catch (failure) {
          const openError = failure instanceof Error ? failure.message : 'Unknown error'
          if (active) setTaskError(`The task started, but GooeyPi could not open it: ${openError}`)
          return { output: result.output, opened: false, openError }
        }
      } catch (failure) {
        const message = (failure instanceof Error ? failure.message : 'Voice tool failed').slice(0, 1_000)
        if (active && request.name === 'start_task') {
          setTaskReceipt(null)
          setTaskError(`Task was not started: ${message}`)
        }
        return { output: JSON.stringify({ error: message }), failed: true }
      }
    }

    const execute = async (callId: string, name: unknown, rawArguments: unknown) => {
      if (handledCalls.has(callId)) return
      let args: unknown
      try { args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments } catch { args = null }
      const request = toolRequest(name, args)
      if (!request) return
      handledCalls.add(callId)
      pendingToolCalls += 1
      const result = await runTool(request)
      sendToolOutput(callId, result.output)
    }

    const sendDelegationContext = (delegationId: string, content: string, contextChannel: 'commentary' | 'speakable') => {
      if (!active || channel.readyState !== 'open') return
      for (const text of utf8Chunks(content)) channel.send(JSON.stringify({
        type: 'delegation.context.append', delegation_item_id: delegationId, channel: contextChannel,
        content: [{ type: 'input_text', text }],
      }))
    }

    const executeDelegation = async ({ id, input }: { id: string; input: string }) => {
      if (handledDelegations.has(id)) return
      handledDelegations.add(id)
      const request = delegatedToolRequest(input)
      if (!request) {
        sendDelegationContext(id, 'The delegated client tool request was invalid. Ask the user to select a project or try again.', 'speakable')
        return
      }
      const result = await runTool(request)
      const navigation = result.opened === true
        ? ' GooeyPi also opened the task in the sidebar.'
        : result.opened === false ? ` The task started, but GooeyPi could not open it in the sidebar: ${result.openError}` : ''
      const outcome = result.failed ? 'failed' : 'returned'
      sendDelegationContext(id, `The ${request.name} tool ${outcome}: ${result.output}.${navigation}`, request.name === 'start_task' ? 'speakable' : 'commentary')
    }

    const handleOpen = () => {
      if (!active) return
      setSessionError('')
      setOrbState('listening')
      if (realtimeProtocol === 'codex-v3') channel.send(JSON.stringify({
        type: 'session.context.append', channel: 'speakable',
        content: [{ type: 'input_text', text: 'The voice session has started. Give the user a short greeting, then wait for them to speak.' }],
      }))
    }
    const handleMessage = (event: MessageEvent) => {
      if (!active) return
      let payload: unknown
      const raw = String(event.data)
      if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return
      try { payload = JSON.parse(raw) } catch { return }
      if (!payload || typeof payload !== 'object') return
      const message = payload as Record<string, unknown>
      if (message.type === 'input_audio_buffer.speech_started') setOrbState('user-speaking')
      else if (message.type === 'input_transcript.added') setOrbState('user-speaking')
      else if (message.type === 'input_audio_buffer.speech_stopped') setOrbState('thinking')
      else if (message.type === 'output_transcript.added') setOrbState('agent-speaking')
      else if (message.type === 'turn.done' && message.turn && typeof message.turn === 'object' && (message.turn as Record<string, unknown>).role === 'user') setOrbState('thinking')
      else if (message.type === 'turn.done' && message.turn && typeof message.turn === 'object' && (message.turn as Record<string, unknown>).role === 'assistant') setOrbState('listening')
      else if (message.type === 'delegation.created') {
        const delegation = delegationInput(message)
        if (delegation) void executeDelegation(delegation)
        else {
          setSessionError('Codex voice returned an invalid delegation.')
          setOrbState('error')
          try { channel.close() } catch { /* already closed */ }
          peer.close()
          for (const track of streamRef.current?.getTracks() ?? []) track.stop()
        }
      }
      else if (message.type === 'response.created') {
        responseActive = true
        setOrbState('thinking')
      }
      else if (message.type === 'response.audio.delta' || message.type === 'output_audio_buffer.started') setOrbState('agent-speaking')
      else if (message.type === 'output_audio_buffer.stopped') setOrbState('listening')
      else if (message.type === 'response.done') {
        responseActive = false
        pendingResponseCreateEventId = null
        setOrbState('listening')
        continueAfterTools()
      }
      else if (message.type === 'response.function_call_arguments.done' && typeof message.call_id === 'string') void execute(message.call_id, message.name, message.arguments)
      else if (message.type === 'response.output_item.done' && message.item && typeof message.item === 'object') {
        const item = message.item as Record<string, unknown>
        if (item.type === 'function_call' && typeof item.call_id === 'string') void execute(item.call_id, item.name, item.arguments)
      } else if (message.type === 'error') {
        const detail = realtimeErrorMessage(message)
        const realtimeError = message.error && typeof message.error === 'object' && !Array.isArray(message.error) ? message.error as Record<string, unknown> : {}
        const triggeringEventId = boundedErrorField(realtimeError.event_id)
        const correlatedResponseCreate = Boolean(triggeringEventId && triggeringEventId === pendingResponseCreateEventId)
        console.error('[voice] realtime error', {
          type: boundedErrorField(realtimeError.type),
          code: boundedErrorField(realtimeError.code),
          message: boundedErrorField(realtimeError.message),
          param: boundedErrorField(realtimeError.param),
          event_id: triggeringEventId,
        })
        if (correlatedResponseCreate) {
          pendingResponseCreateEventId = null
          if (boundedErrorField(realtimeError.code) === 'conversation_already_has_active_response') {
            responseActive = true
            continuationPending = true
          } else {
            responseActive = false
            continuationPending = false
          }
        }
        setSessionError(detail)
        setOrbState('error')
      }
    }
    const handleTrack = (event: RTCTrackEvent) => {
      if (audioRef.current) audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track])
    }
    channel.addEventListener('open', handleOpen)
    channel.addEventListener('message', handleMessage)
    peer.addEventListener('track', handleTrack)

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
        if (!active) { for (const track of stream.getTracks()) track.stop(); return }
        streamRef.current = stream
        for (const track of stream.getAudioTracks()) track.enabled = !mutedRef.current
        for (const track of stream.getTracks()) peer.addTrack(track, stream)
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        if (!active) return
        const answer = await voice.createRealtimeCall({ mode: 'conversation', setupId, sdp: offer.sdp ?? '', harness, ...(projectId ? { projectId } : {}) })
        setupPending = false
        if (!active) return
        realtimeProtocol = answer.protocol
        await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      } catch (failure) {
        if (!active) return
        setSessionError(failure instanceof Error ? failure.message : 'Could not start realtime voice.')
        setOrbState('error')
      } finally { setupPending = false }
    })()

    return () => {
      active = false
      channel.removeEventListener('open', handleOpen)
      channel.removeEventListener('message', handleMessage)
      peer.removeEventListener('track', handleTrack)
      if (setupPending) void voice.cancelRealtimeCall(setupId).catch(() => undefined)
      channelRef.current = null
      try { channel.close() } catch { /* already closed */ }
      peer.close()
      for (const track of streamRef.current?.getTracks() ?? []) track.stop()
      streamRef.current = null
      if (audioRef.current) audioRef.current.srcObject = null
    }
  }, [harness, projectId, voice])

  const toggleMute = () => {
    const next = !muted
    mutedRef.current = next
    setMuted(next)
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = !next
    if (next) setOrbState('listening')
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    dragRef.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    setPosition(clampPosition({ x: event.clientX - current.dx, y: event.clientY - current.dy }))
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem('prime-work:voice-orb-position', JSON.stringify(position))
  }

  const status = muted ? 'Muted' : orbState === 'connecting' ? 'Connecting' : orbState === 'user-speaking' ? 'Listening to you' : orbState === 'thinking' ? 'Thinking' : orbState === 'agent-speaking' ? 'Speaking' : orbState === 'error' ? 'Voice unavailable' : 'Listening'
  const petActivity: PetActivity = muted || orbState === 'listening' || orbState === 'user-speaking' ? 'idle'
    : orbState === 'agent-speaking' ? 'speaking'
      : orbState === 'error' ? 'failed' : 'working'
  const receipt = taskReceipt ? <div className="voice-orb__receipt" role="status">
    <strong>Task started</strong>
    <span>{taskReceipt.projectName} · {HARNESS_SHORT_NAMES[taskReceipt.harness]}</span>
    <small>{taskOpened ? 'Opened in the sidebar' : 'Opening task…'}</small>
  </div> : null
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: Live assistant audio has no static caption track; status remains available as text. */}
      <audio ref={audioRef} autoPlay className="voice-session__audio" />
      {pet ? <DesktopPet
        {...pet}
        voiceActive
        voiceActivity={petActivity}
        voiceMuted={muted}
        voiceStatus={status}
        voiceError={error}
        onToggleVoiceMute={toggleMute}
        onCloseVoice={onClose}
        focusVoiceControl={focusPetControl}
        onVoiceControlFocused={onPetControlFocused}
      >
        {receipt}
      </DesktopPet> : <aside className={`voice-orb voice-orb--${orbState} ${muted ? 'is-muted' : ''}`} style={{ '--orb-x': `${position.x}px`, '--orb-y': `${position.y}px` } as CSSProperties} aria-label="Realtime voice session">
        <div className="voice-orb__drag" onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="voice-orb__halo" aria-hidden="true" />
          <div className="voice-orb__core" aria-hidden="true"><i /><i /><i /></div>
          <span className="voice-orb__status">{status}</span>
          <div className="voice-orb__controls">
            <button type="button" aria-label={muted ? 'Unmute realtime voice' : 'Mute realtime voice'} onClick={toggleMute}>{muted ? <MicOff size={15} /> : <Mic size={15} />}</button>
            <button type="button" aria-label="Close realtime voice" onClick={onClose}><X size={16} /></button>
          </div>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {receipt}
      </aside>}
    </>
  )
}
