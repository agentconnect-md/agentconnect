export type LineDiffKind = 'context' | 'add' | 'delete' | 'meta'

export interface LineDiffRow {
  kind: LineDiffKind
  text: string
  oldLine?: number
  newLine?: number
  eofSide?: 'old' | 'new'
}

function splitLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  if (value.endsWith('\n')) lines.pop()
  return lines
}

interface LineMatch {
  oldIndex: number
  newIndex: number
}

function prefixLcsLengths(
  oldLines: string[],
  oldStart: number,
  oldEnd: number,
  newLines: string[],
  newStart: number,
  newEnd: number
): Uint16Array {
  const width = newEnd - newStart
  let previous = new Uint16Array(width + 1)
  let current = new Uint16Array(width + 1)
  for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex += 1) {
    current[0] = 0
    for (let offset = 1; offset <= width; offset += 1) {
      current[offset] =
        oldLines[oldIndex] === newLines[newStart + offset - 1]
          ? previous[offset - 1]! + 1
          : Math.max(previous[offset]!, current[offset - 1]!)
    }
    ;[previous, current] = [current, previous]
  }
  return previous
}

function suffixLcsLengths(
  oldLines: string[],
  oldStart: number,
  oldEnd: number,
  newLines: string[],
  newStart: number,
  newEnd: number
): Uint16Array {
  const width = newEnd - newStart
  let previous = new Uint16Array(width + 1)
  let current = new Uint16Array(width + 1)
  for (let oldIndex = oldEnd - 1; oldIndex >= oldStart; oldIndex -= 1) {
    current[width] = 0
    for (let offset = width - 1; offset >= 0; offset -= 1) {
      current[offset] =
        oldLines[oldIndex] === newLines[newStart + offset]
          ? previous[offset + 1]! + 1
          : Math.max(previous[offset]!, current[offset + 1]!)
    }
    ;[previous, current] = [current, previous]
  }
  return previous
}

/** Hirschberg LCS: exact matches with linear working memory. */
function collectLcsMatches(
  oldLines: string[],
  oldStart: number,
  oldEnd: number,
  newLines: string[],
  newStart: number,
  newEnd: number,
  matches: LineMatch[]
): void {
  if (oldStart === oldEnd || newStart === newEnd) return
  if (oldEnd - oldStart === 1) {
    for (let newIndex = newStart; newIndex < newEnd; newIndex += 1) {
      if (oldLines[oldStart] === newLines[newIndex]) {
        matches.push({ oldIndex: oldStart, newIndex })
        return
      }
    }
    return
  }
  if (newEnd - newStart === 1) {
    for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex += 1) {
      if (oldLines[oldIndex] === newLines[newStart]) {
        matches.push({ oldIndex, newIndex: newStart })
        return
      }
    }
    return
  }

  const oldMiddle = oldStart + Math.floor((oldEnd - oldStart) / 2)
  let newSplit = newStart
  {
    const prefix = prefixLcsLengths(oldLines, oldStart, oldMiddle, newLines, newStart, newEnd)
    const suffix = suffixLcsLengths(oldLines, oldMiddle, oldEnd, newLines, newStart, newEnd)
    let best = -1
    for (let offset = 0; offset <= newEnd - newStart; offset += 1) {
      const score = prefix[offset]! + suffix[offset]!
      if (score > best) {
        best = score
        newSplit = newStart + offset
      }
    }
  }
  collectLcsMatches(oldLines, oldStart, oldMiddle, newLines, newStart, newSplit, matches)
  collectLcsMatches(oldLines, oldMiddle, oldEnd, newLines, newSplit, newEnd, matches)
}

function addEofMarkers(rows: LineDiffRow[], before: string, after: string, oldCount: number, newCount: number) {
  const oldMissingNewline = before.length > 0 && !before.endsWith('\n')
  const newMissingNewline = after.length > 0 && !after.endsWith('\n')

  // A terminal-newline-only change initially appears as one matched content
  // line. Turn that last context line into the same delete/add pair Git shows.
  if (oldMissingNewline !== newMissingNewline && oldCount > 0 && newCount > 0) {
    const lastContext = rows.findIndex(
      (row) => row.kind === 'context' && row.oldLine === oldCount && row.newLine === newCount
    )
    if (lastContext >= 0) {
      const row = rows[lastContext]!
      rows.splice(
        lastContext,
        1,
        { kind: 'delete', text: row.text, oldLine: row.oldLine },
        { kind: 'add', text: row.text, newLine: row.newLine }
      )
    }
  }

  const withMarkers: LineDiffRow[] = []
  for (const row of rows) {
    withMarkers.push(row)
    if (row.kind === 'delete' && row.oldLine === oldCount && oldMissingNewline) {
      withMarkers.push({ kind: 'meta', text: 'No newline at end of file', eofSide: 'old' })
    }
    if (row.kind === 'add' && row.newLine === newCount && newMissingNewline) {
      withMarkers.push({ kind: 'meta', text: 'No newline at end of file', eofSide: 'new' })
    }
  }
  return withMarkers
}

