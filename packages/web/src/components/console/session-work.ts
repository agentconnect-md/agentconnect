import type { PlanBody } from '@/lib/api'
import type { ElicitBody, ElicitFieldSpec } from '@/lib/data'

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

/** Every outcome this console can READ off a persisted card. A newer daemon's unknown verdict is
 *  dropped rather than rendered, which shows the card as unsettled — the one direction that is
 *  never a wrong verdict. The question itself comes from the row's `text`, not the body. */
const ELICIT_OUTCOMES = new Set(['accepted', 'dismissed', 'cancelled', 'completed', 'unrenderable'])

/** Parse an `elicit` row's `body` into the card it recorded. Null for everything that is not a
 *  readable card — no body at all (a daemon or control plane predating the row), malformed JSON,
 *  a payload with no request id — and the caller then falls back to rendering the row's own text,
 *  which is at least the question, rather than a card with nothing in it. */
export function elicitCard(body: string | undefined): ElicitBody | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as Partial<ElicitBody>
    if (typeof parsed?.requestId !== 'string' || !parsed.requestId) return null
    const outcome =
      typeof parsed.outcome === 'string' && ELICIT_OUTCOMES.has(parsed.outcome) ? parsed.outcome : undefined
    return {
      ...parsed,
      requestId: parsed.requestId,
      options: Array.isArray(parsed.options) ? parsed.options : [],
      ...(outcome ? { outcome } : { outcome: undefined })
    }
  } catch {
    return null
  }
}

/** One elicitation card's identity across the two places it can be rendered from: the agent that
 *  owns the request, and the request itself. A uuid request id could stand alone, but identity
 *  here is (owner, request) and saying so keeps a future non-unique id from silently colliding. */
// What a bridge appends to a question's property name when it adds that question's own
// free-text box: `question_0_custom`, `need_type__other`. The daemon binds a box to its
// question from the elicitation schema's `_meta` marker, which never crosses this wire — so
// where that binding arrives unset, the pair's NAMES are all this side has to read it from.
const CUSTOM_ANSWER_SUFFIXES = ['_custom', '_other', '-custom', '-other']

/** The select question a field name is the free-text box OF: another field's name plus one of
 *  the suffixes above, with a doubled separator (`need_type__other`) read like a single one.
 *  Undefined when the name claims no question that offers choices. */
function suffixedCustomAnswerOwner(propName: string, selects: Set<string>): string | undefined {
  const lower = propName.toLowerCase()
  for (const suffix of CUSTOM_ANSWER_SUFFIXES) {
    if (!lower.endsWith(suffix)) continue
    const stem = propName.slice(0, propName.length - suffix.length)
    for (const owner of [stem, stem.slice(0, -1)]) if (owner && selects.has(owner)) return owner
  }
  return undefined
}

/** A field whose `defaultValue` still names one of its own options — the seed of a control
 *  that just lost an option must not be a value that control can no longer show. */
function withoutStaleDefault(field: ElicitFieldSpec): ElicitFieldSpec {
  const values = new Set(field.options.map((o) => o.value))
  const raw = field.defaultValue
  const stale = Array.isArray(raw) ? raw.some((v) => !values.has(v)) : typeof raw === 'string' && !values.has(raw)
  if (!stale) return field
  const { defaultValue: _dropped, ...rest } = field
  return rest
}

/**
 * A form card's fields with every UNBOUND custom-answer box folded into the question it
 * belongs to, read from the pair's names.
 *
 * An AskUserQuestion bridge gives each select question its own free-text box, and says so with
 * a `_meta` marker the daemon turns into `customAnswerFor`. A bridge that marks nothing leaves
 * it unset, and the box then reads as a question of its own titled "Other" — asked once per
 * real question, numbered and counted among them. Such a bridge also tends to append an
 * "Other" CHOICE to the enum whose only meaning is "type below": picking it answers the
 * question with a value the agent reads as no answer at all, so where the card offers the box
 * itself that choice goes. Matched on the companion's own label rather than any word, and never
 * down to an empty option list.
 *
 * Only OPTIONAL fields the daemon left unbound are read this way, so a newer daemon that already
 * folded them passes through untouched, and a field the daemon deliberately kept standalone and
 * REQUIRED is never folded out of sight. Pure.
 */
export function foldCustomAnswers(fields: ElicitFieldSpec[]): ElicitFieldSpec[] {
  const selects = new Set(fields.filter((f) => f.kind === 'enum' || f.kind === 'multi-enum').map((f) => f.propName))
  const bound = fields.map((f) => {
    // A REQUIRED field is never a box read this way: a companion is an optional alternative to
    // a pick, so a required one is a question in its own right whatever it is named. Folding it
    // would hide it behind its question's chip, where nothing can report that the answer the
    // card is about to send leaves a required field out.
    if (f.customAnswerFor || f.kind !== 'text' || f.required) return f
    const owner = suffixedCustomAnswerOwner(f.propName, selects)
    return owner ? { ...f, customAnswerFor: owner } : f
  })
  const companionLabel = new Map<string, string>()
  for (const f of bound) if (f.customAnswerFor) companionLabel.set(f.customAnswerFor, f.label.trim().toLowerCase())
  return bound.map((f) => {
    const label = companionLabel.get(f.propName)
    if (label === undefined || !f.options.length) return f
    const options = f.options.filter((o) => o.label.trim().toLowerCase() !== label)
    return options.length && options.length < f.options.length ? withoutStaleDefault({ ...f, options }) : f
  })
}

export function elicitStepKey(agentId: string | undefined, requestId: string): string {
  return `${agentId ?? ''}\u0000${requestId}`
}

/** Every card the LIVE stream is currently carrying. On a reload a pending webchat card arrives
 *  twice — once as its transcript row (#1794) and once as the replayed `elicitation` event — and
 *  the live copy is the one that can still be answered and the one `elicitation_resolved` settles,
 *  so this is what the transcript's twin is dropped against. Empty for every surface that streams
 *  no cards at all, which is the Slack-origin case. */
export function liveElicitKeys(
  live: readonly { lane?: string; agentId?: string; elicit?: { requestId: string } }[],
  ownerAgentId?: string
): Set<string> {
  const keys = new Set<string>()
  for (const step of live) {
    if (!step.elicit?.requestId) continue
    keys.add(elicitStepKey(step.agentId ?? ownerAgentId, step.elicit.requestId))
  }
  return keys
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
