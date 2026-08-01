import { describe, it, expect } from 'vitest'
import { splitAtParagraphBoundary } from '../src/messages/stream-boundary.js'

describe('splitAtParagraphBoundary', () => {
  it('cuts just past the last top-level blank line', () => {
    expect(splitAtParagraphBoundary('one\n\ntwo\n\nthree in progre')).toEqual({
      ready: 'one\n\ntwo\n\n',
      tail: 'three in progre'
    })
  })

  it('holds the whole buffer while no paragraph break has arrived', () => {
    expect(splitAtParagraphBoundary('a single streaming senten')).toEqual({
      ready: '',
      tail: 'a single streaming senten'
    })
  })

  it('does not cut on a single newline — a list or table must stay in one message', () => {
    expect(splitAtParagraphBoundary('- one\n- two\n- thr')).toEqual({ ready: '', tail: '- one\n- two\n- thr' })
  })

  it('ignores blank lines inside a fenced code block', () => {
    const text = 'intro\n\n```ts\nconst a = 1\n\nconst b = 2\n'
    expect(splitAtParagraphBoundary(text)).toEqual({ ready: 'intro\n\n', tail: '```ts\nconst a = 1\n\nconst b = 2\n' })
  })

  it('resumes cutting after the fence closes', () => {
    const text = '```\ncode\n\nmore\n```\n\nafter the fence'
    expect(splitAtParagraphBoundary(text)).toEqual({ ready: '```\ncode\n\nmore\n```\n\n', tail: 'after the fence' })
  })

  it('treats a tilde fence the same and does not close it on a backtick run', () => {
    const text = '~~~\ncode\n\n```\n\nstill inside\n'
    expect(splitAtParagraphBoundary(text).ready).toBe('')
  })

  it('never cuts on the trailing line — it is still streaming', () => {
    expect(splitAtParagraphBoundary('para\n\n')).toEqual({ ready: 'para\n\n', tail: '' })
    expect(splitAtParagraphBoundary('para\n')).toEqual({ ready: '', tail: 'para\n' })
  })

  it('yields nothing when everything before the break is whitespace', () => {
    expect(splitAtParagraphBoundary('\n\nreal text')).toEqual({ ready: '', tail: '\n\nreal text' })
  })

  it('is lossless — ready + tail reconstructs the input', () => {
    for (const text of ['a\n\nb\n\nc', '```\nx\n\ny\n```\n\nz', 'no break at all', '\n\n\n', '']) {
      const { ready, tail } = splitAtParagraphBoundary(text)
      expect(ready + tail).toBe(text)
    }
  })
})
