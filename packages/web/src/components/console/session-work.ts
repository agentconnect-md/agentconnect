// 2b chat style: an agent turn shows its spoken answer (MSG/DONE lanes) as plain
// text and collapses its "work" — reasoning (THINK/PLAN), tool calls (TOOL), and
// file edits (EDIT) — behind a per-turn "Thought through…" toggle.
export const WORK_LANES = new Set(['THINK', 'PLAN', 'TOOL', 'EDIT'])

/** Split an agent turn's collapsed work steps into the counts the summary reports:
 *  reasoning STEPS (THINK/PLAN), tool-command STEPS (TOOL), and edited FILES — the
 *  DISTINCT file paths across all EDIT steps (a single EDIT row can touch several
 *  files), with a metadata-less EDIT row counting as one file. Files are counted by
 *  path, not by EDIT-row count, so "1 EDIT step touching a.ts + b.ts" reads "2 files". */
export function workCounts(steps: { lane: string; files: { path: string }[] }[]): {
  thinkCount: number
  toolCount: number
  editCount: number
} {
  let toolCount = 0
  let editStepCount = 0
  let bareEdits = 0
  const editPaths = new Set<string>()
  for (const s of steps) {
    if (s.lane === 'TOOL') toolCount += 1
    else if (s.lane === 'EDIT') {
      editStepCount += 1
      if (s.files.length === 0) bareEdits += 1
      else for (const f of s.files) editPaths.add(f.path)
    }
  }
  return { thinkCount: steps.length - toolCount - editStepCount, toolCount, editCount: editPaths.size + bareEdits }
}

/** Is a turn's work panel open? A finished turn starts collapsed — so the transcript
 *  never expands a panel the reader didn't ask for — but the turn STILL STREAMING
 *  defaults open: its work (skill/command/tool calls) is exactly what the user is
 *  waiting on, and a collapsed one-line counter reads as "nothing is happening".
 *  It collapses on its own when the turn completes (`streaming` flips false).
 *  `override` is the visibility the user last chose for it and wins either way. */
export function workPanelOpen(override: boolean | undefined, streaming = false): boolean {
  return override ?? streaming
}

/** Record the user's toggle of turn `ti`, as the state opposite to what they see now.
 *  `currentOpen` is the EFFECTIVE state on screen — a streaming turn shows open by
 *  default, so the first click must record "closed", not the inverse of the base.
 *  Required (no default): a fallback computed here couldn't know the streaming
 *  state and would silently invert the wrong value. */
export function toggleWorkPanel(
  prev: ReadonlyMap<number, boolean>,
  ti: number,
  currentOpen: boolean
): Map<number, boolean> {
  const next = new Map(prev)
  next.set(ti, !currentOpen)
  return next
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One-line label for the collapsed work: reasoning steps, tool commands, and file
 *  edits are counted SEPARATELY so edits are credited as edits (not folded into the
 *  "thought through" step count). First clause capitalized, the rest lowercased. */
export function workSummary(thinkCount: number, toolCount: number, editCount: number): string {
  const parts: string[] = []
  if (thinkCount > 0) parts.push(`Thought through ${plural(thinkCount, 'step')}`)
  if (toolCount > 0) parts.push(`${parts.length ? 'ran' : 'Ran'} ${plural(toolCount, 'command')}`)
  if (editCount > 0) parts.push(`${parts.length ? 'edited' : 'Edited'} ${plural(editCount, 'file')}`)
  return parts.join(', ')
}
