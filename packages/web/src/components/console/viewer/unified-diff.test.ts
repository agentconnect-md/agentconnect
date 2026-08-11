// The unified-diff parser: the line-number arithmetic every diff row's gutter depends on, and the shapes a repository can hand it that must degrade into data rather than throw.
// Every multi-line fixture here is verbatim `git diff` output from a scratch repository (two hunks with a section heading, a rename, no-newline-at-EOF, a new file, a deletion, a binary change), so the expectations cannot drift from what git actually emits.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LineDiffTable, type LineDiffRow } from '@/components/console/LineDiff'
import { MAX_DIFF_ROWS, parseUnifiedDiff } from './unified-diff'

// Each side of a hunk, rebuilt from the rows it produced — the oracle for the whole parse: a row that landed on the wrong side, or was dropped, changes one of these strings.
function rebuild(rows: LineDiffRow[], side: 'old' | 'new'): string[] {
  const kind = side === 'old' ? 'delete' : 'add'
  return rows.filter((row) => row.kind === 'context' || row.kind === kind).map((row) => row.text)
}

const TWO_HUNKS = `diff --git a/b.txt b/b.txt
index e031777..242c047 100644
--- a/b.txt
+++ b/b.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
 three
 four
 five
@@ -7,6 +7,6 @@ six
 seven
 eight
 nine
-ten
+TEN
 eleven
 twelve
`

const NO_EOL = `diff --git a/noeol.txt b/noeol.txt
index c1b0730..e25f181 100644
--- a/noeol.txt
+++ b/noeol.txt
@@ -1 +1 @@
-x
\\ No newline at end of file
+y
\\ No newline at end of file
`

const RENAME = `diff --git a/a.txt b/b.txt
similarity index 87%
rename from a.txt
rename to b.txt
index e031777..242c047 100644
--- a/a.txt
+++ b/b.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`

describe('parseUnifiedDiff — line-number arithmetic', () => {
  it('numbers both sides from the hunk header and carries the offset across hunks', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS)

    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,5 +1,5 @@' },
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'delete', text: 'two', oldLine: 2 },
      { kind: 'add', text: 'TWO', newLine: 2 },
      { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
      { kind: 'context', text: 'four', oldLine: 4, newLine: 4 },
      { kind: 'context', text: 'five', oldLine: 5, newLine: 5 },
      // The second header restarts BOTH sides at 7 — a parser that kept counting from the first hunk would number these 6, 7, 8…
      { kind: 'hunk', text: '@@ -7,6 +7,6 @@ six' },
      { kind: 'context', text: 'seven', oldLine: 7, newLine: 7 },
      { kind: 'context', text: 'eight', oldLine: 8, newLine: 8 },
      { kind: 'context', text: 'nine', oldLine: 9, newLine: 9 },
      { kind: 'delete', text: 'ten', oldLine: 10 },
      { kind: 'add', text: 'TEN', newLine: 10 },
      { kind: 'context', text: 'eleven', oldLine: 11, newLine: 11 },
      { kind: 'context', text: 'twelve', oldLine: 12, newLine: 12 }
    ])
    expect({ additions: parsed.additions, deletions: parsed.deletions, hunks: parsed.hunks }).toEqual({
      additions: 2,
      deletions: 2,
      hunks: 2
    })
    // Both sides of both hunks, in order: 'two' only on the old side, 'TWO' only on the new.
    expect(rebuild(parsed.rows, 'old')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve'
    ])
    expect(rebuild(parsed.rows, 'new')).toEqual([
      'one',
      'TWO',
      'three',
      'four',
      'five',
      'seven',
      'eight',
      'nine',
      'TEN',
      'eleven',
      'twelve'
    ])
  })

  it('reads a one-line side written with no count, and an empty side written as 0', () => {
    // `@@ -1 +1 @@` — git omits a count of 1 on either side.
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n').rows).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'delete', text: 'a', oldLine: 1 },
      { kind: 'add', text: 'b', newLine: 1 }
    ])
    // A new file: the old side starts at 0 and owes nothing, so no row may claim an old line.
    const added = parseUnifiedDiff(
      'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..45b983b\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hi\n+there\n'
    )
    expect(added.rows).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', text: 'hi', newLine: 1 },
      { kind: 'add', text: 'there', newLine: 2 }
    ])
    expect(added.rows.some((row) => row.oldLine !== undefined)).toBe(false)
    // A deletion: symmetrically, no row may claim a new line.
    const removed = parseUnifiedDiff('@@ -1,2 +0,0 @@\n-hi\n-there\n')
    expect(removed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +0,0 @@' },
      { kind: 'delete', text: 'hi', oldLine: 1 },
      { kind: 'delete', text: 'there', oldLine: 2 }
    ])
    expect(removed.deletions).toBe(2)
  })

  it('keeps an empty context line on both sides, whether git wrote a space or nothing at all', () => {
    const spaced = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n')
    expect(spaced.rows[2]).toEqual({ kind: 'context', text: '', oldLine: 2, newLine: 2 })
    // Some producers strip the lone trailing space; the line still consumes one number on each side, so everything after it must keep the same numbers.
    const bare = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n')
    expect(bare.rows[2]).toEqual({ kind: 'context', text: '', oldLine: 2, newLine: 2 })
    expect(bare.rows[3]).toEqual({ kind: 'delete', text: 'b', oldLine: 3 })
  })

  it('numbers a line whose own text begins with a diff marker from its marker column, not its content', () => {
    // The content is `-- legacy` and `++i`; a parser reading the second character would mis-sign both.
    const parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n--- legacy\n+++i\n')
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'delete', text: '-- legacy', oldLine: 1 },
      { kind: 'add', text: '++i', newLine: 1 }
    ])
  })
})

