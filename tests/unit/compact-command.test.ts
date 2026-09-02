import { describe, expect, it } from 'vitest'
import { parseCompactCommand } from '../../src/hooks/useWorkspaceActions'

describe('parseCompactCommand', () => {
  it('parses bare /compact command', () => {
    expect(parseCompactCommand('/compact')).toEqual({})
    expect(parseCompactCommand('  /compact  ')).toEqual({})
  })

  it('parses /compact with custom instructions', () => {
    expect(parseCompactCommand('/compact focus on auth')).toEqual({ customInstructions: 'focus on auth' })
    expect(parseCompactCommand('/compact   keep current plan and tests  ')).toEqual({ customInstructions: 'keep current plan and tests' })
  })

  it('returns undefined for non-compact prompts or prefix matches', () => {
    expect(parseCompactCommand('/compacting')).toBeUndefined()
    expect(parseCompactCommand('please /compact')).toBeUndefined()
    expect(parseCompactCommand('/review')).toBeUndefined()
    expect(parseCompactCommand('hello world')).toBeUndefined()
  })
})
