// 2b chat style: an agent turn shows its spoken answer (MSG/DONE lanes) as plain
// text and collapses its "work" — reasoning (THINK/PLAN), tool calls (TOOL), and
// file edits (EDIT) — behind a per-turn "Thought through…" toggle.
export const WORK_LANES = new Set(['THINK', 'PLAN', 'TOOL', 'EDIT'])

/** Daemon chrome for a wait (a sandbox pod coming up) — deliberately NOT a work lane:
 *  it is not something the agent thought or did, so it renders as its own standalone
 *  line instead of being counted and hidden as a reasoning step. */
export const NOTICE_LANE = 'NOTICE'

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

/** Is a turn in flight for this session? `rawState` is the session's RAW daemon
 *  state (`Session.statusLabel`: starting/idle/prompting/cancelling/resuming/closed),
 *  NEVER the bucketed `Session.status` key — `toStatusKey()` maps a finished
 *  idle/completed session to 'online' and an active prompting turn to 'paused',
 *  which is exactly backwards as an active-turn signal. `busy` covers the live
 *  playground/webchat path (a turn this browser is streaming). */
export function sessionTurnInFlight(busy: boolean, rawState: string | undefined): boolean {
  return busy || rawState === 'prompting' || rawState === 'cancelling'
}

/** Is a turn's work panel open? Every turn starts collapsed — streaming included —
 *  so the transcript never expands a panel the reader didn't ask for; a live turn's
 *  collapsed toggle line still shows progress (the summary plus the step running
 *  right now). `override` is the visibility the user last chose for it. */
export function workPanelOpen(override: boolean | undefined): boolean {
  return override ?? false
}

/** Record the user's toggle of the turn identified by `key`, as the state opposite to
 *  what they see now. `currentOpen` is the EFFECTIVE state on screen. Keyed by stable turn
 *  identity (not array index), so the toggle survives a "load earlier" prepend. */
export function toggleWorkPanel(
  prev: ReadonlyMap<string, boolean>,
  key: string,
  currentOpen: boolean
): Map<string, boolean> {
  const next = new Map(prev)
  next.set(key, !currentOpen)
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