describe('parseUnifiedDiff — what git says about a file', () => {
  it('marks no-newline-at-EOF on the side the marker follows', () => {
    const parsed = parseUnifiedDiff(NO_EOL)
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'delete', text: 'x', oldLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'old' },
      { kind: 'add', text: 'y', newLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'new' }
    ])
    // The marker is not a diff line: it must not count towards either total.
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 1, deletions: 1 })
  })

  it('attributes a no-newline marker after a context line to both sides', () => {
    const parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file\n')
    expect(parsed.rows.at(-1)).toEqual({ kind: 'meta', text: 'No newline at end of file', eofSide: 'both' })
  })

  it('reports a rename and still reads the hunk that follows it', () => {
    const parsed = parseUnifiedDiff(RENAME)
    expect(parsed.renames).toEqual([{ from: 'a.txt', to: 'b.txt' }])
    expect(parsed.rows[0]).toEqual({ kind: 'meta', text: 'Renamed from a.txt' })
    // `--- a/a.txt` and `+++ b/b.txt` are headers, not a deletion and an addition of the two paths.
    expect(parsed.rows.slice(1)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'delete', text: 'two', oldLine: 2 },
      { kind: 'add', text: 'TWO', newLine: 2 },
      { kind: 'context', text: 'three', oldLine: 3, newLine: 3 }
    ])
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 1, deletions: 1 })
  })

  it('reads a pure rename, which git writes with no hunk at all', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/b.txt b/c.txt\nsimilarity index 100%\nrename from b.txt\nrename to c.txt\n'
    )
    expect(parsed.hunks).toBe(0)
    expect(parsed.renames).toEqual([{ from: 'b.txt', to: 'c.txt' }])
    expect(parsed.rows).toEqual([{ kind: 'meta', text: 'Renamed from b.txt' }])
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 0, deletions: 0 })
  })

  it('reads a binary change as data with no content rows', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/b.bin b/b.bin\nindex 6772730..8d0cd2a 100644\nBinary files a/b.bin and b/b.bin differ\n'
    )
    expect(parsed.binary).toBe(true)
    expect(parsed.hunks).toBe(0)
    expect(parsed.rows).toEqual([{ kind: 'meta', text: 'Binary file — no text to show' }])
  })

  it('reads an empty diff, a header-only diff and whitespace as nothing to show, not as an error', () => {
    for (const input of ['', '\n', '   \n']) {
      const parsed = parseUnifiedDiff(input)
      expect(parsed.rows).toEqual([])
      expect(parsed.hunks).toBe(0)
    }
    // A mode change carries no text either.
    const mode = parseUnifiedDiff('diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n')
    expect(mode.rows).toEqual([])
    expect(mode.hunks).toBe(0)
  })

  it('separates the files of a directory diff and keeps each one’s own numbering', () => {
    const parsed = parseUnifiedDiff(`${TWO_HUNKS}${NO_EOL}`)
    const boundary = parsed.rows.findIndex((row) => row.kind === 'meta' && row.text === 'noeol.txt')
    // The first section is unannounced (the viewer's header names it); every later one is.
    expect(boundary).toBeGreaterThan(0)
    expect(parsed.rows[boundary + 1]).toEqual({ kind: 'hunk', text: '@@ -1 +1 @@' })
    expect(parsed.rows[boundary + 2]).toEqual({ kind: 'delete', text: 'x', oldLine: 1 })
    expect(parsed.hunks).toBe(3)
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 3, deletions: 3 })
  })

  it('closes a hunk on its own line counts, so the next file’s --- header is not read as a deleted line', () => {
    // Two files with no `diff --git` between them: only the header's counts say where the first hunk ends — and its last line is CONTEXT, so a context line has to consume one count on each side too. Otherwise `--- a/y` becomes a delete row reading `-- a/y`.
    const parsed = parseUnifiedDiff(
      '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+A\n tail\n--- a/y\n+++ b/y\n@@ -4 +4 @@\n-b\n+B\n'
    )
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'delete', text: 'a', oldLine: 1 },
      { kind: 'add', text: 'A', newLine: 1 },
      { kind: 'context', text: 'tail', oldLine: 2, newLine: 2 },
      { kind: 'hunk', text: '@@ -4 +4 @@' },
      { kind: 'delete', text: 'b', oldLine: 4 },
      { kind: 'add', text: 'B', newLine: 4 }
    ])
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 2, deletions: 2 })
  })
})

