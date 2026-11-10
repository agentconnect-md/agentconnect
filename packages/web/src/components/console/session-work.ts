import { NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import type { PlanBody } from '@/lib/api'
import type { CapabilityCardBody, ElicitBody, ElicitFieldSpec, FillCardBody, McpAppBody } from '@/lib/data'

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

/** An MCP App's interface (webchat-mcp-apps.md). NOT a work lane either, and for the same reason
 *  as ELICIT: it is a surface handed to the reader, so collapsing it behind the work toggle would
 *  hide the one thing in the turn they are meant to touch. */
export const APP_LANE = 'APP'

/** A capability request card (capability-requests.md §4.4.2). NOT a work lane, like ELICIT: it is handed to the reader. */
export const CAPABILITY_LANE = 'CAPABILITY'

/** A Fill card (computer-form-fill-and-vault.md §6). NOT a work lane, like ELICIT: it is handed to the reader. */
export const FILL_LANE = 'FILL'

const CAPABILITY_STATUSES = new Set(['completed', 'declined', 'expired', 'withdrawn'])

/** Parse a `capability` row's body; null for anything without a request id, and the caller then shows the row's own text. */
export function capabilityCard(body: string | undefined): CapabilityCardBody | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as Partial<CapabilityCardBody> & { status?: unknown; text?: unknown }
    if (typeof parsed?.requestId !== 'string' || !parsed.requestId) return null
    const status = typeof parsed.status === 'string' && CAPABILITY_STATUSES.has(parsed.status) ? parsed.status : null
    return {
      requestId: parsed.requestId,
      generation: typeof parsed.generation === 'number' ? parsed.generation : 1,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      link: typeof parsed.link === 'string' ? parsed.link : '',
      ...(status
        ? {
            resolved: {
              status: status as NonNullable<CapabilityCardBody['resolved']>['status'],
              text: typeof parsed.text === 'string' ? parsed.text : ''
            }
          }
        : {})
    }
  } catch {
    return null
  }
}

/** Request ids the LIVE stream is carrying, so a reload's transcript twin of the same card stands aside. */
export function liveCapabilityIds(live: readonly { capability?: { requestId: string } }[]): Set<string> {
  return new Set(live.flatMap((step) => (step.capability?.requestId ? [step.capability.requestId] : [])))
}

const FILL_OUTCOMES = new Set([
  'filled',
  'partial',
  'failed',
  'uncertain',
  'target_changed',
  'unsupported',
  'cancelled',
  'expired'
])

/** Parse a `fill` row's body into its card; null for anything without a request, a website and fields. */
export function fillCardBody(body: string | undefined): FillCardBody | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as Partial<FillCardBody>
    if (typeof parsed.requestId !== 'string' || typeof parsed.website?.origin !== 'string') return null
    if (!Array.isArray(parsed.fields) || typeof parsed.expiresAt !== 'string') return null
    const { resolved, ...card } = parsed as FillCardBody
    return { ...card, ...(resolved && FILL_OUTCOMES.has(resolved) ? { resolved } : {}) }
  } catch {
    return null
  }
}

/** Request ids of the Fill cards the LIVE stream is carrying, so a reload's transcript twin stands aside. */
export function liveFillIds(live: readonly { fill?: { requestId: string } }[]): Set<string> {
  return new Set(live.flatMap((step) => (step.fill?.requestId ? [step.fill.requestId] : [])))
}

/** The settlements a persisted app row may carry — anything else is a body we do not trust. */
const MCP_APP_OUTCOMES = new Set(['closed', 'superseded', 'expired', 'completed'])

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
// Restore the recorded native intent or iframe presentation and its latest outcome.
export function mcpAppCard(body: string | undefined): McpAppBody | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as Partial<McpAppBody>
    if (typeof parsed?.appId !== 'string' || !parsed.appId) return null
    if (typeof parsed.toolName !== 'string' || !parsed.toolName) return null
    const nativeUi = NativeMcpUi.safeParse(parsed.nativeUi)
    const outcome =
      typeof parsed.outcome === 'string' && MCP_APP_OUTCOMES.has(parsed.outcome) ? parsed.outcome : undefined
    return {
      appId: parsed.appId,
      ...(nativeUi.success ? { nativeUi: nativeUi.data } : {}),
      title: typeof parsed.title === 'string' ? parsed.title : parsed.toolName,
      toolName: parsed.toolName,
      ...(parsed.toolResult ? { toolResult: parsed.toolResult } : {}),
      ...(typeof parsed.html === 'string' && parsed.html.length > 0 ? { html: parsed.html } : {}),
      ...(parsed.toolInput ? { toolInput: parsed.toolInput } : {}),
      ...(parsed.csp ? { csp: parsed.csp } : {}),
      ...(parsed.dimensions ? { dimensions: parsed.dimensions } : {}),
      ...(outcome ? { outcome } : {})
    }
  } catch {
    return null
  }
}

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

