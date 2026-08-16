import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const policyPath = resolve('.github/SECURITY.md')
const readmePath = resolve('README.md')
const securityModelPath = resolve('docs/security.md')
const policy = readFileSync(policyPath, 'utf8')
const readme = readFileSync(readmePath, 'utf8')
const securityModel = readFileSync(securityModelPath, 'utf8')

function localMarkdownTargets(sourcePath: string, source: string): string[] {
  return [...source.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => target.split('#')[0])
    .filter(Boolean)
    .map((target) => resolve(dirname(sourcePath), target))
}

describe('repository security policy', () => {
  test('uses GitHub-recognized placement and identifies supported versions', () => {
    expect(existsSync(policyPath)).toBe(true)
    expect(policy).toContain('# Security Policy')
    expect(policy).toMatch(/latest (?:GooeyPi )?release/i)
    expect(policy).toContain('| Earlier releases | No |')
  })

  test('directs sensitive reports to GitHub private advisories', () => {
    expect(policy).toContain('https://github.com/am-will/gooey-pi/security/advisories/new')
    expect(policy).toMatch(/Do not disclose suspected vulnerabilities in a public issue/i)
    expect(policy).toMatch(/If the private reporting form is unavailable/i)
    expect(policy).toMatch(/Do not include any vulnerability details in that issue/i)
  })

  test('sets report, response, and coordinated-disclosure expectations', () => {
    for (const detail of ['security impact', 'reproduction steps', 'proof of concept', 'suggested remediation', 'preferred credit']) {
      expect(policy.toLowerCase()).toContain(detail)
    }
    expect(policy).toMatch(/acknowledge.+business days/i)
    expect(policy).toMatch(/initial assessment.+business days/i)
    expect(policy).toMatch(/status update.+calendar days/i)
    expect(policy).toMatch(/Keep the report confidential until/i)
    expect(policy).toMatch(/normally within \*\*90 days\*\*/i)
  })

  test('does not publish a private contact or secret-bearing example', () => {
    expect(policy).not.toMatch(/mailto:/i)
    expect(policy).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)
    expect(policy).not.toMatch(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/)
    expect(policy).not.toMatch(/Authorization:\s*Bearer/i)
  })

  test('is linked from the README and technical security model without broken local links', () => {
    expect(readme).toContain('[security policy](.github/SECURITY.md)')
    expect(securityModel).toContain('[vulnerability reporting policy](../.github/SECURITY.md)')

    for (const [sourcePath, source] of [
      [policyPath, policy],
      [readmePath, readme],
      [securityModelPath, securityModel],
    ] as const) {
      for (const target of localMarkdownTargets(sourcePath, source)) {
        expect(existsSync(target), `missing documentation target linked from ${sourcePath}: ${target}`).toBe(true)
      }
    }
  })
})
