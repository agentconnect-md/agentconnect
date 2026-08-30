/**
 * The workspace file operations themselves — list, read, write, delete — against whatever
 * filesystem this process is standing on.
 *
 * Extracted from {@link WorkspaceReader} so the SAME code can run in two places: in the daemon for
 * a workspace on its own disk, and inside the sandbox for a cluster agent's, where the volume is
 * mounted on a pod the daemon cannot see. The alternative was a remote filesystem primitive set
 * (`realpath`, `lstat`, `readdir`, `link`, `rename`, …) driven from the daemon, which fails twice:
 * a 200-entry listing becomes 200 round trips, and the atomic-publish sequence — whose whole point
 * is that the checks and the rename are adjacent — would straddle a WebSocket.
 *
 * So the daemon keeps the POLICY (which agent, which workspace, may it be written) and this module
 * is the PLACEMENT. It runs unchanged on the shim side, which is also what satisfies the shim's own
 * rule that a check on the far side of a channel is not a check on this side: the containment here
 * is not a re-implementation of the daemon's, it is the same lines executing where the files are.
 *
 * Containment is to `root` EXACTLY — for a local workspace the parent directory holds `agent.json`
 * and other daemon-local secrets, and for a pod it holds the materialized provider config, so
 * escaping even one level is a secret leak either way. Every request path is (1) rejected if
 * absolute, (2) lexically resolved against the root and prefix-checked, then (3) canonicalised with
 * `realpath` and re-verified so symlinks (including an intermediate directory component swapped to
 * a symlink after the check) cannot smuggle a target outside the root; all I/O runs on the
 * canonical path. Missing paths are data (`exists:false`), not errors. Never log file contents.
 *
 * Frame-size safety: a result must serialise under the 256 KiB cap on BOTH hops (shim → daemon and
 * daemon → CP), and the budget is the same number, so bounding it once here bounds it for both.
 * JSON escaping of control bytes is a 6× blowup, so `read` bounds the slice by the *encoded* reply
 * size (not the raw byte `limit`) and `list` stops a page early when the encoded entries would
 * overflow — both leave headroom for the envelope.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type {
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceWriteReq,
  WorkspaceWriteOk,
  WorkspaceDeleteReq,
  WorkspaceDeleteOk,
  WorkspaceEntry,
  WorkspaceErrorReason
} from '@agentconnect.md/protocol'
import { MAX_WORKSPACE_EDIT_BYTES } from '@agentconnect.md/protocol'
import { REPLY_BUDGET, encodedBytes, utf8Boundary, fitToBudget } from '../wire-slice.js'

/** Bytes sniffed from the head of a file for binary (NUL byte) detection. */
const SNIFF_BYTES = 8192

/** Path-containment / bad-request violation → `BAD_PAYLOAD` on the wire. `reason`
 *  rides along in the error frame's `details` so the CP can answer a bad request
 *  with a status the console can tell apart from an offline daemon. */
export class WorkspaceViolationError extends Error {
  readonly reason: WorkspaceErrorReason
  constructor(message: string, reason: WorkspaceErrorReason) {
    super(message)
    this.name = 'WorkspaceViolationError'
    this.reason = reason
  }
}

/** Optimistic-concurrency failure → `CONFLICT` on the wire. */
export class WorkspaceConflictError extends Error {
  readonly reason: WorkspaceErrorReason = 'stale'
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceConflictError'
  }
}

/** Where one agent's workspace is, in the coordinates of the filesystem that holds it. */
export interface WorkspaceLocation {
  root: string
  scratch: boolean
}

/**
 * The four operations, as one seam.
 *
 * A `root` rather than an agent id: which agent owns which workspace is the daemon's business and
 * means nothing on the shim side, where the answer is "the volume this pod has mounted".
 */
export interface WorkspaceFiles {
  list(root: string, req: WorkspaceListReq): Promise<WorkspaceListPage>
  read(root: string, req: WorkspaceReadReq): Promise<WorkspaceReadContent>
  /** `scratch` travels with the request because the gate is the DAEMON's (it reads agent config) but
   *  has to hold where the write lands — a remote executor that trusted its own idea of the mode
   *  would be deciding policy from the half-trusted side. */
  write(root: string, scratch: boolean, req: WorkspaceWriteReq): Promise<WorkspaceWriteOk>
  delete(root: string, scratch: boolean, req: WorkspaceDeleteReq): Promise<WorkspaceDeleteOk>
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** Dropped by a concurrent rm: ENOENT, or the EPERM Windows answers while an unlinked entry is delete-pending. */
function vanished(err: unknown): boolean {
  return isErrno(err, 'ENOENT') || (process.platform === 'win32' && isErrno(err, 'EPERM'))
}

/** A failed containment check is an escape only while the path is STILL there: Windows resolves one a
 *  concurrent rm already unlinked to a path outside the root, and that race is absence, not a violation.
 *  Re-probe and let the probe's own error travel, so absence keeps the caller's `exists:false` answer. */
async function rejectEscape(p: string): Promise<never> {
  await fs.lstat(p)
  throw new WorkspaceViolationError('path resolves outside the workspace root', 'path-escape')
}

function under(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep)
}

