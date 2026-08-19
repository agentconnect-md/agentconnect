/**
 * Agent memory — a DIRECTORY at the agent's memory ROOT (`<root>/memory/`), OUTSIDE
 * the workspace so it survives a workspace reset / re-clone and is never committed
 * into a github-workspace repo. The root is a `MemoryFs` (memory/fs.ts): the
 * agent dir on this disk for a local agent, one root on the sandbox volume reached
 * through the shim for a cluster agent — every function here takes the port and
 * never touches `node:fs` itself.
 *
 * Index-plus-topics shape (the structure Claude Code's auto-memory uses): a lean
 * `MEMORY.md` index — injected into the prompt every session, so it must stay small
 * — plus any number of `<topic>.md` files the agent reads on demand. The agent
 * maintains it via the `readMemory` / `writeMemory` MCP tools (writeMemory does both
 * full-write and str-replace edits); the daemon serves the same directory to the CP
 * for the console (which still lists files via the internal `listMemory` helper).
 *
 * SECURITY: topic paths are agent/console-supplied, so absolute paths and `..`
 * escapes are rejected here; the port rejects symlinks/non-files and publishes
 * writes through a random exclusive temp file. Flat by design (one level): a topic
 * is a file directly under `memory/`, no nested dirs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  MEMORY_INDEX,
  MemoryFileHistoryEvent as MemoryFileHistoryEventSchema,
  type MemoryFileHistoryEvent
} from '@agentconnect.md/protocol'
import {
  MemoryConflictError,
  MemoryPathError,
  MemoryTooLargeError,
  type MemoryFs,
  type MemoryFsFileStat
} from './fs.js'

export {
  MemoryConflictError,
  MemoryPathError,
  MemorySandboxUnavailableError,
  MemoryTooLargeError,
  atomicWriteContainedMemoryFile,
  readContainedMemoryFile,
  LocalMemoryFs,
  type MemoryFs
} from './fs.js'

import {
  memoryLinkTargets,
  memoryNameForTopic,
  memoryRefToTopic,
  parseMemoryFrontmatter,
  stampMemoryHeader
} from './frontmatter.js'

export const MEMORY_DIRNAME = 'memory'
export { MEMORY_INDEX }

/** Max bytes of the index injected into the prompt each session — keeps a large
 *  memory from swelling the context (mirrors Claude Code's 25 KB entrypoint cap). */
export const MAX_INDEX_INJECT_BYTES = 25_000

const INDEX_TRUNCATION_NOTICE = '\n\n[…memory index truncated — trim MEMORY.md]'

/** Hard cap on a single memory file. Injected/read every session, so an unbounded
 *  file would swell the prompt and the wire; writes over this are rejected. */
export const MAX_MEMORY_FILE_BYTES = 256_000

/** The retained change log for an agent's memory, a sidecar beside the memory
 *  files (`<agent-root>/memory/.history`). One JSON line per write, for provenance
 *  (who/what/when changed a file). Dotfile so it never surfaces as a topic. */
export const MEMORY_HISTORY_FILENAME = '.history'

/** Cap on a `before`/`after` snapshot stored in a history line — keeps a single log
 *  entry bounded even for a large file. Over this, the snapshot is truncated (with a
 *  `…` marker) rather than omitted, so the line stays small but still human-readable. */
export const MAX_HISTORY_VALUE_BYTES = 4_000

/** System-default retention for the shared managed-memory history sidecar.
 *  Retention is intentionally not user-configurable: preserve the newest rows,
 *  cap each memory file at 100 versions, then cap the whole JSONL file at 2 MiB. */
export const MAX_HISTORY_VERSIONS_PER_FILE = 100
export const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024

/** Where a memory write originated — for change-log provenance. */
export type MemoryWriteSource = 'tool' | 'console' | 'distill' | 'dream'

/** One line in the memory change log (`.history`). `event` is `add` on a first write,
 *  `update` on an overwrite; `delete` is reserved (no delete op exists today — a
 *  "clear" is an empty write, recorded as an `update`). `before`/`after` are the
 *  file's text, truncated to {@link MAX_HISTORY_VALUE_BYTES}. */
export type MemoryHistoryRecord = MemoryFileHistoryEvent

