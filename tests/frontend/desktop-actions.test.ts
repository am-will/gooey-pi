import { describe, expect, it, vi } from 'vitest'
import { openExternalUrl, revealPath } from '@/lib/desktop-actions'

describe('desktop shell actions', () => {
  it('reports nothing when the request reaches the operating system', async () => {
    const app = { openExternal: vi.fn().mockResolvedValue(true), revealPath: vi.fn().mockResolvedValue(true) }
    await expect(openExternalUrl(app, 'https://example.com')).resolves.toBeNull()
    await expect(revealPath(app, '/tmp/session.jsonl')).resolves.toBeNull()
  })

  it('turns a refused request into display text instead of a silent no-op', async () => {
    const app = { openExternal: vi.fn().mockResolvedValue(false), revealPath: vi.fn().mockResolvedValue(false) }
    await expect(openExternalUrl(app, 'https://example.com')).resolves.toContain('https://example.com')
    await expect(revealPath(app, '/tmp/session.jsonl')).resolves.toContain('/tmp/session.jsonl')
  })

  it('surfaces a rejected bridge call as its message', async () => {
    const app = {
      openExternal: vi.fn().mockRejectedValue(new Error('bridge closed')),
      revealPath: vi.fn().mockRejectedValue(new Error('bridge closed')),
    }
    await expect(openExternalUrl(app, 'https://example.com')).resolves.toBe('bridge closed')
    await expect(revealPath(app, '/tmp/session.jsonl')).resolves.toBe('bridge closed')
  })
})
