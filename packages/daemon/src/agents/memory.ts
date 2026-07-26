/**
 * Agent memory — a DIRECTORY at the agent's ROOT (`<agent-root>/memory/`), OUTSIDE
 * the workspace so it survives a workspace reset / re-clone and is never committed
 * into a github-workspace repo.
 *
 * Index-plus-topics shape (the structure Claude Code's auto-memory uses): a lean
 * `MEMORY.md` index — injected into the prompt every session, so it must stay small
 * — plus any number of `<topic>.md` files the agent reads on demand. The agent
 * maintains it via the `readMemory` / `writeMemory` MCP tools (writeMemory does both
 * full-write and str-replace edits); the daemon serves the same directory to the CP
 * for the console (which still lists files via the internal `listMemory` helper).
 *
 * SECURITY: topic paths are agent/console-supplied, so every path is contained to
 * the memory dir — absolute paths and `..` escapes are rejected, and the resolved
 * path is re-checked so a symlink can't smuggle a target out. Flat by design (one
 * level): a topic is a file directly under `memory/`, no nested dirs.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, isAbsolute, sep } from 'node:path'
import {
  MEMORY_INDEX,
  MemoryFileHistoryEvent as MemoryFileHistoryEventSchema,
  type MemoryFileHistoryEvent
} from '@agentconnect.md/protocol'

export const MEMORY_DIRNAME = 'memory'
export { MEMORY_INDEX }

/** Max bytes of the index injected into the prompt each session — keeps a large
 *  memory from swelling the context (mirrors Claude Code's 25 KB entrypoint cap). */
export const MAX_INDEX_INJECT_BYTES = 25_000

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
export type MemoryWriteSource = 'tool' | 'console' | 'distill'

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

/** One in-process mutation chain per agent sidecar. A managed memory directory
 * has one daemon owner, so this prevents append/compact races without a lockfile. */
const historyMutations = new Map<string, Promise<void>>()

/** Raised when a memory path escapes the memory dir. Surfaces as `BAD_PAYLOAD`. */
export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPathError'
  }
}

/** Raised when a write exceeds {@link MAX_MEMORY_FILE_BYTES}. `BAD_PAYLOAD`. */
export class MemoryTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryTooLargeError'
  }
}

/** Raised when an `ifMatchMtime` precondition fails (the file changed under the
 *  writer — e.g. a console edit racing a newer agent write). Surfaces as CONFLICT. */
export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryConflictError'
  }
}

/** The memory directory for an agent, given its root dir (where agent.json lives). */
export function memoryDir(agentDir: string): string {
  return join(agentDir, MEMORY_DIRNAME)
}

/** Resolve a memory-dir-relative path to an absolute one, contained to the dir.
 *  Rejects absolute paths, `..` escapes, and any nested directory (flat only). */
export function resolveInMemoryDir(agentDir: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new MemoryPathError('absolute paths are not allowed')
  const dir = memoryDir(agentDir)
  const abs = resolve(dir, relPath)
  if (abs !== dir && !abs.startsWith(dir + sep)) throw new MemoryPathError('path escapes the memory dir')
  // Flat memory dir: a topic is a direct child, never a nested path.
  const rel = abs.slice(dir.length + 1)
  if (rel.includes(sep)) throw new MemoryPathError('memory is a flat directory (no subdirectories)')
  if (rel.length === 0) throw new MemoryPathError('a file name is required')
  return abs
}

/** Seed `<agent-root>/memory/MEMORY.md` with a header if the dir/index is absent
 *  (idempotent). Called at session start so a brand-new agent always has an index. */
export function ensureMemory(agentDir: string, agentName: string): void {
  const dir = memoryDir(agentDir)
  mkdirSync(dir, { recursive: true })
  const index = join(dir, MEMORY_INDEX)
  if (!existsSync(index)) {
    writeFileSync(
      index,
      `# ${agentName} memory\n\nYour long-term memory index. Keep it short — link out to topic files ` +
        `(e.g. \`[deploys](deploys.md)\`) for detail and read them on demand with the readMemory tool.\n`
    )
  }
}

/** Read the memory index (`MEMORY.md`) for prompt injection, trimmed to the inject
 *  cap so a large index can't blow up the prompt; '' when absent. */
export async function readIndex(agentDir: string): Promise<string> {
  const text = await readMemoryFile(agentDir, MEMORY_INDEX)
  if (Buffer.byteLength(text) <= MAX_INDEX_INJECT_BYTES) return text
  // Cut on a UTF-8 boundary near the cap and flag the truncation.
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_INDEX_INJECT_BYTES)
  return buf.toString('utf8') + '\n\n[…memory index truncated — trim MEMORY.md]'
}

