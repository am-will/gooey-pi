import { describe, expect, it } from 'vitest'
import { attachmentPlaceholderPrompt, composePrompt, type ComposerPromptContext } from '../../src/lib/composer-prompt'
import type { BrowserAnnotation, SessionRecord, SkillRecord } from '../../src/types/api'

const session: SessionRecord = {
  id: 'target', harness: 'omp', title: 'Review', filePath: '/sessions/target.jsonl', projectPath: '/project',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'idle', depth: 0,
}
const skill = (name: string): SkillRecord => ({ id: `skill-${name}`, name, description: '', kind: 'skill', location: 'project', enabled: true })
const annotation: BrowserAnnotation = {
  id: 'a', comment: 'Make clearer', element: { selector: '#submit', tagName: 'button', id: 'submit', classes: [], text: 'Submit', rect: { x: 0, y: 0, width: 20, height: 20 } },
  pageUrl: 'https://example.com', pageTitle: 'Page', stale: false, createdAt: 1,
}
const empty: ComposerPromptContext = { sessions: [], sessionReferenceIds: new Map(), skills: [], annotations: [] }

describe('composer prompt assembly', () => {
  it.each([
    ['  hello  ', 0, 0, 0, 'hello'], ['', 1, 0, 0, '[Attached image]'], ['', 2, 0, 0, '[Attached images]'],
    ['', 0, 1, 0, '[Attached file]'], ['', 0, 2, 0, '[Attached files]'], ['', 0, 0, 1, '[Page annotations]'],
    ['', 0, 0, 0, '[Terminal selection]'], ['', 1, 1, 1, '[Attached image]'],
  ] as const)('chooses the visible prompt for %s/%s/%s/%s', (draft, images, files, annotations, expected) => {
    expect(attachmentPlaceholderPrompt({ draft, images, files, annotations })).toBe(expected)
  })
  it('preserves plain prompts and intercepted commands without context', () => {
    expect(composePrompt('hello', 'omp', empty)).toEqual({ prompt: 'hello' })
    expect(composePrompt('/compact', 'prime', empty)).toEqual({ prompt: '/compact' })
  })
  it('orders session, capability, annotations and terminal routing and lets session names win', () => {
    const result = composePrompt('@Review with @Search', 'omp', {
      ...empty, sessions: [session], skills: [skill('Review'), skill('Search')], annotations: [annotation], files: [{ name: 'notes.md', text: '# Notes' }],
      terminalContext: { tabId: 'shell', label: 'Shell', text: 'status output', truncated: false },
    })
    expect('prompt' in result).toBe(true)
    if (!('prompt' in result)) throw new Error(result.error)
    const text = result.prompt
    const markers = ['BEGIN GOOEYPI SESSION REFERENCES', 'BEGIN GOOEYPI CAPABILITY ROUTING', 'BEGIN BROWSER ANNOTATIONS', 'BEGIN ATTACHED FILES', 'BEGIN TERMINAL SELECTION CONTEXT']
    const positions = markers.map((marker) => text.indexOf(marker))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(text).toContain('skill-Search')
    expect(text).not.toContain('skill-Review')
    expect(text).toContain('omp session UUID target')
  })
  it('rejects model-only context on intercepted commands but allows ordinary commands', () => {
    expect(composePrompt('/compact custom', 'omp', { ...empty, annotations: [annotation] })).toEqual({ error: '/compact does not accept attachments or @ mentions. Remove them and try again.' })
    expect(composePrompt('/mcp', 'prime', { ...empty, annotations: [annotation] })).toHaveProperty('error')
    expect(composePrompt('/mcp', 'pi', { ...empty, annotations: [annotation] })).toHaveProperty('prompt')
    expect(composePrompt('/compact', 'pi', { ...empty, files: [{ name: 'notes.md', text: 'x' }] })).toHaveProperty('error')
  })
})
