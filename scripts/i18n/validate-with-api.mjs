#!/usr/bin/env node
/**
 * Cross-checks the Simplified Chinese catalog against an independent
 * translation pass from the local Index-Translate OpenAI-compatible server.
 *
 * The server is a translation model, not a reviewer, so every English source is
 * re-translated from scratch and compared with the checked-in Chinese. Low
 * similarity, placeholder drift, and untranslated-looking values are flagged
 * for a human to review; the script never edits the catalog.
 *
 * Usage:
 *   node scripts/i18n/validate-with-api.mjs [--limit N] [--concurrency N]
 *   INDEX_TRANSLATE_URL=http://127.0.0.1:8080/v1/chat/completions ...
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const endpoint = process.env.INDEX_TRANSLATE_URL ?? 'http://127.0.0.1:8080/v1/chat/completions'
const model = process.env.INDEX_TRANSLATE_MODEL ?? 'Index-Translate-35B-A3B'
const apiKey = process.env.INDEX_TRANSLATE_KEY ?? 'index'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const limit = option('limit', Number.POSITIVE_INFINITY)
const concurrency = option('concurrency', 6)

const english = (await import(pathToFileURL(resolve(root, 'src/lib/locales/english.ts')).href)).englishCatalog
const chinese = (await import(pathToFileURL(resolve(root, 'src/lib/locales/simplified-chinese.ts')).href)).simplifiedChineseCatalog

const isPlural = (value) => typeof value === 'object' && value !== null && 'one' in value && 'other' in value
const textOf = (value) => isPlural(value) ? value.other : value

const entries = Object.keys(english).slice(0, limit).map((key) => ({
  key,
  source: textOf(english[key]),
  candidate: textOf(chinese[key]),
}))

function placeholders(text) {
  return [...new Set([...text.matchAll(/\{[A-Za-z0-9_]+\}/g)].map((match) => match[0]))].sort().join('|')
}

function normalize(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(text) {
  const value = normalize(text)
  if (value.length < 2) return new Set(value ? [value] : [])
  const result = new Set()
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2))
  return result
}

/** Dice coefficient over character bigrams; tolerant of word-order changes. */
function similarity(left, right) {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

const GLOSSARY = 'harness, worktree, MCP, skill, plugin, token, Git, GooeyPi, Pi, OMP, Prime Agent, API, URL, diff, commit'

async function translate(text, attempt = 0) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: `Translate this desktop-app UI string to Simplified Chinese. Keep these product and technical terms in English: ${GLOSSARY}. Output only the translation: ${text}`,
        }],
        temperature: 0,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') throw new Error('empty response')
    return content.trim()
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      return translate(text, attempt + 1)
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

let cursor = 0
let finished = 0
const results = []

async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor]
    cursor += 1
    const machine = await translate(entry.source)
    finished += 1
    if (finished % 100 === 0) console.error(`  ${finished}/${entries.length}`)
    if (typeof machine !== 'string') {
      results.push({ ...entry, machine: '', similarity: 0, flags: ['request-failed'], error: machine.error })
      continue
    }
    const flags = []
    const score = similarity(entry.candidate, machine)
    // Single-word labels are a deliberate product-terminology choice
    // ("Scheduled" → 定时任务, "Harness" → 运行环境), so a different machine
    // wording is informational rather than a defect.
    const shortLabel = !entry.source.includes(' ') && entry.source.length <= 16
    if (score < 0.45) {
      // Only full sentences carry enough signal for a similarity verdict; short
      // labels legitimately diverge through synonyms and product terminology.
      if (entry.source.length >= 60) flags.push('low-similarity')
      else flags.push(shortLabel ? 'wording-choice' : 'wording-diff')
    }
    if (placeholders(entry.candidate) !== placeholders(entry.source)) flags.push('placeholder-drift')
    if (normalize(machine) === normalize(entry.source)) flags.push('machine-left-english')
    if (normalize(entry.candidate) === normalize(entry.source)) flags.push('candidate-left-english')
    results.push({ ...entry, machine, similarity: Number(score.toFixed(3)), flags })
  }
}

console.error(`Validating ${entries.length} entries with ${model} (concurrency ${concurrency})…`)
await Promise.all(Array.from({ length: concurrency }, () => worker()))

const flagged = results
  .filter((result) => result.flags.length > 0)
  .sort((left, right) => left.similarity - right.similarity)

const outputDirectory = resolve(root, 'release/i18n-review')
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, 'report.json'), JSON.stringify({ model, endpoint, total: results.length, flagged: flagged.length, results }, null, 2))

const lines = [
  '# 简中翻译质检报告',
  '',
  `- 模型：${model}`,
  `- 条目：${results.length}`,
  `- 标记：${flagged.length}`,
  '',
  '| 相似度 | key | 英文 | 现有中文 | 模型重译 | 标记 |',
  '|---|---|---|---|---|---|',
  ...flagged.map((result) => `| ${result.similarity} | \`${result.key}\` | ${result.source.replaceAll('|', '\\|')} | ${result.candidate.replaceAll('|', '\\|')} | ${result.machine.replaceAll('|', '\\|')} | ${result.flags.join(', ')} |`),
]
await writeFile(resolve(outputDirectory, 'report.md'), lines.join('\n'))

console.log(`\nChecked ${results.length} entries; ${flagged.length} flagged.`)
console.log(`Report: ${resolve(outputDirectory, 'report.md')}`)
for (const result of flagged.slice(0, 25)) {
  console.log(`\n[${result.similarity}] ${result.key} — ${result.flags.join(', ')}`)
  console.log(`  EN: ${result.source}`)
  console.log(`  ZH: ${result.candidate}`)
  console.log(`  MT: ${result.machine}`)
}
if (flagged.length > 25) console.log(`\n… ${flagged.length - 25} more in the report.`)
