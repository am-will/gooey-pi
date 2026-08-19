import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrimeWorkApi, VoiceTranscriptionProvider } from '@/types/api'

export type DictationState = 'idle' | 'connecting' | 'recording' | 'transcribing'

interface BatchCapture {
  kind: 'batch'
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
  chunks: Float32Array[]
  frames: number
  sampleRate: number
  overflowed: boolean
}

interface LiveCapture {
  kind: 'live'
  stream: MediaStream
  peer: RTCPeerConnection
  channel: RTCDataChannel
  transcript: string
  completed?: (value: string) => void
  failed?: (error: Error) => void
}

type Capture = BatchCapture | LiveCapture
const MAX_RECORDING_SECONDS = 4 * 60

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function closeCapture(capture: Capture | null): void {
  if (!capture) return
  stopTracks(capture.stream)
  if (capture.kind === 'live') {
    try { capture.channel.close() } catch { /* already closed */ }
    capture.peer.close()
  } else {
    capture.processor.disconnect()
    capture.source.disconnect()
    capture.sink.disconnect()
    void capture.context.close().catch(() => undefined)
  }
}

function encodeWav(chunks: Float32Array[], frames: number, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, frames * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

function waitForChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Realtime transcription did not connect.')), 15_000)
    channel.addEventListener('open', () => { window.clearTimeout(timer); resolve() }, { once: true })
    channel.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('Realtime transcription connection failed.')) }, { once: true })
  })
}

export function useDictation(voice: PrimeWorkApi['voice'] | null | undefined, provider: VoiceTranscriptionProvider, onError: (message: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const captureRef = useRef<Capture | null>(null)
  const generationRef = useRef(0)

  const cancel = useCallback(() => {
    generationRef.current += 1
    const capture = captureRef.current
    captureRef.current = null
    if (capture?.kind === 'live') capture.failed?.(new Error('Dictation cancelled.'))
    closeCapture(capture)
    setState('idle')
  }, [])

  useEffect(() => cancel, [cancel])

  const start = useCallback(async () => {
    if (!voice || state !== 'idle') return
    const generation = ++generationRef.current
    setState('connecting')
    onError('')
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (generation !== generationRef.current) { stopTracks(stream); return }
      if (provider === 'openai-live') {
        const peer = new RTCPeerConnection()
        for (const track of stream.getTracks()) peer.addTrack(track, stream)
        const channel = peer.createDataChannel('oai-events')
        const capture: LiveCapture = { kind: 'live', stream, peer, channel, transcript: '' }
        captureRef.current = capture
        channel.addEventListener('message', (event) => {
          let payload: unknown
          try { payload = JSON.parse(String(event.data)) } catch { return }
          if (!payload || typeof payload !== 'object') return
          const message = payload as Record<string, unknown>
          if (message.type === 'conversation.item.input_audio_transcription.delta' && typeof message.delta === 'string') capture.transcript += message.delta
          if (message.type === 'conversation.item.input_audio_transcription.completed') capture.completed?.(typeof message.transcript === 'string' ? message.transcript : capture.transcript)
          if (message.type === 'error') capture.failed?.(new Error('Realtime transcription failed.'))
        })
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        const answer = await voice.createRealtimeCall({ mode: 'transcription', sdp: offer.sdp ?? '' })
        await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
        await waitForChannel(channel)
      } else {
        const context = new AudioContext()
        await context.resume()
        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4_096, 1, 1)
        const sink = context.createGain()
        sink.gain.value = 0
        const capture: BatchCapture = { kind: 'batch', stream, context, source, processor, sink, chunks: [], frames: 0, sampleRate: context.sampleRate, overflowed: false }
        processor.onaudioprocess = (event) => {
          const samples = event.inputBuffer.getChannelData(0)
          if (capture.frames + samples.length > capture.sampleRate * MAX_RECORDING_SECONDS) { capture.overflowed = true; return }
          capture.chunks.push(new Float32Array(samples))
          capture.frames += samples.length
        }
        source.connect(processor); processor.connect(sink); sink.connect(context.destination)
        captureRef.current = capture
      }
      if (generation === generationRef.current) setState('recording')
    } catch (error) {
      if (stream && !captureRef.current) stopTracks(stream)
      if (generation === generationRef.current) {
        closeCapture(captureRef.current); captureRef.current = null; setState('idle')
        onError(error instanceof Error ? error.message : 'Could not start microphone capture.')
      }
    }
  }, [onError, provider, state, voice])

  const finish = useCallback(async (): Promise<string> => {
    const capture = captureRef.current
    if (!voice || !capture || state !== 'recording') return ''
    setState('transcribing')
    try {
      if (capture.kind === 'live') {
        const result = new Promise<string>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('Realtime transcription timed out.')), 20_000)
          capture.completed = (text) => { window.clearTimeout(timer); resolve(text) }
          capture.failed = (error) => { window.clearTimeout(timer); reject(error) }
        })
        capture.channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        return (await result).trim()
      }
      if (capture.overflowed) throw new Error('Dictation is limited to four minutes per recording.')
      if (capture.frames === 0) return ''
      if (provider === 'openai-live') throw new Error('The transcription provider changed while recording.')
      const audio = encodeWav(capture.chunks, capture.frames, capture.sampleRate)
      return (await voice.transcribe({ provider, audio })).trim()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not transcribe the recording.')
      return ''
    } finally {
      captureRef.current = null
      closeCapture(capture)
      setState('idle')
    }
  }, [onError, provider, state, voice])

  return { state, start, finish, cancel }
}
