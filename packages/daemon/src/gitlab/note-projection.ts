// Informational run projection (gitlab-com-integration.md §16): the daemon is the ONLY GitLab Notes
// writer for this surface — one service-account note per merge-request head, updated in place across
// generations, reconciled by a hidden marker before any retry, reported back as identity + outcome.
// The note carries fixed control fields only: never agent output, review text, issue/MR text, or logs.
import type { CodeHostNoteDesired, CodeHostNoteResult, CodeHostNoteState } from '@agentconnect.md/protocol'
import type { PosterScheduler } from '../github/poster.js'
import { parseGitlabJson, type BrokerCapability } from './broker.js'

/** The fixed §16 lifecycle labels; the note shows one of these and nothing else as its heading. */
const STATE_LABEL: Record<CodeHostNoteState, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  superseded: 'Superseded',
  interrupted: 'Interrupted'
}

/** §16.1: the only authorized ways to open a new generation, named on a note that ended early. */
const RE_REQUEST_SENTENCE =
  'To run again, re-request a review from the project service account, mention the agent explicitly, or use "Run again" in the AgentConnect Console.'

/** The hidden stable marker a note is reconciled by; identical across every generation of one head. */
const MARKER_PREFIX = 'agentconnect-projection:'
/** The key is a Control-Plane-issued opaque id; anything outside this charset cannot enter a comment. */
const PROJECTION_KEY = /^[A-Za-z0-9_.:-]{1,200}$/
const REASON_CODE = /^[a-z0-9_:-]{1,100}$/
/** Console links are ordinary authenticated http(s) URLs — never a scheme that could execute. */
const CONSOLE_URL = /^https?:\/\/[^\s()<>"']{1,500}$/
const NON_HEX = /[^0-9a-fA-F]/g
const DECIMAL_ID = /^[1-9]\d*$/
const MAX_AGENT_NAME_CHARS = 200
const SHORT_SHA_CHARS = 8
/** Bounded reconciliation scan: enough to find our own note on a busy merge request, never unbounded. */
const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 5
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Unsettled rows retry on the projector's own clock: a healthy control socket never triggers a sweep. */
const DEFAULT_RESWEEP_BASE_MS = 30_000
const DEFAULT_RESWEEP_CAP_MS = 300_000
/** The projection is a comment-class effect, so the hook-authorized lease must clamp at least here. */
const REQUIRED_CAPABILITY: BrokerCapability = 'comment'
const CAPABILITY_RANK: Record<BrokerCapability, number> = { read: 0, comment: 1, write: 2 }

export function projectionMarker(projectionKey: string): string {
  return `<!-- ${MARKER_PREFIX}${projectionKey} -->`
}

/** Collapse to one safe display line: no newline, no Markdown structure, no HTML-comment escape. */
function plain(value: string, max: number): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`)
}

/** Re-emit a frame timestamp from its parsed value, so only a real instant ever reaches the body. */
function stamp(value: string | undefined): string | undefined {
  if (!value) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

function shortSha(headSha: string): string | undefined {
  const hex = headSha.replace(NON_HEX, '').slice(0, SHORT_SHA_CHARS)
  return hex.length > 0 ? hex : undefined
}

/**
 * The FIXED template. Its only inputs are the frame's control fields — state, agent display name,
 * revision abbreviation, timestamps, normalized reason, Console link, and the hidden marker. No
 * other field of the frame, and nothing from any other source, may reach this string.
 */
export function renderProjectionNote(desired: CodeHostNoteDesired): string {
  const lines = [projectionMarker(desired.projectionKey), `**AgentConnect run — ${STATE_LABEL[desired.state]}**`, '']
  lines.push(`- Agent: ${plain(desired.agentName, MAX_AGENT_NAME_CHARS)}`)
  const revision = shortSha(desired.headSha)
  if (revision) lines.push(`- Revision: \`${revision}\``)
  if (desired.reason && REASON_CODE.test(desired.reason)) lines.push(`- Reason: \`${desired.reason}\``)
  const queued = stamp(desired.queuedAt)
  if (queued) lines.push(`- Queued: ${queued}`)
  const started = stamp(desired.startedAt)
  if (started) lines.push(`- Started: ${started}`)
  const completed = stamp(desired.completedAt)
  if (completed) lines.push(`- Completed: ${completed}`)
  const updated = stamp(desired.desiredAt)
  if (updated) lines.push(`- Updated: ${updated}`)
  if (desired.consoleUrl && CONSOLE_URL.test(desired.consoleUrl))
    lines.push('', `[View this run in the Console](${desired.consoleUrl})`)
  if (desired.state === 'superseded' || desired.state === 'interrupted') lines.push('', RE_REQUEST_SENTENCE)
  return lines.join('\n')
}

