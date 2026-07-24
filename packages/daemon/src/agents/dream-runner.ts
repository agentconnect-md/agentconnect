import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { DreamInfo, DreamTrigger, MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import {
  MEMORY_INDEX,
  MEMORY_HISTORY_FILENAME,
  MAX_HISTORY_VALUE_BYTES,
  listMemory,
  memoryDir,
  readMemoryFile
} from './memory.js'
import {
  MEMORY_DREAM_SYSTEM_PROMPT,
  buildDreamPrompt,
  clampToBytesOnBoundary,
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
  /** Newest-first addressable sessions for the agent (transcript sources). */
  dreamSessionSources(agentId: string, limit: number): { sessionId: string; channel: string; thread: string }[]
  /** Chronological text rows of one session thread, scoped to the agent. */
  dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number
  ): { sender: string; text: string }[]
}

export interface DreamRunnerDeps {
  agentDirByAgent(agentId: string): string | undefined
  /** The agent's dreaming policy, or undefined when dreaming is not enabled
   *  (missing binding, non-managed provider, or enabled:false). */
  dreamingPolicyFor(agentId: string): MemoryDreamingPolicy | undefined
  store: DreamStorePort
  /** Run one isolated dream extraction and return the streamed text. daemon.ts
   *  owns the session/trust mechanics; the prompt is fully assembled here. */
  extract(agentId: string, systemPrompt: string, prompt: string): Promise<string>
  log: { info(msg: string): void; warn(msg: string): void }
  now?(): Date
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

export class DreamRunner {
  /** dreamId of the agent's in-flight dream — the one-at-a-time invariant. Held
   *  from `start`'s synchronous reservation until the run promise SETTLES (a
   *  cancel does not release it early, so a canceled dream's still-running
   *  extraction can never overlap a replacement). */
  private readonly active = new Map<string, string>()

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
      this.deps.store.updateDream({
        ...dream,
        status: 'failed',
        error: { type: 'daemon_restart', message: 'the daemon restarted while this dream was in flight' },
        endedAt: this.nowIso()
      })
    }
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
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

      // Snapshot the live store now — the digest is the adoption fence.
      const files = await this.readLiveStore(dir)
      const dream: DreamInfo = {
        dreamId: `drm-${randomUUID()}`,
        agentId,
        status: 'pending',
        trigger: opts.trigger,
        sessionIds: sources.map((s) => s.sessionId),
        snapshotDigest: storeDigest(files),
        ...(instructions ? { instructions } : {}),
        createdAt: this.nowIso()
      }
      this.deps.store.insertDream(dream)
      this.active.set(agentId, dream.dreamId)