function containsGitInternals(relPath: string): boolean {
  return relPath.split(/[\\/]+/).some((part) => part.toLowerCase() === '.git')
}

export function containedWorkspacePath(root: string, relPath: string): string {
  if (containsGitInternals(relPath)) {
    throw new WorkspaceViolationError('git internals are not readable', 'git-internals')
  }
  if (path.isAbsolute(relPath)) throw new WorkspaceViolationError('absolute paths are not allowed', 'path-escape')
  const resolved = path.resolve(root, relPath)
  if (!under(root, resolved)) throw new WorkspaceViolationError('path escapes the workspace root', 'path-escape')
  return resolved
}

/**
 * Lexical containment PLUS realpath re-verification on the real target, which is
 * the only check that closes the check-vs-use gap: `containedWorkspacePath` is
 * lexical, and `lstat`/`stat` follow INTERMEDIATE components, so a symlinked
 * directory inside the workspace otherwise resolves out of it. Returns the
 * canonical path, or `null` when the path (or the root) is absent — absence is
 * DATA, and a deleted-but-tracked path still has a diff. Every seam that touches
 * the filesystem or hands git a pathspec must come through here.
 */
export async function canonicalWorkspacePath(root: string, relPath: string): Promise<string | null> {
  const resolved = containedWorkspacePath(root, relPath)
  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  try {
    const canon = await fs.realpath(resolved)
    if (!under(realRoot, canon)) return await rejectEscape(resolved)
    if (containsGitInternals(path.relative(realRoot, canon))) {
      throw new WorkspaceViolationError('git internals are not readable', 'git-internals')
    }
    return canon
  } catch (err) {
    if (!vanished(err)) throw err
  }
  // The leaf is absent, which is data — but the CHAIN above it still has to be checked, or
  // "outside and present" (rejected) and "outside and absent" (exists:false) remain two
  // distinguishable answers, i.e. the same oracle inverted. Canonicalise the deepest ancestor
  // that does exist and verify containment there.
  let ancestor = path.dirname(resolved)
  for (;;) {
    try {
      const canon = await fs.realpath(ancestor)
      if (!under(realRoot, canon) && canon !== realRoot) return await rejectEscape(ancestor)
      return null
    } catch (err) {
      if (err instanceof WorkspaceViolationError) throw err
      if (!vanished(err)) throw err
      const up = path.dirname(ancestor)
      // Ran out of chain without finding anything real: nothing to escape through.
      if (up === ancestor) return null
      ancestor = up
    }
  }
}

/**
 * Lexical containment. Rejects absolute paths and `..` escapes; returns the
 * lexically-resolved path plus the canonical (realpath'd) root, or `null` for
 * `realRoot` when the root does not exist yet (callers report `exists:false`).
 *
 */
async function resolveContained(root: string, relPath: string): Promise<{ resolved: string; realRoot: string | null }> {
  const resolved = containedWorkspacePath(root, relPath)
  try {
    return { resolved, realRoot: await fs.realpath(root) }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { resolved, realRoot: null } // no root ⇒ nothing to escape
    throw err
  }
}

/** Canonicalise an existing target and re-verify containment on the REAL path,
 *  closing the check-vs-use gap (a symlinked intermediate component resolves
 *  out and is rejected here). Returns the canonical path used for I/O. */
async function canonicalUnder(realRoot: string, abs: string): Promise<string> {
  const canon = await fs.realpath(abs)
  if (!under(realRoot, canon)) return rejectEscape(abs)
  if (containsGitInternals(path.relative(realRoot, canon))) {
    throw new WorkspaceViolationError('git internals are not readable', 'git-internals')
  }
  return canon
}

/** Create any missing parent directories one component at a time. Existing
 * components must be real directories; every step is re-canonicalised under
 * the workspace root before the next component is touched. */
