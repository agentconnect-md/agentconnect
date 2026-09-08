// The one-way memory home migration and the forced return (memory-evolution.md §3.2.1). A managed binding whose `home`
// became `control-plane` carries the CP's `homeMigration: 'pending'` until the owning daemon has copied `memory/` and
// `channels/` from the `daemon` home into the CP — the sidecars as change-log rows — and reported `memory/home/migrated`.
// The copy is restartable by doing nothing clever: the source is frozen from the flip (no writer touches a `daemon` tree
// once the home is `control-plane`) and the target is served to nobody until the CP holds the completion, so an
// interrupted copy runs again from the start and overwrites by path. The source tree is never deleted.
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { WireError } from '@agentconnect.md/connection'
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  type MemoryHomeMigratedOk,
  type MemoryHomeMigratedReq
} from '@agentconnect.md/protocol'
import { CP_MEMORY_TREE_ROOT, CpMemoryFs } from '../cp/memory-fs.js'
import { cpMemoryHistoryRoot, packMemoryHistoryBatches } from '../cp/memory-history.js'
import type { Logger } from '../log.js'
import { MemoryHomeUnavailableError, MemoryPathError, MemoryTooLargeError, type MemoryFs } from './fs.js'
import {
  daemonHomeMemoryFs,
  memoryHomeMigrationPending,
  memoryHomeOf,
  type CpMemoryHomeLink,
  type MemoryHomeAgent,
  type MemoryHomeDeps
} from './home.js'
import {
  CHANNEL_MEMORY_DIRNAME,
  MEMORY_BACKUPS_DIRNAME,
  MEMORY_DIRNAME,
  MEMORY_DREAMS_DIRNAME,
  MEMORY_HISTORY_FILENAME,
  channelMemoryRoot,
  listChannelMemoryKeys,
  readMemoryHistoryHoldingLock,
  withMemoryDirLock,
  type MemoryHistoryRecord
} from './store.js'

/** The CP connection as the migration sees it: the home's two request pairs, and the completion report. */
export interface CpMemoryMigrationLink extends CpMemoryHomeLink {
  memoryHomeMigrated(req: MemoryHomeMigratedReq): Promise<MemoryHomeMigratedOk>
}

/** What one copy moved: files and bytes written by path, change-log records sent, files the target refused. */
export interface MemoryTreeCopyReport {
  files: number
  bytes: number
  records: number
  skipped: number
}

export interface CopyMemoryTreeOptions {
  /** Deliver one store's whole change log (`.` or `channels/<key>`); a rejection fails the copy, unlike a write's sink. */
  history(root: string, records: MemoryHistoryRecord[]): Promise<void>
  log: Pick<Logger, 'warn'>
  signal?: AbortSignal | undefined
}

/** Never carried: dream staging belongs to the extraction host, the pre-adoption backup to the adoption that made it. */
const STAYS_BEHIND = new Set([MEMORY_DREAMS_DIRNAME, MEMORY_BACKUPS_DIRNAME])

/** Walked past as a file: the sidecar (sent as rows instead) and the temp file a crashed write left behind. */
function walkedPast(name: string): boolean {
  return name === MEMORY_HISTORY_FILENAME || name.endsWith('.tmp')
}

/** The target refused this one file (over the cap, or a name the tree refuses): skipped with a warning, since the source keeps it. */
function refusedByTarget(err: unknown): boolean {
  if (err instanceof MemoryTooLargeError || err instanceof MemoryPathError) return true
  return err instanceof WireError && err.code === 'BAD_PAYLOAD'
}

