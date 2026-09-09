import { expect, it, vi } from 'vitest'
import { readCompleteMemoryEntry } from './memory-entry-content'
const entry = {
  ref: 'opaque-ref',
  label: 'Topic',
  revision: 'r1',
  byteSize: 6,
  format: 'markdown' as const,
  origin: 'active' as const,
  editable: true
}
it('loads every slice before returning an editable document', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ entry, text: 'head', complete: false, nextContentCursor: 'next' })
    .mockResolvedValueOnce({ entry, text: 'tail', complete: true })
  expect(await readCompleteMemoryEntry(read, 100)).toMatchObject({ text: 'headtail', complete: true })
  expect(read.mock.calls).toEqual([[undefined], ['next']])
})
it.each(['missing', 'loop', 'changed', 'too large'] as const)(
  'refuses %s content instead of exposing a partial editor',
  async (reason) => {
    const read = vi.fn().mockResolvedValue({ entry, text: 'head', complete: false, nextContentCursor: 'next' })
    if (reason === 'missing') read.mockResolvedValueOnce({ entry, text: 'head', complete: false })
    if (reason === 'changed')
      read.mockResolvedValueOnce({
        entry: { ...entry, revision: 'old' },
        text: 'head',
        complete: false,
        nextContentCursor: 'next'
      })
    await expect(readCompleteMemoryEntry(read, reason === 'too large' ? 1 : 100)).rejects.toThrow()
  }
)
