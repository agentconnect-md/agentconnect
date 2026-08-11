// Unified-diff TEXT → `LineDiffRow[]`, so the viewer's Diff mode reuses the table `LineDiff` already draws instead of carrying a second renderer (§4). git computed the diff; this file only reads it.
// Nothing here throws. The text comes from a repository the console does not control and has already been cut to the wire's frame cap, so a header this parser does not know, a `@@` line it cannot read, and a body that stops mid-hunk are all shapes it has to render something honest for.

import type { LineDiffRow } from '@/components/console/LineDiff'

/** Row ceiling for one parsed diff — the same bound `diffLines` puts on its own table (`MAX_DETAILED_DIFF_LINES`), for the same reason: the number of DOM rows. The wire caps a diff near 252 KiB, which is ~100,000 rows of one-character lines, and nobody reads those in a side pane. */
export const MAX_DIFF_ROWS = 2_000

/** Everything one diff text says, beyond the rows themselves. */
export interface ParsedDiff {
  /** Ready for `LineDiffTable`. Empty when the diff has no hunks at all — a pure rename, a mode change, an empty new file, a binary change, or empty input. */
  rows: LineDiffRow[]
  /** `+` / `−` line counts of THIS diff, i.e. of the scope that was read. Deliberately not comparable with `WorkspaceGitFile.additions`, which counts both sides of the index against HEAD. */
  additions: number
  deletions: number
  /** How many `@@` hunks were read. 0 on non-empty input means the change carries no text, or the input was not a diff. */
  hunks: number
  /** git reported a binary change for at least one file section, so there is no text for it. */
  binary: boolean
  /** Renames git reported, in file order. Present even when a rename carries no hunk. */
  renames: Array<{ from: string; to: string }>
  /** {@link MAX_DIFF_ROWS} was reached, so the rows stop before the diff does. */
  rowsTruncated: boolean
  /** `@@` lines this parser could not read. Their rows carry NO line numbers rather than invented ones. */
  malformedHunks: number
}

// `@@ -oldStart,oldCount +newStart,newCount @@ optional section heading`. A count is omitted for a one-line side, and `-0,0` is how git names an absent side (a new or deleted file). Combined diffs use more than two `@`, and their extra sign column is why this parser reports them malformed rather than guessing.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// Lines git writes ABOUT a file rather than in it. Only ever tested while no hunk is open, because `--- ` and `+++ ` are also how a deleted or added line beginning with `-- ` / `++ ` arrives.
const FILE_HEADER =
  /^(diff --git |diff --cc |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |copy from |copy to |rename from |rename to |--- |\+\+\+ |GIT binary patch$)/