export interface ManagedMemoryHistoryPage {
  events: MemoryHistoryRecord[]
  nextCursor?: string
}

export interface MemoryHistoryRetentionLimits {
  maxBytes: number
  maxVersionsPerFile: number
}

const DEFAULT_HISTORY_RETENTION: MemoryHistoryRetentionLimits = {
  maxBytes: MAX_HISTORY_FILE_BYTES,
  maxVersionsPerFile: MAX_HISTORY_VERSIONS_PER_FILE
}

/** The memory directory for an agent, given its local root dir (where agent.json lives). */
export function memoryDir(agentDir: string): string {
  return join(agentDir, MEMORY_DIRNAME)
}

/** Sibling of `memory/` that holds one self-contained memory subtree per channel
 *  when the agent's memory scope is `channel` (#653). */
export const CHANNEL_MEMORY_DIRNAME = 'channels'

/** A deterministic, filesystem-safe folder name for one channel's memory. Keeps a
 *  readable prefix and appends a short digest so distinct (transportScope, channel)
 *  pairs never collide after sanitization. */
export function memoryChannelKey(channel: string, transportScope?: string): string {
  const raw = transportScope ? `${transportScope}::${channel}` : channel
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  const prefix = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return prefix ? `${prefix}-${digest}` : digest
}

const CHANNEL_KEY_RE = /^[A-Za-z0-9._-]{1,120}$/

function assertChannelKey(channelKey: string): void {
  if (channelKey === '.' || channelKey === '..' || !CHANNEL_KEY_RE.test(channelKey)) {
    throw new MemoryPathError('invalid channel memory key')
  }
}

/** The self-contained memory root for one channel (its own `memory/` + `.history`),
 *  used exactly like an agent root. `channelKey` MUST be a pre-sanitized single
 *  path segment (from {@link memoryChannelKey}); anything else is rejected so a
 *  crafted key cannot escape the agent tree. */
export function channelMemoryRoot(fs: MemoryFs, channelKey: string): MemoryFs {
  assertChannelKey(channelKey)
  return fs.subdir(`${CHANNEL_MEMORY_DIRNAME}/${channelKey}`)
}

/** Source identity of a channel memory folder, so the console can render a name
 *  instead of the opaque key. Written when the folder is first created. */
export interface ChannelMemoryMeta {
  channel: string
  transportScope?: string
}

const CHANNEL_META_FILENAME = 'channel.json'

/** Record the source channel identity for a channel memory folder (idempotent
 *  best-effort; a write failure never blocks memory itself). Lives at the channel
 *  root, outside `memory/`, so it never appears as a memory topic. */
export async function writeChannelMemoryMeta(fs: MemoryFs, channelKey: string, meta: ChannelMemoryMeta): Promise<void> {
  assertChannelKey(channelKey)
  const body = JSON.stringify({
    channel: meta.channel,
    ...(meta.transportScope ? { transportScope: meta.transportScope } : {})
  })
  await fs.writeFile(`${CHANNEL_MEMORY_DIRNAME}/${channelKey}/${CHANNEL_META_FILENAME}`, body).catch(() => {})
}

/** Read a channel memory folder's source identity, or null if absent/unreadable. */
export async function readChannelMemoryMeta(fs: MemoryFs, channelKey: string): Promise<ChannelMemoryMeta | null> {
  assertChannelKey(channelKey)
  try {
    const file = await fs.readFile(`${CHANNEL_MEMORY_DIRNAME}/${channelKey}/${CHANNEL_META_FILENAME}`)
    if (!file) return null
    const parsed = JSON.parse(file.content) as ChannelMemoryMeta
    if (parsed && typeof parsed.channel === 'string') return parsed
  } catch {
    /* missing or malformed — treat as unknown */
  }
  return null
}

/** List the channelKeys that have a memory subtree under an agent root (the folder
 *  names under `channels/`). Absent ⇒ none. */
export async function listChannelMemoryKeys(fs: MemoryFs): Promise<string[]> {
  const entries = await fs.readdir(CHANNEL_MEMORY_DIRNAME)
  return entries
    .filter((d) => d.kind === 'dir' && CHANNEL_KEY_RE.test(d.name))
    .map((d) => d.name)
    .sort()
}