/** Read a memory file's text; '' when it does not exist (never throws on ENOENT). */
export async function readMemoryFile(agentDir: string, relPath: string): Promise<string> {
  const abs = resolveInMemoryDir(agentDir, relPath)
  try {
    return await fsp.readFile(abs, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** Truncate a snapshot to the history value cap, on a UTF-8 boundary, flagging it. */
function clampHistoryValue(text: string): { value: string; truncated: boolean } {
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

async function serializeHistoryMutation(path: string, mutation: () => Promise<void>): Promise<void> {
  const previous = historyMutations.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(mutation)
  historyMutations.set(path, current)
  try {
    await current
  } finally {
    if (historyMutations.get(path) === current) historyMutations.delete(path)
  }
}

/** Compact one sidecar atomically. Invalid legacy/torn rows are discarded and
 * rows written before stable event IDs existed are upgraded during the rewrite. */
async function compactHistoryFile(path: string): Promise<void> {
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  const parsed = parseHistory(raw)
  let upgraded = false
  const withIds = parsed.records.map((record) => {
    if (record.id) return record
    upgraded = true
    return { ...record, id: randomUUID() }
  })
  const retained = retainMemoryHistoryRecords(withIds)
  const needsRewrite =
    upgraded ||
    retained.length !== withIds.length ||
    parsed.records.length !== parsed.nonEmptyLines ||
    Buffer.byteLength(raw) > MAX_HISTORY_FILE_BYTES
  if (!needsRewrite) return

  const tmp = `${path}.tmp`
  await fsp.writeFile(tmp, retained.map(historyLine).join(''), 'utf8')
  await fsp.rename(tmp, path)
}

/** Apply system retention to an existing sidecar (including legacy files) while
 * serializing with appends. Callers decide whether failure is best-effort. */
export async function enforceMemoryHistoryRetention(agentDir: string): Promise<void> {
  const path = join(memoryDir(agentDir), MEMORY_HISTORY_FILENAME)
  await serializeHistoryMutation(path, () => compactHistoryFile(path))
}

/** Append one line to the memory change log and enforce fixed retention. The
 * mutation queue prevents a compaction rename from dropping a concurrent append.
 * Best-effort: provenance/retention failure must never fail the memory write. */
export async function appendHistory(agentDir: string, record: MemoryHistoryRecord): Promise<void> {
  const path = join(memoryDir(agentDir), MEMORY_HISTORY_FILENAME)
  try {
    await serializeHistoryMutation(path, async () => {
      await fsp.mkdir(memoryDir(agentDir), { recursive: true })
      await fsp.appendFile(path, historyLine({ ...record, id: record.id ?? randomUUID() }), 'utf8')
      await compactHistoryFile(path)
    })
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
  agentDir: string,
  relPath: string,
  cursor: string | undefined,
  limit: number
): Promise<ManagedMemoryHistoryPage> {
  // Apply the same containment/flat-path validation as ordinary memory reads,
  // even though `relPath` is used only as a filter below.
  resolveInMemoryDir(agentDir, relPath)

  // Enforce retention on first access too, so a legacy oversized file is
  // tightened even before the next managed memory write.
  try {
    await enforceMemoryHistoryRetention(agentDir)
  } catch {
    // History remains readable when best-effort compaction cannot run.
  }

  let raw: string
  try {
    raw = await fsp.readFile(join(memoryDir(agentDir), MEMORY_HISTORY_FILENAME), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [] }
    throw err
  }

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
export async function writeMemoryFile(
  agentDir: string,
  relPath: string,
  content: string,
  ifMatchMtime?: string,
  source: MemoryWriteSource = 'tool'
): Promise<{ size: number; mtime: string }> {
  if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryTooLargeError(`memory file exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  const abs = resolveInMemoryDir(agentDir, relPath)
  // Read the prior contents (for the change log's `before` + to decide add vs update)
  // before we overwrite. '' when absent ⇒ this is an `add`.
  let before = ''
  let existed = false
  try {
    before = await fsp.readFile(abs, 'utf8')
    existed = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (ifMatchMtime) {
    let current: string | null = null
    try {
      current = (await fsp.stat(abs)).mtime.toISOString()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (current !== ifMatchMtime) {
      throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
    }
  }
  await fsp.mkdir(memoryDir(agentDir), { recursive: true })
  const tmp = `${abs}.tmp`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, abs)
  const st = await fsp.stat(abs)

  const beforeClamped = existed ? clampHistoryValue(before) : undefined
  const afterClamped = clampHistoryValue(content)
  await appendHistory(agentDir, {
    path: relPath,
    event: existed ? 'update' : 'add',
    ...(beforeClamped ? { before: beforeClamped.value } : {}),
    after: afterClamped.value,
    at: st.mtime.toISOString(),
    scope: 'agent',
    source,
    ...(afterClamped.truncated || beforeClamped?.truncated ? { truncated: true } : {})
  })
  return { size: st.size, mtime: st.mtime.toISOString() }
}

/** One file in the memory dir. */
export interface MemoryFile {
  name: string
  size: number
  mtime: string
}

/** List the files in the memory dir (flat; index + topics), sorted with the index
 *  first. Empty when the dir does not exist. `.tmp` write artifacts are skipped. */
export async function listMemory(agentDir: string): Promise<MemoryFile[]> {
  const dir = memoryDir(agentDir)
  let dirents
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const files: MemoryFile[] = []
  for (const d of dirents) {
    // Skip non-files, `.tmp` write artifacts, and dotfiles (the `.history` change log
    // is a sidecar, not a topic the agent/console should see).
    if (!d.isFile() || d.name.endsWith('.tmp') || d.name.startsWith('.')) continue
    try {
      const st = await fsp.stat(join(dir, d.name))
      files.push({ name: d.name, size: st.size, mtime: st.mtime.toISOString() })
    } catch {
      // raced deletion — skip
    }
  }
  files.sort((a, b) => (a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)))
  return files
}