      void this.run(dream, files, sources).finally(() => {
        if (this.active.get(agentId) === dream.dreamId) this.active.delete(agentId)
      })
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
    sources: { sessionId: string; channel: string; thread: string }[]
  ): Promise<void> {
    const { agentId, dreamId } = dream
    try {
      const transcripts: DreamTranscriptSource[] = sources.map((source) => ({
        sessionId: source.sessionId,
        rows: this.deps.store.dreamTranscriptText(source.channel, source.thread, agentId, TRANSCRIPT_ROWS_PER_SESSION)
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
        ...(dream.instructions ? { instructions: dream.instructions } : {})
      })
      this.transition(agentId, dreamId, 'pending', { status: 'running' })

      // A cancel that landed before extraction wins: skip the expensive call.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running') return

      const output = await this.deps.extract(agentId, MEMORY_DREAM_SYSTEM_PROMPT, prompt)

      // A cancel that landed mid-extraction wins: drop the output unstaged.
      if (this.deps.store.getDream(agentId, dreamId)?.status !== 'running') return

      const proposal = parseDreamProposal(output)
      if (!proposal) {
        this.finish(agentId, dreamId, {
          status: 'failed',
          error: { type: 'unparseable_proposal', message: 'the dream reply carried no valid store proposal' },
          usage: { inputBytes: Buffer.byteLength(prompt), outputBytes: Buffer.byteLength(output) }
        })
        return
      }

      await this.stage(base, proposal)
      this.finish(agentId, dreamId, {
        status: 'completed',
        usage: { inputBytes: Buffer.byteLength(prompt), outputBytes: Buffer.byteLength(output) }
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
  }

  private transition(agentId: string, dreamId: string, from: DreamInfo['status'], patch: Partial<DreamInfo>): void {
    const dream = this.getDream(agentId, dreamId)
    if (dream.status !== from) return
    this.deps.store.updateDream({ ...dream, ...patch })
  }

  private finish(agentId: string, dreamId: string, patch: Partial<DreamInfo>): void {
    const dream = this.getDream(agentId, dreamId)
    this.deps.store.updateDream({ ...dream, ...patch, endedAt: this.nowIso() })
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
   * file — is built entirely in a sibling temp directory FIRST, so `memory/` is
   * never a half-written tree: the visible window is a single rename, and a
   * failure rolls the previous store back. Fenced against post-snapshot writes
   * unless `force`.
   *
   * Note (design §8): full serialization against live console/tool/distillation
   * writes lands in D-2 (the distillation-rebase rule). Here the fence still
   * detects any interleaving write and refuses (or the caller forces), and the
   * swap window is a single rename rather than a multi-write span.
   */
  async adopt(agentId: string, dreamId: string, force: boolean): Promise<DreamInfo> {
    const dir = this.dirFor(agentId)
    return this.withLock(agentId, async () => {
      const dream = this.getDream(agentId, dreamId)
      if (dream.status !== 'completed') throw new DreamStateError(`cannot adopt a ${dream.status} dream`)
      if (this.active.has(agentId)) throw new DreamStateError('a dream is in flight for this agent; wait or cancel it')

      if (!force) {
        const liveDigest = storeDigest(await this.readLiveStore(dir))
        if (liveDigest !== dream.snapshotDigest) {
          throw new DreamStateError('the live store changed since this dream was snapshotted; rerun the dream or force')
        }
      }

      const out = join(this.dreamDir(agentId, dreamId), 'output')
      const staged = (await fsp.readdir(out, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && stagedPathOk(entry.name))
        .map((entry) => entry.name)
      if (!staged.includes(MEMORY_INDEX)) throw new DreamStateError('this dream has no staged index to adopt')

      const live = memoryDir(dir)
      const at = this.nowIso()

      // 1) Build the complete replacement in a temp sibling dir. `memory/` is
      //    untouched until step 2, so any failure here leaves the live store intact.
      const replacement = join(dir, `.memory.adopting-${dreamId}`)
      await fsp.rm(replacement, { recursive: true, force: true })
      await fsp.mkdir(replacement, { recursive: true })
      let history = ''
      try {
        history = await fsp.readFile(join(live, MEMORY_HISTORY_FILENAME), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      for (const name of staged) {
        const content = await fsp.readFile(join(out, name), 'utf8')
        await fsp.writeFile(join(replacement, name), content, 'utf8')
        history +=
          JSON.stringify({
            path: name,
            event: 'update',
            after: clampToBytesOnBoundary(content, MAX_HISTORY_VALUE_BYTES),
            at,
            scope: 'agent',
            source: 'dream'
          }) + '\n'
      }
      await fsp.writeFile(join(replacement, MEMORY_HISTORY_FILENAME), history, 'utf8')

      // 2) Swap. Move the live store aside, move the replacement in. The window
      //    where `memory/` is absent is a single rename; roll back on failure.
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

      // 3) The backup is the undo path for THIS adoption; older ones are superseded.
      if (hadLiveStore) {
        for (const entry of await fsp.readdir(backupsRoot)) {
          if (join(backupsRoot, entry) !== backup) {
            await fsp.rm(join(backupsRoot, entry), { recursive: true, force: true })
          }
        }
      }

      const adopted: DreamInfo = { ...this.getDream(agentId, dreamId), status: 'adopted', endedAt: this.nowIso() }
      this.deps.store.updateDream(adopted)
      this.deps.log.info(`dream ${dreamId} adopted for agent ${agentId} (${staged.length} files)`)
      return adopted
    })
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
      await fsp.rm(this.dreamDir(agentId, dreamId), { recursive: true, force: true })
      const discarded: DreamInfo = { ...dream, status: 'discarded', endedAt: this.nowIso() }
      this.deps.store.updateDream(discarded)
      return discarded
    })
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
      const st = await fsp.stat(join(out, name))
      entries.push({ name, size: st.size, mtime: st.mtime.toISOString() })
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
