/**
 * `MemoryFs` — the file-system port an agent's managed memory tree is kept behind.
 *
 * Every managed-memory writer and reader (`memory/store.ts`, the memory provider, the dream
 * runner, the CP memory reader) is a DIRECTORY abstraction over this port, so where the tree lives
 * is a placement decision, not a policy one: a local agent's home is `<agent.dir>` on this daemon's
 * disk (`LocalMemoryFs`), a cluster agent's is one root on its sandbox volume reached through the
 * shim (`shim/memory-fs-channel.ts`), and a later home is another implementation. Paths are relative
 * to the root; the root itself is absolute in the coordinates of the filesystem that holds it.
 *
 * SECURITY (local): the daemon is outside the agent's sandbox, so a symlink planted in the writable
 * memory dir must not redirect a read or a write. Every operation canonicalises the parent chain one
 * component at a time, rejects symlink components, and opens the leaf with `O_NOFOLLOW`; writes
 * publish through a random exclusive temp file. The shim executor keeps the same rules against open
 * descriptors where the volume is written by the agent's runtime.
 */
import { randomUUID } from 'node:crypto'
import { constants, promises as fsp, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Raised when a memory path escapes its root or resolves through a symlink. Surfaces as `BAD_PAYLOAD`. */
export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPathError'
  }
}

/** Raised when a write exceeds the memory file cap. `BAD_PAYLOAD`. */
export class MemoryTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryTooLargeError'
  }
}

/** Raised when an `ifMatchMtime` precondition fails (the file changed under the writer). Surfaces as CONFLICT. */
export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryConflictError'
  }
}

/** Raised when a cluster agent's memory home is on a sandbox that is not running — one resolution, no local fallback. */
export class MemorySandboxUnavailableError extends Error {
  readonly reason = 'sandbox-unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'MemorySandboxUnavailableError'
  }
}

export interface MemoryFsFileStat {
  size: number
  /** ISO mtime — the optimistic-concurrency token every memory writer compares. */
  mtime: string
}

export interface MemoryFsFile extends MemoryFsFileStat {
  /** The file's text, or its bytes as base64 when the read asked for that encoding. */
  content: string
}

export type MemoryFsEncoding = 'utf8' | 'base64'

export interface MemoryFsEntry {
  name: string
  kind: 'file' | 'dir' | 'other'
  size?: number
  mtime?: string
}

export interface MemoryFsWriteOptions {
  /** Non-empty ⇒ the target's current mtime must equal it (a brand-new file never matches). */
  ifMatchMtime?: string
  mode?: number
}

/** The port. Paths are root-relative; a missing path is data (`null` / `[]` / `false`), never an error. */
export interface MemoryFs {
  /** Identity of the tree for the in-process locks and write ledger — equal for every instance over one tree. */
  readonly key: string
  /** Absolute root in the coordinates of the filesystem holding it (an execution cwd is built from it). */
  readonly root: string
  /** The same port re-rooted at a subdirectory (a channel's self-contained memory root). */
  subdir(rel: string): MemoryFs
  readFile(rel: string, encoding?: MemoryFsEncoding): Promise<MemoryFsFile | null>
  /** Atomic replace-or-create; the leaf is never followed and parents are created. */
  writeFile(rel: string, content: string | Uint8Array, options?: MemoryFsWriteOptions): Promise<MemoryFsFileStat>
  readdir(rel: string): Promise<MemoryFsEntry[]>
  mkdir(rel: string): Promise<void>
  /** false when `from` is absent. */
  rename(from: string, to: string): Promise<boolean>
  /** Recursive and forced: absence is fine. */
  rm(rel: string): Promise<void>
  /** Best-effort: set a file's mtime (kept for files a store swap left byte-for-byte unchanged). */
  utimes(rel: string, mtime: string): Promise<void>
}

/** Split a root-relative path into plain components; `''` is the root itself. */
export function memoryRelSegments(rel: string): string[] {
  if (isAbsolute(rel)) throw new MemoryPathError('absolute paths are not allowed')
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..' || part.includes('\0'))) {
    throw new MemoryPathError('path escapes the memory root')
  }
  return parts
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** Dropped by a concurrent rm: ENOENT, or EPERM while Windows holds the directory in delete-pending. */
function vanished(err: unknown): boolean {
  return isErrno(err, 'ENOENT') || (process.platform === 'win32' && isErrno(err, 'EPERM'))
}