/**
 * Fold a card fetched in full into the PREVIEW its transcript row carried (webchat-mcp-apps.md §8).
 *
 * The fetch supplies only what the row shed — the template, and the result when the card was large
 * enough to lose that too. The row stays authoritative for everything it still carries, and
 * `outcome` is why the distinction is worth stating: the fetched copy is a snapshot from whenever
 * it was read, so letting it win would put a card the reader has since closed back on screen,
 * frame and all, until the next reload. Pure.
 */
export function mergeFetchedAppCard<T extends { appId: string; outcome?: string }>(preview: T, fetched: T): T {
  const { outcome: _snapshot, ...payload } = fetched
  return { ...payload, ...preview } as T
}

export function appStepKey(agentId: string | undefined, appId: string): string {
  return `${agentId ?? ''}\u0000${appId}`
}

/** Every app card the LIVE stream is currently carrying — the peer of {@link liveElicitKeys}, and
 *  there for the same reason: on a reload, or in a second tab, a card in a running turn arrives
 *  twice, once as its transcript row and once as the replayed `app` event. The live copy wins
 *  while that replay stands — it is the one a settlement reaches — so the persisted row steps
 *  aside rather than standing beside it as a second armed frame. Empty on a surface that streams
 *  no cards, which leaves the persisted copy alone as before. */
