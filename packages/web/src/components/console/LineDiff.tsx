export type LineDiffKind = 'context' | 'add' | 'delete'

export interface LineDiffRow {
  kind: LineDiffKind
  text: string
  oldLine?: number
  newLine?: number
}

function splitLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  if (value.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Exact line diff for bounded text snapshots. Memory history values are capped
 * at 4 KB, so a compact LCS matrix is deterministic and comfortably bounded.
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

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  const columns = newMiddle.length + 1
  const lcs = new Uint16Array((oldMiddle.length + 1) * columns)

  for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * columns + newIndex
      lcs[cell] =
        oldMiddle[oldIndex] === newMiddle[newIndex]
          ? 1 + lcs[(oldIndex + 1) * columns + newIndex + 1]!
          : Math.max(lcs[(oldIndex + 1) * columns + newIndex]!, lcs[oldIndex * columns + newIndex + 1]!)
    }
  }

  const rows: LineDiffRow[] = oldLines
    .slice(0, prefix)
    .map((text, index) => ({ kind: 'context', text, oldLine: index + 1, newLine: index + 1 }))
  let oldIndex = 0
  let newIndex = 0
  let oldLine = prefix + 1
  let newLine = prefix + 1
  while (oldIndex < oldMiddle.length && newIndex < newMiddle.length) {
    if (oldMiddle[oldIndex] === newMiddle[newIndex]) {
      rows.push({ kind: 'context', text: oldMiddle[oldIndex]!, oldLine, newLine })
      oldIndex += 1
      newIndex += 1
      oldLine += 1
      newLine += 1
    } else if (lcs[(oldIndex + 1) * columns + newIndex]! >= lcs[oldIndex * columns + newIndex + 1]!) {
      rows.push({ kind: 'delete', text: oldMiddle[oldIndex]!, oldLine })
      oldIndex += 1
      oldLine += 1
    } else {
      rows.push({ kind: 'add', text: newMiddle[newIndex]!, newLine })
      newIndex += 1
      newLine += 1
    }
  }
  while (oldIndex < oldMiddle.length) {
    rows.push({ kind: 'delete', text: oldMiddle[oldIndex]!, oldLine })
    oldIndex += 1
    oldLine += 1
  }
  while (newIndex < newMiddle.length) {
    rows.push({ kind: 'add', text: newMiddle[newIndex]!, newLine })
    newIndex += 1
    newLine += 1
  }
  for (let index = 0; index < suffix; index += 1) {
    const oldSuffixIndex = oldLines.length - suffix + index
    const newSuffixIndex = newLines.length - suffix + index
    rows.push({
      kind: 'context',
      text: oldLines[oldSuffixIndex]!,
      oldLine: oldSuffixIndex + 1,
      newLine: newSuffixIndex + 1
    })
  }
  return rows
}

const ROW_STYLE: Record<LineDiffKind, string> = {
  context: 'bg-(--surface-card) text-(--text-secondary)',
  add: 'bg-(--status-online-soft) text-(--green-500)',
  delete: 'bg-(--status-error-soft) text-(--red-600)'
}

const MARKER: Record<LineDiffKind, string> = {
  context: ' ',
  add: '+',
  delete: '−'
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
                  key={`${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}:${index}`}
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