async function createParentUnder(root: string, realRoot: string, resolved: string): Promise<string> {
  const relativeParent = path.relative(path.resolve(root), path.dirname(resolved))
  let parent = realRoot
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    const candidate = path.join(parent, part)
    let st
    try {
      st = await fs.lstat(candidate)
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
      try {
        await fs.mkdir(candidate)
      } catch (mkdirErr) {
        if (!isErrno(mkdirErr, 'EEXIST')) throw mkdirErr
      }
      st = await fs.lstat(candidate)
    }
    if (!st.isDirectory()) throw new WorkspaceViolationError('the parent path is not a directory', 'not-a-directory')
    parent = await canonicalUnder(realRoot, candidate)
  }
  return parent
}

/** The scratch gate, re-applied wherever the write actually lands. */
function assertScratch(scratch: boolean): void {
  if (!scratch) {
    throw new WorkspaceViolationError('workspace files are editable only in scratch workspaces', 'read-only-workspace')
  }
}

/** Validate the submitted bytes: the same three refusals on both sides of the channel, so a
 *  request that skipped the console cannot land a binary or oversized file either way. */
export function workspaceEditBytes(req: WorkspaceWriteReq): Buffer {
  const bytes = Buffer.from(req.contentBase64, 'base64')
  if (bytes.byteLength > MAX_WORKSPACE_EDIT_BYTES) {
    throw new WorkspaceViolationError(
      `workspace file exceeds the ${MAX_WORKSPACE_EDIT_BYTES}-byte edit limit`,
      'too-large'
    )
  }
  if (bytes.includes(0)) throw new WorkspaceViolationError('binary files are not editable', 'binary')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceViolationError('workspace file content must be valid UTF-8', 'not-utf8')
  }
  return bytes
}

/**
 * Operations against the DAEMON's own filesystem.
 *
 * Not the sandbox's: a cluster agent's volume is written by that agent's runtime, where checking a
 * name and then acting on it is a window, so `shim/fd-workspace-files.ts` implements the same four
 * operations against open descriptors instead. The two share every rule about the ANSWER — the sort,
 * the page, the frame budget, the UTF-8 boundary, the scratch gate, the edit validation — and differ
 * only in how they reach the bytes.
 */