/**
 * Per-memory-directory serial mutex shared by ALL managed-store writers
 * (`writeMemoryFile` below, and dream adoption via `DreamRunner`). This is the
 * shared exclusion the dream adoption fence relies on: a console/tool/distill
 * write cannot land between adoption's final digest re-check and its swap, so a
 * non-forced adoption can never silently overwrite a post-fence write. Keyed by
 * the port's identity; a rejected critical section never wedges the chain.
 */
const memoryDirLocks = new Map<string, Promise<unknown>>()

function lockKey(fs: MemoryFs): string {
  return `${fs.key}::${MEMORY_DIRNAME}`
}

export function withMemoryDirLock<T>(fs: MemoryFs, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(fs)
  const prev = memoryDirLocks.get(key) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  memoryDirLocks.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  )
  return result
}

/** Validate a memory-dir-relative topic path: no absolute paths, no `..`, flat only,
 *  never the reserved history sidecar. Returns the bare file name. */
export function memoryTopicName(relPath: string): string {
  if (isAbsolute(relPath)) throw new MemoryPathError('absolute paths are not allowed')
  const dir = resolve(sep, MEMORY_DIRNAME)
  const abs = resolve(dir, relPath)
  if (abs !== dir && !abs.startsWith(dir + sep)) throw new MemoryPathError('path escapes the memory dir')
  // Flat memory dir: a topic is a direct child, never a nested path.
  const rel = abs.slice(dir.length + 1)
  if (rel.includes(sep)) throw new MemoryPathError('memory is a flat directory (no subdirectories)')
  if (rel.length === 0) throw new MemoryPathError('a file name is required')
  if (rel === MEMORY_HISTORY_FILENAME) throw new MemoryPathError('memory history is a reserved internal file')
  return rel
}

function topicPath(relPath: string): string {
  return `${MEMORY_DIRNAME}/${memoryTopicName(relPath)}`
}

const HISTORY_PATH = `${MEMORY_DIRNAME}/${MEMORY_HISTORY_FILENAME}`

/** Seed `<root>/memory/MEMORY.md` with a header if the dir/index is absent
 *  (idempotent). Called at session start so a brand-new agent always has an index. */
export async function ensureMemory(fs: MemoryFs, agentName: string): Promise<void> {
  await fs.mkdir(MEMORY_DIRNAME)
  if ((await fs.readFile(`${MEMORY_DIRNAME}/${MEMORY_INDEX}`)) !== null) return
  await fs.writeFile(
    `${MEMORY_DIRNAME}/${MEMORY_INDEX}`,
    `# ${agentName} memory\n\nYour long-term memory index. Keep it short — link out to topic files ` +
      `(e.g. \`[deploys](deploys.md)\`) for detail and read them on demand with the readMemory tool.\n`
  )
}

/** Read the memory index (`MEMORY.md`) for prompt injection, trimmed to the inject
 *  cap so a large index can't blow up the prompt; '' when absent. */
export async function readIndex(fs: MemoryFs): Promise<string> {
  let text: string
  try {
    text = await readMemoryFile(fs, MEMORY_INDEX)
  } catch (err) {
    // This runs at session start for EVERY new session, and its contract is already
    // "'' when absent". A rejected index — a symlink planted where MEMORY.md belongs —
    // must not be read through, but it must not brick the agent either: inject
    // nothing and let the session proceed. The explicit readMemory/writeMemory and
    // console paths still raise, so the cause stays visible where it is actionable.
    if (err instanceof MemoryPathError) return ''
    throw err
  }
  if (Buffer.byteLength(text) <= MAX_INDEX_INJECT_BYTES) return text
  // Reserve the notice inside the budget and cut before a complete UTF-8 code
  // point. The serialized session boundary applies the same cap after escaping.
  const buf = Buffer.from(text, 'utf8')
  let end = MAX_INDEX_INJECT_BYTES - Buffer.byteLength(INDEX_TRUNCATION_NOTICE)
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8') + INDEX_TRUNCATION_NOTICE
}

/** Read a memory file's text; '' when it does not exist (never throws on absence). */
export async function readMemoryFile(fs: MemoryFs, relPath: string): Promise<string> {
  relPath = memoryRefToTopic(relPath)
  return (await readMemoryFileIfPresent(fs, relPath)) ?? ''
}