/**
 * `in_flight` — a mutation was started and its outcome is not yet definite.
 * `settled_unreported` — the outcome is definite but the control plane has not acknowledged it.
 * `settled` — the control plane holds the result; nothing is owed.
 */
export type NoteProjectionPhase = 'in_flight' | 'settled_unreported' | 'settled'

/** The definite outcomes a stored row can replay; `ambiguous` is never definite, so never stored. */
export type NoteProjectionOutcome = 'written' | 'skipped' | 'failed'

/** The durable local write ledger row: written BEFORE any mutation, settled after a definite one. */
export interface NoteProjectionRow {
  projectionKey: string
  projectionId: string
  hookId: string
  agentId: string
  orgId?: string
  provider: string
  projectId: string
  mergeRequestIid: number
  headSha: string
  generation: string
  writeMarker: string
  state: CodeHostNoteState
  /** The rendered body of this generation, so a reconciled write needs no re-render. */
  body: string
  noteId?: string
  credentialEpoch: string
  /** The stable daemon identity that owns this write — the one the placement fence names. */
  daemonId: string
  phase: NoteProjectionPhase
  /** Set with `settled_unreported`: the outcome and code the replay re-sends verbatim. */
  outcome?: NoteProjectionOutcome
  code?: string
}

export interface NoteProjectionStore {
  getNoteProjection(daemonId: string, projectionKey: string): Promise<NoteProjectionRow | undefined>
  beginNoteProjectionWrite(row: NoteProjectionRow, now: number): Promise<void>
  recordNoteProjectionOutcome(
    row: NoteProjectionRow,
    outcome: NoteProjectionOutcome,
    code: string | undefined,
    now: number
  ): Promise<void>
  markNoteProjectionReported(daemonId: string, projectionKey: string, writeMarker: string, now: number): Promise<void>
  /** Scoped to the stable daemon identity, so a restart recovers its own rows and no peer's. */
  listUnsettledNoteProjections(daemonId: string): Promise<NoteProjectionRow[]>
}

export interface NoteProjectionLease {
  token: string
  access: BrokerCapability
  /** The purge fence the grant was minted under; a mismatch against the desired fence never writes. */
  credentialEpoch?: string
}

export interface CodeHostNoteProjectorDeps {
  /** This daemon's adopted id — the frame's placement fence is checked against it, never assumed. */
  daemonId: () => string | undefined
  store: NoteProjectionStore
  /** Hook-authorized effect lease (purpose `gitlab_effect`); the token never leaves this writer. */
  lease: (input: { agentId: string; projectId: string; hookId: string }) => Promise<NoteProjectionLease>
  /** Drop a lease GitLab just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (input: { agentId: string; projectId: string }, token: string) => void
  /** Deliver `codehost/note-result` to the Control Plane; may reject when the CP is unreachable. A
   *  rejection carrying `retryable: false` is a permanent answer and stops the replay. */
  report: (result: CodeHostNoteResult, orgId?: string) => Promise<void>
  log: { warn: (message: string) => void }
  now?: () => number
  /** Timer seam for the self-scheduled resweep; tests drive it, production uses real timers. */
  scheduler?: PosterScheduler
  resweepBaseMs?: number
  resweepCapMs?: number
  /** The instance's `/api/v4` root for THIS projection's agent, resolved per turn (§24.4). */
  apiBaseUrl: (input: { agentId: string; projectId: string }) => string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

/** A definite provider answer, an ambiguous one, or a no-effect refusal this writer owns. */
type WriteOutcome =
  | { kind: 'written'; noteId: string }
  | { kind: 'failed'; code: string }
  | { kind: 'skipped'; code: string }
  | { kind: 'ambiguous'; code: string }

/** One bounded provider call's answer; a timeout or transport error is unavailable, not a status. */
type ProviderAnswer = { kind: 'answered'; status: number; body: string } | { kind: 'unavailable'; code: string }

export class CodeHostNoteProjector {
  /** One mutation at a time per projection key: two generations must never race the same note. */
  private readonly chains = new Map<string, Promise<void>>()
  private readonly sched: PosterScheduler
  private resweepHandle?: unknown
  /** Consecutive sweeps that still left work behind; resets to zero the moment nothing is owed. */
  private resweepAttempt = 0
  /** Monotonic count of arm REQUESTS, so a zero-work disarm can tell whether it raced new work. */
  private armGeneration = 0
  private sweeping = false
  private stopped = false

