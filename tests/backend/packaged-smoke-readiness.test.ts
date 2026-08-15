import { describe, expect, test, vi } from 'vitest'
import {
  EXPECTED_PACKAGED_RENDERER_URL,
  MAX_PACKAGED_SMOKE_READY_BYTES,
  assertPackagedSmokeProbe,
  parsePackagedSmokeRequest,
  serializePackagedSmokeResult,
  waitForPackagedSmokeRenderer,
} from '../../electron/main/packaged-smoke'

const readyProbe = {
  url: EXPECTED_PACKAGED_RENDERER_URL,
  preload: true,
  renderer: true,
}

describe('packaged renderer readiness', () => {
  test('requires an explicit absolute isolated user-data directory', () => {
    expect(parsePackagedSmokeRequest(['gooeypi'])).toEqual({ enabled: false })
    expect(parsePackagedSmokeRequest(['gooeypi', '--gooeypi-packaged-smoke', '--gooeypi-packaged-smoke-user-data=/tmp/smoke-profile'])).toEqual({ enabled: true, userDataPath: '/tmp/smoke-profile' })
    expect(() => parsePackagedSmokeRequest(['gooeypi', '--gooeypi-packaged-smoke'])).toThrow(/exactly one isolated user-data directory/i)
    expect(() => parsePackagedSmokeRequest(['gooeypi', '--gooeypi-packaged-smoke', '--gooeypi-packaged-smoke-user-data=relative/profile'])).toThrow(/absolute single-line path/i)
  })

  test('accepts readiness only from the exact trusted renderer with the preload bridge', () => {
    expect(assertPackagedSmokeProbe(readyProbe, EXPECTED_PACKAGED_RENDERER_URL)).toEqual({
      event: 'gooeypi-packaged-smoke-ready',
      ...readyProbe,
    })
    expect(() => assertPackagedSmokeProbe({ ...readyProbe, url: 'https://attacker.test/' }, EXPECTED_PACKAGED_RENDERER_URL)).toThrow(/unexpected renderer URL/i)
    expect(() => assertPackagedSmokeProbe({ ...readyProbe, preload: false }, EXPECTED_PACKAGED_RENDERER_URL)).toThrow(/preload bridge/i)
    expect(() => assertPackagedSmokeProbe({ ...readyProbe, renderer: false }, EXPECTED_PACKAGED_RENDERER_URL)).toThrow(/renderer did not report ready/i)
  })

  test('canonicalizes same-document fragments and bounds the serialized marker', () => {
    const hugeFragment = `${EXPECTED_PACKAGED_RENDERER_URL}#${'x'.repeat(MAX_PACKAGED_SMOKE_READY_BYTES * 2)}`
    const result = assertPackagedSmokeProbe({ ...readyProbe, url: hugeFragment }, EXPECTED_PACKAGED_RENDERER_URL)
    expect(result.url).toBe(EXPECTED_PACKAGED_RENDERER_URL)
    expect(Buffer.byteLength(serializePackagedSmokeResult(result))).toBeLessThanOrEqual(MAX_PACKAGED_SMOKE_READY_BYTES)
    expect(() => serializePackagedSmokeResult({ ...result, url: hugeFragment })).toThrow(/readiness marker exceeds/i)
  })

  test('checks both the live WebContents URL and the renderer-world probe', async () => {
    const executeJavaScript = vi.fn(async () => readyProbe)
    await expect(
      waitForPackagedSmokeRenderer(
        {
          executeJavaScript,
          getURL: () => EXPECTED_PACKAGED_RENDERER_URL,
        },
        EXPECTED_PACKAGED_RENDERER_URL,
        { timeoutMs: 100 },
      ),
    ).resolves.toEqual({
      event: 'gooeypi-packaged-smoke-ready',
      ...readyProbe,
    })
    expect(executeJavaScript).toHaveBeenCalledOnce()
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('await window.prime.app.getMeta()'))

    await expect(
      waitForPackagedSmokeRenderer(
        {
          executeJavaScript,
          getURL: () => 'https://attacker.test/',
        },
        EXPECTED_PACKAGED_RENDERER_URL,
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow(/untrusted renderer URL/i)
  })

  test('uses timeout only as a failure bound, never as readiness admission', async () => {
    await expect(
      waitForPackagedSmokeRenderer(
        {
          executeJavaScript: vi.fn(() => new Promise(() => undefined)),
          getURL: () => EXPECTED_PACKAGED_RENDERER_URL,
        },
        EXPECTED_PACKAGED_RENDERER_URL,
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow(/did not report ready within 5 ms/i)
  })
})
