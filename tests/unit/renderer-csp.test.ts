import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: {}, protocol: {}, ipcMain: {}, shell: {} }))

import { RENDERER_CONTENT_SECURITY_POLICY } from '../../electron/main/renderer-security'

describe('renderer content policy', () => {
  it('keeps the HTML meta policy aligned with the served policy', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)
    const headerDirectives = RENDERER_CONTENT_SECURITY_POLICY.split(';').map((directive) => directive.trim()).filter((directive) => !directive.startsWith('frame-ancestors '))
    expect(meta?.[1].split(';').map((directive) => directive.trim())).toEqual(headerDirectives)
  })
})
