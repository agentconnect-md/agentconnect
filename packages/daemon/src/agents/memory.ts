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
 * SECURITY: topic paths are agent/console-supplied, so absolute paths and `..`
 * escapes are rejected. Reads and writes both walk and canonicalise every parent
 * and reject symlinks/non-files — the daemon is outside the agent's sandbox, so a
 * link planted in the writable memory dir must not redirect either direction.
 * Writes additionally publish through a random exclusive temp file. Flat by design
 * (one level): a topic is a file directly under `memory/`, no nested dirs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fsp, lstatSync, mkdirSync, realpathSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/** The self-contained memory root for one channel (its own `memory/` + `.history`),
 *  used exactly like an agent root. `channelKey` MUST be a pre-sanitized single
 *  path segment (from {@link memoryChannelKey}); anything else is rejected so a
 *  crafted key cannot escape the agent tree. */
export function channelMemoryRoot(agentDir: string, channelKey: string): string {
  if (channelKey === '.' || channelKey === '..' || !/^[A-Za-z0-9._-]{1,120}$/.test(channelKey)) {
    throw new MemoryPathError('invalid channel memory key')
  }
  return join(agentDir, CHANNEL_MEMORY_DIRNAME, channelKey)
}

/** Source identity of a channel memory folder, so the console can render a name
 *  instead of the opaque key. Written when the folder is first created. */
export interface ChannelMemoryMeta {
  channel: string
  transportScope?: string
}

/** Record the source channel identity for a channel memory folder (idempotent
 *  best-effort; a write failure never blocks memory itself). Lives at the channel
 *  root, outside `memory/`, so it never appears as a memory topic. */
export async function writeChannelMemoryMeta(
  agentDir: string,
  channelKey: string,
  meta: ChannelMemoryMeta
): Promise<void> {
  const root = channelMemoryRoot(agentDir, channelKey)
  await fsp.mkdir(root, { recursive: true })
  const body = JSON.stringify({
    channel: meta.channel,
    ...(meta.transportScope ? { transportScope: meta.transportScope } : {})
  })
  await fsp.writeFile(join(root, 'channel.json'), body, 'utf8').catch(() => {})
}

/** Read a channel memory folder's source identity, or null if absent/unreadable. */
export async function readChannelMemoryMeta(agentDir: string, channelKey: string): Promise<ChannelMemoryMeta | null> {
  try {
    const raw = await fsp.readFile(join(channelMemoryRoot(agentDir, channelKey), 'channel.json'), 'utf8')
    const parsed = JSON.parse(raw) as ChannelMemoryMeta
    if (parsed && typeof parsed.channel === 'string') return parsed
  } catch {
    /* missing or malformed — treat as unknown */
  }
  return null
}

/** List the channelKeys that have a memory subtree under an agent root (the folder
 *  names under `channels/`). ENOENT ⇒ none. */
export async function listChannelMemoryKeys(agentDir: string): Promise<string[]> {
  const root = join(agentDir, CHANNEL_MEMORY_DIRNAME)
  let dirents
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return dirents
    .filter((d) => d.isDirectory() && /^[A-Za-z0-9._-]{1,120}$/.test(d.name))
    .map((d) => d.name)
    .sort()
}

/**
 * Per-memory-directory serial mutex shared by ALL managed-store writers
 * (`writeMemoryFile` below, and dream adoption via `DreamRunner`). This is the
 * shared exclusion the dream adoption fence relies on: a console/tool/distill
 * write cannot land between adoption's final digest re-check and its swap, so a
 * non-forced adoption can never silently overwrite a post-fence write. Keyed by
 * the resolved memory dir; a rejected critical section never wedges the chain.
 */
const memoryDirLocks = new Map<string, Promise<unknown>>()

export function withMemoryDirLock<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
  const key = memoryDir(agentDir)
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
  if (rel === MEMORY_HISTORY_FILENAME) throw new MemoryPathError('memory history is a reserved internal file')
  return abs
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

