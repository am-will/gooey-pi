const DEFAULT_ICE_TIMEOUT_MS = 8_000
const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000

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