/** Like {@link readMemoryFile} but distinguishes absent (`null`) from present-but-
 *  empty (`''`). The channel/base overlay needs this so an intentionally-empty
 *  channel file still shadows a non-empty base file instead of falling through. */
export async function readMemoryFileIfPresent(fs: MemoryFs, relPath: string): Promise<string | null> {
  relPath = memoryRefToTopic(relPath)
  const file = await fs.readFile(topicPath(relPath))
  return file === null ? null : file.content
}

/** Truncate a snapshot to the history value cap, on a UTF-8 boundary, flagging it. */
export function clampMemoryHistoryValue(text: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_HISTORY_VALUE_BYTES) return { value: text, truncated: false }
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_HISTORY_VALUE_BYTES)
  return { value: buf.toString('utf8') + '…', truncated: true }
}

function historyLine(record: MemoryHistoryRecord): string {
  return JSON.stringify(record) + '\n'
}

function historyLineBytes(record: MemoryHistoryRecord): number {
  return Buffer.byteLength(historyLine(record))
}

function parseHistory(raw: string): { records: MemoryHistoryRecord[]; nonEmptyLines: number } {
  const records: MemoryHistoryRecord[] = []
  let nonEmptyLines = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    nonEmptyLines += 1
    let candidate: unknown
    try {
      candidate = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = MemoryFileHistoryEventSchema.safeParse(candidate)
    if (parsed.success) records.push(parsed.data)
  }
  return { records, nonEmptyLines }
}

/** Apply the fixed retention order to already-validated rows: first retain the
 * newest N versions of each file, then evict globally oldest rows until their
 * encoded JSONL representation fits the byte cap. Input/output stay chronological. */
export function retainMemoryHistoryRecords(
  records: MemoryHistoryRecord[],
  limits: MemoryHistoryRetentionLimits = DEFAULT_HISTORY_RETENTION
): MemoryHistoryRecord[] {
  const versionsByPath = new Map<string, number>()
  const perFile: MemoryHistoryRecord[] = []
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    const versions = versionsByPath.get(record.path) ?? 0
    if (versions >= limits.maxVersionsPerFile) continue
    versionsByPath.set(record.path, versions + 1)
    perFile.push(record)
  }
  perFile.reverse()

  let encodedBytes = perFile.reduce((total, record) => total + historyLineBytes(record), 0)
  let first = 0
  while (first < perFile.length && encodedBytes > limits.maxBytes) {
    encodedBytes -= historyLineBytes(perFile[first]!)
    first += 1
  }
  return perFile.slice(first)
}

/** Turn a possibly legacy/torn sidecar into canonical retained JSONL. This is
 * pure so dream adoption can repair the copied sidecar before adding its rows;
 * callers that touch the live store must still hold the memory-dir lock. */
export function canonicalizeMemoryHistory(raw: string): string {
  const withIds = parseHistory(raw).records.map((record) => (record.id ? record : { ...record, id: randomUUID() }))
  return retainMemoryHistoryRecords(withIds).map(historyLine).join('')
}

/** The sidecar's raw text; '' when absent. */
async function readHistoryRaw(fs: MemoryFs): Promise<string> {
  return (await fs.readFile(HISTORY_PATH))?.content ?? ''
}

/** Take a canonical history snapshot while the caller already holds the memory-dir
 * lock. Dream adoption uses this in the same critical section as its final live-store
 * snapshot and directory swap. */
export async function snapshotMemoryHistoryHoldingLock(fs: MemoryFs): Promise<string> {
  const raw = await readHistoryRaw(fs)
  return raw ? canonicalizeMemoryHistory(raw) : ''
}

/** Take a canonical snapshot for a replacement store. The brief shared lock makes the
 * copied sidecar line up with ordinary appends. */
export function snapshotMemoryHistory(fs: MemoryFs): Promise<string> {
  return withMemoryDirLock(fs, () => snapshotMemoryHistoryHoldingLock(fs))
}

/** Compact one sidecar atomically. Invalid legacy/torn rows are discarded and
 * rows written before stable event IDs existed are upgraded during the rewrite. */