function under(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/**
 * Create and canonicalise a destination's parent one component at a time.
 * `root` is the provider-owned memory tree; `agentDir` is the trusted outer
 * boundary. Existing symlink components are rejected instead of followed.
 */
async function containedWriteTarget(agentDir: string, root: string, destination: string): Promise<string> {
  const lexicalAgent = resolve(agentDir)
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(destination)
  if (!under(lexicalAgent, lexicalRoot) || !under(lexicalRoot, lexicalTarget)) {
    throw new MemoryPathError('path escapes the memory dir')
  }

  const realAgent = await fsp.realpath(lexicalAgent)
  let parent = realAgent
  for (const part of relative(lexicalAgent, dirname(lexicalTarget)).split(sep).filter(Boolean)) {
    const candidate = join(parent, part)
    let stat: Stats
    try {
      stat = await fsp.lstat(candidate)
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
      try {
        await fsp.mkdir(candidate)
      } catch (mkdirErr) {
        if (!isErrno(mkdirErr, 'EEXIST')) throw mkdirErr
      }
      stat = await fsp.lstat(candidate)
    }
    if (!stat.isDirectory()) throw new MemoryPathError('memory path contains a symlink or non-directory')
    parent = await fsp.realpath(candidate)
    if (!under(realAgent, parent)) throw new MemoryPathError('path resolves outside the agent root')
  }

  const realRoot = await fsp.realpath(lexicalRoot)
  if (!under(realAgent, realRoot) || !under(realRoot, parent)) {
    throw new MemoryPathError('path resolves outside the memory dir')
  }
  return join(parent, basename(lexicalTarget))
}

/**
 * Canonicalise a destination's parent one component at a time WITHOUT creating
 * anything — the read-side twin of `containedWriteTarget`. Existing symlink
 * components are rejected instead of followed; a missing component means there is
 * nothing to read, reported as `null` so callers keep their "'' when absent"
 * contract.
 */
async function containedReadTarget(agentDir: string, root: string, destination: string): Promise<string | null> {
  const lexicalAgent = resolve(agentDir)
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(destination)
  if (!under(lexicalAgent, lexicalRoot) || !under(lexicalRoot, lexicalTarget)) {
    throw new MemoryPathError('path escapes the memory dir')
  }

  let realAgent: string
  try {
    realAgent = await fsp.realpath(lexicalAgent)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  let parent = realAgent
  for (const part of relative(lexicalAgent, dirname(lexicalTarget)).split(sep).filter(Boolean)) {
    const candidate = join(parent, part)
    let stat: Stats
    try {
      stat = await fsp.lstat(candidate)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null
      throw err
    }
    if (!stat.isDirectory()) throw new MemoryPathError('memory path contains a symlink or non-directory')
    parent = await fsp.realpath(candidate)
    if (!under(realAgent, parent)) throw new MemoryPathError('path resolves outside the agent root')
  }

  let realRoot: string
  try {
    realRoot = await fsp.realpath(lexicalRoot)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  if (!under(realAgent, realRoot) || !under(realRoot, parent)) {
    throw new MemoryPathError('path resolves outside the memory dir')
  }
  return join(parent, basename(lexicalTarget))
}

/**
 * Read one file out of a memory provider's tree without following symlinks; ''
 * when it does not exist. The daemon is NOT inside the agent's sandbox, so a link
 * planted in a writable memory dir would otherwise turn a memory read into an
 * arbitrary-file read — the mirror of the write path's escape.
 */
export async function readContainedMemoryFile(agentDir: string, root: string, destination: string): Promise<string> {
  const target = await containedReadTarget(agentDir, root, destination)
  if (target === null) return ''
  return (await readCurrentMemoryFile(target)).before
}

type CurrentMemoryFile =
  { existed: false; before: ''; stat?: undefined } | { existed: true; before: string; stat: Stats }

async function readCurrentMemoryFile(target: string): Promise<CurrentMemoryFile> {
  let handle
  try {
    handle = await fsp.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { existed: false, before: '' }
    if (isErrno(err, 'ELOOP')) throw new MemoryPathError('memory target is not a regular file')
    throw err
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new MemoryPathError('memory target is not a regular file')
    return { existed: true, before: await handle.readFile('utf8'), stat }
  } finally {
    await handle.close()
  }
}

/**
 * Atomically replace one file under a memory provider's tree without following
 * symlinks. The random `wx` temp defeats pre-planted `<target>.tmp` links; the
 * canonical parent walk also rejects a symlinked native-memory directory.
 */
export async function atomicWriteContainedMemoryFile(
  agentDir: string,
  root: string,
  destination: string,
  content: string,
  ifMatchMtime?: string,
  mode?: number
): Promise<{ before: string; existed: boolean; stat: Stats }> {
  const target = await containedWriteTarget(agentDir, root, destination)
  const current = await readCurrentMemoryFile(target)
  if (ifMatchMtime && current.stat?.mtime.toISOString() !== ifMatchMtime) {
    throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
  }

  const parent = dirname(target)
  const temp = join(parent, `.agentconnect-memory-${randomUUID()}.tmp`)
  try {
    if ((await fsp.realpath(parent)) !== parent) {
      throw new MemoryPathError('path resolves outside the memory dir')
    }
    await fsp.writeFile(temp, content, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode === undefined ? {} : { mode })
    })

    if (ifMatchMtime && current.stat) {
      let latest: Stats
      try {
        latest = await fsp.lstat(target)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) {
          throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
        }
        throw err
      }
      if (!sameFileVersion(current.stat, latest)) {
        throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
      }
    }
    if ((await fsp.realpath(parent)) !== parent) {
      throw new MemoryPathError('path resolves outside the memory dir')
    }
    await fsp.rename(temp, target)
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {})
  }

  const stat = await fsp.lstat(target)
  if (!stat.isFile()) throw new MemoryPathError('memory target is not a regular file')
  return { before: current.before, existed: current.existed, stat }
}