function describeFailure(err: unknown): string {
  if (err instanceof WireError) return `${err.code}: ${err.message}`
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

async function copyDir(
  from: MemoryFs,
  to: MemoryFs,
  rel: string,
  report: MemoryTreeCopyReport,
  opts: CopyMemoryTreeOptions
): Promise<void> {
  await to.mkdir(rel)
  for (const entry of await from.readdir(rel)) {
    const path = `${rel}/${entry.name}`
    if (entry.kind === 'dir') {
      if (!STAYS_BEHIND.has(entry.name)) await copyDir(from, to, path, report, opts)
      continue
    }
    if (entry.kind !== 'file' || walkedPast(entry.name)) continue
    opts.signal?.throwIfAborted()
    const file = await from.readFile(path)
    if (!file) continue
    try {
      // Verbatim text, frontmatter and all; the target's own mtime is then set back to the source's.
      await to.writeFile(path, file.content)
    } catch (err) {
      if (!refusedByTarget(err)) throw err
      opts.log.warn(
        `memory: ${path} was not copied into the Control Plane (${describeFailure(err)}); the source keeps it`
      )
      report.skipped += 1
      continue
    }
    await to.utimes(path, file.mtime)
    report.files += 1
    report.bytes += file.size
  }
}

/** One store's sidecar as rows, read with durable ids under that store's lock and handed over whole. */
async function sendStoreHistory(store: MemoryFs, root: string, opts: CopyMemoryTreeOptions): Promise<number> {
  const records = await readMemoryHistoryHoldingLock(store)
  if (records.length > 0) await opts.history(root, records)
  return records.length
}

// Copy `memory/` and `channels/` from one store to another by path, overwriting, then each store's change log — the
// agent tree's and every channel store's, in the coordinates `CpMemoryFs` names. Held under the source's memory-dir
// lock: the home has flipped, so no writer should be left, and the lock is cheap.
export async function copyMemoryTree(
  from: MemoryFs,
  to: MemoryFs,
  opts: CopyMemoryTreeOptions
): Promise<MemoryTreeCopyReport> {
  const report: MemoryTreeCopyReport = { files: 0, bytes: 0, records: 0, skipped: 0 }
  await withMemoryDirLock(from, async () => {
    const present = new Set((await from.readdir('')).filter((entry) => entry.kind === 'dir').map((entry) => entry.name))
    for (const dir of [MEMORY_DIRNAME, CHANNEL_MEMORY_DIRNAME]) {
      if (present.has(dir)) await copyDir(from, to, dir, report, opts)
    }
    report.records += await sendStoreHistory(from, CP_MEMORY_TREE_ROOT, opts)
    for (const key of await listChannelMemoryKeys(from)) {
      const store = channelMemoryRoot(from, key)
      report.records += await withMemoryDirLock(store, () =>
        sendStoreHistory(store, `${CHANNEL_MEMORY_DIRNAME}/${key}`, opts)
      )
    }
  })
  return report
}

// One store's log to the CP, filed where `CpMemoryHistorySink` files a live write's (`cpMemoryHistoryRoot`), so the
// console's page finds it. Unlike a write's best-effort sink, a failed batch fails the copy: the re-run sends the same
// ids, which the CP takes once.
export async function sendMemoryHistory(
  link: CpMemoryMigrationLink,
  agentId: string,
  storeRoot: string,
  records: readonly MemoryHistoryRecord[]
): Promise<void> {
  for (const batch of packMemoryHistoryBatches(agentId, cpMemoryHistoryRoot(storeRoot), records)) {
    await link.memoryHistoryAppend(batch)
  }
}

/** The forced return, `control-plane` → `daemon` on a managed binding: the CP has dropped its rows, and nothing local may be resurrected. */
export function memoryHomeReturnedToDaemon(
  previous: Pick<MemoryHomeAgent, 'memory'>,
  next: Pick<MemoryHomeAgent, 'memory'>
): boolean {
  if (previous.memory?.provider !== 'managed' || next.memory?.provider !== 'managed') return false
  return memoryHomeOf(previous) === 'control-plane' && memoryHomeOf(next) === 'daemon'
}

/** The archive directory beside the tree, stamped without the characters a Windows path refuses. */
export function memoryArchiveDirname(at: Date): string {
  return `memory-archive-${at.toISOString().replace(/[:.]/g, '-')}`
}

const WINDOWS_RENAME_RETRIES = 10
const WINDOWS_RENAME_DELAY_MS = 100
const WINDOWS_TRANSIENT_FS_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

// Windows refuses to rename a directory while another handle (a watcher's, a scanner's) is briefly open inside it — a
// race POSIX never has — so the move is retried a bounded number of times, as the workspace manager's directory swap is.
async function renameAside(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fsp.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const transient = process.platform === 'win32' && code !== undefined && WINDOWS_TRANSIENT_FS_ERRORS.has(code)
      if (!transient || attempt >= WINDOWS_RENAME_RETRIES) throw err
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_RENAME_DELAY_MS))
    }
  }
}

