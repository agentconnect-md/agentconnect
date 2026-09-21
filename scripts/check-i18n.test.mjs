import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from '@formatjs/icu-messageformat-parser'
import { checkI18n, flatten, pseudoMessage } from './check-i18n.mjs'

/** A throwaway catalog pair, so the checker's verdicts can be asserted directly. */
async function catalogDir(english, translated) {
  const dir = await mkdtemp(join(tmpdir(), 'check-i18n-'))
  await writeFile(join(dir, 'en.json'), JSON.stringify(english))
  await writeFile(join(dir, 'zh-CN.json'), JSON.stringify(translated))
  return dir
}

test('flattens nested messages', () => {
  assert.deepEqual(flatten({ Common: { save: 'Save' } }), { 'Common.save': 'Save' })
})

test('pseudo locale expands visible text without changing ICU placeholders', () => {
  const pseudo = pseudoMessage('{count, plural, one {One apple} other {# apples}} for {name}')
  assert.match(pseudo, /\{name\}/)
  assert.match(pseudo, /Ønë ápplë/)
  assert.doesNotThrow(() => parse(pseudo))
})

test('checked-in locales are valid and complete', async () => {
  const result = await checkI18n()
  assert.deepEqual(result.failures, [])
  // Duplicate English values are reported as warnings and are benign; anything
  // else — a missing key in particular — must not appear for the shipped pair.
  assert.deepEqual(
    result.warnings.filter((warning) => !warning.startsWith('Duplicate English value:')),
    []
  )
})

test('a renamed rich-text tag fails, because t.rich looks the name up', async () => {
  const dir = await catalogDir(
    { A: { x: 'Remove <name></name> from <link>settings</link>.' } },
    { A: { x: '从 <lnk>设置</lnk> 中移除 <nm></nm>。' } }
  )
  const { failures } = await checkI18n({ dir })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /rich-text tag set differs from English/)
})

test('a dropped rich-text tag fails', async () => {
  const dir = await catalogDir({ A: { x: 'Remove <name></name>.' } }, { A: { x: '移除。' } })
  const { failures } = await checkI18n({ dir })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /rich-text tag set differs from English/)
})

test('a placeholder mismatch fails', async () => {
  const dir = await catalogDir({ A: { x: 'Hello {name}' } }, { A: { x: '你好 {npm}' } })
  const { failures } = await checkI18n({ dir })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /placeholder set differs from English/)
})

test('an extra key fails', async () => {
  const dir = await catalogDir({ A: { x: 'Save' } }, { A: { x: '保存', y: '多余' } })
  const { failures } = await checkI18n({ dir })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /extra keys: A\.y/)
})

test('a missing key warns for a draft locale instead of failing', async () => {
  const dir = await catalogDir({ A: { x: 'Save', y: 'Cancel' } }, { A: { x: '保存' } })
  const { failures, warnings } = await checkI18n({ dir })
  assert.deepEqual(failures, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing keys: A\.y/)
})
