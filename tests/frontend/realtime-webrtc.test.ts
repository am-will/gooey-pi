// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeRealtimeToolSupport, waitForDataChannelOpen, waitForIceGathering } from '../../src/lib/realtime-webrtc'

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete'
  localDescription: RTCSessionDescription | null = {
    type: 'offer',
    sdp: 'v=0\r\no=test-offer',
    toJSON: () => ({ type: 'offer', sdp: 'v=0\r\no=test-offer' }),
  } as RTCSessionDescription
}

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  send = vi.fn()
}

afterEach(() => vi.useRealTimers())

describe('realtime WebRTC setup waits', () => {
  it('returns an already gathered offer and rejects a missing local description', async () => {
    const ready = new FakePeer()
    await expect(waitForIceGathering(ready as unknown as RTCPeerConnection)).resolves.toEqual({
      type: 'offer',
      sdp: 'v=0\r\no=test-offer',
    })

    const missing = new FakePeer()
    missing.localDescription = null
    await expect(waitForIceGathering(missing as unknown as RTCPeerConnection)).rejects.toThrow(/local session description/)
  })

  it('waits for ICE completion and rejects an offer that loses its SDP', async () => {
    const peer = new FakePeer()
    peer.iceGatheringState = 'gathering'
    const gathered = waitForIceGathering(peer as unknown as RTCPeerConnection)
    peer.iceGatheringState = 'complete'
    peer.dispatchEvent(new Event('icegatheringstatechange'))
    await expect(gathered).resolves.toMatchObject({ sdp: 'v=0\r\no=test-offer' })

    const missingSdp = new FakePeer()
    missingSdp.iceGatheringState = 'gathering'
    const rejected = waitForIceGathering(missingSdp as unknown as RTCPeerConnection)
    missingSdp.localDescription = { type: 'offer', sdp: '' } as RTCSessionDescription
    missingSdp.iceGatheringState = 'complete'
    missingSdp.dispatchEvent(new Event('icegatheringstatechange'))
    await expect(rejected).rejects.toThrow(/SDP offer/)
  })

  it('bounds ICE gathering time', async () => {
    vi.useFakeTimers()
    const peer = new FakePeer()
    peer.iceGatheringState = 'gathering'
    const assertion = expect(waitForIceGathering(peer as unknown as RTCPeerConnection, 25)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('accepts an open data channel or waits for its open event', async () => {
    const open = new FakeChannel()
    open.readyState = 'open'
    await expect(waitForDataChannelOpen(open as unknown as RTCDataChannel)).resolves.toBeUndefined()

    const connecting = new FakeChannel()
    const opened = waitForDataChannelOpen(connecting as unknown as RTCDataChannel)
    connecting.readyState = 'open'
    connecting.dispatchEvent(new Event('open'))
    await expect(opened).resolves.toBeUndefined()
  })

  it.each(['close', 'error'])('rejects when a data channel emits %s during setup', async (eventName) => {
    const channel = new FakeChannel()
    const rejected = waitForDataChannelOpen(channel as unknown as RTCDataChannel)
    channel.dispatchEvent(new Event(eventName))
    await expect(rejected).rejects.toThrow(/closed during setup/)
  })

  it('bounds the data-channel setup time', async () => {
    vi.useFakeTimers()
    const channel = new FakeChannel()
    const assertion = expect(waitForDataChannelOpen(channel as unknown as RTCDataChannel, 25)).rejects.toThrow(/did not open/)
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('requires the harmless GooeyPi function call to prove tool support', async () => {
    const channel = new FakeChannel()
    channel.readyState = 'open'
    channel.send.mockImplementation(() => {
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'response.function_call_arguments.done',
        name: 'gooeypi_realtime_tool_test',
        arguments: '{}',
      }) }))
    })

    await expect(probeRealtimeToolSupport(channel as unknown as RTCDataChannel)).resolves.toBe(true)
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.create' }))
  })

  it('reports an otherwise connected endpoint that does not call the probe tool', async () => {
    const channel = new FakeChannel()
    channel.readyState = 'open'
    channel.send.mockImplementation(() => {
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'response.done',
        response: { status: 'completed', output: [] },
      }) }))
    })

    await expect(probeRealtimeToolSupport(channel as unknown as RTCDataChannel)).resolves.toBe(false)
  })
})