async function compactHistoryFile(fs: MemoryFs): Promise<void> {
  const raw = await readHistoryRaw(fs)
  if (!raw) return
  const canonical = canonicalizeMemoryHistory(raw)
  if (canonical === raw) return
  await fs.writeFile(HISTORY_PATH, canonical, { mode: 0o600 })
}

/** Apply system retention while the caller already holds the memory-dir lock.
 * Exported for dream adoption, whose directory swap is one larger critical
 * section. Calling this without the shared lock would race ordinary writes. */
export async function enforceMemoryHistoryRetentionHoldingLock(fs: MemoryFs): Promise<void> {
  await compactHistoryFile(fs)
}

/** Apply system retention to an existing sidecar (including legacy files).
 * Callers decide whether failure is best-effort. */
export function enforceMemoryHistoryRetention(fs: MemoryFs): Promise<void> {
  return withMemoryDirLock(fs, () => enforceMemoryHistoryRetentionHoldingLock(fs))
}

/** Append one line to the memory change log and enforce fixed retention: the current
 * sidecar is canonicalized first (a legacy row without its final newline, or a torn
 * tail, would otherwise absorb this append into one invalid row), then rewritten once
 * with the new row retained. Best-effort: provenance failure never fails the write. */
async function appendHistoryHoldingLock(fs: MemoryFs, record: MemoryHistoryRecord): Promise<void> {
  const canonical = canonicalizeMemoryHistory(await readHistoryRaw(fs))
  const next = canonicalizeMemoryHistory(canonical + historyLine({ ...record, id: record.id ?? randomUUID() }))
  await fs.writeFile(HISTORY_PATH, next, { mode: 0o600 })
}

export async function appendHistory(fs: MemoryFs, record: MemoryHistoryRecord): Promise<void> {
  try {
    await withMemoryDirLock(fs, () => appendHistoryHoldingLock(fs, record))
  } catch {
    // Provenance is best-effort — retry compaction on the next append/read.
  }
}

/**
 * Page one file's managed-memory history newest first. The cursor is the stable ID
 * of the next event, so appends and retention cannot shift or duplicate older pages.
 *
 * Invalid/corrupt lines are skipped. History is provenance rather than the source
 * of truth, so one torn or legacy row must not make every valid row unreadable.
 */
export async function listMemoryHistory(
  fs: MemoryFs,
  relPath: string,
  cursor: string | undefined,
  limit: number
): Promise<ManagedMemoryHistoryPage> {
  // Apply the same containment/flat-path validation as ordinary memory reads,
  // even though `relPath` is used only as a filter below.
  memoryTopicName(relPath)

  return withMemoryDirLock(fs, async () => {
    // Enforce retention on first access too, so a legacy oversized file is
    // tightened even before the next managed memory write.
    try {
      await compactHistoryFile(fs)
    } catch {
      // History remains readable when best-effort compaction cannot run.
    }

    const raw = await readHistoryRaw(fs)
    if (!raw) return { events: [] }

    const records = parseHistory(raw).records
    let start = records.length - 1
    if (cursor) {
      start = records.findIndex((record) => record.id === cursor && record.path === relPath)
      // A retention pass may have evicted this cursor. Because eviction is always
      // oldest-first, no older retained rows can remain for this file.
      if (start < 0) return { events: [] }
    }

    const events: MemoryHistoryRecord[] = []
    let nextCursor: string | undefined
    for (let index = start; index >= 0; index -= 1) {
      const record = records[index]!
      if (record.path !== relPath) continue
      if (events.length === limit) {
        // Point at the next not-yet-returned row. IDs remain stable when older
        // rows are pruned or newer rows are appended between requests.
        nextCursor = record.id
        break
      }
      events.push(record)
    }

    return { events, ...(nextCursor ? { nextCursor } : {}) }
  })
}

/**
 * Per-memory-dir write ledger — the AUTHORITATIVE record of what has mutated a
 * store in this process, and the counterpart to `.history`.
 *
 * `.history` is deliberately best-effort: {@link appendHistory} swallows its
 * errors so a logging failure can never fail the write it describes. That makes
 * it a fine audit trail but an unsound *authorization* ledger — a tool write
 * whose append transiently failed would be invisible, and a later distill append
 * would make the window look distill-only. The dream adoption fence therefore
 * authorizes its rebase from these counters, which are bumped inside the write
 * itself under the same lock and cannot silently drop an entry.
 *
 * In-process only, so a daemon restart resets them; adoption treats a counter
 * that moved backwards as unprovable and fails closed.
 */
