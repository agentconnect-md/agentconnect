import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@formatjs/icu-messageformat-parser'
import { checkI18n, flatten, pseudoMessage } from './check-i18n.mjs'

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
})