describe('parseUnifiedDiff — degrading', () => {
  it('renders a malformed hunk header verbatim rather than assigning sides it cannot know', () => {
    // This case used to assert the opposite — body rows classified from charAt(0) with only the
    // gutter blanked. That premise was wrong: the header is unreadable precisely when the sign
    // column may not be one column, and a combined diff (`@@@`) then draws a real addition as an
    // unchanged line. Passing the body through is the honest answer, so the assertion moved with it.
    const parsed = parseUnifiedDiff('@@ -x,y +z @@ broken\n a\n-b\n+B\n')
    expect(parsed.malformedHunks).toBe(1)
    expect(parsed.hunks).toBe(0)
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -x,y +z @@ broken' },
      { kind: 'meta', text: ' a' },
      { kind: 'meta', text: '-b' },
      { kind: 'meta', text: '+B' }
    ])
    // Nothing is counted from rows whose side is unknown, and no gutter number is invented.
    expect({ additions: parsed.additions, deletions: parsed.deletions }).toEqual({ additions: 0, deletions: 0 })
    expect(parsed.rows.some((row) => row.oldLine !== undefined || row.newLine !== undefined)).toBe(false)
  })

  it('recovers a readable hunk that follows a malformed one', () => {
    const parsed = parseUnifiedDiff('@@ bogus @@\n-a\n@@ -4,1 +4,1 @@\n-b\n+B\n')
    expect(parsed.malformedHunks).toBe(1)
    expect(parsed.hunks).toBe(1)
    expect(parsed.rows.slice(2)).toEqual([
      { kind: 'hunk', text: '@@ -4,1 +4,1 @@' },
      { kind: 'delete', text: 'b', oldLine: 4 },
      { kind: 'add', text: 'B', newLine: 4 }
    ])
  })

  it('shows a line that is neither diff content nor a header it knows', () => {
    const parsed = parseUnifiedDiff('fatal: not a git repository\n')
    expect(parsed.rows).toEqual([{ kind: 'meta', text: 'fatal: not a git repository' }])
    expect(parsed.hunks).toBe(0)
  })

  it('reads a hunk that stops mid-body, as a diff cut at the wire cap arrives', () => {
    // The header promises five old lines and the text ends after two, with the last one cut mid-line.
    const parsed = parseUnifiedDiff('@@ -1,5 +1,5 @@\n one\n-tw')
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -1,5 +1,5 @@' },
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'delete', text: 'tw', oldLine: 2 }
    ])
  })

  it('does not throw on any prefix of a real diff', () => {
    const whole = `${TWO_HUNKS}${RENAME}${NO_EOL}`
    for (let end = 0; end <= whole.length; end += 1) {
      expect(() => parseUnifiedDiff(whole.slice(0, end))).not.toThrow()
    }
  })

  it('bounds its rows, says so, and keeps the table it feeds bounded with them', () => {
    const hugeHunk = `@@ -1,${200_000} +1,${200_000} @@\n${'-a\n+b\n'.repeat(100_000)}`
    const parsed = parseUnifiedDiff(hugeHunk)

    expect(parsed.rowsTruncated).toBe(true)
    // The cap, plus the note that says the rows stop before the diff does.
    expect(parsed.rows).toHaveLength(MAX_DIFF_ROWS + 1)
    expect(parsed.rows.at(-1)).toEqual({ kind: 'meta', text: 'Diff truncated at 2,000 lines.' })
    const markup = renderToStaticMarkup(createElement(LineDiffTable, { rows: parsed.rows }))
    expect(markup.match(/<tr/g)).toHaveLength(MAX_DIFF_ROWS + 1)
  })
})