  constructor(private readonly deps: CodeHostNoteProjectorDeps) {
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
  }

  /** Drop the pending resweep so a shutting-down daemon leaves no timer behind. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  /** Converge one desired generation and report exactly one result. Never rejects. */
  apply(desired: CodeHostNoteDesired, orgId?: string): Promise<void> {
    return this.serialize(desired.projectionKey, () => this.converge(desired, orgId))
  }

  /**
   * Startup / reconnect sweep over everything this daemon still owes (§16). An `in_flight` row is
   * reconciled by LISTING the merge request's notes and matching the hidden marker before the note
   * is touched again, so an interrupted create can never become a second note for the same head. A
   * `settled_unreported` row already has its definite outcome and only replays the result, so a
   * dropped `codehost/note-result` cannot leave the control plane's write mutex held forever.
   */
  async reconcilePending(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    // Read BEFORE the scan: work that arms after this point owns the timer, not this sweep.
    const armedThrough = this.armGeneration
    try {
      const remaining = await this.sweepOnce()
      // Keep the projector's own clock running while anything is owed, and go quiet the moment
      // nothing is: an unreachable provider must not depend on a control-plane reconnect to retry.
      // A scan that did not answer proves nothing, so it continues the chain rather than ending it.
      if (remaining === undefined || remaining > 0) this.arm()
      else this.disarm(armedThrough)
    } finally {
      this.sweeping = false
    }
  }

  /** One pass over what this daemon identity owes; the count still unsettled after it, or undefined. */
  private async sweepOnce(): Promise<number | undefined> {
    const daemonId = this.deps.daemonId()
    // Before the control plane adopts an id there is no identity to recover rows under; retry later.
    if (!daemonId) return 0
    let rows: NoteProjectionRow[]
    try {
      rows = await this.deps.store.listUnsettledNoteProjections(daemonId)
    } catch (err) {
      this.warn(`note projection: pending write scan failed (${String(err)})`)
      return undefined
    }
    if (rows.length === 0) return 0
    for (const row of rows) await this.serialize(row.projectionKey, () => this.settlePending(row))
    try {
      return (await this.deps.store.listUnsettledNoteProjections(daemonId)).length
    } catch {
      // The pass ran; an unreadable follow-up count just keeps the backoff armed.
      return rows.length
    }
  }

  /** Arm the next resweep on exponential backoff, capped. An armed timer is never restarted early. */
  private arm(): void {
    if (this.stopped) return
    // EVERY arm request advances the generation, including one an armed timer already covers: a
    // concurrent zero-work sweep decides by this counter whether the timer is still its to clear.
    this.armGeneration += 1
    if (this.resweepHandle !== undefined) return
    const base = this.deps.resweepBaseMs ?? DEFAULT_RESWEEP_BASE_MS
    const cap = this.deps.resweepCapMs ?? DEFAULT_RESWEEP_CAP_MS
    const delay = Math.min(base * 2 ** Math.min(this.resweepAttempt, 16), cap)
    this.resweepAttempt += 1
    try {
      this.resweepHandle = this.sched.setTimeout(() => {
        this.resweepHandle = undefined
        void this.reconcilePending()
      }, delay)
    } catch (err) {
      this.warn(`note projection: resweep scheduling failed (${String(err)})`)
    }
  }