// Move the live store aside — `memory/`, `channels/`, `memory-backups/` under `<agent dir>/memory-archive-<stamp>/` —
// so the agent starts from an empty tree; `memory-dreams/` stays, since staging belongs to the host. Undefined when
// there was nothing to move.
export async function archiveMemoryTreeAside(agentDir: string, at: Date): Promise<string | undefined> {
  const archive = join(agentDir, memoryArchiveDirname(at))
  let moved = false
  for (const name of [MEMORY_DIRNAME, CHANNEL_MEMORY_DIRNAME, MEMORY_BACKUPS_DIRNAME]) {
    const source = join(agentDir, name)
    try {
      await fsp.lstat(source)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (!moved) await fsp.mkdir(archive)
    await renameAside(source, join(archive, name))
    moved = true
  }
  return moved ? archive : undefined
}

type Timer = ReturnType<typeof setTimeout>

export interface MemoryHomeMigratorDeps {
  /** The managed-memory agents this member serves, with their bindings as the daemon holds them right now. */
  agents(): Iterable<MemoryHomeAgent>
  /** Where the homes are reached from, read on every run: the sandbox plane of a `--k8s` member, the CP connection. */
  homes(): MemoryHomeDeps & { cp?: CpMemoryMigrationLink | undefined }
  /** Under `--k8s`, bind the agent pod around the copy — the source is its volume; self-hosted, run the work as it is. */
  withMemoryHome<T>(agentId: string, work: () => Promise<T>): Promise<T>
  /** The CP recorded the completion: drop the marker from the local binding and rebuild the session boundary. */
  onMigrated(agentId: string): Promise<void>
  log: Pick<Logger, 'info' | 'warn'>
  /** Backoff after a failed copy, doubling from `retryBaseMs` up to `retryMaxMs`; a READY connection resets it. */
  retryBaseMs?: number
  retryMaxMs?: number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

interface MigrationState {
  attempts: number
  inFlight?: Promise<void> | undefined
  timer?: Timer | undefined
  /** The binding the CP answered `CONFLICT` for: nothing runs again until the binding changes. */
  conflicted?: string | undefined
}

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

// Runs the copy for every agent whose binding says the CP is waiting for it — once at a time per agent, retried with
// backoff, re-run from the start on CP READY — and hands each accepted completion back to the daemon.
export class MemoryHomeMigrator {
  private readonly runs = new Map<string, MigrationState>()
  private readonly abort = new AbortController()
  private running = true

  constructor(private readonly deps: MemoryHomeMigratorDeps) {}

  /** The roster changed: start the copy for each pending binding, and forget the agents whose binding moved on. */
  reconcile(): void {
    if (!this.running) return
    const pending = new Set<string>()
    for (const agent of this.deps.agents()) {
      if (!memoryHomeMigrationPending(agent)) continue
      pending.add(agent.id)
      this.consider(agent)
    }
    for (const [agentId, state] of this.runs) {
      if (pending.has(agentId) || state.inFlight) continue
      this.clearTimer(state)
      this.runs.delete(agentId)
    }
  }

  /** The CP connection is READY again: every copy that waited on it runs now, from the start, its backoff forgotten. */
  wake(): void {
    for (const state of this.runs.values()) {
      state.attempts = 0
      this.clearTimer(state)
    }
    this.reconcile()
  }

  /** Nothing new starts, a running copy stops between files, and no completion is reported after this. */
  async stop(): Promise<void> {
    this.running = false
    this.abort.abort()
    for (const state of this.runs.values()) this.clearTimer(state)
    await Promise.allSettled([...this.runs.values()].map((state) => state.inFlight))
  }

  private consider(agent: MemoryHomeAgent): void {
    const state = this.runs.get(agent.id) ?? { attempts: 0 }
    this.runs.set(agent.id, state)
    const binding = JSON.stringify(agent.memory)
    if (state.conflicted !== undefined && state.conflicted !== binding) state.conflicted = undefined
    if (state.inFlight || state.timer || state.conflicted !== undefined) return
    state.inFlight = this.run(agent.id, state, binding).finally(() => {
      state.inFlight = undefined
    })
  }

  private async run(agentId: string, state: MigrationState, binding: string): Promise<void> {
    const { log } = this.deps
    let agent: MemoryHomeAgent | undefined
    for (const candidate of this.deps.agents()) if (candidate.id === agentId) agent = candidate
    if (!agent || !memoryHomeMigrationPending(agent)) return
    const source = agent
    try {
      const homes = this.deps.homes()
      const cp = homes.cp
      if (!cp?.connected()) {
        throw new MemoryHomeUnavailableError('connection', 'the Control Plane connection is not ready')
      }
      if (!cp.supportsServerFeature(AGENT_MEMORY_STORE_V1_FEATURE)) {
        throw new MemoryHomeUnavailableError('feature', 'the Control Plane does not serve the memory store')
      }
      log.info(`memory: agent "${agentId}": copying its memory tree into the Control Plane`)
      const report = await this.deps.withMemoryHome(agentId, () =>
        copyMemoryTree(daemonHomeMemoryFs(source, homes.sandbox), new CpMemoryFs(cp, agentId), {
          history: (root, records) => sendMemoryHistory(cp, agentId, root, records),
          log,
          signal: this.abort.signal
        })
      )
      if (!this.running) return
      await cp.memoryHomeMigrated({ agentId })
      state.attempts = 0
      const refused = report.skipped > 0 ? `, ${report.skipped} refused by the target` : ''
      log.info(
        `memory: agent "${agentId}": memory home migrated to the Control Plane (${report.files} file(s), ${report.bytes} byte(s), ${report.records} change-log record(s)${refused})`
      )
      await this.deps.onMigrated(agentId)
    } catch (err) {
      if (err instanceof WireError && err.code === 'CONFLICT') {
        // The home moved on since the flip: whatever the CP holds now is not this copy's business, and neither tree is touched.
        state.conflicted = binding
        log.warn(
          `memory: agent "${agentId}": the Control Plane no longer expects the copy (${err.message}); leaving both trees as they are`
        )
        return
      }
      if (!this.running) return
      state.attempts += 1
      const base = this.deps.retryBaseMs ?? RETRY_BASE_MS
      const delay = Math.min(this.deps.retryMaxMs ?? RETRY_MAX_MS, base * 2 ** (state.attempts - 1))
      log.warn(
        `memory: agent "${agentId}": memory home migration failed (${describeFailure(err)}); retrying in ${Math.round(delay / 1000)}s`
      )
      state.timer = (this.deps.setTimer ?? setTimeout)(() => {
        state.timer = undefined
        this.reconcile()
      }, delay)
      state.timer.unref?.()
    }
  }

  private clearTimer(state: MigrationState): void {
    if (!state.timer) return
    ;(this.deps.clearTimer ?? clearTimeout)(state.timer)
    state.timer = undefined
  }
}
