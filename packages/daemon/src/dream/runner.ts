import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type {
  Ack,
  DreamInfo,
  DreamOrganizationSuggestionInfo,
  DreamTrigger,
  MemoryDreamingPolicy,
  OrganizationSuggestionChunk,
  OrganizationSuggestionContent,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionReviewReq,
  SessionUsage
} from '@agentconnect.md/protocol'
import {
  MAX_ORGANIZATION_SUGGESTION_BODY_BYTES,
  OrganizationSuggestionContentBody,
  organizationSuggestionCanonical
} from '@agentconnect.md/protocol'
import { memoryNameForTopic, parseMemoryFrontmatter } from '../memory/frontmatter.js'
import {
  MEMORY_INDEX,
  renderMemoryIndex,
  regenerateMemoryIndexHoldingLock,
  type MemoryIndexEntry,
  MEMORY_HISTORY_FILENAME,
  MAX_INDEX_INJECT_BYTES,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_DIRNAME,
  MemorySandboxUnavailableError,
  clampMemoryHistoryValue,
  enforceMemoryHistoryRetentionHoldingLock,
  listMemory,
  memoryWriteMarks,
  recordExternalMemoryMutation,
  readMemoryFile,
  snapshotMemoryHistoryHoldingLock,
  type MemoryFs,
  type MemoryHistoryRecord,
  withMemoryDirLock
} from '../memory/store.js'
import {
  buildDreamExplorationPrompt,
  dreamSessionFileName,
  renderDreamSessionFile,
  dreamSystemPrompt,
  MAX_SKILL_BODY_BYTES,
  parseDreamProposal,
  storeDigest,
  type DreamProposal,
  type DreamTranscriptSource
} from './dreamer.js'
import { publishAcceptedDreamSkill } from '../skills/dream-skills.js'
import { inspectLocalSkillSource } from '../skills/skill-source-snapshot.js'

/**
 * `DreamRunner` — the daemon's dream-job engine (design:
 * docs/designs/memory-dreaming.md §4/§6). One dream at a time per agent:
 * snapshot the managed store, mine recent transcripts, run the isolated
 * extraction session, validate, and stage the proposed store under
 * `<memory-root>/memory-dreams/<dreamId>/`. The live store changes only in
 * {@link DreamRunner.adopt} — an explicit, fenced, reversible swap.
 *
 * The runner owns dream policy and staging; every file it touches goes through
 * the agent's `MemoryFs` port (the memory root on this disk, or on a cluster
 * agent's sandbox volume), so staging follows the agent the way the live store
 * does. It does NOT know how the extraction session is created (trusted-channel
 * mechanics live in daemon.ts and arrive as the injected `extract`), and it
 * never logs memory or transcript bodies.
 */

/** Unknown agent / dream / staged path → `BAD_PAYLOAD` on the wire. */
export class DreamViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamViolationError'
  }
}

/** Legal request against the wrong lifecycle state → `CONFLICT` on the wire. */
export class DreamStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamStateError'
  }
}

/** Production admission reason while provider authentication is necessarily
 * materialized in files that the Dream model's read-only tools can inspect.
 * Keep this stable and actionable: it is returned verbatim by the CP start API
 * and recorded in scheduled-skip logs. */
export const DREAM_MODEL_READABLE_CREDENTIALS_REASON =
  'memory Dream execution is blocked because provider authentication cannot be isolated from model-readable paths; use a credential-isolated Dream runtime (model_readable_credentials)'

/** Historical proposals were staged before review/adoption was bound to one
 * immutable content digest. Their bytes must remain untouched until the secure
 * execution boundary can create a fresh, review-bound proposal. */
export const DREAM_UNBOUND_STAGED_CONTENT_REASON =
  'historical Dream staged content is blocked because its reviewed bytes are not cryptographically bound to adoption; rerun after credential-isolated Dream execution is available (unbound_staged_content)'

/** One policy covers every operation that can execute a Dream or touch staged
 * model output. `blocked` fails closed (the original security hold). `test-only`
 * is the injected-host-factory / deterministic-runner test seam. `enabled` is
 * production: the security hold is lifted now that A1/A2 isolate credentials and
 * B binds the reviewed bytes to adoption (task #36 Phase C). */
export type DreamOperationPolicy = 'blocked' | 'test-only' | 'enabled'

export interface DreamStorePort {
  insertDream(dream: DreamInfo): Promise<void>
  updateDream(dream: DreamInfo): Promise<void>
  /** Crash-recovery write, CAS'd on the open statuses so a peer's terminal outcome survives. */
  failOpenDream(dream: DreamInfo): Promise<boolean>
  getDream(agentId: string, dreamId: string): Promise<DreamInfo | undefined>
  listDreams(agentId: string, limit: number): Promise<DreamInfo[]>
  /** Dreams still holding an unreviewed skill candidate, independent of the
   *  bounded history page — a proposal outlives the store lifecycle. */
  pendingSkillDreams(agentId: string, limit: number): Promise<DreamInfo[]>
  /** Non-terminal dreams (pending|running) THIS process left behind — crash recovery at boot. */
  openDreams(): Promise<DreamInfo[]>
  /** Non-terminal dreams stranded by a former owner of these agents, once this process owns them. */
  strandedDreams(agentIds: readonly string[]): Promise<DreamInfo[]>
  /** Every completed store proposal for one agent, without the public list cap. */
  completedDreams(agentId: string): Promise<DreamInfo[]>
  /** Proposals reconciled as superseded during a store upgrade. */
  supersededDreams(): Promise<DreamInfo[]>
  /** Dreams still carrying a proposed organization suggestion, newest first. */
  organizationSuggestionDreams(limit: number): Promise<DreamInfo[]>
  /** The two reads that name a session OUTWARDLY (session-concept.md §1.1), for the durable
   *  records a dream leaves behind — they outlive the session they point at. */
  getSessionByAcpIdForAgent(agentId: string, acpSessionId: string): Promise<{ key: string } | undefined>
  ensureOutwardSessionId(key: string, agentId?: string): Promise<string>
  /** Newest-first addressable sessions for the agent (transcript sources). */
  dreamSessionSources(
    agentId: string,
    limit: number
  ): Promise<
    { sessionId: string; channel: string; thread: string; transportScope?: string | null; updatedAt: number }[]
  >
  /** Chronological text rows of one session thread, scoped to the agent. */
  dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number,
    /** Include tool TITLES too — the trajectory skill mining reads (never bodies). */
    includeTools?: boolean,
    transportScope?: string | null
  ): Promise<{ sender: string; text: string; kind?: string; input?: string }[]>
}

export interface DreamExtractionResult {
  output: string
  /** Topics the extraction wrote through the BOUND memory tools. Staging refuses any
   *  staged file missing from this list: it reached the staged store some other way
   *  (a runtime file tool, say) and never passed the memory write path's rules.
   *  Absent counts as none — an extraction that cannot report provenance cannot
   *  stage files either. */
  memoryTopics?: string[]
  /** The short-lived ACP id is retained for correlation after the runtime
   *  session itself is discarded. */
  sessionId?: string
  runtime?: string
  model?: string
  stopReason?: string
  usage?: SessionUsage
}

export type DreamLifecycleEventType =
  | 'memory.dream.started'
  | 'memory.dream.completed'
  | 'memory.dream.failed'
  | 'memory.dream.adopted'
  | 'memory.dream.skill_accepted'
  | 'memory.dream.skill_dismissed'

export interface DreamLifecycleEvent {
  type: DreamLifecycleEventType
  dream: DreamInfo
  skillName?: string
}

export interface DreamRunnerDeps {
  /** The agent's LOCAL root (accepted skills publish under it); undefined for an unknown agent. */
  agentDirByAgent(agentId: string): string | undefined
  /** The port over the agent's managed memory tree, where every staging and store touch goes. May
   *  refuse with `MemorySandboxUnavailableError` for a cluster agent whose sandbox is not running. */
  memoryFsFor(agentId: string): MemoryFs | undefined
  /** The agent's dreaming policy, or undefined when dreaming is not enabled
   *  (missing binding, non-managed provider, or enabled:false). */
  dreamingPolicyFor(agentId: string): MemoryDreamingPolicy | undefined
  /** Omission is deliberately `blocked`. Production must never infer authority
   * from runtime configuration; deterministic tests opt in explicitly. */
  operationPolicy?: DreamOperationPolicy
  store: DreamStorePort
  /** Run one isolated dream extraction and return the streamed text. daemon.ts
   *  owns the session/trust mechanics; the prompt is fully assembled here. The
   *  `signal` aborts on cancel — the implementation MUST propagate it to the
   *  host's session-cancel path so a hung/long prompt doesn't pin the agent's
   *  one-in-flight reservation forever. */
  extract(
    agentId: string,
    systemPrompt: string,
    prompt: string,
    signal: AbortSignal,
    context: {
      dreamId: string
      trigger: DreamTrigger
      sessionIds: string[]
      inputDir: string
      /** The dream's STAGED memory store. The extraction session binds the shared
       *  memory tools to it, so the model writes its proposal the same way an agent
       *  writes memory — the daemon no longer transcribes files out of JSON. */
      stagedStore: MemoryFs
    }
  ): Promise<DreamExtractionResult>
  /** Metadata-only lifecycle tap. Observer failures are contained by the
   *  runner and can never change the job outcome. */
  onEvent?(event: DreamLifecycleEvent): void
  /** Best-effort inventory convergence after completion/review. */
  onOrganizationSuggestions?(): void | Promise<void>
  /** Fence a warm runtime after a new accepted local source becomes active. */
  /** Hold the daemon's per-agent host/admission gate while accepted source
   * publication runs. Tests without a live host may omit this seam. */
  withSkillAcceptance?(agentId: string, publish: () => Promise<void>): Promise<void>
  /** Bring the agent's memory home up and hold it for a background job — a dream is authorized
   *  work like a turn, so a cluster agent's sandbox is woken and bound before the store is read and
   *  kept from the idle sweep until the run (and any auto-adoption) settles. Identity when absent. */
  withMemoryHome?<T>(agentId: string, work: () => Promise<T>): Promise<T>
  log: { info(msg: string): void; warn(msg: string): void }
  now?(): Date
  /** Grace period after a cancel before the runner ABANDONS the extraction and
   *  releases the reservation regardless of whether `extract` ever settles — the
   *  hard backstop for a runtime that ignores `session/cancel`. Default 30 s. */
  cancelGraceMs?: number
  /** Test seam: invoked immediately after staging finishes, before the
   *  cancel-wins recheck. Production leaves it unset. */
  onStaged?(agentId: string, dreamId: string): void | Promise<void>
}