/**
 * Exact line diff for bounded text snapshots. Hirschberg keeps working memory
 * linear even when a valid 4 KB snapshot contains thousands of tiny lines.
 */
export function diffLines(before: string, after: string): LineDiffRow[] {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1
  }

  const matches: LineMatch[] = oldLines.slice(0, prefix).map((_text, index) => ({ oldIndex: index, newIndex: index }))
  collectLcsMatches(oldLines, prefix, oldLines.length - suffix, newLines, prefix, newLines.length - suffix, matches)
  for (let index = 0; index < suffix; index += 1) {
    matches.push({
      oldIndex: oldLines.length - suffix + index,
      newIndex: newLines.length - suffix + index
    })
  }

  const rows: LineDiffRow[] = []
  let oldIndex = 0
  let newIndex = 0
  for (const match of matches) {
    while (oldIndex < match.oldIndex) {
      rows.push({ kind: 'delete', text: oldLines[oldIndex]!, oldLine: oldIndex + 1 })
      oldIndex += 1
    }
    while (newIndex < match.newIndex) {
      rows.push({ kind: 'add', text: newLines[newIndex]!, newLine: newIndex + 1 })
      newIndex += 1
    }
    rows.push({
      kind: 'context',
      text: oldLines[match.oldIndex]!,
      oldLine: match.oldIndex + 1,
      newLine: match.newIndex + 1
    })
    oldIndex = match.oldIndex + 1
    newIndex = match.newIndex + 1
  }
  while (oldIndex < oldLines.length) {
    rows.push({ kind: 'delete', text: oldLines[oldIndex]!, oldLine: oldIndex + 1 })
    oldIndex += 1
  }
  while (newIndex < newLines.length) {
    rows.push({ kind: 'add', text: newLines[newIndex]!, newLine: newIndex + 1 })
    newIndex += 1
  }
  return addEofMarkers(rows, before, after, oldLines.length, newLines.length)
}

const ROW_STYLE: Record<LineDiffKind, string> = {
  context: 'bg-(--surface-card) text-(--text-secondary)',
  add: 'bg-(--status-online-soft) text-(--green-500)',
  delete: 'bg-(--status-error-soft) text-(--red-600)',
  meta: 'bg-(--surface-sunken) italic text-(--text-tertiary)'
}

const MARKER: Record<LineDiffKind, string> = {
  context: ' ',
  add: '+',
  delete: '−',
  meta: '\\'
}

export function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = diffLines(before, after)
  const changed = rows.some((row) => row.kind !== 'context')

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-(--border-subtle)">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[10.5px] font-semibold leading-normal text-(--text-secondary)">
        <span>Line changes</span>
        <span className="font-normal text-(--red-600)">− removed</span>
        <span className="font-normal text-(--green-500)">+ added</span>
      </div>
      {changed ? (
        <div className="max-h-80 overflow-auto">
          <table className="mono w-full min-w-max border-collapse text-[11px] leading-[1.55]" aria-label="Line changes">
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}:${row.eofSide ?? ''}:${index}`}
                  className={ROW_STYLE[row.kind]}
                  data-diff-kind={row.kind}
                >
                  <td className="w-9 select-none border-r border-(--border-subtle) px-2 py-px text-right text-(--text-tertiary)">
                    {row.oldLine ?? ''}
                  </td>
                  <td className="w-9 select-none border-r border-(--border-subtle) px-2 py-px text-right text-(--text-tertiary)">
                    {row.newLine ?? ''}
                  </td>
                  <td className="w-7 select-none px-2 py-px text-center font-semibold">{MARKER[row.kind]}</td>
                  <td className="whitespace-pre px-2 py-px pr-4">{row.text || '\u00a0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-(--surface-card) px-3 py-4 text-[11px] text-(--text-tertiary)">No line changes.</div>
      )}
    </div>
  )
}
