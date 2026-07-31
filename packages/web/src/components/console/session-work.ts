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

/** Is a turn's work panel open? `autoOpen` is the default the turn's own content
 *  implies (a turn with no answer text yet defaults OPEN so a mid-stream agent isn't
 *  hidden); `override` is the visibility the user last chose for it, if any.
 *
 *  The user's choice is stored as the explicit desired state rather than as "flipped
 *  from the default" — otherwise, when a work-only turn's answer text lands and the
 *  default flips, a "flipped" bit would silently re-open a panel the user had hidden. */
export function workPanelOpen(override: boolean | undefined, autoOpen: boolean): boolean {
  return override ?? autoOpen
}

/** Record the user's toggle of turn `ti`, as the state opposite to what they see now. */
export function toggleWorkPanel(
  prev: ReadonlyMap<number, boolean>,
  ti: number,
  autoOpen: boolean
): Map<number, boolean> {
  const next = new Map(prev)
  next.set(ti, !workPanelOpen(prev.get(ti), autoOpen))
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
