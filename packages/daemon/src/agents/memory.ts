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
import { promises as fsp, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { MEMORY_INDEX } from '@agentconnect.md/protocol'

export const MEMORY_DIRNAME = 'memory'
export { MEMORY_INDEX }

/** Max bytes of the index injected into the prompt each session — keeps a large
 *  memory from swelling the context (mirrors Claude Code's 25 KB entrypoint cap). */
export const MAX_INDEX_INJECT_BYTES = 25_000

/** Hard cap on a single memory file. Injected/read every session, so an unbounded
 *  file would swell the prompt and the wire; writes over this are rejected. */
export const MAX_MEMORY_FILE_BYTES = 256_000

/** The append-only change log for an agent's memory, a sidecar beside the memory
 *  files (`<agent-root>/memory/.history`). One JSON line per write, for provenance
 *  (who/what/when changed a file). Dotfile so it never surfaces as a topic. */
export const MEMORY_HISTORY_FILENAME = '.history'

/** Cap on a `before`/`after` snapshot stored in a history line — keeps a single log
 *  entry bounded even for a large file. Over this, the snapshot is truncated (with a
 *  `…` marker) rather than omitted, so the line stays small but still human-readable. */
export const MAX_HISTORY_VALUE_BYTES = 4_000

/** Where a memory write originated — for change-log provenance. */
export type MemoryWriteSource = 'tool' | 'console' | 'distill' | 'dream'

/** One line in the memory change log (`.history`). `event` is `add` on a first write,
 *  `update` on an overwrite; `delete` is reserved (no delete op exists today — a
 *  "clear" is an empty write, recorded as an `update`). `before`/`after` are the
 *  file's text, truncated to {@link MAX_HISTORY_VALUE_BYTES}. */
export interface MemoryHistoryRecord {
  path: string
  event: 'add' | 'update' | 'delete'
  before?: string
  after: string
  at: string
  scope: string
  source: MemoryWriteSource
  truncated?: boolean
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

/** Append one line to the memory change log (`<agent-root>/memory/.history`). A single
 *  `O_APPEND` write, so concurrent appends never interleave a partial line. Best-effort:
 *  a logging failure must never fail the write it describes, so errors are swallowed. */
export async function appendHistory(agentDir: string, record: MemoryHistoryRecord): Promise<void> {
  try {
    await fsp.mkdir(memoryDir(agentDir), { recursive: true })
    await fsp.appendFile(join(memoryDir(agentDir), MEMORY_HISTORY_FILENAME), JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // provenance is best-effort — never let it break the actual memory write.
  }
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