const TRANSCRIPT_ROWS_PER_SESSION = 200
// How far back to scan an agent's dreams for the last SUCCESSFUL one when sizing
// the automatic session window. Generous enough that a run of failed dreams
// after a success never hides the baseline.
const LAST_SUCCESSFUL_DREAM_SCAN = 50
// Safety cap on the automatic window: the dream self-sizes to "sessions with
// activity since the last successful dream" (no operator config), but a first
// dream — or a long-idle agent — must not mine an unbounded corpus.
const MAX_AUTO_SESSION_WINDOW = 100
const DREAMS_DIRNAME = 'memory-dreams'
const BACKUPS_DIRNAME = 'memory-backups'
/** A dream stages into a real memory store (`<dream>/memory/`), so every store helper
 *  — listing, index generation, the memory tools — works on it unchanged. Dreams
 *  staged before that lived in `output/`; those keep resolving for review and adoption. */
const LEGACY_STAGED_DIRNAME = 'output'

/** The staged store for a dream: the current layout when present, else the legacy one. */
async function resolveStagedDir(fs: MemoryFs, base: string): Promise<string> {
  const current = join(base, MEMORY_DIRNAME)
  if ((await fs.readdir(current)).length > 0) return current
  const legacy = join(base, LEGACY_STAGED_DIRNAME)
  return (await fs.readdir(legacy)).length > 0 ? legacy : current
}

/** Staged file names are the validator's own outputs; anything else is a violation. */
const STAGED_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}\.md$/

function stagedPathOk(name: string): boolean {
  return name === MEMORY_INDEX || STAGED_NAME_RE.test(name)
}

/** Mined skill dir/script names become filesystem paths — re-validated at the
 *  write site as well as in the parser, since traversal here would escape the
 *  agent's dream staging entirely. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const SKILL_SCRIPT_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Identity of one memory line for rebase dedup — matches the distiller's own
 *  normalization (bullet marker stripped, trimmed, case-folded) so a line the
 *  dream already folded in is not appended twice. '' for a non-content line. */
function normalizeMemoryLine(line: string): string {
  return line
    .replace(/^\s*[-*]\s+/, '')
    .trim()
    .toLowerCase()
}

export class DreamRunner {
  /** dreamId of the agent's in-flight dream — the one-at-a-time invariant. Held
   *  from `start`'s synchronous reservation until the run promise SETTLES (a
   *  cancel does not release it early, so a canceled dream's still-running
   *  extraction can never overlap a replacement). */
  private readonly active = new Map<string, string>()

  /** Abort handle for the in-flight extraction, keyed by dreamId. `cancel`
   *  aborts it so daemon.ts can drive the host's session-cancel path and the
   *  extraction promise settles promptly (releasing the reservation). */
  private readonly aborters = new Map<string, AbortController>()

  /** dreamId of the agent's background job — home acquisition, run, and any auto-adoption — the
   *  span a drain treats as in-flight work. Outlives the adoption reservation (`active`), which
   *  ends before auto-adoption so `adopt` can proceed. */
  private readonly backgroundJobs = new Map<string, string>()

  /** Per-agent serial mutex over the mutating critical sections (snapshot+reserve,
   *  the adopt fence/swap, discard). Ordering matters: the adopt swap must not
   *  interleave with a start snapshot or a discard on the same agent. A rejected
   *  op never wedges the chain (the stored tail swallows the outcome). */
  private readonly locks = new Map<string, Promise<unknown>>()