export interface MemoryWriteMarks {
  /** Opaque id of the daemon process+store instance these counts belong to.
   *  Counts are only comparable WITHIN one generation: a restart resets the
   *  counters, and numeric comparison alone cannot see that (a `{0,0}` snapshot
   *  never moves backwards, and any older snapshot is eventually caught up by
   *  new writes). Adoption requires an exact generation match before it trusts a
   *  single count. */
  generation: string
  /** Every successful managed mutation, whatever its source. */
  total: number
  /** The subset NOT written by per-turn distillation — tool, console, and dream
   *  mutations, the ones a rebase may never silently roll over. */
  nonDistill: number
}

/** New per process: every store's marks are stamped with it, so marks recorded
 *  by an earlier daemon can never be compared against this one's counts. */
const WRITE_MARK_GENERATION = randomUUID()

const writeMarks = new Map<string, { total: number; nonDistill: number }>()

/** A snapshot copy of one store's write marks (zeroed when never written). */
export function memoryWriteMarks(fs: MemoryFs): MemoryWriteMarks {
  const marks = writeMarks.get(lockKey(fs)) ?? { total: 0, nonDistill: 0 }
  return { generation: WRITE_MARK_GENERATION, ...marks }
}

/**
 * Count a managed-store mutation that did NOT go through {@link writeMemoryFile}
 * — today, a dream adoption's directory swap. Such a mutation is invisible to
 * the ledger otherwise, which would let a second dream staged from the same
 * snapshot classify the first adoption as distill-only drift and roll over it.
 * Callers must already hold the memory-dir lock.
 */
export function recordExternalMemoryMutation(fs: MemoryFs, source: MemoryWriteSource): void {
  bumpWriteMarks(fs, source)
}

function bumpWriteMarks(fs: MemoryFs, source: MemoryWriteSource): void {
  const key = lockKey(fs)
  const marks = writeMarks.get(key) ?? { total: 0, nonDistill: 0 }
  marks.total++
  if (source !== 'distill') marks.nonDistill++
  writeMarks.set(key, marks)
}

/** Overwrite a memory file with `content` (creating the dir if needed). Atomic
 *  (tmp + rename) so a concurrent read never sees a partial file. Appends a line to
 *  the change log (`.history`) recording the add/update, its `before`/`after`
 *  snapshot (bounded), and the `source`.
 *
 *  - Rejects content over {@link MAX_MEMORY_FILE_BYTES} ({@link MemoryTooLargeError}).
 *  - `ifMatchMtime` (optimistic concurrency): when given, the current file's mtime
 *    must equal it, else {@link MemoryConflictError} — so a console edit can't
 *    clobber a newer write. A brand-new file (no mtime) matches `ifMatchMtime`
 *    only when the caller passes none (or the empty string). */
export function writeMemoryFile(
  fs: MemoryFs,
  relPath: string,
  content: string,
  ifMatchMtime?: string,
  source: MemoryWriteSource = 'tool'
): Promise<{ size: number; mtime: string }> {
  // Serialize every write behind the shared per-dir lock so it can't interleave
  // with a dream adoption's fence-and-swap (nor another write).
  return withMemoryDirLock(fs, () => writeMemoryFileHoldingLock(fs, relPath, content, ifMatchMtime, source))
}

/**
 * The write itself, WITHOUT taking the memory-dir lock — for a caller that
 * already holds it and needs several writes to be one critical section (the
 * distiller's topic+index batch: an adoption slipping between those two writes
 * would be overwritten by the batch's stale index). The lock is not reentrant,
 * so calling {@link writeMemoryFile} from inside it would deadlock.
 */
