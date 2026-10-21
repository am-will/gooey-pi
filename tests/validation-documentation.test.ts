import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { localMarkdownTargets } from './helpers/markdown'

type RecordValue = Record<string, unknown>

const load = createRequire(import.meta.url)('js-yaml').load as (source: string) => unknown
const validationPath = resolve('docs/validation.md')
const validation = readFileSync(validationPath, 'utf8')
const packageManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
const workflowsPath = resolve('.github/workflows')

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
}

function workflow(path: string): RecordValue {
  return record(load(readFileSync(path, 'utf8')))
}

function section(source: string, heading: string): string {
  const start = source.indexOf(`## ${heading}`)
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0)
  const body = source.slice(start + heading.length + 3)
  const nextHeading = body.search(/^## /m)
  return nextHeading === -1 ? body : body.slice(0, nextHeading)
}

function firstTableRows(source: string): string[][] {
  const lines = source.split('\n')
  const firstTableLine = lines.findIndex((line) => line.trim().startsWith('|'))
  expect(firstTableLine).toBeGreaterThanOrEqual(0)
  const table = lines.slice(firstTableLine).filter((line) => line.trim().startsWith('|'))
  return table.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )
}

function workflowJobs(path: string): RecordValue {
  return record(workflow(path).jobs)
}

function dispatchOnly(job: RecordValue): boolean {
  const condition = typeof job.if === 'string' ? job.if.trim() : ''
  return /^github\.event_name\s*==\s*['"]workflow_dispatch['"]$/.test(condition)
}

function jobName(jobId: string, job: RecordValue): string {
  return typeof job.name === 'string' ? job.name : jobId
}

function matrixContexts(jobId: string, job: RecordValue): string[] {
  const matrix = record(record(job.strategy).matrix)
  const include = matrix.include
  const name = jobName(jobId, job)
  if (!Array.isArray(include)) return [name]

  return include.map((entry) => {
    const values = Object.values(record(entry))
      .filter((value) => value !== '' && value !== null && value !== undefined)
      .map(String)
    return values.length > 0 ? `${name} (${values.join(', ')})` : name
  })
}

function requiredContexts(jobs: RecordValue): string[] {
  return Object.entries(jobs)
    .filter(([, job]) => !dispatchOnly(record(job)))
    .flatMap(([jobId, job]) => matrixContexts(jobId, record(job)))
}

function runCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(runCommands)
  if (!value || typeof value !== 'object') return []

  const object = record(value)
  return [...(typeof object.run === 'string' ? [object.run] : []), ...Object.values(object).flatMap(runCommands)]
}

describe('validation guide structure', () => {
  test('resolves every local link and names only package scripts that exist', () => {
    for (const target of localMarkdownTargets(validationPath, validation)) {
      expect(existsSync(target), `missing documentation target: ${target}`).toBe(true)
    }

    const mentionedScripts = [...validation.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1])
    for (const script of new Set(mentionedScripts)) {
      expect(packageManifest.scripts, `missing package script mentioned by the guide: ${script}`).toHaveProperty(script)
    }
  })

  test('keeps CI and release job tables equal to their reported workflow names', () => {
    const ciJobs = workflowJobs(resolve('.github/workflows/ci.yml'))
    const releaseJobs = workflowJobs(resolve('.github/workflows/release.yml'))
    const ciTable = firstTableRows(section(validation, 'Pull-request and branch CI')).map(([job]) => job.replaceAll('`', ''))
    const releaseTable = firstTableRows(section(validation, 'Public release validation')).map(([job]) => job.replaceAll('`', ''))

    expect(new Set(ciTable)).toEqual(new Set(Object.entries(ciJobs).map(([id, job]) => jobName(id, record(job)))))
    expect(new Set(releaseTable)).toEqual(new Set(Object.entries(releaseJobs).map(([id, job]) => jobName(id, record(job)))))
  })

  test('documents the scheduled audit workflow contract', () => {
    const audit = workflow(resolve('.github/workflows/audit.yml'))
    const triggers = record(audit.on)
    expect(triggers).toHaveProperty('schedule')
    expect(triggers).toHaveProperty('workflow_dispatch')
    expect(runCommands(record(audit.jobs).audit)).toContain('npm run audit:production')
  })

  test('links every workflow file from the guide', () => {
    const linkedTargets = new Set(localMarkdownTargets(validationPath, validation))
    const workflowFiles = readdirSync(workflowsPath).map((name) => resolve(workflowsPath, name))

    for (const workflowFile of workflowFiles) {
      expect(linkedTargets, `workflow is not linked from the guide: ${workflowFile}`).toContain(workflowFile)
    }
  })

  test('derives protected-main required checks and manual exclusions from CI', () => {
    const ciJobs = workflowJobs(resolve('.github/workflows/ci.yml'))
    const protectedSection = section(validation, 'Protected `main` validation contract')
    const requiredChecks = [...protectedSection.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1])
    const exclusion = protectedSection.match(/^Do not require (.+?):/m)
    expect(exclusion).not.toBeNull()
    const documentedExclusions = [...(exclusion?.[1].matchAll(/`([^`]+)`/g) ?? [])].map((match) => match[1])
    const derivedExclusions = Object.entries(ciJobs)
      .filter(([, job]) => dispatchOnly(record(job)))
      .map(([jobId, job]) => jobName(jobId, record(job)))

    expect(new Set(documentedExclusions)).toEqual(new Set(derivedExclusions))
    expect(new Set(requiredChecks)).toEqual(new Set(requiredContexts(ciJobs)))
  })

  test('documents patch verification, fresh-build E2E and packaged renderer startup checks', () => {
    const commands = section(validation, 'Local aggregate commands')
    expect(commands).toContain('npm run vendor:verify-patches')
    expect(packageManifest.scripts['release:verify:package']).toContain('npm run vendor:verify-patches')
    expect(commands).toContain('npm run test:e2e:hermetic')
    expect(commands).toContain('Run `npm run build` after source changes first')
    expect(commands).toContain('scripts/release/smoke-packaged-app.mjs')
    expect(section(validation, 'Pull-request and branch CI')).toContain('renderer startup marker')
  })

  test('does not hard-code a suite count', () => {
    expect(validation).not.toMatch(/\b\d+ (?:tests|Electron tests)\b/)
  })
})
