// Informational run projection (gitlab-com-integration.md §16): the daemon is the ONLY GitLab Notes
// writer for this surface — one service-account note per merge-request head, updated in place across
// generations, reconciled by a hidden marker before any retry, reported back as identity + outcome.
// The note carries fixed control fields only: never agent output, review text, issue/MR text, or logs.
import type { CodeHostNoteDesired, CodeHostNoteResult, CodeHostNoteState } from '@agentconnect.md/protocol'
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
const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4'
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

export type NoteProjectionPhase = 'in_flight' | 'settled'

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
  phase: NoteProjectionPhase
}

export interface NoteProjectionStore {
  getNoteProjection(projectionKey: string): Promise<NoteProjectionRow | undefined>
  beginNoteProjectionWrite(row: NoteProjectionRow, now: number): Promise<void>
  settleNoteProjectionWrite(
    projectionKey: string,
    writeMarker: string,
    noteId: string | undefined,
    now: number
  ): Promise<void>
  listInFlightNoteProjections(): Promise<NoteProjectionRow[]>
}

export interface NoteProjectionLease {
  token: string
  access: BrokerCapability
}

export interface CodeHostNoteProjectorDeps {
  /** This daemon's adopted id — the frame's placement fence is checked against it, never assumed. */
  daemonId: () => string | undefined
  store: NoteProjectionStore
  /** Hook-authorized effect lease (purpose `gitlab_effect`); the token never leaves this writer. */
  lease: (input: { agentId: string; projectId: string; hookId: string }) => Promise<NoteProjectionLease>
  /** Drop a lease GitLab just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (input: { agentId: string; projectId: string }, token: string) => void
  /** Deliver `codehost/note-result` to the Control Plane; may reject when the CP is unreachable. */
  report: (result: CodeHostNoteResult, orgId?: string) => Promise<void>
  log: { warn: (message: string) => void }
  now?: () => number
  baseUrl?: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

/** A definite provider answer, an ambiguous one, or a deterministic no-effect refusal. */
type WriteOutcome =
  { kind: 'written'; noteId: string } | { kind: 'failed'; code: string } | { kind: 'ambiguous'; code: string }

/** One bounded provider call's answer; a timeout or transport error is unavailable, not a status. */
type ProviderAnswer = { kind: 'answered'; status: number; body: string } | { kind: 'unavailable'; code: string }

export class CodeHostNoteProjector {
  /** One mutation at a time per projection key: two generations must never race the same note. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: CodeHostNoteProjectorDeps) {}

  /** Converge one desired generation and report exactly one result. Never rejects. */
  apply(desired: CodeHostNoteDesired, orgId?: string): Promise<void> {
    return this.serialize(desired.projectionKey, () => this.converge(desired, orgId))
  }

  /**
   * Startup / reconnect sweep over writes this daemon started but never settled (§16): every one is
   * reconciled by LISTING the merge request's notes and matching the hidden marker before the note
   * is touched again, so an interrupted create can never become a second note for the same head.
   */
  async reconcilePending(): Promise<void> {
    let rows: NoteProjectionRow[]
    try {
      rows = await this.deps.store.listInFlightNoteProjections()
    } catch (err) {
      this.warn(`note projection: pending write scan failed (${String(err)})`)
      return
    }
    for (const row of rows) await this.serialize(row.projectionKey, () => this.settlePending(row))
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
    if (fence) return await this.send(refusal(desired, fence.outcome, fence.code, this.now()), orgId)
    let stored: NoteProjectionRow | undefined
    try {
      stored = await this.deps.store.getNoteProjection(desired.projectionKey)
    } catch (err) {
      this.warn(`note projection: ledger read failed for ${desired.projectionKey} (${String(err)})`)
      return await this.send(refusal(desired, 'failed', 'ledger_unavailable', this.now()), orgId)
    }
    const ledger = this.ledgerFailure(desired, stored)
    if (ledger) return await this.send(refusal(desired, 'skipped', ledger, this.now()), orgId)

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
      phase: 'in_flight'
    }
    // An earlier write of this projection never reached a definite outcome, so the note's identity
    // is recovered from the provider before this generation may touch the merge request at all.
    const outcome = await this.write(row, stored?.phase === 'in_flight', true)
    await this.send(settled(row, outcome, this.now()), orgId)
  }

  /** Finish an interrupted write from the ledger row alone: reconcile by marker, then converge. */
  private async settlePending(row: NoteProjectionRow): Promise<void> {
    const outcome = await this.write(row, true, false)
    // Still fail-closed on this writer: the row stays in flight and the next sweep reconciles again.
    if (outcome.kind === 'ambiguous') return
    await this.send(settled(row, outcome, this.now()), row.orgId)
  }

