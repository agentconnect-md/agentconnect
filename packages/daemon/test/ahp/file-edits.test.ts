import { expect, it } from 'vitest'
import { fileEditContent } from '../../src/ahp/file-edits.js'

const edit = { index: 0, created: true, added: 1, removed: 0, afterBytes: 1 }

it('names an edited file by a file URI a client can match, for POSIX, Windows and relative paths', () => {
  const uri = (path: string) => fileEditContent('ahp-session:/one', 'call', { ...edit, path }).after!.uri
  expect(uri('/work/src/a b.ts')).toBe('file:///work/src/a%20b.ts')
  expect(uri('D:\\a\\_temp\\work space\\notes.txt')).toBe('file:///D:/a/_temp/work%20space/notes.txt')
  expect(uri('c:/repo/notes.txt')).toBe('file:///c:/repo/notes.txt')
  expect(uri('docs/notes #1.txt')).toBe('file:///docs/notes%20%231.txt')
})