export const localWorkspaceFiles: WorkspaceFiles = {
  async list(root, req) {
    const { resolved, realRoot } = await resolveContained(root, req.path)
    const notFound = { agentId: req.agentId, path: req.path, exists: false, entries: [] as WorkspaceEntry[] }
    if (realRoot === null) return notFound // workspace root missing

    let target: string
    try {
      target = await canonicalUnder(realRoot, resolved)
    } catch (err) {
      if (vanished(err)) return notFound
      throw err
    }

    let dirents
    try {
      dirents = await fs.readdir(target, { withFileTypes: true })
    } catch (err) {
      // Missing dir or a non-directory target "does not exist" as a directory.
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return notFound
      throw err
    }

    const entries: WorkspaceEntry[] = []
    for (const d of dirents) {
      if (d.name === '.git') continue // git-repo mode internals
      const type: WorkspaceEntry['type'] = d.isDirectory()
        ? 'dir'
        : d.isFile()
          ? 'file'
          : d.isSymbolicLink()
            ? 'symlink'
            : 'other'
      const entry: WorkspaceEntry = { name: d.name, type }
      if (type === 'file') {
        // lstat (not stat): never follow symlinks for size/mtime.
        try {
          const st = await fs.lstat(path.join(target, d.name))
          entry.size = st.size
          entry.mtime = st.mtime.toISOString()
        } catch {
          // raced deletion — keep the name-only entry
        }
      }
      entries.push(entry)
    }
    return { agentId: req.agentId, path: req.path, ...pageWorkspaceEntries(entries, req) }
  },

  async read(root, req) {
    const { resolved, realRoot } = await resolveContained(root, req.path)
    const notFound = { agentId: req.agentId, path: req.path, exists: false }
    if (realRoot === null) return notFound

    // lstat the lexical target first: this rejects a FINAL-component symlink
    // (isFile() is false) before we canonicalise.
    let st
    try {
      st = await fs.lstat(resolved)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return notFound
      throw err
    }
    // A DIRECTORY is DATA (`type:'dir'`, no content): reporting it as a violation
    // made a `?file=` naming a directory indistinguishable from an offline daemon.
    // Every OTHER non-regular target keeps the violation — a final-component
    // symlink is a containment matter and must not read as an ordinary answer.
    if (!st.isDirectory() && !st.isFile()) throw new WorkspaceViolationError('not a regular file', 'not-a-file')

    // Canonicalise FIRST, for BOTH answers, and re-verify (this catches an intermediate component
    // swapped to a symlink after resolveContained). `lstat` follows intermediate components, so a
    // symlinked directory inside the workspace would otherwise let the dir branch report the
    // existence and mtime of a host directory outside it — the same oracle the git-diff seam had,
    // reopened by making directories an ordinary answer. A target dropped under us here is absence.
    let target: string
    try {
      target = await canonicalUnder(realRoot, resolved)
    } catch (err) {
      if (vanished(err)) return notFound
      throw err
    }

    if (st.isDirectory()) {
      const canonSt = await fs.lstat(target)
      return {
        agentId: req.agentId,
        path: req.path,
        exists: true,
        type: 'dir' as const,
        mtime: canonSt.mtime.toISOString()
      }
    }

    const size = st.size
    const mtime = st.mtime.toISOString()
    const fh = await fs.open(target, 'r')
    try {
      // Binary detection: NUL byte anywhere in the first 8 KiB ⇒ no content.
      const sniffLen = Math.min(SNIFF_BYTES, size)
      if (sniffLen > 0) {
        const sniff = Buffer.alloc(sniffLen)
        const { bytesRead } = await fh.read(sniff, 0, sniffLen, 0)
        if (sniff.subarray(0, bytesRead).includes(0)) {
          return {
            agentId: req.agentId,
            path: req.path,
            exists: true,
            type: 'file' as const,
            size,
            mtime,
            encoding: 'none' as const
          }
        }
      }

      // Read up to the requested byte count, then shrink so the JSON-escaped
      // reply fits the frame budget and ends on a UTF-8 boundary. `limit` is a
      // ceiling; the slice may be shorter. `nextOffset` (not a client-side
      // recount of `content`) is the authoritative next offset.
      const want = Math.min(req.limit, Math.max(0, size - req.offset))
      let slice = Buffer.alloc(0)
      if (want > 0) {
        const buf = Buffer.alloc(want)
        const { bytesRead } = await fh.read(buf, 0, want, req.offset)
        slice = buf.subarray(0, bytesRead)
      }

      return {
        agentId: req.agentId,
        path: req.path,
        exists: true,
        type: 'file' as const,
        size,
        mtime,
        encoding: 'utf8' as const,
        ...sliceWorkspaceRead(slice, req, size)
      }
    } finally {
      await fh.close()
    }
  },

  async write(root, scratch, req) {
    assertScratch(scratch)
    const bytes = workspaceEditBytes(req)

    let { resolved, realRoot } = await resolveContained(root, req.path)
    if (realRoot === null && req.ifMatchMtime === undefined) {
      await fs.mkdir(root, { recursive: true })
      ;({ resolved, realRoot } = await resolveContained(root, req.path))
    }
    if (realRoot === null) throw changedFile()

    if (req.ifMatchMtime === undefined) {
      const parent = await createParentUnder(root, realRoot, resolved)

      const target = path.join(parent, path.basename(resolved))
      try {
        await fs.lstat(target)
        throw existingFile()
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err
      }

      const temp = path.join(parent, `.agentconnect-edit-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o666 })
        try {
          await fs.link(temp, target)
        } catch (err) {
          if (isErrno(err, 'EEXIST')) throw existingFile()
          throw err
        }
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {})
      }

      const written = await fs.stat(target)
      return {
        agentId: req.agentId,
        path: req.path,
        size: written.size,
        mtime: written.mtime.toISOString()
      }
    }

    let initial
    try {
      initial = await fs.lstat(resolved)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw changedFile()
      throw err
    }
    if (!initial.isFile()) throw new WorkspaceViolationError('not a regular file', 'not-a-file')
    if (initial.mtime.toISOString() !== req.ifMatchMtime) throw changedFile()

    let target: string
    try {
      target = await canonicalUnder(realRoot, resolved)
    } catch (err) {
      if (vanished(err)) throw changedFile()
      throw err
    }

    // Match the read path's binary guard. The editor never turns a binary file
    // into text merely because a caller bypassed the console UI.
    const fh = await fs.open(target, 'r')
    try {
      const sniffLen = Math.min(SNIFF_BYTES, initial.size)
      if (sniffLen > 0) {
        const sniff = Buffer.alloc(sniffLen)
        const { bytesRead } = await fh.read(sniff, 0, sniffLen, 0)
        if (sniff.subarray(0, bytesRead).includes(0)) {
          throw new WorkspaceViolationError('binary files are not editable', 'binary')
        }
      }
    } finally {
      await fh.close()
    }

    const temp = path.join(path.dirname(target), `.agentconnect-edit-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, bytes, { flag: 'wx', mode: initial.mode & 0o777 })
      await fs.chmod(temp, initial.mode & 0o777)

      let latest
      try {
        latest = await fs.lstat(target)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) throw changedFile()
        throw err
      }
      if (!sameFileVersion(initial, latest)) throw changedFile()
      await fs.rename(temp, target)
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw err
    }

    const written = await fs.stat(target)
    return {
      agentId: req.agentId,
      path: req.path,
      size: written.size,
      mtime: written.mtime.toISOString()
    }
  },

  async delete(root, scratch, req) {
    assertScratch(scratch)
    const { resolved, realRoot } = await resolveContained(root, req.path)
    if (realRoot === null) throw changedFile()

    let initial
    try {
      initial = await fs.lstat(resolved)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw changedFile()
      throw err
    }
    if (!initial.isFile()) throw new WorkspaceViolationError('not a regular file', 'not-a-file')
    if (initial.mtime.toISOString() !== req.ifMatchMtime) throw changedFile()

    let target: string
    try {
      target = await canonicalUnder(realRoot, resolved)
    } catch (err) {
      if (vanished(err)) throw changedFile()
      throw err
    }

    let latest
    try {
      latest = await fs.lstat(target)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw changedFile()
      throw err
    }
    if (!sameFileVersion(initial, latest)) throw changedFile()
    await fs.unlink(target)
    return { agentId: req.agentId, path: req.path }
  }
}

