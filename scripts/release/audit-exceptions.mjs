import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIT_FAILING_SEVERITIES = new Set(['high', 'critical'])

const EXCEPTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'audit-exceptions.json')
const ADVISORY_PATTERN = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/
const EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function advisoryId(via) {
  const fromUrl = /\/advisories\/(GHSA-[\w-]+)$/.exec(typeof via.url === 'string' ? via.url : '')?.[1]
  return fromUrl ?? (typeof via.source === 'number' ? `npm-${via.source}` : undefined)
}

/**
 * Flattens `npm audit --json` into the distinct high and critical advisories it reports.
 * Each vulnerable package lists its own advisories as objects in `via`; string entries are
 * only back-references to another vulnerable package, so they carry no advisory of their own.
 */
export function collectAuditAdvisories(report) {
  if (!report || typeof report !== 'object') throw new Error('Audit report is not an object')
  const vulnerabilities = report.vulnerabilities
  if (vulnerabilities !== undefined && (typeof vulnerabilities !== 'object' || vulnerabilities === null)) {
    throw new Error('Audit report has a malformed vulnerabilities section')
  }
  const advisories = new Map()
  for (const entry of Object.values(vulnerabilities ?? {})) {
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (typeof via !== 'object' || via === null) continue
      if (!AUDIT_FAILING_SEVERITIES.has(via.severity)) continue
      const advisory = advisoryId(via)
      if (!advisory) continue
      const pkg = typeof via.name === 'string' ? via.name : entry.name
      advisories.set(`${advisory}\u0000${pkg}`, {
        advisory,
        package: pkg,
        severity: via.severity,
        title: typeof via.title === 'string' ? via.title : 'unknown advisory',
      })
    }
  }
  return [...advisories.values()].sort((left, right) => `${left.package}${left.advisory}`.localeCompare(`${right.package}${right.advisory}`))
}

export function parseAuditExceptions(contents) {
  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error('Audit exception list is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.exceptions)) {
    throw new Error('Audit exception list must be an object with an exceptions array')
  }
  return parsed.exceptions.map((exception, index) => {
    const label = `Audit exception #${index + 1}`
    if (typeof exception !== 'object' || exception === null) throw new Error(`${label} is not an object`)
    const { advisory, package: pkg, expires, reason } = exception
    if (typeof advisory !== 'string' || !ADVISORY_PATTERN.test(advisory)) throw new Error(`${label} needs a GHSA advisory identifier`)
    if (typeof pkg !== 'string' || !pkg.length) throw new Error(`${label} needs the vulnerable package name`)
    if (typeof reason !== 'string' || reason.trim().length < 20) throw new Error(`${label} needs a reason explaining why it is accepted`)
    if (typeof expires !== 'string' || !EXPIRY_PATTERN.test(expires)) throw new Error(`${label} needs an expires date formatted YYYY-MM-DD`)
    const expiresAt = Date.parse(`${expires}T00:00:00Z`)
    if (Number.isNaN(expiresAt)) throw new Error(`${label} has an invalid expires date: ${expires}`)
    return { advisory, package: pkg, expires, expiresAt, reason }
  })
}

export function readAuditExceptions(path = EXCEPTIONS_PATH) {
  return parseAuditExceptions(readFileSync(path, 'utf8'))
}

/**
 * Classifies the audit against the accepted exceptions. `stale` entries matter as much as
 * `unexpected` ones: an exception that no longer matches anything means the advisory was fixed
 * or dropped, and leaving it behind would suppress a future report of the same advisory.
 */
export function evaluateAuditReport(report, exceptions, now = Date.now()) {
  const advisories = collectAuditAdvisories(report)
  const matched = new Set()
  const unexpected = []
  const expired = []
  const accepted = []
  for (const advisory of advisories) {
    const exception = exceptions.find((candidate) => candidate.advisory === advisory.advisory && candidate.package === advisory.package)
    if (!exception) {
      unexpected.push(advisory)
      continue
    }
    matched.add(exception)
    if (exception.expiresAt <= now) expired.push({ ...advisory, expires: exception.expires })
    else accepted.push({ ...advisory, expires: exception.expires })
  }
  return { unexpected, expired, accepted, stale: exceptions.filter((exception) => !matched.has(exception)) }
}

export function describeAuditEvaluation({ unexpected, expired, accepted, stale }) {
  const problems = []
  for (const advisory of unexpected) {
    problems.push(`unaccepted ${advisory.severity} advisory ${advisory.advisory} in ${advisory.package}: ${advisory.title}`)
  }
  for (const advisory of expired) {
    problems.push(`accepted advisory ${advisory.advisory} in ${advisory.package} expired on ${advisory.expires}; re-check for a fix or extend the exception`)
  }
  for (const exception of stale) {
    problems.push(`exception for ${exception.advisory} in ${exception.package} no longer matches any advisory; remove it from audit-exceptions.json`)
  }
  if (problems.length) return { ok: false, message: problems.map((problem) => `- ${problem}`).join('\n') }
  const summary = accepted.length
    ? `no unaccepted high or critical advisories (accepted: ${accepted.map((advisory) => `${advisory.advisory} in ${advisory.package} until ${advisory.expires}`).join(', ')})`
    : 'no high or critical advisories'
  return { ok: true, message: summary }
}
