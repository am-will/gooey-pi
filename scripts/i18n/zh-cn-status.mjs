#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function loadCatalog(relativePath, exportName) {
  const module = await import(pathToFileURL(resolve(root, relativePath)).href)
  return module[exportName]
}

const english = await loadCatalog('src/lib/locales/english.ts', 'englishCatalog')
const japanese = await loadCatalog('src/lib/locales/japanese.ts', 'japaneseCatalog')
const chinese = await loadCatalog('src/lib/locales/simplified-chinese.ts', 'simplifiedChineseCatalog')

const enKeys = Object.keys(english)
const jaKeys = Object.keys(japanese)
const zhKeys = Object.keys(chinese)

const missing = enKeys.filter((key) => !(key in chinese))
const extra = zhKeys.filter((key) => !(key in english))
const jaMissing = enKeys.filter((key) => !(key in japanese))

const isPlural = (value) => typeof value === 'object' && value !== null && 'one' in value && 'other' in value
const messageTexts = (value) => (isPlural(value) ? [value.one, value.other] : [value])

const blank = zhKeys.filter((key) => messageTexts(chinese[key]).some((text) => text.trim() === ''))
const identical = zhKeys.filter(
  (key) => typeof english[key] === 'string' && english[key] === chinese[key],
)

function placeholders(value) {
  const found = new Set()
  for (const text of messageTexts(value)) {
    for (const match of text.matchAll(/\{[A-Za-z0-9_]+\}/g)) found.add(match[0])
  }
  return [...found].sort()
}

const placeholderMismatch = zhKeys
  .filter((key) => key in english)
  .map((key) => ({ key, en: placeholders(english[key]), zh: placeholders(chinese[key]) }))
  .filter(({ en, zh }) => en.join('|') !== zh.join('|'))

const pluralMismatch = zhKeys.filter(
  (key) => key in english && isPlural(english[key]) !== isPlural(chinese[key]),
)

function asciiRatio(value) {
  const text = messageTexts(value).join('')
  const visible = [...text].filter((character) => !/\s/.test(character))
  if (visible.length === 0) return 0
  return visible.filter((character) => /[A-Za-z]/.test(character)).length / visible.length
}

const suspicious = zhKeys
  .filter((key) => key in english && asciiRatio(chinese[key]) > 0.6)
  .map((key) => ({ key, text: messageTexts(chinese[key])[0] }))

const percent = enKeys.length === 0 ? 0 : (zhKeys.length / enKeys.length) * 100

console.log('Catalog status')
console.log(`  English keys:            ${enKeys.length}`)
console.log(`  Japanese keys:           ${jaKeys.length} (missing ${jaMissing.length})`)
console.log(`  Simplified Chinese keys: ${zhKeys.length} (${percent.toFixed(1)}% of English)`)
console.log('')
console.log(`  Missing from zh-CN:      ${missing.length}`)
console.log(`  Extra keys in zh-CN:     ${extra.length}`)
console.log(`  Blank values:            ${blank.length}`)
console.log(`  Identical to English:    ${identical.length}`)
console.log(`  Placeholder mismatches:  ${placeholderMismatch.length}`)
console.log(`  Plural-shape mismatches: ${pluralMismatch.length}`)
console.log(`  Mostly-ASCII values:     ${suspicious.length}`)

if (missing.length > 0) {
  console.log('\nMissing keys (first 40):')
  for (const key of missing.slice(0, 40)) console.log(`  - ${key}`)
}

if (extra.length > 0) {
  console.log('\nExtra keys:')
  for (const key of extra) console.log(`  - ${key}`)
}

if (placeholderMismatch.length > 0) {
  console.log('\nPlaceholder mismatches:')
  for (const { key, en, zh } of placeholderMismatch) {
    console.log(`  - ${key}: en=[${en.join(', ')}] zh=[${zh.join(', ')}]`)
  }
}

if (pluralMismatch.length > 0) {
  console.log('\nPlural-shape mismatches:')
  for (const key of pluralMismatch) {
    console.log(`  - ${key}: en=${isPlural(english[key]) ? 'plural' : 'string'} zh=${isPlural(chinese[key]) ? 'plural' : 'string'}`)
  }
}

if (suspicious.length > 0) {
  console.log('\nValues that still look English (first 40):')
  for (const { key, text } of suspicious.slice(0, 40)) console.log(`  - ${key}: ${text}`)
}

if (process.argv.includes('--strict')) {
  const failures = missing.length + extra.length + blank.length + placeholderMismatch.length + pluralMismatch.length
  if (failures > 0) process.exitCode = 1
}