  /** Go quiet — but only if nothing armed after the sweep that decided there was no work left. */
  private disarm(armedThrough: number): void {
    if (this.armGeneration !== armedThrough) return
    this.resweepAttempt = 0
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.resweepHandle === undefined) return
    try {
      this.sched.clearTimeout(this.resweepHandle)
    } catch {
      // A failed clear only leaves a sweep that finds nothing to do.
    }
    this.resweepHandle = undefined
  }

  private serialize(key: string, run: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(run, run)
    this.chains.set(key, next)
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    return next
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async converge(desired: CodeHostNoteDesired, orgId?: string): Promise<void> {
    const fence = this.fenceFailure(desired)
    // A refusal this daemon does not own leaves no local row: there is nothing here to replay.
    if (fence.kind === 'refused') {
      await this.send(refusal(desired, fence.outcome, fence.code, this.now()), orgId)
      return
    }
    const daemonId = fence.daemonId
    let stored: NoteProjectionRow | undefined
    try {
      stored = await this.deps.store.getNoteProjection(daemonId, desired.projectionKey)
    } catch (err) {
      this.warn(`note projection: ledger read failed for ${desired.projectionKey} (${String(err)})`)
      await this.send(refusal(desired, 'failed', 'ledger_unavailable', this.now()), orgId)
      return
    }
    const ledger = this.ledgerFailure(desired, stored)
    if (ledger) {
      await this.send(refusal(desired, 'skipped', ledger, this.now()), orgId)
      return
    }

    // The recorded note wins over the frame's hint only when the frame carries none; both are the
    // same observed identity, and an unreadable one is treated as unknown so the marker decides.
    const noteId = noteIdOf(desired.noteId) ?? noteIdOf(stored?.noteId)
    const row: NoteProjectionRow = {
      projectionKey: desired.projectionKey,
      projectionId: desired.projectionId,
      hookId: desired.hookId,
      agentId: desired.agentId,
      ...(orgId ? { orgId } : {}),
      provider: desired.provider,
      projectId: desired.projectId,
      mergeRequestIid: desired.mergeRequestIid,
      headSha: desired.headSha,
      generation: desired.generation,
      writeMarker: desired.writeMarker,
      state: desired.state,
      body: renderProjectionNote(desired),
      ...(noteId ? { noteId } : {}),
      credentialEpoch: desired.credentialEpoch,
      daemonId,
      phase: 'in_flight'
    }
    // An earlier write of this projection never reached a definite outcome, so the note's identity
    // is recovered from the provider before this generation may touch the merge request at all.
    const outcome = await this.write(row, stored?.phase === 'in_flight', true)
    await this.deliver(row, outcome, orgId)
  }

  /** Finish what the ledger row still owes: reconcile an interrupted write, or replay its result. */
  private async settlePending(row: NoteProjectionRow): Promise<void> {
    if (row.phase === 'settled_unreported') return await this.deliver(row, storedOutcome(row), row.orgId)
    const outcome = await this.write(row, true, false)
    // Still fail-closed on this writer: the row stays in flight and the next sweep reconciles again.
    if (outcome.kind === 'ambiguous') {
      await this.send(settled(row, outcome, this.now()), row.orgId)
      return
    }
    await this.deliver(row, outcome, row.orgId)
  }

  /** Send one definite result and stop replaying it only once the control plane has taken it. */
  private async deliver(row: NoteProjectionRow, outcome: WriteOutcome, orgId?: string): Promise<void> {
    // An ambiguous outcome keeps its in-flight row: arm the resweep that will reconcile it, because
    // a provider timeout says nothing about the control socket that would otherwise be the trigger.
    if (outcome.kind === 'ambiguous') {
      await this.send(settled(row, outcome, this.now()), orgId)
      this.arm()
      return
    }
    if (!(await this.send(settled(row, outcome, this.now()), orgId))) {
      // The outcome is durable but unreported; the sweep replays it until the control plane takes it.
      this.arm()
      return
    }
    try {
      await this.deps.store.markNoteProjectionReported(row.daemonId, row.projectionKey, row.writeMarker, this.now())
    } catch (err) {
      // Harmless: the row simply replays an identical result, which the control plane answers once.
      this.warn(`note projection: ledger ack failed for ${row.projectionKey} (${String(err)})`)
    }
  }

  /** Placement, credential and renderability fences — all of them refuse BEFORE any provider call. */
  private fenceFailure(
    desired: CodeHostNoteDesired
  ): { kind: 'owned'; daemonId: string } | { kind: 'refused'; outcome: 'skipped' | 'failed'; code: string } {
    const refused = (outcome: 'skipped' | 'failed', code: string) => ({ kind: 'refused', outcome, code }) as const
    if (desired.provider !== 'gitlab') return refused('skipped', 'provider_unsupported')
    const daemonId = this.deps.daemonId()
    // No adopted id yet, or a fence naming another member: this daemon is not the writer.
    if (!daemonId || desired.snapshot.dispatchDaemonId !== daemonId) return refused('skipped', 'not_dispatch_owner')
    const leaseUntil = Date.parse(desired.leaseUntil)
    if (!Number.isFinite(leaseUntil) || leaseUntil <= this.now()) return refused('skipped', 'lease_expired')
    if (!PROJECTION_KEY.test(desired.projectionKey)) return refused('failed', 'invalid_projection_key')
    if (!DECIMAL_ID.test(desired.projectId)) return refused('failed', 'invalid_project_id')
    return { kind: 'owned', daemonId }
  }

  /** What the durable ledger already knows refuses a frame the local record has moved past. */
  private ledgerFailure(desired: CodeHostNoteDesired, stored: NoteProjectionRow | undefined): string | undefined {
    if (!stored) return undefined
    if (
      stored.hookId !== desired.hookId ||
      stored.projectId !== desired.projectId ||
      stored.mergeRequestIid !== desired.mergeRequestIid ||
      stored.headSha !== desired.headSha
    )
      return 'projection_key_conflict'
    if (BigInt(stored.credentialEpoch) > BigInt(desired.credentialEpoch)) return 'stale_credential_epoch'
    // Any phase but in-flight means the stored generation reached a definite outcome and outranks an older one.
    if (stored.phase !== 'in_flight' && BigInt(stored.generation) > BigInt(desired.generation))
      return 'stale_generation'
    return undefined
  }

  /**
   * The single provider mutation: adopt the note by marker when reconciliation is owed, persist the
   * write marker, then create once or update the SAME note in place.
   */
  private async write(row: NoteProjectionRow, reconcile: boolean, persist: boolean): Promise<WriteOutcome> {
    const minted = await this.mint(row)
    if (minted.kind !== 'lease') return await this.persistOutcome(row, minted, row.noteId)
    const lease = minted.lease

    let noteId = row.noteId
    if (reconcile) {
      const found = await this.findByMarker(row, lease.token)
      // A list that did not answer cannot authorize a write: retrying blind is how a head gets two notes.
      if (found.kind === 'unavailable') return { kind: 'ambiguous', code: 'reconcile_unavailable' }
      noteId = found.noteId
    }
    if (persist) {
      try {
        await this.deps.store.beginNoteProjectionWrite({ ...row, ...(noteId ? { noteId } : {}) }, this.now())
      } catch (err) {
        this.warn(`note projection: write marker persist failed for ${row.projectionKey} (${String(err)})`)
        return { kind: 'failed', code: 'ledger_unavailable' }
      }
    }

    const outcome = await this.mutate(row, noteId, lease)
    // An ambiguous mutation keeps its in-flight row: only reconciliation, never a replay, may follow.
    if (outcome.kind === 'ambiguous') return outcome
    return await this.persistOutcome(row, outcome, noteId)
  }

  /** A definite outcome becomes durable BEFORE it is reported, so a dropped report is replayable. */
  private async persistOutcome(
    row: NoteProjectionRow,
    outcome: WriteOutcome,
    noteId: string | undefined
  ): Promise<WriteOutcome> {
    if (outcome.kind === 'ambiguous') return outcome
    const settledNoteId = outcome.kind === 'written' ? outcome.noteId : noteId
    try {
      await this.deps.store.recordNoteProjectionOutcome(
        { ...row, ...(settledNoteId ? { noteId: settledNoteId } : {}) },
        outcome.kind,
        outcome.kind === 'written' ? undefined : outcome.code,
        this.now()
      )
    } catch (err) {
      this.warn(`note projection: outcome persist failed for ${row.projectionKey} (${String(err)})`)
    }
    return outcome
  }

  /**
   * Mint the hook-authorized effect lease and check every authority fence it must satisfy: the §13.1
   * clamp, and the credential epoch the desired generation was fenced on. A grant minted under an
   * older or newer purge epoch is stale authority and may not write.
   */
  private async mint(
    row: NoteProjectionRow
  ): Promise<{ kind: 'lease'; lease: NoteProjectionLease } | { kind: 'failed' | 'skipped'; code: string }> {
    let lease: NoteProjectionLease
    try {
      lease = await this.deps.lease({ agentId: row.agentId, projectId: row.projectId, hookId: row.hookId })
    } catch {
      // A refused effect lease is its own outcome: nothing was ever sent to GitLab.
      return { kind: 'failed', code: 'token_unavailable' }
    }
    if (CAPABILITY_RANK[lease.access] < CAPABILITY_RANK[REQUIRED_CAPABILITY])
      return { kind: 'failed', code: 'insufficient_authority' }
    if (lease.credentialEpoch !== row.credentialEpoch) return { kind: 'skipped', code: 'stale_credential_epoch' }
    return { kind: 'lease', lease }
  }

  /** One retry only, and only after a definite auth rejection or a 404 proving the note is gone. */
  private async mutate(
    row: NoteProjectionRow,
    noteId: string | undefined,
    lease: NoteProjectionLease
  ): Promise<WriteOutcome> {
    let current = lease
    let target = noteId
    let readopted = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const path = target === undefined ? this.notesPath(row) : `${this.notesPath(row)}/${encodeURIComponent(target)}`
      const res = await this.call(row, target === undefined ? 'POST' : 'PUT', path, current.token, {
        body: row.body
      })
      if (res.kind === 'unavailable') return { kind: 'ambiguous', code: res.code }
      if (res.status >= 200 && res.status < 300) {
        const id = noteIdOf(idFromBody(res.body))
        if (id) return { kind: 'written', noteId: id }
        // An update already knows the note it edited, so an unreadable body loses nothing. A create
        // does not: GitLab accepted it, so the note exists at an id only the marker can recover.
        return target === undefined
          ? { kind: 'ambiguous', code: 'create_id_unreadable' }
          : { kind: 'written', noteId: target }
      }
      // A 5xx never proves the mutation had no effect — on either attempt, so this precedes the guard.
      if (res.status >= 500) return { kind: 'ambiguous', code: `http_${res.status}` }
      if (attempt === 1) return { kind: 'failed', code: `http_${res.status}` }
      if (res.status === 401 || res.status === 403) {
        if (!this.deps.invalidateLease) return { kind: 'failed', code: `http_${res.status}` }
        this.deps.invalidateLease({ agentId: row.agentId, projectId: row.projectId }, current.token)
        // The re-minted grant re-runs every authority fence: a refresh may cross a credential purge.
        const minted = await this.mint(row)
        if (minted.kind !== 'lease') return minted
        current = minted.lease
        continue
      }
      // The recorded note is gone: reconcile by marker once more rather than assume a fresh create.
      if (res.status === 404 && target !== undefined && !readopted) {
        const found = await this.findByMarker(row, current.token)
        if (found.kind === 'unavailable') return { kind: 'ambiguous', code: 'reconcile_unavailable' }
        readopted = true
        target = found.noteId
        continue
      }
      return { kind: 'failed', code: `http_${res.status}` }
    }
    return { kind: 'failed', code: 'write_failed' }
  }