function under(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/**
 * A failed containment check is an escape only when the path is still there. Windows resolves a
 * component a concurrent rm already unlinked to a path outside the root, so re-probe before calling
 * a benign race a violation; a dropped component is absence, which is data on the read side.
 */
async function rejectEscape(path: string, create: boolean): Promise<null> {
  try {
    await fsp.lstat(path)
  } catch (err) {
    if (!vanished(err) || create) throw err
    return null
  }
  throw new MemoryPathError('path resolves outside the memory root')
}

/**
 * Canonicalise `parts` under `root` one component at a time, refusing symlink components; with
 * `create` missing components are made along the way. `null` when a component is absent (read side).
 */
async function walkContained(root: string, parts: string[], create: boolean): Promise<string | null> {
  let realRoot: string
  try {
    realRoot = await fsp.realpath(root)
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
    if (!create) return null
    await fsp.mkdir(root, { recursive: true })
    realRoot = await fsp.realpath(root)
  }
  let parent = realRoot
  for (const part of parts) {
    const candidate = join(parent, part)
    let stat: Stats
    try {
      stat = await fsp.lstat(candidate)
    } catch (err) {
      if (!create) {
        if (!vanished(err)) throw err
        return null
      }
      if (!isErrno(err, 'ENOENT')) throw err
      try {
        await fsp.mkdir(candidate)
      } catch (mkdirErr) {
        if (!isErrno(mkdirErr, 'EEXIST')) throw mkdirErr
      }
      stat = await fsp.lstat(candidate)
    }
    if (!stat.isDirectory()) throw new MemoryPathError('memory path contains a symlink or non-directory')
    try {
      parent = await fsp.realpath(candidate)
    } catch (err) {
      // A concurrent rm can drop the component between lstat and realpath; absent stays data on the read side.
      if (!vanished(err) || create) throw err
      return null
    }
    if (!under(realRoot, parent)) return rejectEscape(candidate, create)
  }
  return parent
}

type CurrentFile = { existed: false; before: ''; stat?: undefined } | { existed: true; before: string; stat: Stats }

/** Open the leaf without following a symlink; `existed:false` on ENOENT. */
async function readCurrentFile(target: string, encoding: MemoryFsEncoding = 'utf8'): Promise<CurrentFile> {
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
    return { existed: true, before: await handle.readFile(encoding), stat }
  } finally {
    await handle.close()
  }
}

/** Read one file under `root` (a memory tree or the runtime's own store) without following symlinks; '' when absent. */
export async function readContainedMemoryFile(root: string, destination: string): Promise<string> {
  const parts = containedParts(root, destination)
  const parent = await walkContained(root, parts.slice(0, -1), false)
  if (parent === null) return ''
  return (await readCurrentFile(join(parent, parts[parts.length - 1]!))).before
}

/** `destination` must be a lexical descendant of `root`; returns its components. */
function containedParts(root: string, destination: string): string[] {
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(destination)
  if (!under(lexicalRoot, lexicalTarget) || lexicalTarget === lexicalRoot) {
    throw new MemoryPathError('path escapes the memory root')
  }
  return relative(lexicalRoot, lexicalTarget).split(sep).filter(Boolean)
}

/**
 * Atomically replace one file under `root` without following symlinks. The random `wx` temp defeats
 * pre-planted `<target>.tmp` links; a non-empty `ifMatchMtime` is checked before the temp write and
 * re-verified (dev/ino/size/mtime) right before the rename.
 */
export async function atomicWriteContainedMemoryFile(
  root: string,
  destination: string,
  content: string | Uint8Array,
  ifMatchMtime?: string,
  mode?: number
): Promise<MemoryFsFileStat> {
  const parts = containedParts(root, destination)
  const parent = (await walkContained(root, parts.slice(0, -1), true))!
  const target = join(parent, parts[parts.length - 1]!)
  const current = await readCurrentFile(target)
  if (ifMatchMtime && current.stat?.mtime.toISOString() !== ifMatchMtime) {
    throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
  }
  const temp = join(parent, `.agentconnect-memory-${randomUUID()}.tmp`)
  try {
    if ((await fsp.realpath(parent)) !== parent) await rejectEscape(parent, true)
    await fsp.writeFile(temp, content, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) })
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
    if ((await fsp.realpath(parent)) !== parent) await rejectEscape(parent, true)
    await publishOverTarget(temp, target)
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {})
  }
  const stat = await fsp.lstat(target)
  if (!stat.isFile()) throw new MemoryPathError('memory target is not a regular file')
  return { size: stat.size, mtime: stat.mtime.toISOString() }
}