export async function writeMemoryFileHoldingLock(
  fs: MemoryFs,
  relPath: string,
  content: string,
  ifMatchMtime: string | undefined,
  source: MemoryWriteSource
): Promise<{ size: number; mtime: string }> {
  const topic = memoryTopicName(relPath)
  // Keep a written header truthful (`name` from the filename, fresh `modified`).
  // Headerless notes are left exactly as written — frontmatter is never forced on.
  if (topic !== MEMORY_INDEX) content = stampMemoryHeader(topic, content, new Date().toISOString())
  if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryTooLargeError(`memory file exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  const path = topicPath(relPath)
  const current = await fs.readFile(path)
  const st: MemoryFsFileStat = await fs.writeFile(path, content, ifMatchMtime ? { ifMatchMtime } : {})
  // Bump the authoritative ledger the moment the write is durable — BEFORE the
  // best-effort history append, which is allowed to fail silently. The dream
  // adoption fence authorizes from these counters, never from `.history`.
  bumpWriteMarks(fs, source)

  const existed = current !== null
  const beforeClamped = existed ? clampMemoryHistoryValue(current.content) : undefined
  const afterClamped = clampMemoryHistoryValue(content)
  try {
    await appendHistoryHoldingLock(fs, {
      path: relPath,
      event: existed ? 'update' : 'add',
      ...(beforeClamped ? { before: beforeClamped.value } : {}),
      after: afterClamped.value,
      at: st.mtime,
      scope: 'agent',
      source,
      ...(afterClamped.truncated || beforeClamped?.truncated ? { truncated: true } : {})
    })
  } catch {
    // Provenance is best-effort — retry compaction on the next append/read.
  }
  if (topic !== MEMORY_INDEX) await regenerateMemoryIndexHoldingLock(fs, source)
  return { size: st.size, mtime: st.mtime }
}

/** The marker that identifies an index this code owns (vs one an agent hand-wrote). */
const INDEX_OVERFLOW_NOTICE = '\n[…more topics than fit the index — shorten some `description` headers]\n'

const GENERATED_INDEX_MARKER = "<!-- generated from each topic's `description` header — edit that, not this file -->"

/**
 * Rebuild `MEMORY.md` from the topic headers, so the index can never drift from the
 * files it points at (#41). The entry line carries each topic's `description`, which
 * is what lets the agent pick a topic to open without reading them all.
 *
 * Only runs once at least one topic carries a description: until then there is nothing
 * to generate from, and a legacy hand-written index is left untouched. The previous
 * index is recorded in `.history` by the caller's own write path, and here on replace.
 */
export async function regenerateMemoryIndexHoldingLock(
  fs: MemoryFs,
  source: MemoryWriteSource,
  opts: { force?: boolean } = {}
): Promise<void> {
  const entries: { topic: string; name: string; description: string }[] = []
  for (const file of await listMemory(fs)) {
    if (file.name === MEMORY_INDEX) continue
    const raw = await fs.readFile(`${MEMORY_DIRNAME}/${file.name}`)
    if (raw === null) continue
    const { header } = parseMemoryFrontmatter(raw.content)
    entries.push({
      topic: file.name,
      name: header.name || memoryNameForTopic(file.name),
      description: header.description ?? ''
    })
  }
  const current = await fs.readFile(`${MEMORY_DIRNAME}/${MEMORY_INDEX}`)
  // Take ownership on the first described topic; once the index is ours, keep it in
  // step forever — including when the last description is removed, which must clear
  // the stale line rather than freeze it in the injected index.
  const owned = current?.content.includes(GENERATED_INDEX_MARKER) === true
  // `force` is for a caller that just added topics and would otherwise hand-maintain
  // the index itself (distillation): adopt it now so there is exactly one writer.
  if (!owned && !opts.force && !entries.some((entry) => entry.description)) return

  const heading = /^#[ \t]+.*$/m.exec(current?.content ?? '')?.[0] ?? '# Memory'
  const prefix = `${heading}\n\n${GENERATED_INDEX_MARKER}\n\n`
  const lines: string[] = []
  let budget = MAX_MEMORY_FILE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(INDEX_OVERFLOW_NOTICE) - 1
  let dropped = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const line = `- [${entry.name}](${entry.topic})${entry.description ? ` — ${entry.description}` : ''}`
    const cost = Buffer.byteLength(line) + 1
    // The generated file is subject to the same managed bound as any other write.
    if (cost > budget) {
      dropped++
      continue
    }
    budget -= cost
    lines.push(line)
  }
  const next = `${prefix}${lines.join('\n')}\n${dropped > 0 ? INDEX_OVERFLOW_NOTICE : ''}`
  if (current?.content === next) return

  const st = await fs.writeFile(`${MEMORY_DIRNAME}/${MEMORY_INDEX}`, next, {})
  try {
    const before = current ? clampMemoryHistoryValue(current.content) : undefined
    const after = clampMemoryHistoryValue(next)
    await appendHistoryHoldingLock(fs, {
      path: MEMORY_INDEX,
      event: current ? 'update' : 'add',
      ...(before ? { before: before.value } : {}),
      after: after.value,
      at: st.mtime,
      scope: 'agent',
      source,
      ...(after.truncated || before?.truncated ? { truncated: true } : {})
    })
  } catch {
    // Provenance is best-effort, exactly as in the topic write above.
  }
}

/** One file in the memory dir. */
export interface MemoryFile {
  name: string
  size: number
  mtime: string
}

/** List the files in the memory dir (flat; index + topics), sorted with the index
 *  first. Empty when the dir does not exist. `.tmp` write artifacts are skipped. */
export async function listMemory(fs: MemoryFs): Promise<MemoryFile[]> {
  const files: MemoryFile[] = []
  for (const d of await fs.readdir(MEMORY_DIRNAME)) {
    // Skip non-files, `.tmp` write artifacts, and dotfiles (the `.history` change log
    // is a sidecar, not a topic the agent/console should see).
    if (d.kind !== 'file' || d.name.endsWith('.tmp') || d.name.startsWith('.')) continue
    if (d.size === undefined || d.mtime === undefined) continue // raced deletion
    files.push({ name: d.name, size: d.size, mtime: d.mtime })
  }
  files.sort((a, b) => (a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)))
  return files
}

/** One end of a `[[name]]` edge, with the description that makes it worth following. */
export interface MemoryNeighbor {
  name: string
  topic: string
  description?: string
  /** False for a link to a memory that does not exist yet — a deliberate note-to-self. */
  exists: boolean
}

export interface MemoryNeighbors {
  /** Memories this one links out to. */
  links: MemoryNeighbor[]
  /** Memories that link to this one. */
  backlinks: MemoryNeighbor[]
}

/** Cap on either side of the neighbour list, so a heavily linked memory cannot
 *  balloon a tool result. */
const MAX_NEIGHBORS = 20

/**
 * One hop of the memory graph around a topic (#41): what it links to, and what links
 * back. Descriptions come along so a link is actionable without a second read — the
 * whole point of the edges being there.
 */
export async function memoryNeighbors(roots: MemoryFs | MemoryFs[], relPath: string): Promise<MemoryNeighbors> {
  const topic = memoryTopicName(memoryRefToTopic(relPath))
  const self = memoryNameForTopic(topic)

  const described = new Map<string, { topic: string; description?: string }>()
  const outgoing = new Map<string, string[]>()
  // Walk the read overlay in precedence order (channel first, then the shared base)
  // and let the FIRST layer win, so a neighbour's metadata always describes the same
  // file a later `readMemory` would actually open.
  for (const fs of Array.isArray(roots) ? roots : [roots]) {
    for (const file of await listMemory(fs)) {
      const raw = await fs.readFile(`${MEMORY_DIRNAME}/${file.name}`)
      if (raw === null) continue
      const parsed = parseMemoryFrontmatter(raw.content)
      const name = parsed.header.name || memoryNameForTopic(file.name)
      if (described.has(name)) continue // shadowed by a higher-precedence layer
      described.set(name, {
        topic: file.name,
        ...(parsed.header.description ? { description: parsed.header.description } : {})
      })
      outgoing.set(name, memoryLinkTargets(parsed.body))
    }
  }

  const toNeighbor = (name: string): MemoryNeighbor => {
    const known = described.get(name)
    return {
      name,
      topic: known?.topic ?? `${name}.md`,
      ...(known?.description ? { description: known.description } : {}),
      exists: known !== undefined
    }
  }

  const links = (outgoing.get(self) ?? [])
    .filter((name) => name !== self)
    .slice(0, MAX_NEIGHBORS)
    .map(toNeighbor)
  const backlinks = [...outgoing.entries()]
    .filter(([name, targets]) => name !== self && targets.includes(self))
    .slice(0, MAX_NEIGHBORS)
    .map(([name]) => toNeighbor(name))
  return { links, backlinks }
}
