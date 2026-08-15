import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const validationPath = resolve('docs/validation.md')
const validation = readFileSync(validationPath, 'utf8')

describe('validation guide', () => {
  test('links every local source to a checked-in path', () => {
    const localTargets = [...validation.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
      .map((target) => target.split('#')[0])

    expect(localTargets.length).toBeGreaterThan(0)
    for (const target of localTargets) {
      expect(existsSync(resolve(dirname(validationPath), target)), `missing documentation target: ${target}`).toBe(true)
    }
  })

  test('describes reproducible sources without reviving a point-in-time status snapshot', () => {
    for (const source of ['../.github/workflows/ci.yml', '../.github/workflows/release.yml', '../.github/workflows/audit.yml', '../package.json']) {
      expect(validation).toContain(`](${source})`)
    }
    expect(validation).not.toMatch(
      /Last full local validation|Pass —|\b0 known vulnerabilities\b|\b33 tests\b|\b9 Electron tests\b|\b(?:Node(?:\.js)?|npm|Electron) v?\d+\.\d+\.\d+\b/i,
    )
    expect(validation).not.toMatch(/Integration prerequisite|reviewed PR head/i)
    expect(validation).not.toMatch(/\b(?:before|after)\b[^\n.]{0,100}\b(?:merge(?:d|s)?|land(?:ed|s)?)\b/i)
    expect(validation).toContain('evidence only for the exact commit')
    expect(validation).toContain('Do not hard-code the current Node, npm, or Electron version')
  })
})
