import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCALES } from '../packages/web/src/i18n/config.ts'
import { flatten } from './check-i18n.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const messagesDir = resolve(root, 'packages/web/messages')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function orderedLike(source, flat, prefix = '') {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const path = prefix ? prefix + '.' + key : key
      return [key, typeof value === 'string' ? flat[path] : orderedLike(value, flat, path)]
    })
  )
}

const locale = process.argv[2]
if (!locale || !Object.hasOwn(LOCALES, locale) || LOCALES[locale].status === 'source') {
  console.error('Usage: node scripts/i18n-draft.mjs <non-source-locale> [--apply [draft.json|-]]')
  process.exit(1)
}

const source = await readJson(resolve(messagesDir, 'en.json'))
const targetPath = resolve(messagesDir, locale + '.json')
const target = await readJson(targetPath).catch(() => ({}))
const sourceFlat = flatten(source)
const targetFlat = flatten(target)
const missing = Object.fromEntries(Object.entries(sourceFlat).filter(([key]) => targetFlat[key] === undefined))
const applyIndex = process.argv.indexOf('--apply')

if (applyIndex === -1) {
  process.stdout.write(JSON.stringify(missing, null, 2) + '\n')
} else {
  const inputPath = process.argv[applyIndex + 1]
  const input =
    inputPath && inputPath !== '-' ? await readFile(resolve(process.cwd(), inputPath), 'utf8') : await readStdin()
  const draft = flatten(JSON.parse(input))
  const merged = { ...targetFlat }
  for (const key of Object.keys(sourceFlat)) {
    if (draft[key] !== undefined) merged[key] = draft[key]
  }
  const stillMissing = Object.keys(sourceFlat).filter((key) => merged[key] === undefined)
  if (stillMissing.length) throw new Error('Draft still misses: ' + stillMissing.join(', '))
  await writeFile(targetPath, JSON.stringify(orderedLike(source, merged), null, 2) + '\n')
  console.log('Updated ' + locale + ' in English key order')
}