describe('LineDiffTable', () => {
  it('draws a hunk header as its own kind — the purple sunken row, not the meta row’s backslash', () => {
    const rows = parseUnifiedDiff(TWO_HUNKS).rows
    const markup = renderToStaticMarkup(createElement(LineDiffTable, { rows, label: 'Diff of b.txt' }))

    expect(markup).toContain('aria-label="Diff of b.txt"')
    expect(markup.match(/data-diff-kind="hunk"/g)).toHaveLength(2)
    expect(markup).toContain('text-(--purple-500)')
    // Every row kind the parser can emit is drawable: an unstyled kind would render an undefined class.
    expect(markup).not.toContain('undefined')
  })
})

describe('a hunk header that is not plain two-way', () => {
  // Real `git diff --cc` output for a conflicted file. The sign column has one slot PER
  // PARENT, so ` +MAIN` is a genuine addition from parent 1 — reading charAt(0) as a single
  // column draws it as an unchanged context line, which is confidently wrong rather than
  // merely unhelpful.
  const combined = [
    'diff --cc m.txt',
    'index 1111111,2222222..0000000',
    '--- a/m.txt',
    '+++ b/m.txt',
    '@@@ -1,2 -1,2 +1,4 @@@',
    '  common',
    ' +MAIN',
    '+ SIDE',
    '  tail'
  ].join('\n')

  it('passes the body through verbatim instead of asserting a side', () => {
    const parsed = parseUnifiedDiff(combined)
    expect(parsed.malformedHunks).toBe(1)
    const body = parsed.rows.filter((row) => row.kind !== 'hunk' && !row.text.startsWith('diff --cc'))
    // Nothing in the body claims to be an addition or a deletion, and no gutter number is invented.
    expect(body.some((row) => row.kind === 'add' || row.kind === 'delete' || row.kind === 'context')).toBe(false)
    expect(body.every((row) => row.oldLine === undefined && row.newLine === undefined)).toBe(true)
    // The raw text survives, including both sign columns, so a reader can still see what git wrote.
    expect(parsed.rows.map((row) => row.text)).toContain(' +MAIN')
  })

  it('counts nothing it could not read, so the header does not claim +4 −0', () => {
    const parsed = parseUnifiedDiff(combined)
    expect(parsed.additions).toBe(0)
    expect(parsed.deletions).toBe(0)
  })

  it('recovers on the next well-formed hunk rather than staying verbatim', () => {
    const mixed = [combined, '@@ -10,1 +10,2 @@', ' ctx', '+added'].join('\n')
    const parsed = parseUnifiedDiff(mixed)
    expect(parsed.additions).toBe(1)
    const added = parsed.rows.find((row) => row.kind === 'add')
    expect(added?.text).toBe('added')
    expect(added?.newLine).toBe(11)
  })
})
