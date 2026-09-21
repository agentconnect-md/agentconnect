import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, TYPE } from '@formatjs/icu-messageformat-parser'
import { LOCALES } from '../packages/web/src/i18n/config.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const messagesDir = resolve(root, 'packages/web/messages')

export function flatten(value, prefix = '', result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + '.' + key : key
    if (typeof child === 'string') result[path] = child
    else if (child && typeof child === 'object') flatten(child, path, result)
  }
  return result
}

function inspectAst(elements, placeholders = new Set(), plurals = [], tags = new Set()) {
  for (const element of elements) {
    if (
      element.type === TYPE.argument ||
      element.type === TYPE.number ||
      element.type === TYPE.date ||
      element.type === TYPE.time
    ) {
      placeholders.add(element.value)
    } else if (element.type === TYPE.select || element.type === TYPE.plural) {
      placeholders.add(element.value)
      if (element.type === TYPE.plural) {
        plurals.push({
          name: element.value,
          type: element.pluralType,
          categories: Object.keys(element.options).filter((key) => !key.startsWith('='))
        })
      }
      for (const option of Object.values(element.options)) inspectAst(option.value, placeholders, plurals, tags)
    } else if (element.type === TYPE.tag) {
      // A rich-text tag name is a runtime input to `t.rich`, so it belongs to the
      // same contract as a placeholder: a renamed one has no renderer.
      tags.add(element.value)
      inspectAst(element.children, placeholders, plurals, tags)
    }
  }
  return { placeholders, plurals, tags }
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item))
}

function literalRanges(elements, ranges = []) {
  for (const element of elements) {
    if (element.type === TYPE.literal && element.location) {
      ranges.push([element.location.start.offset, element.location.end.offset])
    } else if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options)) literalRanges(option.value, ranges)
    } else if (element.type === TYPE.tag) {
      literalRanges(element.children, ranges)
    }
  }
  return ranges
}

export function pseudoMessage(message) {
  const accents = {
    a: 'á',
    e: 'ë',
    i: 'ï',
    o: 'ø',
    u: 'ü',
    A: 'Â',
    E: 'Ë',
    I: 'Ï',
    O: 'Ø',
    U: 'Û'
  }
  const transform = new Set()
  for (const [start, end] of literalRanges(parse(message, { captureLocation: true }))) {
    for (let index = start; index < end; index += 1) transform.add(index)
  }

  let visibleLength = 0
  const output = message
    .split('')
    .map((character, index) => {
      if (!transform.has(index)) return character
      if (/[A-Za-z]/.test(character)) visibleLength += 1
      return accents[character] ?? character
    })
    .join('')

  return '[!! ' + output + ' '.repeat(Math.ceil(visibleLength * 0.3)) + '!!]'
}

export function pseudoMessages(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      typeof child === 'string' ? pseudoMessage(child) : pseudoMessages(child)
    ])
  )
}

async function readMessages(locale, dir = messagesDir) {
  return JSON.parse(await readFile(resolve(dir, locale + '.json'), 'utf8'))
}

export async function checkI18n({ dir = messagesDir } = {}) {
  const failures = []
  const warnings = []
  const english = flatten(await readMessages('en', dir))
  const parsedEnglish = new Map()

  for (const [key, message] of Object.entries(english)) {
    try {
      parsedEnglish.set(key, inspectAst(parse(message)))
    } catch (error) {
      failures.push('en:' + key + ': ' + error.message)
    }
  }

  const duplicates = new Map()
  for (const [key, message] of Object.entries(english)) {
    if (message.length < 3) continue
    const keys = duplicates.get(message) ?? []
    keys.push(key)
    duplicates.set(message, keys)
  }
  for (const keys of duplicates.values()) {
    if (keys.length > 1) warnings.push('Duplicate English value: ' + keys.join(', '))
  }

  for (const [locale, meta] of Object.entries(LOCALES)) {
    let translated
    try {
      translated = flatten(await readMessages(locale, dir))
    } catch (error) {
      failures.push(locale + ': unable to read messages: ' + error.message)
      continue
    }

    const missing = Object.keys(english).filter((key) => translated[key] === undefined)
    const extra = Object.keys(translated).filter((key) => english[key] === undefined)
    if (missing.length) {
      const message = locale + ': missing keys: ' + missing.join(', ')
      if (meta.status === 'draft') warnings.push(message)
      else failures.push(message)
    }
    if (extra.length) failures.push(locale + ': extra keys: ' + extra.join(', '))

    for (const [key, message] of Object.entries(translated)) {
      if (english[key] === undefined) continue
      try {
        const current = inspectAst(parse(message))
        const source = parsedEnglish.get(key)
        if (source && !sameSet(source.placeholders, current.placeholders)) {
          failures.push(locale + ':' + key + ': placeholder set differs from English')
        }
        if (source && !sameSet(source.tags, current.tags)) {
          failures.push(locale + ':' + key + ': rich-text tag set differs from English')
        }
        for (const sourcePlural of source?.plurals ?? []) {
          const plural = current.plurals.find(
            (candidate) => candidate.name === sourcePlural.name && candidate.type === sourcePlural.type
          )
          if (!plural) {
            failures.push(locale + ':' + key + ': missing plural for {' + sourcePlural.name + '}')
            continue
          }
          const required = new Intl.PluralRules(locale, { type: plural.type }).resolvedOptions().pluralCategories
          const missingCategories = required.filter((category) => !plural.categories.includes(category))
          if (missingCategories.length) {
            failures.push(locale + ':' + key + ': missing plural categories: ' + missingCategories.join(', '))
          }
        }
      } catch (error) {
        failures.push(locale + ':' + key + ': ' + error.message)
      }
    }
  }

  return { failures, warnings }
}

async function main() {
  const { failures, warnings } = await checkI18n()
  for (const warning of warnings) console.warn('i18n warning: ' + warning)
  for (const failure of failures) console.error('i18n error: ' + failure)

  const pseudoIndex = process.argv.indexOf('--pseudo')
  if (pseudoIndex !== -1) {
    const output = process.argv[pseudoIndex + 1]
    const pseudo = JSON.stringify(pseudoMessages(await readMessages('en')), null, 2) + '\n'
    if (output) await writeFile(resolve(process.cwd(), output), pseudo)
    else process.stdout.write(pseudo)
  }

  if (failures.length) process.exitCode = 1
  else console.log('i18n check passed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
