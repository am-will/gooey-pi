import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const policyPath = resolve('.github/SECURITY.md')
const readmePath = resolve('README.md')
const securityModelPath = resolve('docs/security.md')
const policy = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : ''
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

describe('repository vulnerability-reporting policy', () => {
  test('uses GitHub recognized placement and states the supported release policy', () => {
    expect(existsSync(policyPath)).toBe(true)
    expect(policy).toContain('# Security Policy')
    expect(policy).toContain('| Latest release on GitHub Releases | Yes |')
    expect(policy).toContain('| Every earlier release | No |')
    expect(policy).toContain('When it is safe to do so, confirm whether the suspected vulnerability affects the latest published release before reporting it')
    expect(policy).toContain('If you cannot update or retest safely, report the version you used and explain why')
  })

  test('routes sensitive details through private reporting with a safe unavailable-state fallback', () => {
    expect(policy).toContain('Do not report suspected vulnerabilities in a public issue, discussion, or pull request.')
    expect(policy).toContain('https://github.com/am-will/gooey-pi/security/advisories/new')
    expect(policy).toContain('Complete and submit the form through the private GitHub advisory.')
    expect(policy).not.toContain('Select **Report a vulnerability** and submit the report')
    expect(policy).toContain('If **Report a vulnerability** is unavailable')
    expect(policy).toContain('Do not include vulnerability details in that public request.')
  })

  test('keeps report contents, response targets, and coordinated disclosure explicit', () => {
    for (const detail of ['affected release', 'security impact', 'reproduction steps', 'proof of concept', 'suggested remediation', 'credit preference']) {
      expect(policy.toLowerCase()).toContain(detail)
    }
    expect(policy).toContain('acknowledge a new report within **3 business days**')
    expect(policy).toContain('initial assessment within **7 business days**')
    expect(policy).toContain('status update at least every **14 calendar days**')
    expect(policy).toContain('normally within **90 days** of acknowledgement')
    expect(policy).toContain('Keep the report confidential until the advisory is published or another disclosure date is agreed in the private advisory')
  })

  test('does not publish a private contact or secret-bearing example', () => {
    expect(policy).not.toMatch(/mailto:/i)
    expect(policy).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)
    expect(policy).not.toMatch(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/)
    expect(policy).not.toMatch(/Authorization:\s*Bearer/i)
  })

  test('links the recognized policy from the README and technical security model', () => {
    expect(readme).toContain('[security policy](.github/SECURITY.md)')
    expect(securityModel).toContain('[vulnerability-reporting policy](../.github/SECURITY.md)')

    for (const [sourcePath, source] of [[policyPath, policy], [readmePath, readme], [securityModelPath, securityModel]] as const) {
      for (const target of localMarkdownTargets(sourcePath, source)) {
        expect(existsSync(target), `missing documentation target linked from ${sourcePath}: ${target}`).toBe(true)
      }
    }
  })

  test('records the admin-only activation, PR comment, and live verification steps without claiming completion', () => {
    expect(securityModel).toContain('Adding this file does not enable private vulnerability reporting.')
    expect(securityModel).toContain('@am-will Maintainer action required:')
    expect(securityModel).toContain('gh api --method PUT repos/am-will/gooey-pi/private-vulnerability-reporting')
    expect(securityModel).toContain("gh api --method GET repos/am-will/gooey-pi/private-vulnerability-reporting --jq '.enabled'")
    expect(securityModel).toContain('gh api --method GET repos/am-will/gooey-pi/community/profile')
    expect(securityModel).toContain('Do not state that private reporting is enabled until the status endpoint returns `true`')
  })
})