// Windows cannot rename over a file another handle holds open — a scanner's transient handle on the
// bytes just written is enough — so EPERM/EACCES/EBUSY here is a race POSIX never has. Bounded retry,
// as `WorkspaceManager.renameWorkspaceDirectory` does for the same reason on a directory swap.
async function publishOverTarget(temp: string, target: string): Promise<void> {
  if (process.platform !== 'win32') return fsp.rename(temp, target)
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY'])
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(temp, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt === 9 || code === undefined || !transient.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/** The port over this process's own filesystem, contained to `root`. */
export class LocalMemoryFs implements MemoryFs {
  readonly root: string
  readonly key: string

  constructor(root: string) {
    this.root = resolve(root)
    this.key = this.root
  }

  subdir(rel: string): MemoryFs {
    return new LocalMemoryFs(join(this.root, ...memoryRelSegments(rel)))
  }

  private leaf(rel: string): { parts: string[]; name: string } {
    const parts = memoryRelSegments(rel)
    if (parts.length === 0) throw new MemoryPathError('a file name is required')
    return { parts: parts.slice(0, -1), name: parts[parts.length - 1]! }
  }

  async readFile(rel: string, encoding: MemoryFsEncoding = 'utf8'): Promise<MemoryFsFile | null> {
    const { parts, name } = this.leaf(rel)
    const parent = await walkContained(this.root, parts, false)
    if (parent === null) return null
    const current = await readCurrentFile(join(parent, name), encoding)
    if (!current.existed) return null
    return { content: current.before, size: current.stat.size, mtime: current.stat.mtime.toISOString() }
  }

  writeFile(rel: string, content: string | Uint8Array, options: MemoryFsWriteOptions = {}): Promise<MemoryFsFileStat> {
    const parts = memoryRelSegments(rel)
    if (parts.length === 0) throw new MemoryPathError('a file name is required')
    return atomicWriteContainedMemoryFile(
      this.root,
      join(this.root, ...parts),
      content,
      options.ifMatchMtime,
      options.mode
    )
  }

  async readdir(rel: string): Promise<MemoryFsEntry[]> {
    const dir = await walkContained(this.root, memoryRelSegments(rel), false)
    if (dir === null) return []
    let dirents
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return []
      throw err
    }
    const entries: MemoryFsEntry[] = []
    for (const d of dirents) {
      const kind: MemoryFsEntry['kind'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
      const entry: MemoryFsEntry = { name: d.name, kind }
      if (kind === 'file') {
        try {
          const st = await fsp.lstat(join(dir, d.name))
          entry.size = st.size
          entry.mtime = st.mtime.toISOString()
        } catch {
          // raced deletion — keep the name-only entry
        }
      }
      entries.push(entry)
    }
    return entries
  }

  async mkdir(rel: string): Promise<void> {
    await walkContained(this.root, memoryRelSegments(rel), true)
  }

  async rename(from: string, to: string): Promise<boolean> {
    const source = this.leaf(from)
    const sourceParent = await walkContained(this.root, source.parts, false)
    if (sourceParent === null) return false
    const sourcePath = join(sourceParent, source.name)
    try {
      await fsp.lstat(sourcePath)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false
      throw err
    }
    const target = this.leaf(to)
    const targetParent = (await walkContained(this.root, target.parts, true))!
    await fsp.rename(sourcePath, join(targetParent, target.name))
    return true
  }

  async rm(rel: string): Promise<void> {
    const { parts, name } = this.leaf(rel)
    const parent = await walkContained(this.root, parts, false)
    if (parent === null) return
    await fsp.rm(join(parent, name), { recursive: true, force: true })
  }

  async utimes(rel: string, mtime: string): Promise<void> {
    const { parts, name } = this.leaf(rel)
    const parent = await walkContained(this.root, parts, false)
    if (parent === null) return
    const when = new Date(mtime)
    try {
      await fsp.lutimes(join(parent, name), when, when)
    } catch {
      // best-effort: a vanished file keeps whatever mtime it has
    }
  }
}

/** The sandbox plane as the factory sees it: the port over a bound sandbox volume, or nothing. */
export interface SandboxMemoryFsSource {
  memoryFsFor(agentId: string): MemoryFs | undefined
}

/**
 * The ONE decision about where an agent's managed memory tree lives. With a sandbox plane (every
 * agent of a `--k8s` daemon runs in a pod) it is the port over the agent's sandbox volume, reachable
 * exactly while the pod is bound — no fallback to this member's disk, since a duty move would leave
 * the memory behind; without one, the local port over the agent dir.
 */
export function resolveMemoryFs(
  agent: { id: string; dir: string },
  sandbox: SandboxMemoryFsSource | undefined
): MemoryFs {
  if (!sandbox) return new LocalMemoryFs(agent.dir)
  const fs = sandbox.memoryFsFor(agent.id)
  if (!fs) {
    throw new MemorySandboxUnavailableError(
      `agent "${agent.id}" has no running sandbox, so its memory cannot be reached`
    )
  }
  return fs
}
