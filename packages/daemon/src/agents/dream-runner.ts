import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { DreamInfo, DreamTrigger, MemoryDreamingPolicy, SessionUsage } from '@agentconnect.md/protocol'
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
  buildDreamPrompt,
  dreamSystemPrompt,
  parseDreamProposal,
  storeDigest,
  type DreamProposal,
  type DreamTranscriptSource
} from './memory-dreamer.js'

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

export interface DreamStorePort {
  insertDream(dream: DreamInfo): void
  updateDream(dream: DreamInfo): void
  getDream(agentId: string, dreamId: string): DreamInfo | undefined
  listDreams(agentId: string, limit: number): DreamInfo[]
  /** Non-terminal dreams (pending|running) for crash recovery at boot. */
  openDreams(): DreamInfo[]
  /** Every completed store proposal for one agent, without the public list cap. */
  completedDreams(agentId: string): DreamInfo[]
  /** Proposals reconciled as superseded during a store upgrade. */
  supersededDreams(): DreamInfo[]
  /** Newest-first addressable sessions for the agent (transcript sources). */
  dreamSessionSources(agentId: string, limit: number): { sessionId: string; channel: string; thread: string }[]
  /** Chronological text rows of one session thread, scoped to the agent. */
  dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number,
    /** Include tool TITLES too — the trajectory skill mining reads (never bodies). */
    includeTools?: boolean
  ): { sender: string; text: string; kind?: string; input?: string }[]
}

