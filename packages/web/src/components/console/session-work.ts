// 2b chat style: an agent turn shows its spoken answer (MSG/DONE lanes) as plain
// text and collapses its "work" — reasoning (THINK/PLAN), tool calls (TOOL), and
// file edits (EDIT) — behind a per-turn "Thought through…" toggle.
export const WORK_LANES = new Set(['THINK', 'PLAN', 'TOOL', 'EDIT'])

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
