import type { PlanBody } from '@/lib/api'

// 2b chat style: an agent turn shows its spoken answer (MSG/DONE lanes) as plain
// text and collapses its "work" — reasoning (THINK/PLAN), tool calls (TOOL), and
// file edits (EDIT) — behind a per-turn "Thought through…" toggle.
export const WORK_LANES = new Set(['THINK', 'PLAN', 'TOOL', 'EDIT'])

/** Daemon chrome for a wait (a sandbox pod coming up) — deliberately NOT a work lane:
 *  it is not something the agent thought or did, so it renders as its own standalone
 *  line instead of being counted and hidden as a reasoning step. */
export const NOTICE_LANE = 'NOTICE'

/** A persisted ACP plan row — the turn's task list. Also NOT a work lane: the plan is
 *  what the agent set out to do, not a step it took, so it renders as its own checklist
 *  above the answer rather than collapsing into "Thought through N steps". The name is
 *  deliberately not `'PLAN'` — that one is a WORK lane, the playground's live re-tag. */
export const PLAN_LANE = 'PLAN_BLOCK'

/** An in-band elicitation card — the agent's question, awaiting or carrying an answer. Also
 *  NOT a work lane: it is addressed to the reader, so it stands in the conversation instead
 *  of collapsing behind the work toggle where nobody would see it in time to answer. */
export const ELICIT_LANE = 'ELICIT'

export type PlanEntry = PlanBody['entries'][number]

/** The plan block's one-line label. Computed from the entries wherever they are present —
 *  live and persisted alike — so the two surfaces can never disagree about the count; the
 *  daemon writes the same string onto the row for readers that get no entries at all. */
export function planLabel(entries: PlanEntry[]): string {
  return `Plan · ${entries.filter((entry) => entry.status === 'completed').length}/${entries.length}`
}

/** Parse a plan row's `body` into its entries. Everything that is not a readable list —
 *  no body at all (an older daemon, or a control plane that forwards none), malformed
 *  JSON, an entry without text — yields nothing, and the caller falls back to the row's
 *  `Plan · n/m` summary rather than rendering a broken checklist. */
export function planEntries(body: string | undefined): PlanEntry[] {
  if (!body) return []
  try {
    const parsed = JSON.parse(body) as Partial<PlanBody>
    return (parsed.entries ?? []).filter((entry) => typeof entry?.content === 'string' && entry.content.trim() !== '')
  } catch {
    return []
  }
}

/** Split an agent turn's collapsed work steps into the counts the summary reports:
 *  reasoning STEPS (THINK/PLAN), tool-command STEPS (TOOL), and edited FILES — the
 *  DISTINCT file paths across all EDIT steps (a single EDIT row can touch several
 *  files), with a metadata-less EDIT row counting as one file. Files are counted by
 *  path, not by EDIT-row count, so "1 EDIT step touching a.ts + b.ts" reads "2 files".
 *  A DEMOTED step — a superseded answer re-tagged into this lane — is skipped, not counted. */
export function workCounts(steps: { lane: string; files: { path: string }[]; demoted?: boolean }[]): {
  thinkCount: number
  toolCount: number
  editCount: number
} {
  let thinkCount = 0
  let toolCount = 0
  let bareEdits = 0
  const editPaths = new Set<string>()
  for (const s of steps) {
    if (s.lane === 'TOOL') toolCount += 1
    else if (s.lane === 'EDIT') {
      if (s.files.length === 0) bareEdits += 1
      else for (const f of s.files) editPaths.add(f.path)
    } else if (!s.demoted) thinkCount += 1
  }
  return { thinkCount, toolCount, editCount: editPaths.size + bareEdits }
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

/** Drop paired bold markers from reasoning text, keeping every other kind of markdown.
 *  Runtimes write each thought heading as `**heading**`, so a heading-only run renders as a
 *  slab of bold — the headings are the content, the shouting is not. Bounded to a line so a
 *  stray `**` cannot swallow text across paragraphs. The Slack plan card does the same. */
export function stripBoldMarks(s: string): string {
  return s.replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/__([^\n]+?)__/g, '$1')
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
