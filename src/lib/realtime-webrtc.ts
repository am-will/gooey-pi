import { REALTIME_TOOL_PROBE_NAME } from '@/types/api'

const DEFAULT_ICE_TIMEOUT_MS = 8_000
const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000
const DEFAULT_TOOL_PROBE_TIMEOUT_MS = 15_000

export async function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs = DEFAULT_ICE_TIMEOUT_MS,
): Promise<RTCSessionDescriptionInit> {
  if (!peer.localDescription) throw new Error('WebRTC did not create a local session description')
  if (peer.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (peer.iceGatheringState !== 'complete') return
        cleanup()
        resolve()
      }
      const timer = window.setTimeout(() => {
        cleanup()
        reject(new Error('WebRTC ICE gathering timed out'))
      }, timeoutMs)
      const cleanup = () => {
        window.clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', finish)
      }
      peer.addEventListener('icegatheringstatechange', finish)
      finish()
    })
  }
  const description = peer.localDescription
  if (!description?.sdp) throw new Error('WebRTC did not produce an SDP offer')
  return { type: description.type, sdp: description.sdp }
}

export async function waitForDataChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = DEFAULT_CHANNEL_TIMEOUT_MS,
): Promise<void> {
  if (channel.readyState === 'open') return
  await new Promise<void>((resolve, reject) => {
    const opened = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('Realtime data channel closed during setup')) }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Realtime data channel did not open'))
    }, timeoutMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      channel.removeEventListener('open', opened)
      channel.removeEventListener('close', closed)
      channel.removeEventListener('error', closed)
    }
    channel.addEventListener('open', opened, { once: true })
    channel.addEventListener('close', closed, { once: true })
    channel.addEventListener('error', closed, { once: true })
  })
}

function isToolProbeCall(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.name === REALTIME_TOOL_PROBE_NAME &&
    (item.type === undefined || item.type === 'function_call')
}

export async function probeRealtimeToolSupport(
  channel: RTCDataChannel,
  timeoutMs = DEFAULT_TOOL_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (channel.readyState !== 'open') return false
  return new Promise<boolean>((resolve) => {
    const finish = (supported: boolean) => {
      cleanup()
      resolve(supported)
    }
    const message = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let parsed: Record<string, unknown>
      try {
        const value = JSON.parse(event.data) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        parsed = value as Record<string, unknown>
      } catch { return }
      if (parsed.type === 'response.function_call_arguments.done' && parsed.name === REALTIME_TOOL_PROBE_NAME) {
        finish(true)
        return
      }
      if (parsed.type === 'response.output_item.done' && isToolProbeCall(parsed.item)) {
        finish(true)
        return
      }
      if (parsed.type === 'response.done') {
        const response = parsed.response
        const output = response && typeof response === 'object' && !Array.isArray(response)
          ? (response as Record<string, unknown>).output
          : undefined
        finish(Array.isArray(output) && output.some(isToolProbeCall))
        return
      }
      if (parsed.type === 'error') finish(false)
    }
    const unavailable = () => finish(false)
    const timer = window.setTimeout(unavailable, timeoutMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      channel.removeEventListener('message', message)
      channel.removeEventListener('close', unavailable)
      channel.removeEventListener('error', unavailable)
    }
    channel.addEventListener('message', message)
    channel.addEventListener('close', unavailable, { once: true })
    channel.addEventListener('error', unavailable, { once: true })
    try {
      channel.send(JSON.stringify({ type: 'response.create' }))
    } catch {
      finish(false)
    }
  })
}
