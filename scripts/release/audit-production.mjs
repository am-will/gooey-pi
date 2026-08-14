#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { describeAuditEvaluation, evaluateAuditReport, readAuditExceptions } from './audit-exceptions.mjs'
import { resolveCommandInvocation } from './lib.mjs'

// npm audit exits non-zero whenever it reports anything at the requested level, so the status is
// no help here: the report itself decides, and only an unparseable report is a runner failure.
function runProductionAudit() {
  const invocation = resolveCommandInvocation('npm', ['audit', '--omit', 'dev', '--json'])
  const result = spawnSync(invocation.file, invocation.args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: invocation.shell })
  if (result.error) throw result.error
  if (!result.stdout?.trim()) throw new Error(`npm audit produced no output${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm audit did not produce JSON${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }
}

try {
  const evaluation = describeAuditEvaluation(evaluateAuditReport(runProductionAudit(), readAuditExceptions()))
  if (evaluation.ok) console.log(`Production dependency audit passed: ${evaluation.message}`)
  else {
    console.error(`Production dependency audit failed:\n${evaluation.message}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`Production dependency audit could not run: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
