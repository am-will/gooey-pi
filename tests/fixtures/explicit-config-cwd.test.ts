import { describe, expect, it } from 'vitest'

describe('explicit config cwd fixture', () => {
  it('runs after the repository config resolves its own root', () => {
    expect(true).toBe(true)
  })
})
