import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv } from './parse-csv.mjs'

test('uses the first row as headers', () => {
  assert.deepEqual(parseCsv('name,score\nAri,12\nBo,9'), [
    { name: 'Ari', score: '12' },
    { name: 'Bo', score: '9' }
  ])
})

test('returns arrays without headers', () => {
  assert.deepEqual(parseCsv('a,b\n1,2', { headers: false }), [
    ['a', 'b'],
    ['1', '2']
  ])
  assert.deepEqual(parseCsv(' ', { headers: false }), [[' ']])
})

test('handles quoted commas, escaped quotes, and multiline fields', () => {
  assert.deepEqual(parseCsv('name,note\r\n"A, B","Said ""hello""\r\nthen left"'), [
    { name: 'A, B', note: 'Said "hello"\nthen left' }
  ])
})

test('reports malformed rows and quote syntax with line numbers', () => {
  assert.throws(() => parseCsv('a,b\n1'), /Line 2: expected 2 columns, found 1/)
  assert.throws(() => parseCsv('a\n"unfinished'), /Line 2: quoted field is not closed/)
  assert.throws(() => parseCsv('a\n"ok"oops'), /Line 2: unexpected character after closing quote/)
  assert.throws(() => parseCsv('a\nb"ad'), /Line 2: unexpected quote/)
  assert.throws(() => parseCsv('a,a\n1,2'), /duplicate header/)
})

test('handles BOM, empty values, and a trailing newline', () => {
  assert.deepEqual(parseCsv('\uFEFFname,value\nA,\n'), [{ name: 'A', value: '' }])
  assert.deepEqual(parseCsv(''), [])
})

test('skips blank lines but preserves quoted empty fields and source line numbers', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n3,4\n\n'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' }
  ])
  assert.deepEqual(parseCsv('a\n\n""\n'), [{ a: '' }])
  assert.deepEqual(parseCsv('a\n\n1', { headers: false }), [['a'], ['1']])
  assert.throws(() => parseCsv('a,b\n1,2\n\n3'), /Line 4: expected 2 columns, found 1/)
})