  /** Placement, credential and renderability fences — all of them refuse BEFORE any provider call. */
  private fenceFailure(desired: CodeHostNoteDesired): { outcome: 'skipped' | 'failed'; code: string } | undefined {
    if (desired.provider !== 'gitlab') return { outcome: 'skipped', code: 'provider_unsupported' }
    const daemonId = this.deps.daemonId()
    // No adopted id yet, or a fence naming another member: this daemon is not the writer.
    if (!daemonId || desired.snapshot.dispatchDaemonId !== daemonId)
      return { outcome: 'skipped', code: 'not_dispatch_owner' }
    const leaseUntil = Date.parse(desired.leaseUntil)
    if (!Number.isFinite(leaseUntil) || leaseUntil <= this.now()) return { outcome: 'skipped', code: 'lease_expired' }
    if (!PROJECTION_KEY.test(desired.projectionKey)) return { outcome: 'failed', code: 'invalid_projection_key' }
    if (!DECIMAL_ID.test(desired.projectId)) return { outcome: 'failed', code: 'invalid_project_id' }
    return undefined
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
    if (stored.phase === 'settled' && BigInt(stored.generation) > BigInt(desired.generation)) return 'stale_generation'
    return undefined
  }

  /**
   * The single provider mutation: adopt the note by marker when reconciliation is owed, persist the
   * write marker, then create once or update the SAME note in place.
   */
  private async write(row: NoteProjectionRow, reconcile: boolean, persist: boolean): Promise<WriteOutcome> {
    let lease: NoteProjectionLease
    try {
      lease = await this.deps.lease({ agentId: row.agentId, projectId: row.projectId, hookId: row.hookId })
    } catch {
      // A refused effect lease is its own outcome: nothing was ever sent to GitLab.
      return { kind: 'failed', code: 'token_unavailable' }
    }
    if (CAPABILITY_RANK[lease.access] < CAPABILITY_RANK[REQUIRED_CAPABILITY])
      return { kind: 'failed', code: 'insufficient_authority' }

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
    try {
      await this.deps.store.settleNoteProjectionWrite(
        row.projectionKey,
        row.writeMarker,
        outcome.kind === 'written' ? outcome.noteId : noteId,
        this.now()
      )
    } catch (err) {
      this.warn(`note projection: ledger settle failed for ${row.projectionKey} (${String(err)})`)
    }
    return outcome
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
      const res = await this.call(target === undefined ? 'POST' : 'PUT', path, current.token, { body: row.body })
      if (res.kind === 'unavailable') return { kind: 'ambiguous', code: res.code }
      if (res.status >= 200 && res.status < 300) {
        const id = noteIdOf(idFromBody(res.body))
        // The note exists; a missing id only loses the deep link and must never re-run the write.
        return id ? { kind: 'written', noteId: id } : { kind: 'failed', code: 'note_id_unreadable' }
      }
      if (attempt === 1) return { kind: 'failed', code: `http_${res.status}` }
      if (res.status === 401 || res.status === 403) {
        if (!this.deps.invalidateLease) return { kind: 'failed', code: `http_${res.status}` }
        this.deps.invalidateLease({ agentId: row.agentId, projectId: row.projectId }, current.token)
        try {
          current = await this.deps.lease({ agentId: row.agentId, projectId: row.projectId, hookId: row.hookId })
        } catch {
          return { kind: 'failed', code: 'token_unavailable' }
        }
        if (CAPABILITY_RANK[current.access] < CAPABILITY_RANK[REQUIRED_CAPABILITY])
          return { kind: 'failed', code: 'insufficient_authority' }
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
      // A 5xx answer does not prove the mutation had no effect, so it stays fail-closed here.
      if (res.status >= 500) return { kind: 'ambiguous', code: `http_${res.status}` }
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
      const res = await this.call('GET', `${this.notesPath(row)}?per_page=${LIST_PAGE_SIZE}&page=${page}`, token)
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
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    payload?: Record<string, unknown>
  ): Promise<ProviderAnswer> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      const res = await doFetch(`${this.deps.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
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

  private async send(result: CodeHostNoteResult, orgId?: string): Promise<void> {
    try {
      await this.deps.report(result, orgId)
    } catch (err) {
      // The ledger row already records the truth; a lost result is re-derivable, never a second write.
      this.warn(`note projection: result report failed for ${result.projectionId} (${String(err)})`)
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
