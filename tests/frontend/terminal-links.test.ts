import { describe, expect, it } from 'vitest'
import { terminalLinkOpensExternally } from '../../src/lib/terminal-links'

describe('terminal link routing', () => {
  it('opens plain clicks in GooeyPi and modified clicks externally', () => {
    expect(terminalLinkOpensExternally({ metaKey: false, ctrlKey: false })).toBe(false)
    expect(terminalLinkOpensExternally({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(terminalLinkOpensExternally({ metaKey: false, ctrlKey: true })).toBe(true)
  })
})
