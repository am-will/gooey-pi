import { describe, expect, it } from 'vitest'
import { normalizeBrowserAddress } from '../../src/lib/browser-address'
import { isAllowedBrowserUrl } from '../../src/lib/browser-url'

describe('browser address normalization', () => {
  it.each(['localhost:3000', 'LOCALHOST:3000/a', 'localhost:3000?x=1', 'app.localhost:3000', '127.0.0.1:8080', '[::1]:3000', '0.0.0.0:8080', '10.1.2.3:3000', '192.168.1.5:5173', '172.16.0.1', '172.31.2.3#foo'])('uses http for local address %s', (value) => {
    expect(normalizeBrowserAddress(value)).toBe(`http://${value}`)
  })
  it.each(['example.com', 'example.com:443/a', 'localhost.example.com', '10.0.0.1.evil.test', '172.15.0.1', '172.32.0.1'])('does not confuse public host %s with local hosts', (value) => {
    expect(normalizeBrowserAddress(value)).toBe(`https://${value}`)
  })
  it.each(['http://example.com/', 'https://example.com/', 'about:blank'])('preserves %s', (value) => {
    expect(normalizeBrowserAddress(value)).toBe(value)
  })
  it('supports blank addresses and text searches', () => {
    expect(normalizeBrowserAddress('  ')).toBe('about:blank')
    expect(normalizeBrowserAddress('hello world')).toBe('https://www.google.com/search?q=hello%20world')
  })
  it.each(['file:///private/secret', 'javascript:alert(1)', 'data:text/html,private', 'mailto:private@example.com', 'https://user:secret@example.com/'])('never converts rejected explicit input %s into a search', (value) => {
    const candidate = normalizeBrowserAddress(value)
    expect(candidate).toBe(value)
    expect(isAllowedBrowserUrl(candidate)).toBe(false)
  })
})