  private withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agentId) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    this.locks.set(
      agentId,
      result.then(
        () => {},
        () => {}
      )
    )
    return result
  }

  /** Guards {@link initialize} so a lazily-constructed runner recovers exactly once. */
  private initialized = false

  constructor(private readonly deps: DreamRunnerDeps) {}

  /** Boot-time store work, out of the constructor so it can await a Promise-returning store.
   *  Named apart from {@link start}, which starts one dream. */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    // Crash recovery: fail what THIS process left in flight (staging kept); a peer's dream waits for its duty grant.
    await this.failInterrupted(await this.deps.store.openDreams())
    // The LocalStore migration marks proposals stranded by adoptions made on an
    // older daemon. Their metadata is already safe; sweep the corresponding
    // store staging now that the runner can resolve agent directories. Proposed
    // skills keep their independent review lifecycle.
    if (this.operationsAllowed()) {
      for (const dream of await this.deps.store.supersededDreams()) {
        if (!this.deps.agentDirByAgent(dream.agentId)) continue
        void this.removeStoreStaging(dream.agentId, dream).catch((err) => {
          // A cluster agent's tree is unreachable while its sandbox sleeps; the staging is a few
          // files on its own volume, so leaving it is not worth a warning per boot.
          if (err instanceof MemorySandboxUnavailableError) return
          this.deps.log.warn(
            `dream ${dream.dreamId}: could not remove superseded store staging (${err instanceof Error ? err.message : 'unknown'})`
          )
        })
      }
    }
  }

  /** Reclaim the dreams of agents this process has just been made responsible for: their
   *  former owner is no longer running them, so they can only be failed. */
  async reclaimDreams(agentIds: readonly string[]): Promise<void> {
    await this.failInterrupted(await this.deps.store.strandedDreams(agentIds))
  }

  private async failInterrupted(dreams: readonly DreamInfo[]): Promise<void> {
    for (const dream of dreams) {
      const failed: DreamInfo = {
        ...dream,
        status: 'failed',
        error: { type: 'daemon_restart', message: 'the daemon restarted while this dream was in flight' },
        endedAt: this.nowIso()
      }
      // The CAS makes reclaim safe: a row that reached its own terminal state keeps it, and announces nothing.
      if (await this.deps.store.failOpenDream(failed))
        this.emitLifecycle({ type: 'memory.dream.failed', dream: failed })
    }
  }

  private operationsAllowed(): boolean {
    return this.deps.operationPolicy === 'test-only' || this.deps.operationPolicy === 'enabled'
  }

  private assertExecutionAllowed(): void {
    if (!this.operationsAllowed()) throw new DreamStateError(DREAM_MODEL_READABLE_CREDENTIALS_REASON)
  }

  private assertStagedContentAllowed(): void {
    if (!this.operationsAllowed()) throw new DreamStateError(DREAM_UNBOUND_STAGED_CONTENT_REASON)
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private withMemoryHome<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    return this.deps.withMemoryHome ? this.deps.withMemoryHome(agentId, work) : work()
  }

  /** Whether a dream job is under way for the agent — from home acquisition through auto-adoption. */
  inFlight(agentId: string): boolean {
    return this.backgroundJobs.has(agentId)
  }

  private emitLifecycle(event: DreamLifecycleEvent): void {
    try {
      this.deps.onEvent?.(event)
    } catch (err) {
      this.deps.log.warn(`dream lifecycle observer failed (${err instanceof Error ? err.name : 'unknown'})`)
    }
  }

  private dirFor(agentId: string): string {
    const dir = this.deps.agentDirByAgent(agentId)
    if (!dir) throw new DreamViolationError(`unknown agent ${agentId}`)
    return dir
  }

  private fsFor(agentId: string): MemoryFs {
    const fs = this.deps.memoryFsFor(agentId)
    if (!fs) throw new DreamViolationError(`unknown agent ${agentId}`)
    return fs
  }

  /** One dream's staging area, relative to the memory root. */
  private dreamDir(agentId: string, dreamId: string): string {
    this.dirFor(agentId)
    return join(DREAMS_DIRNAME, dreamId)
  }

  private async getDream(agentId: string, dreamId: string): Promise<DreamInfo> {
    const dream = await this.deps.store.getDream(agentId, dreamId)
    if (!dream) throw new DreamViolationError(`unknown dream ${dreamId}`)
    return dream
  }

  /** Start a dream. Rejects when dreaming is not enabled for the agent or one
   *  is already in flight. Returns immediately with the `pending` record; the
   *  pipeline runs asynchronously (poll via get/list, as the console does). */
  /**
   * Whether a scheduled dream would mine at least one session with activity the
   * last SUCCESSFUL dream (completed or adopted) did not consolidate. Scheduled
   * dreams consult this to skip re-dreaming an unchanged corpus — running a fresh
   * host + burning model tokens to re-derive the same proposal is pure waste.
   * When the agent has never completed a dream there is no baseline, so any
   * session at all makes this true; an agent with no sessions yet has nothing to
   * consolidate and skips even its first scheduled run. Manual dreams never call
   * this: an explicit request always runs.
   *
   * "New" is by activity, not just session identity: a session counts when its
   * `updatedAt` is at or after the last successful dream's baseline — so a
   * brand-new session AND fresh messages in an already-mined session both
   * re-trigger (new messages bump `updatedAt`). This mirrors the automatic window
   * in {@link selectSessionSources}: true iff that selection is non-empty.
   */
  async hasNewSessionsSinceLastDream(agentId: string): Promise<boolean> {
    return (await this.selectSessionSources(agentId)).length > 0
  }

  /** The most recent dream that successfully mined its sessions (completed or
   *  adopted) — the baseline the automatic window measures "new activity" from. */
  private async lastSuccessfulDream(agentId: string): Promise<DreamInfo | undefined> {
    return (await this.deps.store.listDreams(agentId, LAST_SUCCESSFUL_DREAM_SCAN)).find(
      (d) => d.status === 'completed' || d.status === 'adopted'
    )
  }

  /**
   * The sessions a dream should mine, chosen AUTOMATICALLY — no operator config.
   * Default: every session with activity since the last successful dream (its
   * `updatedAt` is at or after that dream's baseline), capped at
   * {@link MAX_AUTO_SESSION_WINDOW}. The first dream (no baseline) mines the
   * current corpus up to the cap. An explicit `sessionWindow` (a per-run manual
   * override, or a legacy configured policy value) still pins a fixed newest-N
   * window instead.
   *
   * The comparison is inclusive (`>=`) on purpose. Both the baseline and
   * `updatedAt` have millisecond resolution, so a session written just after the
   * source query but in the same millisecond as the baseline has
   * `updatedAt === cutoff`; a strict `>` would drop it from this dream (query
   * already ran) and every later one — a permanent gap. `>=` instead re-mines the
   * boundary sessions once (a harmless duplicate the pipeline already tolerates)
   * and self-heals: the next dream's baseline moves past them. The invariant is
   * "duplicates possible, gaps never".
   *
   * The cap is an intentional bound, not a paging cursor: it takes the newest N
   * active sessions by `updatedAt`. If more than N sessions changed since the last
   * dream (a large backlog in one interval), the oldest of that changed set are
   * not consolidated in this run, and because the baseline advances they are not
   * revisited later either. N=100 is a deliberately large corpus; consolidating an
   * unbounded backlog in a single host/prompt is the worse failure. Scheduled
   * dreams run often enough that this bound is not normally reached.
   */
  private async selectSessionSources(
    agentId: string,
    explicitWindow?: number
  ): Promise<
    { sessionId: string; channel: string; thread: string; transportScope?: string | null; updatedAt: number }[]
  > {
    if (explicitWindow !== undefined) return await this.deps.store.dreamSessionSources(agentId, explicitWindow)
    const recent = await this.deps.store.dreamSessionSources(agentId, MAX_AUTO_SESSION_WINDOW)
    const lastSuccessful = await this.lastSuccessfulDream(agentId)
    if (!lastSuccessful) return recent
    const cutoff = Date.parse(lastSuccessful.createdAt)
    if (!Number.isFinite(cutoff)) return recent
    return recent.filter((s) => s.updatedAt >= cutoff)
  }

  async start(
    agentId: string,
    opts: { trigger: DreamTrigger; sessionWindow?: number; instructions?: string }
  ): Promise<DreamInfo> {
    // This must precede agent lookup, policy resolution, snapshots, corpus
    // selection, reservation, and persistence. A blocked production request is
    // observationally equivalent to never having started a Dream.
    this.assertExecutionAllowed()
    this.dirFor(agentId)
    const policy = this.deps.dreamingPolicyFor(agentId)
    if (!policy?.enabled) {
      throw new DreamStateError('dreaming is not enabled for this agent (managed provider + dreaming.enabled required)')
    }

    // Reserve + snapshot under the per-agent lock, so the "one in flight" check
    // and the live-store read cannot interleave with a concurrent start or an
    // adopt swap. The lock is released once the run is scheduled; the run then
    // proceeds asynchronously, holding only `active`. The memory home is woken and
    // held for the snapshot, and again for the whole run below.
    return this.withLock(agentId, async () => {
      if (this.active.has(agentId)) {
        throw new DreamStateError('a dream is already in flight for this agent')
      }
      return await this.withMemoryHome(agentId, () => this.reserve(agentId, policy, opts))
    })
  }

  private async reserve(
    agentId: string,
    policy: MemoryDreamingPolicy,
    opts: { trigger: DreamTrigger; sessionWindow?: number; instructions?: string }
  ): Promise<DreamInfo> {
    const fs = this.fsFor(agentId)
    // An explicit sessionWindow (per-run manual override, or a legacy configured
    // policy value) pins a fixed newest-N window; otherwise the window is chosen
    // AUTOMATICALLY (sessions active since the last successful dream, capped).
    const explicitWindow = opts.sessionWindow ?? policy.sessionWindow
    const instructions = opts.instructions ?? policy.instructions
    // Capture this dream's baseline watermark BEFORE selecting sources. This
    // timestamp becomes the dream's `createdAt`, which the NEXT automatic dream
    // uses as its cutoff (`updatedAt > cutoff`). If it were stamped after the
    // source query instead, a session whose `updatedAt` fell between the query
    // and the stamp would be in neither this dream (query already ran) nor any
    // future one (its `updatedAt` < the new baseline) — a permanent drop. Taken
    // first, the baseline is <= the query time, so the worst case is a thin band
    // of sessions mined twice (safe), never a gap. better-sqlite3 is synchronous
    // and single-threaded, so no session write can interleave between here and
    // the query below.
    const createdAt = this.nowIso()
    // A dream distills EVERY session this agent participated in — channel, DM,
    // webchat, external (GitHub), A2A, or launched alike. We deliberately do NOT
    // apply the per-turn capture-visibility gate here: an agent's own transcript
    // is content it already saw, so consolidating it into that same agent's own
    // memory adds no new audience. Peer isolation is preserved by the source
    // itself — dreamSessionSources is scoped to `agentId` and dreamTranscriptText
    // returns only the rows this agent sent, received, or was delivered — so a
    // peer's private session never enters. What used to be a hard pre-filter is
    // now handled by the dream policy prompt: it must not surface a person's
    // private/personal conversation as shared organization knowledge
    // (session-visibility.md §5.1, #36 follow-up).
    const sources = await this.selectSessionSources(agentId, explicitWindow)

    // Snapshot the live store — the digest is the adoption fence. Taken under
    // the shared memory-dir lock so it cannot tear against a concurrent
    // writeMemoryFile, and so the `.history` line count captured with it
    // delimits the post-snapshot write window exactly (see `adopt`).
    const { files, writes } = await withMemoryDirLock(fs, async () => ({
      files: await this.readLiveStore(fs),
      writes: memoryWriteMarks(fs)
    }))
    const dream: DreamInfo = {
      dreamId: `drm-${randomUUID()}`,
      agentId,
      status: 'pending',
      trigger: opts.trigger,
      sessionIds: sources.map((s) => s.sessionId),
      snapshotDigest: storeDigest(files),
      snapshotWrites: writes,
      ...(instructions ? { instructions } : {}),
      createdAt
    }
    await this.deps.store.insertDream(dream)
    this.emitLifecycle({ type: 'memory.dream.started', dream })
    this.active.set(agentId, dream.dreamId)
    const aborter = new AbortController()
    this.aborters.set(dream.dreamId, aborter)

    this.backgroundJobs.set(agentId, dream.dreamId)
    const releaseReservation = (): void => {
      this.aborters.delete(dream.dreamId)
      if (this.active.get(agentId) === dream.dreamId) this.active.delete(agentId)
    }
    // The home stays held across the run AND the auto-adoption that may follow it, so the idle
    // sweep never suspends a cluster agent's sandbox under a dream. Auto-adopt runs only AFTER
    // the reservation is released — `adopt` refuses while a dream is in flight.
    void this.withMemoryHome(agentId, async () => {
      try {
        await this.run(dream, files, sources, aborter.signal)
      } finally {
        releaseReservation()
      }
      await this.maybeAutoAdopt(agentId, dream.dreamId)
    })
      .catch(async (err: unknown) => {
        // `run` settles its own failures; a rejection here is the home not coming up before the
        // callback ever ran (a wake that failed) — the dream must not stay pending forever.
        if ((await this.deps.store.getDream(agentId, dream.dreamId))?.status === 'pending') {
          await this.finish(agentId, dream.dreamId, {
            status: 'failed',
            error: { type: 'pipeline_error', message: err instanceof Error ? err.message : 'unknown error' }
          })
        }
      })
      .finally(() => {
        // Promise-wide, outside the callback: a rejected acquisition must not leave the
        // reservation or the job marker registered forever.
        releaseReservation()
        if (this.backgroundJobs.get(agentId) === dream.dreamId) this.backgroundJobs.delete(agentId)
      })
    return dream
  }

  private async readLiveStore(fs: MemoryFs): Promise<{ name: string; content: string }[]> {
    const files: { name: string; content: string }[] = []
    for (const entry of await listMemory(fs)) {
      files.push({ name: entry.name, content: await readMemoryFile(fs, entry.name) })
    }
    return files
  }

  private async run(
    dream: DreamInfo,
    files: { name: string; content: string }[],
    sources: { sessionId: string; channel: string; thread: string; transportScope?: string | null }[],
    signal: AbortSignal
  ): Promise<void> {
    const { agentId, dreamId } = dream
    try {
      // Skill mining reads the TRAJECTORY (which commands and files, in order),
      // which conversational text alone does not contain — a procedure the agent
      // repeated via tool calls is invisible without this (design §4).
      const mineSkills = this.deps.dreamingPolicyFor(agentId)?.mineSkills === true
      const transcripts: DreamTranscriptSource[] = []
      for (const source of sources) {
        transcripts.push({
          sessionId: source.sessionId,
          rows: await this.deps.store.dreamTranscriptText(
            source.channel,
            source.thread,
            agentId,
            TRANSCRIPT_ROWS_PER_SESSION,
            mineSkills,
            source.transportScope
          )
        })
      }

      // Materialize the dream inputs as FILES the model explores with its own
      // read-only tools (task #36): the memory snapshot at input/ root, each mined
      // transcript at input/sessions/<id>.md (already secret-hygiene filtered by
      // dreamTranscriptText). input/ IS the dream's working directory now — it is
      // read back, by the model, not the pipeline.
      const fs = this.fsFor(agentId)
      const base = this.dreamDir(agentId, dreamId)
      const inputDir = join(base, 'input')
      const sessionsDir = join(inputDir, 'sessions')
      await fs.mkdir(sessionsDir)
      for (const file of files) {
        await fs.writeFile(join(inputDir, file.name), file.content)
      }
      const materializedSessionIds: string[] = []
      for (const transcript of transcripts) {
        const body = renderDreamSessionFile(transcript)
        if (!body.trim()) continue
        await fs.writeFile(join(sessionsDir, `${dreamSessionFileName(transcript.sessionId)}.md`), body)
        materializedSessionIds.push(transcript.sessionId)
      }

      // The dreamer discovers existing org knowledge/skills on demand via its
      // read-only tools (findKnowledge / listKnowledge / listOrgSkills) and
      // proposes an update against any id it finds. The daemon only validates the
      // proposal structurally (well-formed targetId + revision); whether that
      // target exists and is current is the CP's authority when the owner accepts
      // (updateKnowledge = getKnowledge + optimistic revision fence).
      const prompt = buildDreamExplorationPrompt({
        sessionIds: materializedSessionIds,
        mineSkills,
        ...(mineSkills ? { dismissedSkills: await this.dismissedSkillNames(agentId) } : {}),
        ...(dream.instructions ? { instructions: dream.instructions } : {})
      })
      await this.transition(agentId, dreamId, 'pending', { status: 'running' })

      // A cancel that landed before extraction wins: skip the expensive call.
      if ((await this.deps.store.getDream(agentId, dreamId))?.status !== 'running') return

      // The dream's cwd is its input dir in the coordinates of the filesystem that holds it: this
      // disk for a local agent, the pod's volume for a cluster agent — where its host runs.
      // The staged store must exist BEFORE extraction: the model writes into it
      // through the memory tools rather than returning file contents to transcribe.
      const stagedStore = fs.subdir(base)
      await fs.rm(join(base, MEMORY_DIRNAME))
      await fs.rm(join(base, LEGACY_STAGED_DIRNAME))
      await fs.mkdir(join(base, MEMORY_DIRNAME))
      const extracted = await this.extractWithBackstop(
        dream,
        prompt,
        signal,
        join(fs.root, inputDir),
        stagedStore,
        mineSkills
      )

      // A cancel that landed mid-extraction wins: drop the output unstaged. This
      // also covers the backstop firing (extraction ignored the cancel and never
      // settled within the grace window) — the reservation is released either way.
      // The model writes as it goes, so whatever it already wrote is dropped too.
      if ((await this.deps.store.getDream(agentId, dreamId))?.status !== 'running' || extracted.abandoned) {
        await this.clearStaging(agentId, dreamId)
        return
      }
      const output = extracted.output
      // Named outwardly here too (§1.1) — the extraction hands back the runtime's id, and this row
      // outlives the session it points at.
      const executionSlot = extracted.sessionId
        ? await this.deps.store.getSessionByAcpIdForAgent(agentId, extracted.sessionId)
        : undefined
      const executionSessionId = executionSlot
        ? await this.deps.store.ensureOutwardSessionId(executionSlot.key, agentId)
        : extracted.sessionId
      const execution = {
        ...(executionSessionId ? { executionSessionId } : {}),
        ...(extracted.runtime ? { runtime: extracted.runtime } : {}),
        ...(extracted.model ? { model: extracted.model } : {}),
        ...(extracted.stopReason ? { stopReason: extracted.stopReason } : {})
      }
      const usage = {
        inputBytes: Buffer.byteLength(prompt),
        outputBytes: Buffer.byteLength(output),
        ...(extracted.usage ?? {})
      }
      // The mined session ids are what grounds a skill candidate — a citation the
      // model invented can't be used to justify a recommendation (design §7).
      const proposal = parseDreamProposal(
        output,
        sources.map((s) => s.sessionId)
      )
      if (!proposal) {
        await this.clearStaging(agentId, dreamId)
        await this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'unparseable_proposal', message: 'the dream reply carried no valid store proposal' },
          ...execution,
          usage
        })
        return
      }

      // The store is what the model WROTE, so an extraction that never called
      // `writeMemory` — a broken tool surface, refused writes, a turn that ended
      // early — produced no store proposal at all, only a parseable reply. Staging
      // it would complete an index-only store that adoption, auto-adoption above
      // all, installs over every live topic. Treat it as no proposal.
      const stagedNames = (await fs.readdir(join(base, MEMORY_DIRNAME)))
        .filter((entry) => entry.kind === 'file' && entry.name !== MEMORY_INDEX && stagedPathOk(entry.name))
        .map((entry) => entry.name)
      const stagedTopics = stagedNames.length
      const liveTopics = files.filter((file) => file.name !== MEMORY_INDEX).length
      // Provenance is by NAME: a staged file no bound write ever produced means the
      // model reached the staging directory some other way — its own file tools — so
      // the whole proposal is suspect. (A topic written properly and then overwritten
      // out of band still passes; catching that needs a per-write digest.)
      const written = new Set(extracted.memoryTopics ?? [])
      const unaccounted = stagedNames.filter((name) => !written.has(name))
      if (unaccounted.length > 0) {
        await this.clearStaging(agentId, dreamId)
        await this.finish(agentId, dreamId, {
          status: 'failed',
          error: {
            type: 'untrusted_staging',
            message: `staged files did not come from the memory tools: ${unaccounted.slice(0, 5).join(', ')}`
          },
          ...execution,
          usage
        })
        return
      }
      if (stagedTopics === 0 && liveTopics > 0) {
        await this.clearStaging(agentId, dreamId)
        await this.finish(agentId, dreamId, {
          status: 'failed',
          error: {
            type: 'empty_proposal',
            message: `the dream wrote no memory files; refusing a rebuild that would delete ${liveTopics} existing topic(s)`
          },
          ...execution,
          usage
        })
        return
      }

      if (!mineSkills) {
        proposal.skills = []
        proposal.organizationSkills = []
      }
      const organizationSuggestions = await this.stage(fs, base, proposal)
      await this.deps.onStaged?.(agentId, dreamId)

      // stage() is several awaited writes; a cancel can land while it runs.
      // Cancel-wins: honor it, drop the partial output, don't flip to completed.
      if ((await this.deps.store.getDream(agentId, dreamId))?.status !== 'running') {
        await this.clearStaging(agentId, dreamId)
        return
      }
      await this.finish(agentId, dreamId, {
        status: 'completed',
        ...execution,
        // Candidates start `proposed`; nothing installs them until a human
        // accepts each one individually (design §7).
        ...(proposal.skills.length
          ? {
              skills: proposal.skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                state: 'proposed' as const
              }))
            }
          : {}),
        ...(organizationSuggestions.length ? { organizationSuggestions } : {}),
        usage
      })
      await Promise.resolve(this.deps.onOrganizationSuggestions?.()).catch((err) => {
        this.deps.log.warn(
          `dream ${dreamId}: suggestion inventory sync deferred (${err instanceof Error ? err.name : 'unknown'})`
        )
      })
      this.deps.log.info(`dream ${dreamId} completed for agent ${agentId} (${stagedTopics} staged topics)`)
    } catch (err) {
      this.deps.log.warn(`dream ${dreamId} failed for agent ${agentId}: ${err instanceof Error ? err.name : 'unknown'}`)
      // Fail BOTH pending and running dreams terminally — a failure before the
      // pending→running transition (e.g. the input-snapshot write) must not
      // leave the job stuck non-terminal forever. A cancel still wins (its
      // status is preserved, not overwritten).
      const status = (await this.deps.store.getDream(agentId, dreamId))?.status
      if (status === 'running' || status === 'pending') {
        // Whatever the model already wrote belongs to a run that never completed.
        await this.clearStaging(agentId, dreamId)
        await this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'pipeline_error', message: err instanceof Error ? err.message : 'unknown error' }
        })
      }
    }
  }

  /** Drop every staged byte of a run that will never complete — both layouts, best effort. */
  private async clearStaging(agentId: string, dreamId: string): Promise<void> {
    try {
      const fs = this.fsFor(agentId)
      const base = this.dreamDir(agentId, dreamId)
      await fs.rm(join(base, MEMORY_DIRNAME))
      await fs.rm(join(base, LEGACY_STAGED_DIRNAME))
    } catch {
      // The home may already be unreachable; the dream dir is swept with the record.
    }
  }

  /**
   * Await `deps.extract`, but ABANDON it if a cancel fires and the extraction
   * hasn't settled within `cancelGraceMs`. daemon.ts drives the ACP
   * `session/cancel` on abort; this is the hard backstop for a runtime that
   * ignores it — the runner never waits forever, so a canceled dream's
   * reservation is always released within the grace window even if the prompt
   * never returns. (The orphaned extraction resolves into nothing; its ACP
   * session is discarded daemon-side.)
   */
  private async extractWithBackstop(
    dream: DreamInfo,
    prompt: string,
    signal: AbortSignal,
    inputDir: string,
    stagedStore: MemoryFs,
    mineSkills = false
  ): Promise<({ abandoned: false } & DreamExtractionResult) | { abandoned: true; output: '' }> {
    const graceMs = this.deps.cancelGraceMs ?? 30_000
    const extraction = this.deps
      .extract(dream.agentId, dreamSystemPrompt(mineSkills), prompt, signal, {
        dreamId: dream.dreamId,
        trigger: dream.trigger,
        sessionIds: dream.sessionIds,
        inputDir,
        stagedStore
      })
      .then((result) => ({ abandoned: false as const, ...result }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const backstop = new Promise<{ abandoned: true; output: '' }>((resolve) => {
      const arm = () => {
        timer = setTimeout(() => resolve({ abandoned: true, output: '' }), graceMs)
      }
      if (signal.aborted) arm()
      else signal.addEventListener('abort', arm, { once: true })
    })
    try {
      return await Promise.race([extraction, backstop])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async stage(fs: MemoryFs, base: string, proposal: DreamProposal): Promise<DreamOrganizationSuggestionInfo[]> {
    // The model already wrote its topic files into the staged store through the memory
    // tools, so staging no longer transcribes them — it reads back what landed and
    // renders the index the same way adoption will.
    const out = join(base, MEMORY_DIRNAME)
    const staged: MemoryIndexEntry[] = []
    for (const entry of await fs.readdir(out)) {
      if (entry.kind !== 'file' || entry.name === MEMORY_INDEX || !stagedPathOk(entry.name)) continue
      const raw = await fs.readFile(join(out, entry.name))
      if (raw === null) continue
      const { header } = parseMemoryFrontmatter(raw.content)
      staged.push({
        topic: entry.name,
        name: header.name || memoryNameForTopic(entry.name),
        description: header.description ?? ''
      })
    }
    await fs.writeFile(join(out, MEMORY_INDEX), renderMemoryIndex(staged))
    await this.stageSkills(fs, base, proposal)
    return this.stageOrganizationSuggestions(fs, base, proposal)
  }

  private async stageOrganizationSuggestions(
    fs: MemoryFs,
    base: string,
    proposal: DreamProposal
  ): Promise<DreamOrganizationSuggestionInfo[]> {
    const root = join(base, 'organization')
    await fs.rm(root)
    const candidates = [
      ...proposal.organizationKnowledge.map((candidate) => ({ kind: 'knowledge' as const, candidate })),
      ...proposal.organizationSkills.map((candidate) => ({ kind: 'skill' as const, candidate }))
    ]
    if (candidates.length === 0) return []
    await fs.mkdir(root)
    const createdAt = this.nowIso()
    const metadata: DreamOrganizationSuggestionInfo[] = []
    for (const entry of candidates.slice(0, 32)) {
      const candidateId = randomUUID()
      const body: NonNullable<OrganizationSuggestionContent['body']> =
        entry.kind === 'knowledge'
          ? {
              kind: 'knowledge',
              content: entry.candidate.content,
              ...(entry.candidate.summary !== undefined ? { summary: entry.candidate.summary } : {}),
              ...(entry.candidate.tags.length ? { tags: entry.candidate.tags } : {})
            }
          : { kind: 'skill', files: entry.candidate.files }
      const canonical = organizationSuggestionCanonical(body)
      const serialized = JSON.stringify(body)
      if (
        Buffer.byteLength(canonical) > MAX_ORGANIZATION_SUGGESTION_BODY_BYTES ||
        Buffer.byteLength(serialized) > MAX_ORGANIZATION_SUGGESTION_BODY_BYTES
      ) {
        this.deps.log.warn(`dream organization suggestion exceeded its staged-body size cap; dropping candidate`)
        continue
      }
      const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
      await fs.writeFile(join(root, `${candidateId}.json`), serialized, { mode: 0o600 })
      metadata.push({
        candidateId,
        kind: entry.kind,
        operation: entry.candidate.operation,
        ...(entry.candidate.operation === 'update'
          ? { targetId: entry.candidate.targetId, targetRevision: entry.candidate.targetRevision }
          : {}),
        title: entry.candidate.title,
        ...(entry.candidate.summary !== undefined ? { summary: entry.candidate.summary } : {}),
        ...(entry.kind === 'knowledge' && entry.candidate.tags.length ? { tags: entry.candidate.tags } : {}),
        digest,
        contentBytes: Buffer.byteLength(canonical),
        state: 'proposed',
        sessionIds: entry.candidate.sessionIds,
        createdAt
      })
    }
    return metadata
  }

  /**
   * Stage mined skill candidates as standard skill directories
   * (`skills/<name>/SKILL.md` + `scripts/`), so an accepted one is consumable by
   * the skill machinery without conversion. Separate from `output/` because they
   * have a separate review lifecycle: adopting the store neither accepts nor
   * discards these, and they are NEVER auto-installed (design §7).
   */
  private async stageSkills(fs: MemoryFs, base: string, proposal: DreamProposal): Promise<void> {
    const root = join(base, 'skills')
    await fs.rm(root)
    if (proposal.skills.length === 0) return
    await fs.mkdir(root)
    for (const skill of proposal.skills) {
      // The parser enforced the name shape; re-check because it becomes a path.
      if (!SKILL_DIR_RE.test(skill.name)) continue
      const dir = join(root, skill.name)
      await fs.mkdir(dir)
      if (skill.files?.length) {
        for (const file of skill.files) {
          const target = join(dir, ...file.path.split('/'))
          await fs.mkdir(dirname(target))
          await fs.writeFile(target, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content)
        }
        continue
      }
      // Frontmatter is generated HERE, not taken from the model: name and
      // description are the fields the skill loader keys on, and they must match
      // the validated values the console shows in the recommendation.
      //
      // The description is model-controlled text, so it is SERIALIZED, never
      // interpolated: a bare `Deploy: staging` is invalid YAML, and `[a]` /
      // `{x: y}` / `a # b` would silently parse as a different type or value than
      // the string the reviewer approved. Newlines are folded first so one
      // description can never become two frontmatter lines.
      const description = skill.description.replace(/[\r\n]+/g, ' ').trim()
      const frontmatter = `---\n${stringifyYaml({ name: skill.name, description })}---\n\n`
      const bodySource = Buffer.from(skill.skill.trimEnd(), 'utf8')
      const bodyBudget = Math.max(0, MAX_SKILL_BODY_BYTES - Buffer.byteLength(frontmatter) - 1)
      let bodyEnd = Math.min(bodySource.byteLength, bodyBudget)
      while (bodyEnd > 0 && (bodySource[bodyEnd]! & 0xc0) === 0x80) bodyEnd -= 1
      const body = bodySource.subarray(0, bodyEnd).toString('utf8')
      await fs.writeFile(join(dir, 'SKILL.md'), frontmatter + body + '\n')
      if (skill.scripts.length === 0) continue
      const scriptsDir = join(dir, 'scripts')
      await fs.mkdir(scriptsDir)
      for (const script of skill.scripts) {
        if (!SKILL_SCRIPT_FILE_RE.test(script.path)) continue
        await fs.writeFile(join(scriptsDir, script.path), script.content)
      }
    }
  }

  private async transition(
    agentId: string,
    dreamId: string,
    from: DreamInfo['status'],
    patch: Partial<DreamInfo>
  ): Promise<void> {
    const dream = await this.getDream(agentId, dreamId)
    if (dream.status !== from) return
    await this.deps.store.updateDream({ ...dream, ...patch })
  }

  private async finish(agentId: string, dreamId: string, patch: Partial<DreamInfo>): Promise<void> {
    const dream = await this.getDream(agentId, dreamId)
    const next = { ...dream, ...patch, endedAt: this.nowIso() }
    await this.deps.store.updateDream(next)
    if (next.status === 'completed') this.emitLifecycle({ type: 'memory.dream.completed', dream: next })
    if (next.status === 'failed') this.emitLifecycle({ type: 'memory.dream.failed', dream: next })
  }

  async cancel(agentId: string, dreamId: string): Promise<DreamInfo> {
    const dream = await this.getDream(agentId, dreamId)
    if (dream.status === 'canceled') return dream // idempotent no-op
    if (dream.status !== 'pending' && dream.status !== 'running') {
      throw new DreamStateError(`cannot cancel a ${dream.status} dream`)
    }
    // Flip the status; the run loop observes it (before and after extraction)
    // and drops any output unstaged. We deliberately do NOT release `active`
    // here — the extraction promise may still be resolving, and clearing the
    // reservation early would let a replacement dream overlap it. The run's
    // `finally` releases it once the promise actually settles.
    const canceled: DreamInfo = { ...dream, status: 'canceled', endedAt: this.nowIso() }
    await this.deps.store.updateDream(canceled)
    // Abort the in-flight extraction so daemon.ts drives the host session-cancel
    // path — otherwise a hung/long prompt would pin the reservation forever.
    this.aborters.get(dreamId)?.abort()
    return canceled
  }

  async get(agentId: string, dreamId: string): Promise<DreamInfo> {
    this.dirFor(agentId)
    return await this.getDream(agentId, dreamId)
  }

  /** Dreams whose skill candidates are still awaiting review. */
  async listPendingSkills(agentId: string, limit: number): Promise<DreamInfo[]> {
    this.dirFor(agentId)
    return await this.deps.store.pendingSkillDreams(agentId, limit)
  }

  async list(agentId: string, limit: number): Promise<DreamInfo[]> {
    this.dirFor(agentId)
    return await this.deps.store.listDreams(agentId, limit)
  }

  /**
   * Adopt a completed dream (design §6). Serialized per agent (the lock) against
   * concurrent starts, adopts, and discards. The replacement store — including
   * the carried-over `.history` plus one `source:"dream"` provenance row per
   * changed file — is built entirely in a sibling temp directory FIRST, so `memory/` is
   * never a half-written tree: the visible window is a single rename, and a
   * failure rolls the previous store back. Fenced against post-snapshot writes
   * unless `force`.
   *
   * The non-force fence is authoritative *under the shared memory-dir lock*: the
   * replacement is built first (no touch to `memory/`), then the digest is
   * re-validated and the swap committed while `withMemoryDirLock` excludes every
   * `writeMemoryFile` caller (console, tool, distillation). So a live write can
   * never land between the fence and the swap — a non-forced adoption cannot
   * silently lose a post-snapshot write. When the fence trips, §8's distillation
   * rebase gets one chance to explain the drift: if every post-snapshot
   * `.history` record is distill-sourced, those additions are replayed onto the
   * replacement and adoption proceeds; anything else still refuses.
   */
  async adopt(agentId: string, dreamId: string, force: boolean, reviewToken?: string): Promise<DreamInfo> {
    this.assertStagedContentAllowed()
    const fs = this.fsFor(agentId)
    return this.withLock(agentId, async () => {
      const dream = await this.getDream(agentId, dreamId)
      if (dream.status !== 'completed') throw new DreamStateError(`cannot adopt a ${dream.status} dream`)
      if (this.active.has(agentId)) throw new DreamStateError('a dream is in flight for this agent; wait or cancel it')

      const out = await resolveStagedDir(fs, this.dreamDir(agentId, dreamId))
      const stagedNames = (await fs.readdir(out))
        .filter((entry) => entry.kind === 'file' && stagedPathOk(entry.name))
        .map((entry) => entry.name)
      if (!stagedNames.includes(MEMORY_INDEX)) throw new DreamStateError('this dream has no staged index to adopt')
      // Read the staged bytes once; they define both the replacement and the
      // same-bytes review fence below.
      const stagedFiles = await Promise.all(
        stagedNames.map(async (name) => ({ name, content: (await fs.readFile(join(out, name)))?.content ?? '' }))
      )
      // Same-bytes review fence (task #36 Phase B): when the caller adopts a
      // proposal it reviewed, bind adoption to those exact staged bytes. Any
      // change to the staging since review (a re-run, a distill rebase, manual
      // edit) yields a different digest, so adoption is refused and the user must
      // re-review the current proposal rather than silently adopt un-reviewed
      // content. Auto-adopt passes no token (it opted out of content review).
      if (reviewToken !== undefined && storeDigest(stagedFiles) !== reviewToken) {
        throw new DreamStateError(
          'the staged proposal changed since it was reviewed; re-review the current proposal before adopting'
        )
      }

      const live = MEMORY_DIRNAME
      const at = this.nowIso()

      // 1) Build the proposed files in a temp sibling dir. `memory/` is
      //    untouched. History is added later under the shared lock so every
      //    `before` snapshot describes the exact store the swap replaces.
      const replacement = `.memory.adopting-${dreamId}`
      await fs.rm(replacement)
      await fs.mkdir(replacement)
      for (const file of stagedFiles) {
        await fs.writeFile(join(replacement, file.name), file.content)
      }

      // 2) Fence + swap under the shared memory-dir lock, so no writeMemoryFile
      //    caller can interleave between the digest re-check and the rename.
      try {
        return await withMemoryDirLock(fs, async () => {
          const liveFiles = await this.readLiveStore(fs)
          if (!force) {
            const liveDigest = storeDigest(liveFiles)
            if (liveDigest !== dream.snapshotDigest) {
              // §8 distillation rebase: additive per-turn capture may have landed
              // while the dream ran. When EVERY post-snapshot write was
              // distill-sourced, replay those additions onto the replacement and
              // adopt; any tool/console write still hard-fences to review.
              const rebased = await this.rebaseDistillWrites(fs, dream, replacement)
              // `0` is a SUCCESSFUL rebase (every addition was already folded in
              // by the dream) — only `null` means the drift wasn't distill-only.
              if (rebased === null) {
                throw new DreamStateError(
                  'the live store changed since this dream was snapshotted; rerun the dream or force'
                )
              }
              this.deps.log.info(`dream ${dreamId}: rebased ${rebased} distilled line(s) onto the staged store`)
            }
          }

          // Canonicalize the exact live history before adding adoption rows. A
          // legacy final row without a newline (or a torn tail) must not absorb
          // the first dream row. Build a full add/update/delete change set from
          // the store that is about to be replaced, skipping unchanged files.
          let history = await snapshotMemoryHistoryHoldingLock(fs)
          const beforeByPath = new Map(liveFiles.map((file) => [file.name, file.content]))
          const afterFiles = (await fs.readdir(replacement))
            .filter((entry) => entry.kind === 'file' && stagedPathOk(entry.name))
            .map((entry) => entry.name)
          const afterByPath = new Map<string, string>()
          for (const name of afterFiles) {
            afterByPath.set(name, (await fs.readFile(join(replacement, name)))?.content ?? '')
          }
          const changedPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
          for (const path of [...changedPaths].sort((a, b) => a.localeCompare(b))) {
            const before = beforeByPath.get(path)
            const after = afterByPath.get(path)
            if (before === after) continue

            const beforeClamped = before === undefined ? undefined : clampMemoryHistoryValue(before)
            const afterClamped = clampMemoryHistoryValue(after ?? '')
            const record: MemoryHistoryRecord = {
              id: randomUUID(),
              path,
              event: before === undefined ? 'add' : after === undefined ? 'delete' : 'update',
              ...(beforeClamped ? { before: beforeClamped.value } : {}),
              after: afterClamped.value,
              at,
              scope: 'agent',
              source: 'dream',
              ...(beforeClamped?.truncated || afterClamped.truncated ? { truncated: true } : {})
            }
            history += JSON.stringify(record) + '\n'
          }
          await fs.writeFile(join(replacement, MEMORY_HISTORY_FILENAME), history, { mode: 0o600 })

          // Preserve the "last meaningfully changed" time of files the dream left
          // byte-for-byte unchanged. The whole store is rebuilt into `replacement`
          // and swapped in, so without this EVERY topic would show the adoption
          // time as its updated time even when the dream didn't touch it. Files
          // whose content actually changed (or are new) keep the fresh mtime.
          const liveMtimes = new Map((await listMemory(fs)).map((file) => [file.name, file.mtime]))
          for (const [path, after] of afterByPath) {
            if (beforeByPath.get(path) !== after) continue
            const liveMtime = liveMtimes.get(path)
            // Live file gone — leave the fresh adoption mtime.
            if (liveMtime) await fs.utimes(join(replacement, path), liveMtime).catch(() => {})
          }

          const backupsRoot = BACKUPS_DIRNAME
          await fs.mkdir(backupsRoot)
          const backup = join(backupsRoot, `${at.replace(/[:.]/g, '-')}-pre-${dreamId}`)
          // false ⇒ brand-new store: nothing to back up
          const hadLiveStore = await fs.rename(live, backup)
          try {
            await fs.rename(replacement, live)
          } catch (err) {
            // Roll back to the previous store and drop the temp; the dream stays
            // `completed` and reviewable.
            if (hadLiveStore) await fs.rename(backup, live).catch(() => {})
            await fs.rm(replacement).catch(() => {})
            throw err
          }
          // This swap rewrote the store without going through `writeMemoryFile`,
          // so the ledger would not otherwise see it. Record it as a NON-distill
          // mutation (still inside the lock): a second dream staged from the same
          // snapshot must fence on this adoption rather than classify it as
          // distill-only drift and roll over it.
          recordExternalMemoryMutation(fs, 'dream')
          // The adopted store has a hand-authored MEMORY.md while ordinary writes
          // regenerate it from the topic descriptions — two writers with no defined
          // precedence. Settle it here, inside the same lock: if the adopted topics
          // give the generator anything to work with, it owns the index from now on
          // instead of silently replacing the dream's copy at some later write.
          await regenerateMemoryIndexHoldingLock(fs, 'dream').catch(() => {})
          // Dream adoption copies history as part of the atomic store swap, so
          // tighten that copied/appended sidecar before releasing the same lock.
          await enforceMemoryHistoryRetentionHoldingLock(fs).catch(() => {})

          // The backup is the undo path for THIS adoption; older ones superseded.
          if (hadLiveStore) {
            for (const entry of await fs.readdir(backupsRoot)) {
              if (join(backupsRoot, entry.name) !== backup) await fs.rm(join(backupsRoot, entry.name))
            }
          }

          const adoptedAt = this.nowIso()
          const adopted: DreamInfo = {
            ...(await this.getDream(agentId, dreamId)),
            status: 'adopted',
            endedAt: adoptedAt
          }
          await this.deps.store.updateDream(adopted)
          this.emitLifecycle({ type: 'memory.dream.adopted', dream: adopted })
          const superseded = await this.supersedeCompletedDreams(agentId, dreamId, adoptedAt)
          this.deps.log.info(
            `dream ${dreamId} adopted for agent ${agentId} (${stagedFiles.length} files, ${superseded} competing proposal(s) superseded)`
          )
          return adopted
        })
      } finally {
        // If the fence refused (or a failure escaped the swap), never leave the
        // temp replacement lying around.
        await fs.rm(replacement).catch(() => {})
      }
    })
  }

  /**
   * Adopt a just-completed dream without review when the agent opted in
   * (`dreaming.autoAdopt`). The user explicitly opted in to accepting completed
   * results without review, so the runtime's system-prompt transport does not add a second
   * review gate. Never throws — a live-memory fence conflict or failed swap
   * still leaves the dream `completed` and awaiting review.
   */
  private async maybeAutoAdopt(agentId: string, dreamId: string): Promise<void> {
    const dream = await this.deps.store.getDream(agentId, dreamId)
    if (dream?.status !== 'completed') return
    const policy = this.deps.dreamingPolicyFor(agentId)
    if (!policy?.autoAdopt) return
    try {
      // Never force: a fence conflict the rebase can't explain must still fall
      // back to human review rather than clobber a live tool/console write.
      await this.adopt(agentId, dreamId, false)
      this.deps.log.info(`dream ${dreamId} auto-adopted for agent ${agentId}`)
    } catch (err) {
      this.deps.log.warn(
        `dream ${dreamId}: auto-adopt did not apply for agent ${agentId} (${err instanceof Error ? err.message : 'unknown'}); left for review`
      )
    }
  }

  /**
   * §8 distillation rebase. Called under the memory-dir lock when the adoption
   * fence trips. Returns the number of replayed lines when the drift was
   * distill-only (the replacement has been patched in place and adoption may
   * proceed), or `null` when it must hard-fence to human review.
   *
   * Two independent halves:
   *
   *  - **Authorization** comes from the in-process write ledger
   *    ({@link memoryWriteMarks}), not from `.history`. `appendHistory` is
   *    best-effort by design — it swallows its own failures so logging can never
   *    fail a write — so a tool write whose append was lost would be invisible
   *    there, and a later distill append would make the window look distill-only.
   *    The ledger is bumped inside the write under this same lock, so it cannot
   *    drop an entry. Counters that moved backwards (a daemon restart cleared
   *    them) are unprovable, so they fail closed.
   *  - **Content** comes from diffing the live store against this dream's own
   *    `input/` snapshot. Distillation is additive by construction, so whatever
   *    is in live but not in the snapshot is exactly what capture added.
   *
   * The result is re-checked against the store's byte caps: a rebase must never
   * produce a file the ordinary write path would reject.
   */
  private async rebaseDistillWrites(fs: MemoryFs, dream: DreamInfo, replacement: string): Promise<number | null> {
    const snapshot = dream.snapshotWrites
    // A dream recorded before this field existed can't be reasoned about.
    if (!snapshot) return null
    const now = memoryWriteMarks(fs)
    // A different generation means these counts were recorded by another daemon
    // process; they are not comparable at all. Numeric comparison cannot stand in
    // for this — a {0,0} snapshot never moves backwards, and any older snapshot
    // is eventually caught up by new writes, which would let a pre-restart tool
    // edit be reclassified as post-restart distillation.
    if (now.generation !== snapshot.generation) return null
    // Backwards within a generation should be impossible; treat it as unprovable.
    if (now.total < snapshot.total || now.nonDistill < snapshot.nonDistill) return null
    // A tool/console/dream write landed in the window — never roll over it.
    if (now.nonDistill !== snapshot.nonDistill) return null
    // The digest differs but no write was recorded: something mutated the store
    // outside `writeMemoryFile`. Unexplained ⇒ refuse.
    if (now.total === snapshot.total) return null

    const input = join(this.dreamDir(dream.agentId, dream.dreamId), 'input')
    const readOr = async (base: string, name: string): Promise<string> =>
      (await fs.readFile(join(base, name)))?.content ?? ''

    // Dedup against everything already staged — the dream has very likely folded
    // the same fact in already (it mined the same transcripts).
    const known = new Set<string>()
    for (const entry of await fs.readdir(replacement)) {
      if (entry.kind !== 'file' || !stagedPathOk(entry.name)) continue
      for (const line of (await readOr(replacement, entry.name)).split('\n')) {
        const value = normalizeMemoryLine(line)
        if (value) known.add(value)
      }
    }

    let replayed = 0
    for (const file of await listMemory(fs)) {
      const name = file.name
      if (!stagedPathOk(name)) return null // an unexpected name ⇒ refuse
      const before = new Set(
        (await readOr(input, name))
          .split('\n')
          .map(normalizeMemoryLine)
          .filter((v): v is string => !!v)
      )
      const additions: string[] = []
      for (const line of (await readMemoryFile(fs, name)).split('\n')) {
        const value = normalizeMemoryLine(line)
        if (!value || before.has(value) || known.has(value)) continue
        additions.push(line.trimEnd())
        known.add(value)
      }
      if (additions.length === 0) continue

      const current = await readOr(replacement, name)
      const next = `${current.trimEnd()}${current.trim() ? '\n' : ''}${additions.join('\n')}\n`
      // The swap bypasses `writeMemoryFile`, so re-enforce its cap here: an
      // at-capacity staged file plus one replayed line must not adopt a store
      // that later managed writes would be unable to update.
      const cap = name === MEMORY_INDEX ? MAX_INDEX_INJECT_BYTES : MAX_MEMORY_FILE_BYTES
      if (Buffer.byteLength(next) > cap) return null
      await fs.writeFile(join(replacement, name), next)
      replayed += additions.length
    }
    // Zero replayed lines is still a successful rebase — the drift was
    // distill-only and every addition was already represented.
    return replayed
  }

  /** Discard a terminal dream's staging. Keeps the job record for history.
   *  Serialized per agent so it can't race an adopt reading the same staging. */
  async discard(agentId: string, dreamId: string): Promise<DreamInfo> {
    this.assertStagedContentAllowed()
    this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const dream = await this.getDream(agentId, dreamId)
      if (dream.status === 'discarded') return dream // idempotent no-op
      if (dream.status !== 'completed' && dream.status !== 'failed' && dream.status !== 'canceled') {
        throw new DreamStateError(`cannot discard a ${dream.status} dream`)
      }
      await this.removeStoreStaging(agentId, dream)
      const discarded: DreamInfo = { ...dream, status: 'discarded', endedAt: this.nowIso() }
      await this.deps.store.updateDream(discarded)
      return discarded
    })
  }

  /** Adoption changes the live store, so every other completed proposal is now
   *  fenced by definition. Make that invalidation explicit and remove only its
   *  memory-store staging; proposed skills remain independently reviewable. */
  private async supersedeCompletedDreams(agentId: string, adoptedDreamId: string, adoptedAt: string): Promise<number> {
    this.assertStagedContentAllowed()
    const candidates = (await this.deps.store.completedDreams(agentId)).filter(
      (dream) => dream.dreamId !== adoptedDreamId
    )
    for (const dream of candidates) {
      await this.deps.store.updateDream({ ...dream, status: 'superseded', endedAt: adoptedAt })
    }
    for (const dream of candidates) {
      await this.removeStoreStaging(agentId, dream).catch((err) => {
        this.deps.log.warn(
          `dream ${dream.dreamId}: could not remove superseded store staging (${err instanceof Error ? err.message : 'unknown'})`
        )
      })
    }
    return candidates.length
  }

  /** Skills have an INDEPENDENT review lifecycle (design §7): removing a store
   *  proposal must not destroy a candidate the user has not ruled on. */
  private async removeStoreStaging(agentId: string, dream: DreamInfo): Promise<void> {
    this.assertStagedContentAllowed()
    const fs = this.fsFor(agentId)
    const base = this.dreamDir(agentId, dream.dreamId)
    const pending =
      (dream.skills ?? []).some((skill) => skill.state === 'proposed') ||
      (dream.organizationSuggestions ?? []).some((suggestion) => suggestion.state === 'proposed')
    if (pending) {
      for (const part of ['input', MEMORY_DIRNAME, LEGACY_STAGED_DIRNAME]) await fs.rm(join(base, part))
    } else {
      await fs.rm(base)
    }
  }

  /** Accept a mined skill by publishing an immutable bounded local-source
   * revision under the daemon-owned agent root. Workspace materialization is
   * deferred to the unified installer and the warm host is fenced first. */
  async skillAccept(agentId: string, dreamId: string, name: string, reviewToken?: string): Promise<DreamInfo> {
    this.assertStagedContentAllowed()
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const { dream, skill } = await this.skillCandidate(agentId, dreamId, name)
      if (skill.state === 'accepted') return dream // idempotent
      if (skill.state === 'dismissed') throw new DreamStateError('this skill candidate was already dismissed')

      // Same-bytes review fence (task #36 Phase B): bind acceptance to the exact
      // staged skill bytes the caller reviewed. The check runs INSIDE
      // publishAcceptedDreamSkill against its own capture snapshot (not a separate
      // preflight inspection), so a concurrent writer cannot swap the staged bytes
      // between inspection and capture — the digest verified is the digest that is
      // actually pinned and published.
      const publish = async (): Promise<void> => {
        const staged = await this.localStagedSkill(agentId, dreamId, name)
        try {
          await publishAcceptedDreamSkill({ agentDir: dir, sourceDir: staged.path, name, expectedDigest: reviewToken })
        } finally {
          await staged.dispose()
        }
      }
      if (this.deps.withSkillAcceptance) await this.deps.withSkillAcceptance(agentId, publish)
      else await publish()

      const next = await this.setSkillState(agentId, dreamId, name, 'accepted')
      this.emitLifecycle({ type: 'memory.dream.skill_accepted', dream: next, skillName: name })
      await this.sweepReviewedStaging(agentId, next)
      this.deps.log.info(`dream ${dreamId}: accepted skill "${name}" for agent ${agentId}`)
      return next
    })
  }

  /** Dismiss one candidate: drop its staging and record the decision, so later
   *  dreams can be told not to propose it again. */
  async skillDismiss(agentId: string, dreamId: string, name: string): Promise<DreamInfo> {
    this.assertStagedContentAllowed()
    this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const { dream, skill } = await this.skillCandidate(agentId, dreamId, name)
      if (skill.state === 'dismissed') return dream // idempotent
      if (skill.state === 'accepted') throw new DreamStateError('this skill candidate was already accepted')
      await this.fsFor(agentId).rm(join(this.dreamDir(agentId, dreamId), 'skills', name))
      const next = await this.setSkillState(agentId, dreamId, name, 'dismissed')
      this.emitLifecycle({ type: 'memory.dream.skill_dismissed', dream: next, skillName: name })
      await this.sweepReviewedStaging(agentId, next)
      return next
    })
  }

  /** Names the user has already declined across this agent's past dreams, so the
   *  next mining prompt can be told not to re-propose them (design §7). */
  private async dismissedSkillNames(agentId: string): Promise<string[]> {
    const names = new Set<string>()
    for (const dream of await this.deps.store.listDreams(agentId, 50)) {
      for (const skill of dream.skills ?? []) {
        if (skill.state === 'dismissed') names.add(skill.name)
      }
    }
    return [...names]
  }

  /** A discarded or superseded dream keeps its candidate staging while either
   *  review lifecycle is pending; once every local and organization candidate
   *  is terminal there is nothing left to inspect. */
  private async sweepReviewedStaging(agentId: string, dream: DreamInfo): Promise<void> {
    this.assertStagedContentAllowed()
    if (dream.status !== 'discarded' && dream.status !== 'superseded') return
    if ((dream.skills ?? []).some((skill) => skill.state === 'proposed')) return
    if ((dream.organizationSuggestions ?? []).some((suggestion) => suggestion.state === 'proposed')) return
    await this.fsFor(agentId)
      .rm(this.dreamDir(agentId, dream.dreamId))
      .catch(() => {})
  }

  private async skillCandidate(
    agentId: string,
    dreamId: string,
    name: string
  ): Promise<{ dream: DreamInfo; skill: NonNullable<DreamInfo['skills']>[number] }> {
    const dream = await this.getDream(agentId, dreamId)
    const skill = dream.skills?.find((candidate) => candidate.name === name)
    if (!skill) throw new DreamViolationError(`unknown skill candidate ${name}`)
    return { dream, skill }
  }

  private async setSkillState(
    agentId: string,
    dreamId: string,
    name: string,
    state: 'accepted' | 'dismissed'
  ): Promise<DreamInfo> {
    const dream = await this.getDream(agentId, dreamId)
    const next: DreamInfo = {
      ...dream,
      skills: (dream.skills ?? []).map((skill) => (skill.name === name ? { ...skill, state } : skill))
    }
    await this.deps.store.updateDream(next)
    return next
  }

  /** Staged skill candidates for the review screen (name → its staged files). */
  async stagedSkill(
    agentId: string,
    dreamId: string,
    name: string
  ): Promise<{
    skill: string
    scripts: { path: string; content: string }[]
  } | null> {
    this.assertStagedContentAllowed()
    await this.skillCandidate(agentId, dreamId, name)
    const fs = this.fsFor(agentId)
    const dir = join(this.dreamDir(agentId, dreamId), 'skills', name)
    const skill = (await fs.readFile(join(dir, 'SKILL.md')))?.content
    if (skill === undefined) return null
    const scripts: { path: string; content: string }[] = []
    for (const entry of await fs.readdir(join(dir, 'scripts'))) {
      if (entry.kind !== 'file' || !SKILL_SCRIPT_FILE_RE.test(entry.name)) continue
      const script = await fs.readFile(join(dir, 'scripts', entry.name))
      if (script) scripts.push({ path: entry.name, content: script.content })
    }
    scripts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { skill, scripts }
  }

  /** Metadata inventory sent on Dream completion and every CP reconnect. */
  async organizationSuggestionInventory(): Promise<
    Array<DreamOrganizationSuggestionInfo & { sourceAgentId: string; dreamId: string }>
  > {
    return (await this.deps.store.organizationSuggestionDreams(256))
      .flatMap((dream) =>
        (dream.organizationSuggestions ?? [])
          .filter((suggestion) => suggestion.state === 'proposed')
          .map((suggestion) => ({
            ...suggestion,
            sourceAgentId: dream.agentId,
            dreamId: dream.dreamId
          }))
      )
      .slice(0, 256)
  }

  async organizationSuggestionRead(req: OrganizationSuggestionReadReq): Promise<OrganizationSuggestionChunk> {
    this.assertStagedContentAllowed()
    const dream = await this.getDream(req.sourceAgentId, req.dreamId)
    const suggestion = dream.organizationSuggestions?.find((candidate) => candidate.candidateId === req.candidateId)
    const absent = {
      sourceAgentId: req.sourceAgentId,
      dreamId: req.dreamId,
      candidateId: req.candidateId,
      digest: suggestion?.digest ?? `sha256:${'0'.repeat(64)}`,
      exists: false as const,
      size: 0,
      offset: 0,
      nextOffset: 0,
      data: '',
      truncated: false
    }
    if (!suggestion || suggestion.kind !== req.kind || suggestion.state !== 'proposed') return absent
    try {
      const staged = await this.fsFor(req.sourceAgentId).readFile(
        join(this.dreamDir(req.sourceAgentId, req.dreamId), 'organization', `${req.candidateId}.json`)
      )
      if (!staged) return absent
      const raw = Buffer.from(staged.content, 'utf8')
      if (raw.byteLength > MAX_ORGANIZATION_SUGGESTION_BODY_BYTES) return absent
      const parsed = OrganizationSuggestionContentBody.safeParse(JSON.parse(raw.toString('utf8')))
      if (!parsed.success || parsed.data.kind !== suggestion.kind) return absent
      const actualDigest = `sha256:${createHash('sha256').update(organizationSuggestionCanonical(parsed.data)).digest('hex')}`
      if (actualDigest !== suggestion.digest) return absent
      if (req.offset > raw.byteLength) throw new DreamViolationError('organization suggestion offset exceeds body size')
      const end = Math.min(raw.byteLength, req.offset + req.limit)
      return {
        ...absent,
        digest: suggestion.digest,
        exists: true,
        size: raw.byteLength,
        offset: req.offset,
        nextOffset: end,
        data: raw.subarray(req.offset, end).toString('base64'),
        truncated: end < raw.byteLength
      }
    } catch (err) {
      if (err instanceof SyntaxError) return absent
      throw err
    }
  }

  async organizationSuggestionReview(req: OrganizationSuggestionReviewReq): Promise<Ack> {
    this.assertStagedContentAllowed()
    const dream = await this.getDream(req.sourceAgentId, req.dreamId)
    const suggestion = dream.organizationSuggestions?.find((candidate) => candidate.candidateId === req.candidateId)
    if (!suggestion) throw new DreamViolationError(`unknown organization suggestion ${req.candidateId}`)
    if (suggestion.state !== 'proposed' && suggestion.state !== req.state) {
      throw new DreamStateError(`organization suggestion is already ${suggestion.state}`)
    }
    let reviewed = dream
    if (suggestion.state !== req.state) {
      reviewed = {
        ...dream,
        organizationSuggestions: (dream.organizationSuggestions ?? []).map((candidate) =>
          candidate.candidateId === req.candidateId ? { ...candidate, state: req.state } : candidate
        )
      }
      await this.deps.store.updateDream(reviewed)
    }
    // Terminal metadata is retained for reconnect/history, but the unapproved
    // daemon-local body is no longer needed once the central decision commits.
    await this.fsFor(req.sourceAgentId).rm(
      join(this.dreamDir(req.sourceAgentId, req.dreamId), 'organization', `${req.candidateId}.json`)
    )
    await this.sweepReviewedStaging(req.sourceAgentId, reviewed)
    await Promise.resolve(this.deps.onOrganizationSuggestions?.()).catch(() => undefined)
    return { ok: true }
  }

  /** Staged output listing for the review screen. Missing staging is DATA. */
  async stagedFiles(agentId: string, dreamId: string): Promise<{ name: string; size: number; mtime: string }[] | null> {
    this.assertStagedContentAllowed()
    await this.getDream(agentId, dreamId)
    const out = await resolveStagedDir(this.fsFor(agentId), this.dreamDir(agentId, dreamId))
    // A staged store always carries its index, so no entries means no staging (absent is data).
    const staged = (await this.fsFor(agentId).readdir(out)).filter(
      (entry) => entry.kind === 'file' && stagedPathOk(entry.name)
    )
    if (staged.length === 0) return null
    staged.sort((a, b) => (a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)))
    const entries = []
    for (const entry of staged) {
      // A file can vanish between readdir and stat if a cancel/discard is
      // removing the staging concurrently — skip it rather than throw.
      if (entry.size === undefined || entry.mtime === undefined) continue
      entries.push({ name: entry.name, size: entry.size, mtime: entry.mtime })
    }
    return entries
  }

  /** Whole staged file text, or null when absent. Byte-slicing for the wire is
   *  the CP adapter's concern (cp/dream-reader.ts), mirroring memory-reader. */
  async stagedRead(agentId: string, dreamId: string, path: string): Promise<{ content: string; mtime: string } | null> {
    this.assertStagedContentAllowed()
    await this.getDream(agentId, dreamId)
    if (!stagedPathOk(path)) throw new DreamViolationError('staged memory paths are plain kebab-case .md names')
    const stagedDir = await resolveStagedDir(this.fsFor(agentId), this.dreamDir(agentId, dreamId))
    const file = await this.fsFor(agentId).readFile(join(stagedDir, path))
    return file ? { content: file.content, mtime: file.mtime } : null
  }

  /** Review token for the staged memory-store proposal: the digest the console
   *  reviewed, which `adopt(reviewToken)` re-verifies against the exact staged
   *  bytes before swapping (task #36 Phase B). `null` when nothing is staged.
   *  Uses the same canonical `storeDigest` the adopt fence recomputes. */
  async stagedStoreReviewToken(agentId: string, dreamId: string): Promise<string | null> {
    this.assertStagedContentAllowed()
    await this.getDream(agentId, dreamId)
    const fs = this.fsFor(agentId)
    const out = await resolveStagedDir(fs, this.dreamDir(agentId, dreamId))
    const names = (await fs.readdir(out))
      .filter((entry) => entry.kind === 'file' && stagedPathOk(entry.name))
      .map((entry) => entry.name)
    if (names.length === 0) return null
    const files = await Promise.all(
      names.map(async (name) => ({ name, content: (await fs.readFile(join(out, name)))?.content ?? '' }))
    )
    return storeDigest(files)
  }

  /** Review token for a staged skill candidate: the canonical snapshot digest the
   *  console reviewed, which `skillAccept(reviewToken)` re-verifies against the
   *  captured publish snapshot (task #36 Phase B). `inspectLocalSkillSource` uses
   *  the same walker + digest as the publish snapshot, so the token matches the
   *  bytes that would be published. `null` when the candidate has no staging. */
  async stagedSkillReviewToken(agentId: string, dreamId: string, name: string): Promise<string | null> {
    this.assertStagedContentAllowed()
    await this.skillCandidate(agentId, dreamId, name)
    const staged = await this.localStagedSkill(agentId, dreamId, name)
    try {
      return (await inspectLocalSkillSource(staged.path)).sha256
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    } finally {
      await staged.dispose()
    }
  }

  /**
   * A staged skill candidate as a LOCAL directory for the skill snapshot walker: a temp copy pulled
   * through the port (a mined skill is bounded — a SKILL.md and a few scripts). Callers dispose it.
   */
  private async localStagedSkill(
    agentId: string,
    dreamId: string,
    name: string
  ): Promise<{ path: string; dispose: () => Promise<void> }> {
    const fs = this.fsFor(agentId)
    const rel = join(this.dreamDir(agentId, dreamId), 'skills', name)
    const temp = await mkdtemp(join(tmpdir(), 'agentconnect-dream-skill-'))
    const dispose = () => rm(temp, { recursive: true, force: true }).catch(() => {})
    try {
      const copy = async (from: string, to: string): Promise<boolean> => {
        const entries = await fs.readdir(from)
        if (entries.length === 0) return false
        await mkdir(to, { recursive: true })
        for (const entry of entries) {
          if (entry.kind === 'dir') await copy(join(from, entry.name), join(to, entry.name))
          else if (entry.kind === 'file') {
            const file = await fs.readFile(join(from, entry.name), 'base64')
            if (file) await writeFile(join(to, entry.name), Buffer.from(file.content, 'base64'))
          }
        }
        return true
      }
      // Absent staging is reported the way a missing local dir is: ENOENT from the walker.
      if (!(await copy(rel, join(temp, name)))) await rm(join(temp, name), { recursive: true, force: true })
      return { path: join(temp, name), dispose }
    } catch (err) {
      await dispose()
      throw err
    }
  }
}