function sameFileVersion(a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function changedFile(): WorkspaceConflictError {
  return new WorkspaceConflictError('the workspace file changed since it was read; reload and retry')
}

function existingFile(): WorkspaceConflictError {
  return new WorkspaceConflictError('the workspace file already exists; open it to edit')
}

/**
 * Sort, page and budget one directory's entries — the RESULT rules, shared by both implementations.
 *
 * Opaque cursor = numeric index into the sorted listing. Paged by BOTH the count limit and an
 * encoded-size budget (long or many names could overflow the frame), always emitting ≥1 entry so a
 * pathological name still makes progress rather than wedging the cursor. Extracted because the
 * fd-bound implementation enumerates differently and must still answer identically: a second copy of
 * these bounds is how one of the two ends up able to overflow the frame it rides.
 */
export function pageWorkspaceEntries(
  entries: WorkspaceEntry[],
  req: { cursor?: string; limit: number }
): { exists: true; entries: WorkspaceEntry[]; nextCursor?: string } {
  const sorted = [...entries].sort(compareEntries)
  const start = req.cursor !== undefined && /^\d+$/.test(req.cursor) ? Number(req.cursor) : 0
  const page: WorkspaceEntry[] = []
  let acc = 0
  for (let i = start; i < sorted.length && page.length < req.limit; i++) {
    const e = sorted[i]!
    const enc = encodedBytes(e) + 1 // + array separator
    if (page.length > 0 && acc + enc > REPLY_BUDGET) break
    page.push(e)
    acc += enc
  }
  const consumed = start + page.length
  return { exists: true, entries: page, ...(consumed < sorted.length ? { nextCursor: String(consumed) } : {}) }
}

/**
 * Cut a read to what one reply can carry: the requested byte count, shrunk so the JSON-escaped form
 * fits the frame budget and never splits a UTF-8 character. `nextOffset` is authoritative — a caller
 * must not recount the content it received.
 */
export function sliceWorkspaceRead(
  slice: Buffer,
  req: { offset: number },
  size: number
): { content: string; offset: number; nextOffset: number; truncated: boolean } {
  const fitted = fitToBudget(slice, utf8Boundary(slice, slice.length))
  const nextOffset = req.offset + fitted.end
  return { content: fitted.content, offset: req.offset, nextOffset, truncated: nextOffset < size }
}

/** The entry a dirent becomes on the wire, without its size/mtime — the caller adds those, since only
 *  it knows how to stat safely on its own side. `.git` is never listed: those are repo internals. */
export function workspaceEntryOf(
  name: string,
  kind: { dir: boolean; file: boolean; symlink: boolean }
): WorkspaceEntry {
  return { name, type: kind.dir ? 'dir' : kind.file ? 'file' : kind.symlink ? 'symlink' : 'other' }
}

/** dirs first, then case-insensitive alphabetical (stable within the page). */
function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  const aDir = a.type === 'dir' ? 0 : 1
  const bDir = b.type === 'dir' ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  const al = a.name.toLowerCase()
  const bl = b.name.toLowerCase()
  if (al !== bl) return al < bl ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
