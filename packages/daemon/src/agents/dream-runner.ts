import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type {
  Ack,
  DreamInfo,
  DreamOrganizationSuggestionInfo,
  DreamTrigger,
  KnowledgeSearchItem,
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
import {
  MEMORY_INDEX,
  MEMORY_HISTORY_FILENAME,
  MAX_INDEX_INJECT_BYTES,
  MAX_MEMORY_FILE_BYTES,
  clampMemoryHistoryValue,
  enforceMemoryHistoryRetentionHoldingLock,
  listMemory,
  memoryDir,
  memoryWriteMarks,
  recordExternalMemoryMutation,
  readMemoryFile,
  snapshotMemoryHistoryHoldingLock,
  type MemoryHistoryRecord,
  withMemoryDirLock
} from './memory.js'
import {
  buildDreamExplorationPrompt,
  dreamSessionFileName,
  renderDreamSessionFile,
  dreamSystemPrompt,
  MAX_SKILL_BODY_BYTES,
  parseDreamProposal,
  storeDigest,
  type DreamProposal,
  type DreamTranscriptSource,
  type TrustedOrganizationSkillTarget
} from './memory-dreamer.js'
import { publishAcceptedDreamSkill } from '../skills/dream-skills.js'
import { inspectLocalSkillSource } from '../skills/skill-source-snapshot.js'

/**
 * `DreamRunner` — the daemon's dream-job engine (design:
 * docs/designs/memory-dreaming.md §4/§6). One dream at a time per agent:
 * snapshot the managed store, mine recent transcripts, run the isolated
 * extraction session, validate, and stage the proposed store under
 * `<agent-root>/memory-dreams/<dreamId>/`. The live store changes only in
 * {@link DreamRunner.adopt} — an explicit, fenced, reversible swap.
 *
 * The runner owns dream policy and filesystem staging; it does NOT know how
 * the extraction session is created (trusted-channel mechanics live in
 * daemon.ts and arrive as the injected `extract`), and it never logs memory
 * or transcript bodies.
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

/** One fail-closed policy covers every operation that can execute a Dream or
 * touch staged model output. Only daemon tests with an injected host factory,
 * and standalone deterministic runner tests, may opt into `test-only`. */
export type DreamOperationPolicy = 'blocked' | 'test-only'

export interface DreamStorePort {
  insertDream(dream: DreamInfo): void
  updateDream(dream: DreamInfo): void
  getDream(agentId: string, dreamId: string): DreamInfo | undefined
  listDreams(agentId: string, limit: number): DreamInfo[]
  /** Dreams still holding an unreviewed skill candidate, independent of the
   *  bounded history page — a proposal outlives the store lifecycle. */
  pendingSkillDreams(agentId: string, limit: number): DreamInfo[]
  /** Non-terminal dreams (pending|running) for crash recovery at boot. */
  openDreams(): DreamInfo[]
  /** Every completed store proposal for one agent, without the public list cap. */
  completedDreams(agentId: string): DreamInfo[]
  /** Proposals reconciled as superseded during a store upgrade. */
  supersededDreams(): DreamInfo[]
  /** Dreams still carrying a proposed organization suggestion, newest first. */
  organizationSuggestionDreams(limit: number): DreamInfo[]
  /** Newest-first addressable sessions for the agent (transcript sources). */
  dreamSessionSources(
    agentId: string,
    limit: number
  ): { sessionId: string; channel: string; thread: string; transportScope?: string | null }[]
  /** Is this session excluded from agent-memory capture (session-visibility.md §5.1)? */
  isCaptureExcluded(acpSessionId: string | undefined): boolean
  /** Chronological text rows of one session thread, scoped to the agent. */
  dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number,
    /** Include tool TITLES too — the trajectory skill mining reads (never bodies). */
    includeTools?: boolean,
    transportScope?: string | null
  ): { sender: string; text: string; kind?: string; input?: string }[]
}