  /** The §16 reconciliation read: the note this projection owns, identified only by its hidden marker. */
  private async findByMarker(
    row: NoteProjectionRow,
    token: string
  ): Promise<{ kind: 'resolved'; noteId?: string } | { kind: 'unavailable' }> {
    const marker = projectionMarker(row.projectionKey)
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const res = await this.call(row, 'GET', `${this.notesPath(row)}?per_page=${LIST_PAGE_SIZE}&page=${page}`, token)
      if (res.kind === 'unavailable' || res.status < 200 || res.status >= 300) return { kind: 'unavailable' }
      let notes: unknown
      try {
        notes = parseGitlabJson(res.body)
      } catch {
        return { kind: 'unavailable' }
      }
      if (!Array.isArray(notes)) return { kind: 'unavailable' }
      for (const raw of notes) {
        const note = (typeof raw === 'object' && raw !== null ? raw : {}) as { id?: unknown; body?: unknown }
        if (typeof note.body !== 'string' || !note.body.includes(marker)) continue
        const id = noteIdOf(rawId(note.id))
        if (id) return { kind: 'resolved', noteId: id }
      }
      if (notes.length < LIST_PAGE_SIZE) break
    }
    return { kind: 'resolved' }
  }

  private notesPath(row: NoteProjectionRow): string {
    return `/projects/${encodeURIComponent(row.projectId)}/merge_requests/${row.mergeRequestIid}/notes`
  }

  /** One bounded provider call. A timeout or transport error is UNAVAILABLE, never a no-effect answer. */
  private async call(
    row: NoteProjectionRow,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    payload?: Record<string, unknown>
  ): Promise<ProviderAnswer> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      const res = await doFetch(`${this.deps.apiBaseUrl(row)}${path}`, {
        method,
        headers: {
          'private-token': token,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {})
        },
        signal: abort.signal,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
      })
      return { kind: 'answered', status: res.status, body: await res.text() }
    } catch {
      return { kind: 'unavailable', code: 'request_unresolved' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** True once the control plane has definitively taken the result — acked, or permanently refused. */
  private async send(result: CodeHostNoteResult, orgId?: string): Promise<boolean> {
    try {
      await this.deps.report(result, orgId)
      return true
    } catch (err) {
      this.warn(`note projection: result report failed for ${result.projectionId} (${String(err)})`)
      // A non-retryable refusal means the control plane already moved past this generation: replaying
      // it forever would only leak a row. Anything else is a delivery failure the sweep retries.
      return (err as { retryable?: unknown })?.retryable === false
    }
  }

  private warn(message: string): void {
    try {
      this.deps.log.warn(message)
    } catch {
      // A broken logger must not break this writer's no-throw boundary.
    }
  }
}

/** A refusal that never reached GitLab; the Control Plane releases or keeps its mutex on the outcome. */
function refusal(
  desired: CodeHostNoteDesired,
  outcome: 'skipped' | 'failed',
  code: string,
  now: number
): CodeHostNoteResult {
  return {
    projectionId: desired.projectionId,
    hookId: desired.hookId,
    generation: desired.generation,
    writeMarker: desired.writeMarker,
    outcome,
    code,
    observedAt: new Date(now).toISOString()
  }
}

/** The observed outcome of one started mutation, echoed by the generation and marker it was fenced on. */
function settled(row: NoteProjectionRow, outcome: WriteOutcome, now: number): CodeHostNoteResult {
  return {
    projectionId: row.projectionId,
    hookId: row.hookId,
    generation: row.generation,
    writeMarker: row.writeMarker,
    outcome: outcome.kind,
    ...(outcome.kind === 'written' ? { noteId: outcome.noteId, observedState: row.state } : { code: outcome.code }),
    observedAt: new Date(now).toISOString()
  }
}

/** Rebuild an unreported outcome from its row. A `written` row without an id cannot claim one. */
function storedOutcome(row: NoteProjectionRow): WriteOutcome {
  if (row.outcome === 'written' && row.noteId) return { kind: 'written', noteId: row.noteId }
  if (row.outcome === 'skipped') return { kind: 'skipped', code: row.code ?? 'skipped' }
  return { kind: 'failed', code: row.code ?? 'note_id_unreadable' }
}

function noteIdOf(value: string | undefined): string | undefined {
  return value !== undefined && DECIMAL_ID.test(value) ? value : undefined
}

function rawId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}

/** Note ids exceed the safe-integer range; quote them before parsing, as the poster does. */
function idFromBody(raw: string): string | undefined {
  try {
    return rawId((parseGitlabJson(raw) as { id?: unknown })?.id)
  } catch {
    // An unreadable body is handled by the caller as a missing id.
    return undefined
  }
}
