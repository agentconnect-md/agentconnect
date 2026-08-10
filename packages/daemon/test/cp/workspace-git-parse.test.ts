import { describe, it, expect } from 'vitest'
import { MAX_WORKSPACE_COMMIT_AUTHOR, MAX_WORKSPACE_COMMIT_SUBJECT } from '@agentconnect.md/protocol'
import { capText, numstatByPath, parseLogZ, parseNumstatZ } from '../../src/cp/workspace-git-parse.js'

// Every fixture below is the byte-exact shape `git` writes; test/workspace-git-read.test.ts
// re-derives the same expectations from a real repository so these cannot drift.
const NUL = '\0'

describe('parseNumstatZ', () => {
  it('parses one ordinary row', () => {
    expect(parseNumstatZ(`12\t3\tsrc/a.ts${NUL}`)).toEqual([{ path: 'src/a.ts', additions: 12, deletions: 3 }])
  })

  it('reports a binary change as counts ABSENT, never zero', () => {
    const [entry] = parseNumstatZ(`-\t-\tlogo.png${NUL}`)
    expect(entry).toEqual({ path: 'logo.png' })
    expect(entry?.additions).toBeUndefined()
    expect(entry?.deletions).toBeUndefined()
  })

  it('parses a rename record (empty third field ⇒ the next two tokens are old/new)', () => {
    expect(parseNumstatZ(`0\t0\t${NUL}old/name.ts${NUL}new/name.ts${NUL}1\t0\tafter.ts${NUL}`)).toEqual([
      { path: 'new/name.ts', from: 'old/name.ts', additions: 0, deletions: 0 },
      { path: 'after.ts', additions: 1, deletions: 0 }
    ])
  })

  it('keeps paths containing a space, a quote, a tab or a newline intact', () => {
    // -z means git does no c-style quoting, so the path is whatever bytes it is.
    const rows = parseNumstatZ(`1\t0\tsp ace'q.txt${NUL}2\t1\ttab\there.txt${NUL}3\t0\tnew\nline.txt${NUL}`)
    expect(rows.map((r) => r.path)).toEqual(["sp ace'q.txt", 'tab\there.txt', 'new\nline.txt'])
    expect(rows[1]).toEqual({ path: 'tab\there.txt', additions: 2, deletions: 1 })
  })

  it('ignores a line that is not a numstat row rather than guessing', () => {
    expect(parseNumstatZ('https://github.com/acme/repo.git\n')).toEqual([])
    expect(parseNumstatZ('')).toEqual([])
  })

  it('drops a truncated rename record instead of inventing a path', () => {
    expect(parseNumstatZ(`1\t0\ta.ts${NUL}0\t0\t${NUL}only-old.ts${NUL}`)).toEqual([
      { path: 'a.ts', additions: 1, deletions: 0 }
    ])
  })

  it('numstatByPath keys the join on the path git status also reports', () => {
    const byPath = numstatByPath(parseNumstatZ(`0\t0\t${NUL}old.ts${NUL}new.ts${NUL}`))
    expect(byPath.get('new.ts')).toMatchObject({ from: 'old.ts' })
    expect(byPath.get('old.ts')).toBeUndefined()
  })
})

describe('parseLogZ', () => {
  const rec = (sha: string, short: string, author: string, date: string, subject: string) =>
    [sha, short, author, date, subject].join(NUL) + NUL

  it('parses commits newest-first out of the 5-field NUL stream', () => {
    const out =
      rec('a'.repeat(40), 'aaaaaaa', 'Ada Lovelace', '2026-07-02T07:00:00+00:00', 'Pin deploy image') +
      rec('b'.repeat(40), 'bbbbbbb', 'Grace Hopper', '2026-07-01T07:00:00+00:00', 'Add the dock')
    expect(parseLogZ(out)).toEqual([
      {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        author: 'Ada Lovelace',
        committedAt: '2026-07-02T07:00:00+00:00',
        subject: 'Pin deploy image'
      },
      {
        sha: 'b'.repeat(40),
        shortSha: 'bbbbbbb',
        author: 'Grace Hopper',
        committedAt: '2026-07-01T07:00:00+00:00',
        subject: 'Add the dock'
      }
    ])
  })

  it('keeps a subject that contains the field separator of a lesser format', () => {
    // The record boundary is the NUL field COUNT, so a tab, a \x1f or a colon in the
    // subject cannot shift the parse the way a printable separator would.
    const [c] = parseLogZ(rec('c'.repeat(40), 'ccccccc', 'A', '2026-07-02T07:00:00+00:00', 'fix: a\tbc'))
    expect(c?.subject).toBe('fix: a\tbc')
  })

  it('caps a repository-controlled subject and author at their wire maxima', () => {
    const [c] = parseLogZ(rec('d'.repeat(40), 'ddddddd', 'x'.repeat(500), '2026-07-02T07:00:00+00:00', 'y'.repeat(900)))
    expect(c?.subject).toHaveLength(MAX_WORKSPACE_COMMIT_SUBJECT)
    expect(c?.author).toHaveLength(MAX_WORKSPACE_COMMIT_AUTHOR)
  })

  it('drops a partial trailing record (the byte ceiling cut mid-commit)', () => {
    const out = rec('e'.repeat(40), 'eeeeeee', 'A', '2026-07-02T07:00:00+00:00', 'complete') + 'f'.repeat(40) + NUL
    expect(parseLogZ(out)).toHaveLength(1)
    expect(parseLogZ('')).toEqual([])
  })

  it('accepts an empty subject (a commit message of only a body)', () => {
    const [c] = parseLogZ(rec('a'.repeat(40), 'aaaaaaa', 'A', '2026-07-02T07:00:00+00:00', ''))
    expect(c?.subject).toBe('')
    expect(c?.sha).toBe('a'.repeat(40))
  })
})

describe('capText', () => {
  it('leaves text at or under the cap untouched', () => {
    expect(capText('abc', 3)).toBe('abc')
    expect(capText('', 3)).toBe('')
  })

  it('cuts text over the cap to exactly the cap', () => {
    expect(capText('abcd', 3)).toBe('abc')
  })
})