/** Parse unified-diff text as git emits it. One path or many: a diff of a directory carries a `diff --git` section per file, and each one after the first gets a `meta` row naming it, so a reader can see the boundary. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const rows: LineDiffRow[] = []
  const renames: Array<{ from: string; to: string }> = []
  let additions = 0
  let deletions = 0
  let hunks = 0
  let malformedHunks = 0
  // True while the open hunk's header could not be read, so its body is passed through instead of classified.
  let guessing = false
  let binary = false
  let rowsTruncated = false
  // The open hunk's next line numbers, and how many lines of each side it still owes. `null` numbers mean its header was unreadable, so its rows get a blank gutter instead of a guess; the counts are what tell a `--- a/x` header apart from a deleted line reading `-- a/x`.
  let open = false
  let oldLine: number | null = null
  let newLine: number | null = null
  let oldOwed = 0
  let newOwed = 0
  let sectionStarted = false
  let renameFrom: string | null = null

  const push = (row: LineDiffRow): boolean => {
    if (rows.length >= MAX_DIFF_ROWS) {
      rowsTruncated = true
      return false
    }
    rows.push(row)
    return true
  }

  // One trailing terminator is dropped: git's last line is terminated, and splitting on it would invent an empty final line.
  const lines = text.replace(/\r?\n$/, '').split('\n')
  for (const raw of lines) {
    if (rowsTruncated) break
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    const hunk = HUNK.exec(line)
    if (hunk) {
      hunks += 1
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      oldOwed = hunk[2] === undefined ? 1 : Number(hunk[2])
      newOwed = hunk[4] === undefined ? 1 : Number(hunk[4])
      open = oldOwed > 0 || newOwed > 0
      guessing = false
      if (!push({ kind: 'hunk', text: line })) break
      continue
    }
    // A `@@` line that is not a readable header. Its numbers are unknown, so the rows that follow carry none; the row itself is kept because its section heading is often the only name a reader has for what comes next, and the body stays readable.
    if (line.startsWith('@@')) {
      malformedHunks += 1
      open = true
      // The sign column cannot be trusted under this header. A combined diff (`@@@`, which a conflicted file produces) carries one column PER PARENT, so ` +MAIN` is a real addition from parent 1 and reading `charAt(0)` would draw it as unchanged context. Verbatim rows say "here is what git wrote" instead of asserting a side.
      guessing = true
      oldLine = null
      newLine = null
      oldOwed = Number.POSITIVE_INFINITY
      newOwed = Number.POSITIVE_INFINITY
      if (!push({ kind: 'hunk', text: line })) break
      continue
    }

    // git's no-newline marker belongs to the row before it and is not counted by the hunk header, so it arrives after the hunk's last owed line — outside the open state, and handled before it.
    if (line.startsWith('\\')) {
      const previous = rows.at(-1)
      const side = previous?.kind === 'delete' ? 'old' : previous?.kind === 'add' ? 'new' : 'both'
      if (!push({ kind: 'meta', text: 'No newline at end of file', eofSide: side })) break
      continue
    }

    const marker = line.charAt(0)
    const contentMarker = marker === ' ' || marker === '+' || marker === '-' || line === ''
    // A hunk that owes lines but whose next line is not a content line ended early (a truncated diff, or a producer that omits the empty context line): close it and read this line as a header.
    if (open && !contentMarker) open = false

    if (open && guessing) {
      // Neither counted nor sided: the header that opened this hunk was unreadable.
      if (!push({ kind: 'meta', text: line })) break
      continue
    }

    if (open) {
      if (marker === '+') {
        additions += 1
        newOwed -= 1
        if (!push({ kind: 'add', text: line.slice(1), ...(newLine === null ? {} : { newLine: newLine++ }) })) break
      } else if (marker === '-') {
        deletions += 1
        oldOwed -= 1
        if (!push({ kind: 'delete', text: line.slice(1), ...(oldLine === null ? {} : { oldLine: oldLine++ }) })) break
      } else {
        // A context line, including the bare empty line some producers write in place of a lone space.
        oldOwed -= 1
        newOwed -= 1
        if (
          !push({
            kind: 'context',
            text: marker === ' ' ? line.slice(1) : '',
            ...(oldLine === null ? {} : { oldLine: oldLine++ }),
            ...(newLine === null ? {} : { newLine: newLine++ })
          })
        ) {
          break
        }
      }
      if (oldOwed <= 0 && newOwed <= 0) open = false
      continue
    }

    if (FILE_HEADER.test(line)) {
      if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
        // The first section is not announced — the viewer's own header already names the path that was asked for. A second one is, because otherwise two files' hunks run together.
        if (sectionStarted && !push({ kind: 'meta', text: diffHeaderPath(line) })) break
        sectionStarted = true
        renameFrom = null
      } else if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ') && renameFrom !== null) {
        renames.push({ from: renameFrom, to: line.slice('rename to '.length) })
        if (!push({ kind: 'meta', text: `Renamed from ${renameFrom}` })) break
        renameFrom = null
      } else if (line === 'GIT binary patch') {
        binary = true
        if (!push({ kind: 'meta', text: 'Binary file — no text to show' })) break
      }
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('Files ')) {
      binary = true
      if (!push({ kind: 'meta', text: 'Binary file — no text to show' })) break
      continue
    }
    // Not a diff line and not a header this parser knows. Shown rather than dropped — whatever the daemon returned is what a reader should be able to see — except blank filler outside a hunk, which says nothing.
    if (line.trim() !== '' && !push({ kind: 'meta', text: line })) break
  }

  if (rowsTruncated) {
    rows.push({ kind: 'meta', text: `Diff truncated at ${MAX_DIFF_ROWS.toLocaleString('en-US')} lines.` })
  }
  return { rows, additions, deletions, hunks, binary, renames, rowsTruncated, malformedHunks }
}

// The path a `diff --git a/x b/y` line is about: the second half, which is the name AFTER a rename. A path that itself contains ' b/' cannot be split unambiguously, so the whole header is kept rather than a wrong half of it.
function diffHeaderPath(line: string): string {
  const rest = line.replace(/^diff --(git|cc) /, '')
  const at = rest.lastIndexOf(' b/')
  return at > 0 ? rest.slice(at + 3) : rest
}