export interface DreamExtractionResult {
  output: string
  trustedChannel: boolean
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
    context: { dreamId: string; trigger: DreamTrigger; sessionIds: string[] }
  ): Promise<DreamExtractionResult>
  /** Metadata-only lifecycle tap. Observer failures are contained by the
   *  runner and can never change the job outcome. */
  onEvent?(event: DreamLifecycleEvent): void
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
/** Where an ACCEPTED mined skill is installed, under the agent root. */
const AGENT_SKILLS_DIRNAME = 'skills'

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

  /** Trust verdict of the host that produced each dream's proposal, captured at
   *  extraction time. Auto-adopt reads THIS, never the agent's current host. */
  private readonly extractionTrust = new Map<string, boolean>()

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
    for (const dream of this.deps.store.supersededDreams()) {
      if (!this.deps.agentDirByAgent(dream.agentId)) continue
      void this.removeStoreStaging(dream.agentId, dream).catch((err) => {
        this.deps.log.warn(
          `dream ${dream.dreamId}: could not remove superseded store staging (${err instanceof Error ? err.message : 'unknown'})`
        )
      })
    }
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
      const sources = this.deps.store.dreamSessionSources(agentId, sessionWindow)

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
        .finally(() => this.extractionTrust.delete(dream.dreamId))
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
    sources: { sessionId: string; channel: string; thread: string }[],
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
          mineSkills
        )
      }))

      // Snapshot copy for inspection (input/ is never read back by the pipeline).
      const base = this.dreamDir(agentId, dreamId)
      await fsp.mkdir(join(base, 'input'), { recursive: true })
      for (const file of files) {
        await fsp.writeFile(join(base, 'input', file.name), file.content, 'utf8')
      }

      const prompt = buildDreamPrompt({
        files,
        transcripts,
        mineSkills,
        ...(mineSkills ? { dismissedSkills: this.dismissedSkillNames(agentId) } : {}),
        ...(dream.instructions ? { instructions: dream.instructions } : {})
      })
      this.transition(agentId, dreamId, 'pending', { status: 'running' })

      // A cancel that landed before extraction wins: skip the expensive call.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running') return

      const extracted = await this.extractWithBackstop(dream, prompt, signal, mineSkills)

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
      // Bind auto-adopt's gate to the host that ACTUALLY produced this proposal.
      // Re-reading the agent's current host later would let a host replacement
      // between extraction and adoption authorize an untrusted proposal.
      this.extractionTrust.set(dreamId, extracted.trustedChannel)

      // The mined session ids are what grounds a skill candidate — a citation the
      // model invented can't be used to justify a recommendation (design §7).
      const proposal = parseDreamProposal(output, mineSkills ? sources.map((s) => s.sessionId) : [])
      if (!proposal) {
        this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'unparseable_proposal', message: 'the dream reply carried no valid store proposal' },
          ...execution,
          usage
        })
        return
      }

      await this.stage(base, proposal)
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
        usage
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
    mineSkills = false
  ): Promise<({ abandoned: false } & DreamExtractionResult) | { abandoned: true; output: ''; trustedChannel: false }> {
    const graceMs = this.deps.cancelGraceMs ?? 30_000
    const extraction = this.deps
      .extract(dream.agentId, dreamSystemPrompt(mineSkills), prompt, signal, {
        dreamId: dream.dreamId,
        trigger: dream.trigger,
        sessionIds: dream.sessionIds
      })
      .then((result) => ({ abandoned: false as const, ...result }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const backstop = new Promise<{ abandoned: true; output: ''; trustedChannel: false }>((resolve) => {
      const arm = () => {
        timer = setTimeout(() => resolve({ abandoned: true, output: '', trustedChannel: false }), graceMs)
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

  private async stage(base: string, proposal: DreamProposal): Promise<void> {
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
      await fsp.writeFile(join(dir, 'SKILL.md'), frontmatter + skill.skill.trimEnd() + '\n', 'utf8')
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
  async adopt(agentId: string, dreamId: string, force: boolean): Promise<DreamInfo> {
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const dream = this.getDream(agentId, dreamId)
      if (dream.status !== 'completed') throw new DreamStateError(`cannot adopt a ${dream.status} dream`)
      if (this.active.has(agentId)) throw new DreamStateError('a dream is in flight for this agent; wait or cancel it')

      const out = join(this.dreamDir(agentId, dreamId), 'output')
      const staged = (await fsp.readdir(out, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && stagedPathOk(entry.name))
        .map((entry) => entry.name)
      if (!staged.includes(MEMORY_INDEX)) throw new DreamStateError('this dream has no staged index to adopt')

      const live = memoryDir(dir)
      const at = this.nowIso()

      // 1) Build the proposed files in a temp sibling dir. `memory/` is
      //    untouched. History is added later under the shared lock so every
      //    `before` snapshot describes the exact store the swap replaces.
      const replacement = join(dir, `.memory.adopting-${dreamId}`)
      await fsp.rm(replacement, { recursive: true, force: true })
      await fsp.mkdir(replacement, { recursive: true })
      for (const name of staged) {
        const content = await fsp.readFile(join(out, name), 'utf8')
        await fsp.writeFile(join(replacement, name), content, 'utf8')
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
            `dream ${dreamId} adopted for agent ${agentId} (${staged.length} files, ${superseded} competing proposal(s) superseded)`
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
   * (`dreaming.autoAdopt`) AND its runtime carries a trusted system-prompt
   * channel. Unattended adoption has distillation-equivalent blast radius, so it
   * inherits distillation's gate: an untrusted-channel runtime keeps the dream
   * reviewable instead (design §2/§6). Never throws — a fence conflict or a
   * failed swap just leaves the dream `completed` and awaiting review.
   */
  private async maybeAutoAdopt(agentId: string, dreamId: string): Promise<void> {
    const dream = this.deps.store.getDream(agentId, dreamId)
    if (dream?.status !== 'completed') return
    const policy = this.deps.dreamingPolicyFor(agentId)
    if (!policy?.autoAdopt) return
    if (!this.extractionTrust.get(dreamId)) {
      this.deps.log.warn(
        `dream ${dreamId}: auto-adopt skipped for agent ${agentId} — the extraction ran on a runtime without a trusted system-prompt channel; review it manually`
      )
      return
    }
    try {
      // Never force: a fence conflict the rebase can't explain must fall back to
      // human review rather than clobber a live tool/console write.
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
    const base = this.dreamDir(agentId, dream.dreamId)
    const pending = (dream.skills ?? []).some((skill) => skill.state === 'proposed')
    if (pending) {
      for (const part of ['input', 'output']) {
        await fsp.rm(join(base, part), { recursive: true, force: true })
      }
    } else {
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  /**
   * Accepting a mined skill is NOT AVAILABLE in this phase.
   *
   * "Accepted" must mean the skill can steer future sessions, and that requires
   * materializing it where the runtime looks — under the agent-writable ACP cwd.
   * Every daemon-authority write there is escapable (see skills/dream-skills.ts:
   * the parent can be swapped for a symlink mid-operation and Node has no
   * `openat` family), so the containment-safe registration step is deliberately
   * deferred rather than shipped subtly unsafe.
   *
   * Failing loudly is the point: a terminal `accepted` whose effect does not
   * exist would be a worse outcome than an explicit refusal. Mining, staging,
   * review metadata, and dismissal all work; only acceptance waits.
   */
  async skillAccept(agentId: string, dreamId: string, name: string): Promise<DreamInfo> {
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const { dream, skill } = this.skillCandidate(agentId, dreamId, name)
      if (skill.state === 'accepted') return dream // idempotent
      if (skill.state === 'dismissed') throw new DreamStateError('this skill candidate was already dismissed')

      // COPY into the agent's own skills tree rather than referencing the dream
      // staging, so discarding the dream later cannot uninstall a skill the user
      // already accepted. Session prep materializes it into the runtime's skill
      // root (skills/dream-skill-install.ts) under symlink-safe containment.
      const staged = join(this.dreamDir(agentId, dreamId), 'skills', name)
      const target = join(dir, AGENT_SKILLS_DIRNAME, name)
      await fsp.mkdir(join(dir, AGENT_SKILLS_DIRNAME), { recursive: true })
      await fsp.rm(target, { recursive: true, force: true })
      await fsp.cp(staged, target, { recursive: true, dereference: false, errorOnExist: false })

      const next = this.setSkillState(agentId, dreamId, name, 'accepted')
      await this.sweepReviewedStaging(agentId, next)
      this.deps.log.info(`dream ${dreamId}: accepted skill "${name}" for agent ${agentId}`)
      return next
    })
  }

  /** Dismiss one candidate: drop its staging and record the decision, so later
   *  dreams can be told not to propose it again. */
  async skillDismiss(agentId: string, dreamId: string, name: string): Promise<DreamInfo> {
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

  /** A discarded or superseded dream keeps its `skills/` only while a candidate
   *  is unreviewed; once the last one is decided there is nothing left to review. */
  private async sweepReviewedStaging(agentId: string, dream: DreamInfo): Promise<void> {
    if (dream.status !== 'discarded' && dream.status !== 'superseded') return
    if ((dream.skills ?? []).some((skill) => skill.state === 'proposed')) return
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
  ): Promise<{ skill: string; scripts: { path: string; content: string }[] } | null> {
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
    return { skill, scripts }
  }

  /** Staged output listing for the review screen. Missing staging is DATA. */
  async stagedFiles(agentId: string, dreamId: string): Promise<{ name: string; size: number; mtime: string }[] | null> {
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