/** Seed `<agent-root>/memory/MEMORY.md` with a header if the dir/index is absent
 *  (idempotent). Called at session start so a brand-new agent always has an index. */
export function ensureMemory(agentDir: string, agentName: string): void {
  const dir = memoryDir(agentDir)
  mkdirSync(dir, { recursive: true })
  if (!lstatSync(dir).isDirectory()) throw new MemoryPathError('memory path contains a symlink or non-directory')
  const realAgent = realpathSync(agentDir)
  const realDir = realpathSync(dir)
  if (!under(realAgent, realDir)) throw new MemoryPathError('path resolves outside the agent root')
  try {
    writeFileSync(
      join(realDir, MEMORY_INDEX),
      `# ${agentName} memory\n\nYour long-term memory index. Keep it short — link out to topic files ` +
        `(e.g. \`[deploys](deploys.md)\`) for detail and read them on demand with the readMemory tool.\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err
  }
}

/** Read the memory index (`MEMORY.md`) for prompt injection, trimmed to the inject
 *  cap so a large index can't blow up the prompt; '' when absent. */
export async function readIndex(agentDir: string): Promise<string> {
  let text: string
  try {
    text = await readMemoryFile(agentDir, MEMORY_INDEX)
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

/** Read a memory file's text; '' when it does not exist (never throws on ENOENT). */
export async function readMemoryFile(agentDir: string, relPath: string): Promise<string> {
  const abs = resolveInMemoryDir(agentDir, relPath)
  return readContainedMemoryFile(agentDir, memoryDir(agentDir), abs)
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

/** Take a contained/no-follow canonical history snapshot while the caller
 * already holds the memory-dir lock. Dream adoption uses this in the same
 * critical section as its final live-store snapshot and directory swap. */
export async function snapshotMemoryHistoryHoldingLock(agentDir: string): Promise<string> {
  const dir = memoryDir(agentDir)
  const path = await containedReadTarget(agentDir, dir, join(dir, MEMORY_HISTORY_FILENAME))
  if (path === null) return ''
  const current = await readCurrentMemoryFile(path)
  return current.existed ? canonicalizeMemoryHistory(current.before) : ''
}

/** Take a contained/no-follow canonical snapshot for a replacement store. The
 * brief shared lock makes the copied sidecar line up with ordinary appends. */
export function snapshotMemoryHistory(agentDir: string): Promise<string> {
  return withMemoryDirLock(agentDir, () => snapshotMemoryHistoryHoldingLock(agentDir))
}

/** Compact one sidecar atomically. Invalid legacy/torn rows are discarded and
 * rows written before stable event IDs existed are upgraded during the rewrite. */
async function compactHistoryFile(agentDir: string): Promise<void> {
  const dir = memoryDir(agentDir)
  const lexicalPath = join(dir, MEMORY_HISTORY_FILENAME)
  const path = await containedReadTarget(agentDir, dir, lexicalPath)
  if (path === null) return
  const current = await readCurrentMemoryFile(path)
  if (!current.existed) return
  const raw = current.before

  const canonical = canonicalizeMemoryHistory(raw)
  if (canonical === raw) return

  await atomicWriteContainedMemoryFile(agentDir, dir, lexicalPath, canonical, undefined, 0o600)
}

/** Apply system retention while the caller already holds the memory-dir lock.
 * Exported for dream adoption, whose directory swap is one larger critical
 * section. Calling this without the shared lock would race ordinary writes. */
export async function enforceMemoryHistoryRetentionHoldingLock(agentDir: string): Promise<void> {
  await compactHistoryFile(agentDir)
}

/** Apply system retention to an existing sidecar (including legacy files).
 * Callers decide whether failure is best-effort. */
export function enforceMemoryHistoryRetention(agentDir: string): Promise<void> {
  return withMemoryDirLock(agentDir, () => enforceMemoryHistoryRetentionHoldingLock(agentDir))
}

/** Append one line to the memory change log and enforce fixed retention. The
 * shared memory-dir lock prevents compaction from dropping a concurrent append.
 * Best-effort: provenance/retention failure must never fail the memory write. */
async function appendHistoryHoldingLock(agentDir: string, record: MemoryHistoryRecord): Promise<void> {
  const dir = memoryDir(agentDir)
  const path = await containedWriteTarget(agentDir, dir, join(dir, MEMORY_HISTORY_FILENAME))
  // Canonicalize first: a valid legacy row without its final newline, or a torn
  // JSON tail, would otherwise absorb this append into one invalid combined row.
  await compactHistoryFile(agentDir)
  let handle
  try {
    handle = await fsp.open(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    )
    const stat = await handle.stat()
    if (!stat.isFile()) throw new MemoryPathError('memory target is not a regular file')
    await handle.writeFile(historyLine({ ...record, id: record.id ?? randomUUID() }), 'utf8')
  } finally {
    await handle?.close()
  }
  await compactHistoryFile(agentDir)
}

export async function appendHistory(agentDir: string, record: MemoryHistoryRecord): Promise<void> {
  try {
    await withMemoryDirLock(agentDir, () => appendHistoryHoldingLock(agentDir, record))
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

  return withMemoryDirLock(agentDir, async () => {
    // Enforce retention on first access too, so a legacy oversized file is
    // tightened even before the next managed memory write.
    try {
      await enforceMemoryHistoryRetentionHoldingLock(agentDir)
    } catch {
      // History remains readable when best-effort compaction cannot run.
    }

    const dir = memoryDir(agentDir)
    const path = await containedReadTarget(agentDir, dir, join(dir, MEMORY_HISTORY_FILENAME))
    if (path === null) return { events: [] }
    const current = await readCurrentMemoryFile(path)
    if (!current.existed) return { events: [] }

    const records = parseHistory(current.before).records
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
export function memoryWriteMarks(agentDir: string): MemoryWriteMarks {
  const marks = writeMarks.get(memoryDir(agentDir)) ?? { total: 0, nonDistill: 0 }
  return { generation: WRITE_MARK_GENERATION, ...marks }
}

/**
 * Count a managed-store mutation that did NOT go through {@link writeMemoryFile}
 * — today, a dream adoption's directory swap. Such a mutation is invisible to
 * the ledger otherwise, which would let a second dream staged from the same
 * snapshot classify the first adoption as distill-only drift and roll over it.
 * Callers must already hold the memory-dir lock.
 */
export function recordExternalMemoryMutation(agentDir: string, source: MemoryWriteSource): void {
  bumpWriteMarks(agentDir, source)
}

function bumpWriteMarks(agentDir: string, source: MemoryWriteSource): void {
  const key = memoryDir(agentDir)
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
  agentDir: string,
  relPath: string,
  content: string,
  ifMatchMtime?: string,
  source: MemoryWriteSource = 'tool'
): Promise<{ size: number; mtime: string }> {
  // Serialize every write behind the shared per-dir lock so it can't interleave
  // with a dream adoption's fence-and-swap (nor another write).
  return withMemoryDirLock(agentDir, () => writeMemoryFileHoldingLock(agentDir, relPath, content, ifMatchMtime, source))
}

/**
 * The write itself, WITHOUT taking the memory-dir lock — for a caller that
 * already holds it and needs several writes to be one critical section (the
 * distiller's topic+index batch: an adoption slipping between those two writes
 * would be overwritten by the batch's stale index). The lock is not reentrant,
 * so calling {@link writeMemoryFile} from inside it would deadlock.
 */
export async function writeMemoryFileHoldingLock(
  agentDir: string,
  relPath: string,
  content: string,
  ifMatchMtime: string | undefined,
  source: MemoryWriteSource
): Promise<{ size: number; mtime: string }> {
  if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryTooLargeError(`memory file exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  const abs = resolveInMemoryDir(agentDir, relPath)
  const {
    before,
    existed,
    stat: st
  } = await atomicWriteContainedMemoryFile(agentDir, memoryDir(agentDir), abs, content, ifMatchMtime)
  // Bump the authoritative ledger the moment the write is durable — BEFORE the
  // best-effort history append, which is allowed to fail silently. The dream
  // adoption fence authorizes from these counters, never from `.history`.
  bumpWriteMarks(agentDir, source)

  const beforeClamped = existed ? clampMemoryHistoryValue(before) : undefined
  const afterClamped = clampMemoryHistoryValue(content)
  try {
    await appendHistoryHoldingLock(agentDir, {
      path: relPath,
      event: existed ? 'update' : 'add',
      ...(beforeClamped ? { before: beforeClamped.value } : {}),
      after: afterClamped.value,
      at: st.mtime.toISOString(),
      scope: 'agent',
      source,
      ...(afterClamped.truncated || beforeClamped?.truncated ? { truncated: true } : {})
    })
  } catch {
    // Provenance is best-effort — retry compaction on the next append/read.
  }
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