export interface DreamExtractionResult {
  output: string
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
  agentDirByAgent(agentId: string): string | undefined
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
    context: { dreamId: string; trigger: DreamTrigger; sessionIds: string[]; inputDir: string }
  ): Promise<DreamExtractionResult>
  /** Metadata-only lifecycle tap. Observer failures are contained by the
   *  runner and can never change the job outcome. */
  onEvent?(event: DreamLifecycleEvent): void
  /** Dream-only, on-demand CP retrieval. Failure is non-fatal and produces an
   * empty context; ordinary agent turns never call this seam. */
  findOrganizationKnowledge?(agentId: string, query: string): Promise<KnowledgeSearchItem[]>
  /** Exact managed-skill targets from the CP-authored AgentSpec. */
  managedSkillsFor?(agentId: string): TrustedOrganizationSkillTarget[]
  /** Best-effort inventory convergence after completion/review. */
  onOrganizationSuggestions?(): void | Promise<void>
  /** Fence a warm runtime after a new accepted local source becomes active. */
  /** Hold the daemon's per-agent host/admission gate while accepted source
   * publication runs. Tests without a live host may omit this seam. */
  withSkillAcceptance?(agentId: string, publish: () => Promise<void>): Promise<void>
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

const DEFAULT_SESSION_WINDOW = 20
const TRANSCRIPT_ROWS_PER_SESSION = 200
const DREAMS_DIRNAME = 'memory-dreams'
const BACKUPS_DIRNAME = 'memory-backups'
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

  constructor(private readonly deps: DreamRunnerDeps) {
    // Crash recovery: a dream that was pending|running when the daemon died can
    // never complete (its extraction session is gone). Fail it, keep the staging
    // for inspection.
    for (const dream of this.deps.store.openDreams()) {
      const failed: DreamInfo = {
        ...dream,
        status: 'failed',
        error: { type: 'daemon_restart', message: 'the daemon restarted while this dream was in flight' },
        endedAt: this.nowIso()
      }
      this.deps.store.updateDream(failed)
      this.emitLifecycle({ type: 'memory.dream.failed', dream: failed })
    }
    // The LocalStore migration marks proposals stranded by adoptions made on an
    // older daemon. Their metadata is already safe; sweep the corresponding
    // store staging now that the runner can resolve agent directories. Proposed
    // skills keep their independent review lifecycle.
    if (this.operationsAllowed()) {
      for (const dream of this.deps.store.supersededDreams()) {
        if (!this.deps.agentDirByAgent(dream.agentId)) continue
        void this.removeStoreStaging(dream.agentId, dream).catch((err) => {
          this.deps.log.warn(
            `dream ${dream.dreamId}: could not remove superseded store staging (${err instanceof Error ? err.message : 'unknown'})`
          )
        })
      }
    }
  }

  private operationsAllowed(): boolean {
    return this.deps.operationPolicy === 'test-only'
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

  private dreamDir(agentId: string, dreamId: string): string {
    return join(this.dirFor(agentId), DREAMS_DIRNAME, dreamId)
  }

  private getDream(agentId: string, dreamId: string): DreamInfo {
    const dream = this.deps.store.getDream(agentId, dreamId)
    if (!dream) throw new DreamViolationError(`unknown dream ${dreamId}`)
    return dream
  }

  /** Start a dream. Rejects when dreaming is not enabled for the agent or one
   *  is already in flight. Returns immediately with the `pending` record; the
   *  pipeline runs asynchronously (poll via get/list, as the console does). */
  async start(
    agentId: string,
    opts: { trigger: DreamTrigger; sessionWindow?: number; instructions?: string }
  ): Promise<DreamInfo> {
    // This must precede agent lookup, policy resolution, snapshots, corpus
    // selection, reservation, and persistence. A blocked production request is
    // observationally equivalent to never having started a Dream.
    this.assertExecutionAllowed()
    const dir = this.dirFor(agentId)
    const policy = this.deps.dreamingPolicyFor(agentId)
    if (!policy?.enabled) {
      throw new DreamStateError('dreaming is not enabled for this agent (managed provider + dreaming.enabled required)')
    }

    // Reserve + snapshot under the per-agent lock, so the "one in flight" check
    // and the live-store read cannot interleave with a concurrent start or an
    // adopt swap. The lock is released once the run is scheduled; the run then
    // proceeds asynchronously, holding only `active`.
    return this.withLock(agentId, async () => {
      if (this.active.has(agentId)) {
        throw new DreamStateError('a dream is already in flight for this agent')
      }
      const sessionWindow = opts.sessionWindow ?? policy.sessionWindow ?? DEFAULT_SESSION_WINDOW
      const instructions = opts.instructions ?? policy.instructions
      // Dreams distill transcripts straight from the store, bypassing the
      // per-turn capture path — so the session-visibility gate has to be applied
      // here too, or a private session's content reaches shared agent memory by
      // the back door (session-visibility.md §5.1).
      const sources = this.deps.store
        .dreamSessionSources(agentId, sessionWindow)
        .filter((source) => !this.deps.store.isCaptureExcluded(source.sessionId))

      // Snapshot the live store — the digest is the adoption fence. Taken under
      // the shared memory-dir lock so it cannot tear against a concurrent
      // writeMemoryFile, and so the `.history` line count captured with it
      // delimits the post-snapshot write window exactly (see `adopt`).
      const { files, writes } = await withMemoryDirLock(dir, async () => ({
        files: await this.readLiveStore(dir),
        writes: memoryWriteMarks(dir)
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
        createdAt: this.nowIso()
      }
      this.deps.store.insertDream(dream)
      this.emitLifecycle({ type: 'memory.dream.started', dream })
      this.active.set(agentId, dream.dreamId)
      const aborter = new AbortController()
      this.aborters.set(dream.dreamId, aborter)

      void this.run(dream, files, sources, aborter.signal)
        .finally(() => {
          this.aborters.delete(dream.dreamId)
          if (this.active.get(agentId) === dream.dreamId) this.active.delete(agentId)
        })
        // Auto-adopt runs only AFTER the reservation is released — `adopt` refuses
        // while a dream is in flight, and this dream holds that slot until here.
        .then(() => this.maybeAutoAdopt(agentId, dream.dreamId))
        .catch(() => {})
      return dream
    })
  }

  private async readLiveStore(dir: string): Promise<{ name: string; content: string }[]> {
    const files: { name: string; content: string }[] = []
    for (const entry of await listMemory(dir)) {
      files.push({ name: entry.name, content: await readMemoryFile(dir, entry.name) })
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
      const transcripts: DreamTranscriptSource[] = sources.map((source) => ({
        sessionId: source.sessionId,
        rows: this.deps.store.dreamTranscriptText(
          source.channel,
          source.thread,
          agentId,
          TRANSCRIPT_ROWS_PER_SESSION,
          mineSkills,
          source.transportScope
        )
      }))

      // Materialize the dream inputs as FILES the model explores with its own
      // read-only tools (task #36): the memory snapshot at input/ root, each mined
      // transcript at input/sessions/<id>.md (already secret-hygiene filtered by
      // dreamTranscriptText). input/ IS the dream's working directory now — it is
      // read back, by the model, not the pipeline.
      const base = this.dreamDir(agentId, dreamId)
      const inputDir = join(base, 'input')
      const sessionsDir = join(inputDir, 'sessions')
      await fsp.mkdir(sessionsDir, { recursive: true })
      for (const file of files) {
        await fsp.writeFile(join(inputDir, file.name), file.content, 'utf8')
      }
      const materializedSessionIds: string[] = []
      for (const transcript of transcripts) {
        const body = renderDreamSessionFile(transcript)
        if (!body.trim()) continue
        await fsp.writeFile(join(sessionsDir, `${dreamSessionFileName(transcript.sessionId)}.md`), body, 'utf8')
        materializedSessionIds.push(transcript.sessionId)
      }

      let organizationKnowledge: KnowledgeSearchItem[] = []
      if (this.deps.findOrganizationKnowledge) {
        const query = transcripts
          .flatMap((transcript) => transcript.rows.map((row) => row.text))
          .join('\n')
          .slice(-4096)
          .trim()
        if (query) {
          organizationKnowledge = await this.deps.findOrganizationKnowledge(agentId, query).catch((err) => {
            this.deps.log.warn(
              `dream ${dreamId}: organization knowledge context unavailable (${err instanceof Error ? err.name : 'unknown'})`
            )
            return []
          })
        }
      }
      const managedSkills = mineSkills ? (this.deps.managedSkillsFor?.(agentId) ?? []) : []

      const prompt = buildDreamExplorationPrompt({
        sessionIds: materializedSessionIds,
        mineSkills,
        organizationKnowledge,
        managedSkills,
        ...(mineSkills ? { dismissedSkills: this.dismissedSkillNames(agentId) } : {}),
        ...(dream.instructions ? { instructions: dream.instructions } : {})
      })
      this.transition(agentId, dreamId, 'pending', { status: 'running' })

      // A cancel that landed before extraction wins: skip the expensive call.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running') return

      const extracted = await this.extractWithBackstop(dream, prompt, signal, inputDir, mineSkills)

      // A cancel that landed mid-extraction wins: drop the output unstaged. This
      // also covers the backstop firing (extraction ignored the cancel and never
      // settled within the grace window) — the reservation is released either way.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running' || extracted.abandoned) return
      const output = extracted.output
      const execution = {
        ...(extracted.sessionId ? { executionSessionId: extracted.sessionId } : {}),
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
        sources.map((s) => s.sessionId),
        organizationKnowledge.map(({ id, revision }) => ({ id, revision })),
        managedSkills
      )
      if (!proposal) {
        this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'unparseable_proposal', message: 'the dream reply carried no valid store proposal' },
          ...execution,
          usage
        })
        return
      }

      if (!mineSkills) {
        proposal.skills = []
        proposal.organizationSkills = []
      }
      const organizationSuggestions = await this.stage(base, proposal)
      await this.deps.onStaged?.(agentId, dreamId)

      // stage() is several awaited writes; a cancel can land while it runs.
      // Cancel-wins: honor it, drop the partial output, don't flip to completed.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running') {
        await fsp.rm(join(base, 'output'), { recursive: true, force: true }).catch(() => {})
        return
      }
      this.finish(agentId, dreamId, {
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
      this.deps.log.info(`dream ${dreamId} completed for agent ${agentId} (${proposal.files.length + 1} staged files)`)
    } catch (err) {
      this.deps.log.warn(`dream ${dreamId} failed for agent ${agentId}: ${err instanceof Error ? err.name : 'unknown'}`)
      // Fail BOTH pending and running dreams terminally — a failure before the
      // pending→running transition (e.g. the input-snapshot write) must not
      // leave the job stuck non-terminal forever. A cancel still wins (its
      // status is preserved, not overwritten).
      const status = this.deps.store.getDream(agentId, dreamId)?.status
      if (status === 'running' || status === 'pending') {
        this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'pipeline_error', message: err instanceof Error ? err.message : 'unknown error' }
        })
      }
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
    mineSkills = false
  ): Promise<({ abandoned: false } & DreamExtractionResult) | { abandoned: true; output: '' }> {
    const graceMs = this.deps.cancelGraceMs ?? 30_000
    const extraction = this.deps
      .extract(dream.agentId, dreamSystemPrompt(mineSkills), prompt, signal, {
        dreamId: dream.dreamId,
        trigger: dream.trigger,
        sessionIds: dream.sessionIds,
        inputDir
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

  private async stage(base: string, proposal: DreamProposal): Promise<DreamOrganizationSuggestionInfo[]> {
    const out = join(base, 'output')
    await fsp.rm(out, { recursive: true, force: true })
    await fsp.mkdir(out, { recursive: true })
    await fsp.writeFile(join(out, MEMORY_INDEX), proposal.index, 'utf8')
    for (const file of proposal.files) {
      // parseDreamProposal already enforced TOPIC_RE — belt and suspenders here
      // because these names become filesystem paths.
      if (!stagedPathOk(file.path)) continue
      await fsp.writeFile(join(out, file.path), file.content, 'utf8')
    }
    await this.stageSkills(base, proposal)
    return this.stageOrganizationSuggestions(base, proposal)
  }

  private async stageOrganizationSuggestions(
    base: string,
    proposal: DreamProposal
  ): Promise<DreamOrganizationSuggestionInfo[]> {
    const root = join(base, 'organization')
    await fsp.rm(root, { recursive: true, force: true })
    const candidates = [
      ...proposal.organizationKnowledge.map((candidate) => ({ kind: 'knowledge' as const, candidate })),
      ...proposal.organizationSkills.map((candidate) => ({ kind: 'skill' as const, candidate }))
    ]
    if (candidates.length === 0) return []
    await fsp.mkdir(root, { recursive: true })
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
      await fsp.writeFile(join(root, `${candidateId}.json`), serialized, { encoding: 'utf8', mode: 0o600 })
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
  private async stageSkills(base: string, proposal: DreamProposal): Promise<void> {
    const root = join(base, 'skills')
    await fsp.rm(root, { recursive: true, force: true })
    if (proposal.skills.length === 0) return
    await fsp.mkdir(root, { recursive: true })
    for (const skill of proposal.skills) {
      // The parser enforced the name shape; re-check because it becomes a path.
      if (!SKILL_DIR_RE.test(skill.name)) continue
      const dir = join(root, skill.name)
      await fsp.mkdir(dir, { recursive: true })
      if (skill.files?.length) {
        for (const file of skill.files) {
          const target = join(dir, ...file.path.split('/'))
          await fsp.mkdir(dirname(target), { recursive: true })
          await fsp.writeFile(
            target,
            file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
            file.encoding === 'base64' ? undefined : 'utf8'
          )
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
      await fsp.writeFile(join(dir, 'SKILL.md'), frontmatter + body + '\n', 'utf8')
      if (skill.scripts.length === 0) continue
      const scriptsDir = join(dir, 'scripts')
      await fsp.mkdir(scriptsDir, { recursive: true })
      for (const script of skill.scripts) {
        if (!SKILL_SCRIPT_FILE_RE.test(script.path)) continue
        await fsp.writeFile(join(scriptsDir, script.path), script.content, 'utf8')
      }
    }
  }

  private transition(agentId: string, dreamId: string, from: DreamInfo['status'], patch: Partial<DreamInfo>): void {
    const dream = this.getDream(agentId, dreamId)
    if (dream.status !== from) return
    this.deps.store.updateDream({ ...dream, ...patch })
  }

  private finish(agentId: string, dreamId: string, patch: Partial<DreamInfo>): void {
    const dream = this.getDream(agentId, dreamId)
    const next = { ...dream, ...patch, endedAt: this.nowIso() }
    this.deps.store.updateDream(next)
    if (next.status === 'completed') this.emitLifecycle({ type: 'memory.dream.completed', dream: next })
    if (next.status === 'failed') this.emitLifecycle({ type: 'memory.dream.failed', dream: next })
  }

  cancel(agentId: string, dreamId: string): DreamInfo {
    const dream = this.getDream(agentId, dreamId)
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
    this.deps.store.updateDream(canceled)
    // Abort the in-flight extraction so daemon.ts drives the host session-cancel
    // path — otherwise a hung/long prompt would pin the reservation forever.
    this.aborters.get(dreamId)?.abort()
    return canceled
  }

  get(agentId: string, dreamId: string): DreamInfo {
    this.dirFor(agentId)
    return this.getDream(agentId, dreamId)
  }

  /** Dreams whose skill candidates are still awaiting review. */
  listPendingSkills(agentId: string, limit: number): DreamInfo[] {
    this.dirFor(agentId)
    return this.deps.store.pendingSkillDreams(agentId, limit)
  }

  list(agentId: string, limit: number): DreamInfo[] {
    this.dirFor(agentId)
    return this.deps.store.listDreams(agentId, limit)
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
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const dream = this.getDream(agentId, dreamId)
      if (dream.status !== 'completed') throw new DreamStateError(`cannot adopt a ${dream.status} dream`)
      if (this.active.has(agentId)) throw new DreamStateError('a dream is in flight for this agent; wait or cancel it')

      const out = join(this.dreamDir(agentId, dreamId), 'output')
      const stagedNames = (await fsp.readdir(out, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && stagedPathOk(entry.name))
        .map((entry) => entry.name)
      if (!stagedNames.includes(MEMORY_INDEX)) throw new DreamStateError('this dream has no staged index to adopt')
      // Read the staged bytes once; they define both the replacement and the
      // same-bytes review fence below.
      const stagedFiles = await Promise.all(
        stagedNames.map(async (name) => ({ name, content: await fsp.readFile(join(out, name), 'utf8') }))
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

      const live = memoryDir(dir)
      const at = this.nowIso()

      // 1) Build the proposed files in a temp sibling dir. `memory/` is
      //    untouched. History is added later under the shared lock so every
      //    `before` snapshot describes the exact store the swap replaces.
      const replacement = join(dir, `.memory.adopting-${dreamId}`)
      await fsp.rm(replacement, { recursive: true, force: true })
      await fsp.mkdir(replacement, { recursive: true })
      for (const file of stagedFiles) {
        await fsp.writeFile(join(replacement, file.name), file.content, 'utf8')
      }

      // 2) Fence + swap under the shared memory-dir lock, so no writeMemoryFile
      //    caller can interleave between the digest re-check and the rename.
      try {
        return await withMemoryDirLock(dir, async () => {
          const liveFiles = await this.readLiveStore(dir)
          if (!force) {
            const liveDigest = storeDigest(liveFiles)
            if (liveDigest !== dream.snapshotDigest) {
              // §8 distillation rebase: additive per-turn capture may have landed
              // while the dream ran. When EVERY post-snapshot write was
              // distill-sourced, replay those additions onto the replacement and
              // adopt; any tool/console write still hard-fences to review.
              const rebased = await this.rebaseDistillWrites(dir, dream, replacement)
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
          let history = await snapshotMemoryHistoryHoldingLock(dir)
          const beforeByPath = new Map(liveFiles.map((file) => [file.name, file.content]))
          const afterFiles = (await fsp.readdir(replacement, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && stagedPathOk(entry.name))
            .map((entry) => entry.name)
          const afterByPath = new Map<string, string>()
          for (const name of afterFiles) {
            afterByPath.set(name, await fsp.readFile(join(replacement, name), 'utf8'))
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
          await fsp.writeFile(join(replacement, MEMORY_HISTORY_FILENAME), history, { encoding: 'utf8', mode: 0o600 })

          const backupsRoot = join(dir, BACKUPS_DIRNAME)
          await fsp.mkdir(backupsRoot, { recursive: true })
          const backup = join(backupsRoot, `${at.replace(/[:.]/g, '-')}-pre-${dreamId}`)
          let hadLiveStore = true
          try {
            await fsp.rename(live, backup)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            hadLiveStore = false // brand-new store: nothing to back up
          }
          try {
            await fsp.rename(replacement, live)
          } catch (err) {
            // Roll back to the previous store and drop the temp; the dream stays
            // `completed` and reviewable.
            if (hadLiveStore) await fsp.rename(backup, live).catch(() => {})
            await fsp.rm(replacement, { recursive: true, force: true }).catch(() => {})
            throw err
          }
          // This swap rewrote the store without going through `writeMemoryFile`,
          // so the ledger would not otherwise see it. Record it as a NON-distill
          // mutation (still inside the lock): a second dream staged from the same
          // snapshot must fence on this adoption rather than classify it as
          // distill-only drift and roll over it.
          recordExternalMemoryMutation(dir, 'dream')
          // Dream adoption copies history as part of the atomic store swap, so
          // tighten that copied/appended sidecar before releasing the same lock.
          await enforceMemoryHistoryRetentionHoldingLock(dir).catch(() => {})

          // The backup is the undo path for THIS adoption; older ones superseded.
          if (hadLiveStore) {
            for (const entry of await fsp.readdir(backupsRoot)) {
              if (join(backupsRoot, entry) !== backup) {
                await fsp.rm(join(backupsRoot, entry), { recursive: true, force: true })
              }
            }
          }

          const adoptedAt = this.nowIso()
          const adopted: DreamInfo = { ...this.getDream(agentId, dreamId), status: 'adopted', endedAt: adoptedAt }
          this.deps.store.updateDream(adopted)
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
        await fsp.rm(replacement, { recursive: true, force: true }).catch(() => {})
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
    const dream = this.deps.store.getDream(agentId, dreamId)
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
  private async rebaseDistillWrites(dir: string, dream: DreamInfo, replacement: string): Promise<number | null> {
    const snapshot = dream.snapshotWrites
    // A dream recorded before this field existed can't be reasoned about.
    if (!snapshot) return null
    const now = memoryWriteMarks(dir)
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
    const readOr = async (base: string, name: string): Promise<string> => {
      try {
        return await fsp.readFile(join(base, name), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw err
      }
    }

    // Dedup against everything already staged — the dream has very likely folded
    // the same fact in already (it mined the same transcripts).
    const known = new Set<string>()
    for (const entry of await fsp.readdir(replacement, { withFileTypes: true })) {
      if (!entry.isFile() || !stagedPathOk(entry.name)) continue
      for (const line of (await readOr(replacement, entry.name)).split('\n')) {
        const value = normalizeMemoryLine(line)
        if (value) known.add(value)
      }
    }

    let replayed = 0
    for (const file of await listMemory(dir)) {
      const name = file.name
      if (!stagedPathOk(name)) return null // an unexpected name ⇒ refuse
      const before = new Set(
        (await readOr(input, name))
          .split('\n')
          .map(normalizeMemoryLine)
          .filter((v): v is string => !!v)
      )
      const additions: string[] = []
      for (const line of (await readMemoryFile(dir, name)).split('\n')) {
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
      await fsp.writeFile(join(replacement, name), next, 'utf8')
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
      const dream = this.getDream(agentId, dreamId)
      if (dream.status === 'discarded') return dream // idempotent no-op
      if (dream.status !== 'completed' && dream.status !== 'failed' && dream.status !== 'canceled') {
        throw new DreamStateError(`cannot discard a ${dream.status} dream`)
      }
      await this.removeStoreStaging(agentId, dream)
      const discarded: DreamInfo = { ...dream, status: 'discarded', endedAt: this.nowIso() }
      this.deps.store.updateDream(discarded)
      return discarded
    })
  }

  /** Adoption changes the live store, so every other completed proposal is now
   *  fenced by definition. Make that invalidation explicit and remove only its
   *  memory-store staging; proposed skills remain independently reviewable. */
  private async supersedeCompletedDreams(agentId: string, adoptedDreamId: string, adoptedAt: string): Promise<number> {
    this.assertStagedContentAllowed()
    const candidates = this.deps.store.completedDreams(agentId).filter((dream) => dream.dreamId !== adoptedDreamId)
    for (const dream of candidates) {
      this.deps.store.updateDream({ ...dream, status: 'superseded', endedAt: adoptedAt })
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
    const base = this.dreamDir(agentId, dream.dreamId)
    const pending =
      (dream.skills ?? []).some((skill) => skill.state === 'proposed') ||
      (dream.organizationSuggestions ?? []).some((suggestion) => suggestion.state === 'proposed')
    if (pending) {
      for (const part of ['input', 'output']) {
        await fsp.rm(join(base, part), { recursive: true, force: true })
      }
    } else {
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  /** Accept a mined skill by publishing an immutable bounded local-source
   * revision under the daemon-owned agent root. Workspace materialization is
   * deferred to the unified installer and the warm host is fenced first. */
  async skillAccept(agentId: string, dreamId: string, name: string, reviewToken?: string): Promise<DreamInfo> {
    this.assertStagedContentAllowed()
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const { dream, skill } = this.skillCandidate(agentId, dreamId, name)
      if (skill.state === 'accepted') return dream // idempotent
      if (skill.state === 'dismissed') throw new DreamStateError('this skill candidate was already dismissed')

      const staged = join(this.dreamDir(agentId, dreamId), 'skills', name)
      // Same-bytes review fence (task #36 Phase B): bind acceptance to the exact
      // staged skill bytes the caller reviewed. inspectLocalSkillSource uses the
      // same canonical no-follow walker + digest as the publish snapshot, so any
      // change to the staged skill since review yields a different digest and
      // forces a re-review instead of accepting un-reviewed bytes.
      if (reviewToken !== undefined && (await inspectLocalSkillSource(staged)).sha256 !== reviewToken) {
        throw new DreamStateError(
          'the staged skill changed since it was reviewed; re-review the current skill before accepting'
        )
      }
      const publish = async (): Promise<void> => {
        await publishAcceptedDreamSkill({ agentDir: dir, sourceDir: staged, name })
      }
      if (this.deps.withSkillAcceptance) await this.deps.withSkillAcceptance(agentId, publish)
      else await publish()

      const next = this.setSkillState(agentId, dreamId, name, 'accepted')
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
      const { dream, skill } = this.skillCandidate(agentId, dreamId, name)
      if (skill.state === 'dismissed') return dream // idempotent
      if (skill.state === 'accepted') throw new DreamStateError('this skill candidate was already accepted')
      await fsp.rm(join(this.dreamDir(agentId, dreamId), 'skills', name), { recursive: true, force: true })
      const next = this.setSkillState(agentId, dreamId, name, 'dismissed')
      this.emitLifecycle({ type: 'memory.dream.skill_dismissed', dream: next, skillName: name })
      await this.sweepReviewedStaging(agentId, next)
      return next
    })
  }

  /** Names the user has already declined across this agent's past dreams, so the
   *  next mining prompt can be told not to re-propose them (design §7). */
  private dismissedSkillNames(agentId: string): string[] {
    const names = new Set<string>()
    for (const dream of this.deps.store.listDreams(agentId, 50)) {
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
    await fsp.rm(this.dreamDir(agentId, dream.dreamId), { recursive: true, force: true }).catch(() => {})
  }

  private skillCandidate(
    agentId: string,
    dreamId: string,
    name: string
  ): { dream: DreamInfo; skill: NonNullable<DreamInfo['skills']>[number] } {
    const dream = this.getDream(agentId, dreamId)
    const skill = dream.skills?.find((candidate) => candidate.name === name)
    if (!skill) throw new DreamViolationError(`unknown skill candidate ${name}`)
    return { dream, skill }
  }

  private setSkillState(agentId: string, dreamId: string, name: string, state: 'accepted' | 'dismissed'): DreamInfo {
    const dream = this.getDream(agentId, dreamId)
    const next: DreamInfo = {
      ...dream,
      skills: (dream.skills ?? []).map((skill) => (skill.name === name ? { ...skill, state } : skill))
    }
    this.deps.store.updateDream(next)
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
    this.skillCandidate(agentId, dreamId, name)
    const dir = join(this.dreamDir(agentId, dreamId), 'skills', name)
    let skill: string
    try {
      skill = await fsp.readFile(join(dir, 'SKILL.md'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const scripts: { path: string; content: string }[] = []
    try {
      for (const entry of await fsp.readdir(join(dir, 'scripts'), { withFileTypes: true })) {
        if (!entry.isFile() || !SKILL_SCRIPT_FILE_RE.test(entry.name)) continue
        scripts.push({ path: entry.name, content: await fsp.readFile(join(dir, 'scripts', entry.name), 'utf8') })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    scripts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { skill, scripts }
  }

  /** Metadata inventory sent on Dream completion and every CP reconnect. */
  organizationSuggestionInventory(): Array<
    DreamOrganizationSuggestionInfo & { sourceAgentId: string; dreamId: string }
  > {
    return this.deps.store
      .organizationSuggestionDreams(256)
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
    const dream = this.getDream(req.sourceAgentId, req.dreamId)
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
      const raw = await fsp.readFile(
        join(this.dreamDir(req.sourceAgentId, req.dreamId), 'organization', `${req.candidateId}.json`)
      )
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return absent
      throw err
    }
  }

  async organizationSuggestionReview(req: OrganizationSuggestionReviewReq): Promise<Ack> {
    this.assertStagedContentAllowed()
    const dream = this.getDream(req.sourceAgentId, req.dreamId)
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
      this.deps.store.updateDream(reviewed)
    }
    // Terminal metadata is retained for reconnect/history, but the unapproved
    // daemon-local body is no longer needed once the central decision commits.
    await fsp.rm(join(this.dreamDir(req.sourceAgentId, req.dreamId), 'organization', `${req.candidateId}.json`), {
      force: true
    })
    await this.sweepReviewedStaging(req.sourceAgentId, reviewed)
    await Promise.resolve(this.deps.onOrganizationSuggestions?.()).catch(() => undefined)
    return { ok: true }
  }

  /** Staged output listing for the review screen. Missing staging is DATA. */
  async stagedFiles(agentId: string, dreamId: string): Promise<{ name: string; size: number; mtime: string }[] | null> {
    this.assertStagedContentAllowed()
    this.getDream(agentId, dreamId)
    const out = join(this.dreamDir(agentId, dreamId), 'output')
    let names: string[]
    try {
      names = (await fsp.readdir(out, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && stagedPathOk(entry.name))
        .map((entry) => entry.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    names.sort((a, b) => (a === MEMORY_INDEX ? -1 : b === MEMORY_INDEX ? 1 : a.localeCompare(b)))
    const entries = []
    for (const name of names) {
      // A file can vanish between readdir and stat if a cancel/discard is
      // removing the staging concurrently — skip it rather than throw.
      try {
        const st = await fsp.stat(join(out, name))
        entries.push({ name, size: st.size, mtime: st.mtime.toISOString() })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
    }
    return entries
  }

  /** Whole staged file text, or null when absent. Byte-slicing for the wire is
   *  the CP adapter's concern (cp/dream-reader.ts), mirroring memory-reader. */
  async stagedRead(agentId: string, dreamId: string, path: string): Promise<{ content: string; mtime: string } | null> {
    this.assertStagedContentAllowed()
    this.getDream(agentId, dreamId)
    if (!stagedPathOk(path)) throw new DreamViolationError('staged memory paths are plain kebab-case .md names')
    const abs = join(this.dreamDir(agentId, dreamId), 'output', path)
    try {
      const [content, st] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)])
      return { content, mtime: st.mtime.toISOString() }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
}