export function liveAppKeys(
  live: readonly { lane?: string; agentId?: string; app?: { appId: string } }[],
  ownerAgentId?: string
): Set<string> {
  const keys = new Set<string>()
  for (const step of live) {
    if (!step.app?.appId) continue
    keys.add(appStepKey(step.agentId ?? ownerAgentId, step.app.appId))
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

/** The first and last of a turn's own step timestamps, or null when none of its steps carries one. */
export function turnSpan(stamps: readonly (number | undefined)[]): { startMs: number; endMs: number } | null {
  const finite = stamps.filter((ms): ms is number => ms !== undefined && Number.isFinite(ms))
  return finite.length ? { startMs: Math.min(...finite), endMs: Math.max(...finite) } : null
}

/** A turn's approximate duration: start to now while running, first to last step once done; null rather than a guess. */
export function turnDurationMs(
  span: { startMs: number; endMs: number } | null,
  running: boolean,
  nowMs: number
): number | null {
  if (!span) return null
  if (running) return Math.max(0, nowMs - span.startMs)
  return span.endMs > span.startMs ? span.endMs - span.startMs : null
}

/** Whether an agent turn is the one still streaming: its busy lane's latest turn, never one that answered before the latest prompt. */
export function agentTurnStreaming(p: {
  turnInFlight: boolean
  index: number
  lastIndex: number
  /** The latest prompt that opened an exchange (a steer joins the running turn instead); -1 for none. */
  lastExchangeAt: number
  agentId?: string | undefined
  busyLanes: readonly string[]
  agentLastIndex: number | undefined
}): boolean {
  if (!p.turnInFlight || p.index < p.lastExchangeAt) return false
  return p.agentId && p.busyLanes.length > 0
    ? p.busyLanes.includes(p.agentId) && p.agentLastIndex === p.index
    : p.index === p.lastIndex
}

/** When the message an agent turn answers was sent: the latest person's turn above it, past other agents' replies, unless this agent already answered it. */
export function exchangePromptMs(
  turns: readonly { kind: string; steer?: boolean; timeMs?: number; agentId?: string }[],
  index: number
): number | undefined {
  const agentId = turns[index]?.kind === 'bot' ? turns[index].agentId : undefined
  for (let i = index - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (turn.kind === 'user') {
      if (!turn.steer) return turn.timeMs
    } else if (!agentId || turn.agentId === agentId) return undefined
  }
  return undefined
}

/** A span its own steps cannot measure (one instant, or none) starts at the message the turn answers, when that came earlier. */
export function withPromptStart(
  span: { startMs: number; endMs: number } | null,
  promptMs: number | undefined
): { startMs: number; endMs: number } | null {
  if (promptMs === undefined || !Number.isFinite(promptMs)) return span
  if (span && (span.endMs > span.startMs || promptMs >= span.startMs)) return span
  return { startMs: promptMs, endMs: span?.endMs ?? promptMs }
}

/** "42s", "1m 9s", "1h 3m" — a finished sub-second span reads "1s", never a fake "0s". */
export function formatTurnDuration(ms: number): string {
  const total = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** A translator for the turn-status strings, as `useTranslations('Sessions.detail')` returns one. */
type StatusText = (
  key: 'turnWorking' | 'turnWorked' | 'turnStopped' | 'turnFailed',
  values?: Record<string, string | number>
) => string

/** What a turn's header line says about its work: the short parts it shows and the long form its tooltip carries. */
export interface WorkStatus {
  running: boolean
  /** "Stopped" ahead of the duration, for a turn someone interrupted. */
  lead: string | null
  duration: string | null
  /** "1 failed", drawn in the error colour. */
  failed: string | null
  title: string
}

/** One turn's work status: "● 12s" running, "1s" done, "18s · 1 failed", "Stopped · 3s"; the counts go to the tooltip only. */
export function formatWorkStatus(
  p: { ms: number | null; running: boolean; stopped?: boolean; failed: number; summary: string },
  t: StatusText
): WorkStatus {
  const duration = p.ms === null ? null : formatTurnDuration(p.ms)
  const stopped = !p.running && p.stopped === true
  const failed = p.failed > 0 ? t('turnFailed', { count: p.failed }) : null
  const detail = p.summary ? p.summary.charAt(0).toLowerCase() + p.summary.slice(1) : ''
  const lead = stopped ? t('turnStopped') : null
  const head = stopped ? duration : duration && t(p.running ? 'turnWorking' : 'turnWorked', { duration })
  const title = [lead, head, detail, failed].filter(Boolean).join(' · ')
  return { running: p.running, lead, duration, failed, title }
}

/** A reply's age in its shortest form: "39s", "52m", "3h", "2d". */
export function shortAgo(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A tool step's status mark: running for pending/in_progress, done, failed, or none when it reports no status. */
export function stepStatusMark(toolStatus: string | undefined): 'running' | 'done' | 'failed' | null {
  const status = (toolStatus ?? '').toLowerCase()
  if (status === 'pending' || status === 'in_progress') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  return null
}

// What each schema `format` asks of a typed answer, named the way the reader has to fix it.
const FORMAT_HINT: Record<string, { test: (v: string) => boolean; why: string }> = {
  email: { test: (v) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v), why: 'Enter an email address' },
  uri: {
    test: (v) => {
      try {
        return !!new URL(v).protocol
      } catch {
        return false
      }
    },
    why: 'Enter a URL, including its scheme'
  },
  date: {
    // `2025-13-01` matches the shape but is not a date, and toISOString THROWS on it — this
    // runs during render, so an ordinary invalid draft would crash the view, not fail a check.
    test: (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
      const d = new Date(`${v}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && v === d.toISOString().slice(0, 10)
    },
    why: 'Enter a date as YYYY-MM-DD'
  },
  'date-time': {
    test: (v) =>
      /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(Date.parse(v)),
    why: 'Enter a date and time, e.g. 2025-01-31T09:00:00Z'
  }
}

/** Why a typed draft is not yet answerable, or undefined once it is — the same constraints the
 *  daemon re-checks, said in words the reader can act on rather than as a silent dead control. */
export function typedInvalidReason(
  elicit: Pick<ElicitFieldSpec, 'text' | 'number'>,
  draft: string
): string | undefined {
  const num = elicit.number
  if (num) {
    if (!draft.trim()) return 'Enter a number'
    const value = Number(draft)
    if (!Number.isFinite(value)) return 'Enter a number'
    if (num.integer && !Number.isInteger(value)) return 'Enter a whole number'
    if (num.minimum !== undefined && value < num.minimum) return `Enter ${num.minimum} or more`
    if (num.maximum !== undefined && value > num.maximum) return `Enter ${num.maximum} or less`
    return undefined
  }
  const text = elicit.text
  if (!text) return undefined
  if (text.minLength !== undefined && draft.length < text.minLength)
    return `Enter at least ${text.minLength} character${text.minLength === 1 ? '' : 's'}`
  if (!draft.length) return 'Enter an answer'
  // Also what keeps the pattern below cheap: the daemon sizes maxLength down to the pattern
  // cap, so a long draft is refused here rather than matched on every keystroke.
  if (text.maxLength !== undefined && draft.length > text.maxLength) return `Enter at most ${text.maxLength} characters`
  const format = text.format ? FORMAT_HINT[text.format] : undefined
  if (format && !format.test(draft)) return format.why
  if (text.pattern !== undefined) {
    try {
      if (!new RegExp(text.pattern).test(draft)) return `Match ${text.pattern}`
    } catch {
      return 'This field cannot be answered here'
    }
  }
  return undefined
}
