/**
 * The workspace file operations, executed against open directory handles instead of names.
 *
 * This is the sandbox's implementation of {@link WorkspaceFiles}. The daemon keeps the path-based one
 * in `workspace/workspace-files.ts`, and the split is not a preference: the two run on filesystems
 * with different owners. A self-hosted daemon's workspace sits on its own disk, where nothing races
 * it; a cluster agent's sits on a volume that agent's runtime writes to, and there every check-by-name
 * followed by a use-by-name is a window it can open. Four rounds of stricter revalidation each closed
 * one and revealed the next, because the flaw was never the strictness — a name is not a directory.
 *
 * So every operation here descends once through {@link withDescent}, which yields a handle bound to
 * an inode, and does all of its work relative to that handle. Renaming the checkout aside, pointing
 * the path at the mount, restoring it afterwards: none of it reaches work already anchored on a
 * descriptor. The cost is Linux (`/proc/self/fd`) and one behavioural divergence, both stated in
 * `safe-descent.ts`.
 *
 * What is NOT re-implemented is any rule about the ANSWER: the sort, the page, the frame budget, the
 * UTF-8 boundary, the scratch gate and the edit validation are imported from the shared module, so
 * the two implementations cannot drift into giving a console two different answers about one file.
 */
import { promises as fs } from 'node:fs'
import type {
  WorkspaceDeleteOk,
  WorkspaceDeleteReq,
  WorkspaceEntry,
  WorkspaceListPage,
  WorkspaceListReq,
  WorkspaceReadContent,
  WorkspaceReadReq,
  WorkspaceWriteOk,
  WorkspaceWriteReq
} from '@agentconnect.md/protocol'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import {
  pageWorkspaceEntries,
  sliceWorkspaceRead,
  workspaceEditBytes,
  workspaceEntryOf,
  WorkspaceConflictError,
  WorkspaceViolationError,
  type WorkspaceFiles
} from '../workspace/workspace-files.js'
import { DirHandle, MissingPathError, withDescent } from './safe-descent.js'

/** Bytes sniffed from the head of a file for binary (NUL byte) detection — the shared module's rule. */
const SNIFF_BYTES = 8192

/** Split a workspace-relative request path into components, refusing what a descent must never take.
 *  `.git` is excluded here rather than during the walk because it is a PRODUCT rule (repo internals
 *  are not browsable), not a containment one, and the two should not be confused for each other. */
function requestSegments(relPath: string): string[] {
  if (isAbsolute(relPath)) throw new WorkspaceViolationError('absolute paths are not allowed', 'path-escape')
  const segments = relPath.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (segments.some((part) => part === '..')) {
    throw new WorkspaceViolationError('path escapes the workspace root', 'path-escape')
  }
  if (segments.some((part) => part.toLowerCase() === '.git')) {
    throw new WorkspaceViolationError('git internals are not readable', 'git-internals')
  }
  return segments
}

/** Where the workspace root sits under the anchor, as components. The daemon names an absolute pod
 *  path; the descent needs the steps from the mount, and anything outside it is refused here — the
 *  same fence the exec channel applies, kept because this module is also called directly by tests. */
function rootSegments(anchor: string, root: string): string[] {
  const rel = relative(anchor, root)
  if (rel === '') return []
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceViolationError('the workspace root is outside the sandbox mount', 'path-escape')
  }
  return rel.split(sep).filter(Boolean)
}

/** A descent refusal reads as containment; absence stays absence, which callers answer as data. */
function asViolation(err: unknown): never {
  if (
    err instanceof MissingPathError ||
    err instanceof WorkspaceViolationError ||
    err instanceof WorkspaceConflictError
  ) {
    throw err
  }
  throw new WorkspaceViolationError('the workspace path could not be opened safely', 'path-escape')
}

/** Everything up to the last component, which the caller then opens as a file or a directory. */
async function withParent<T>(
  anchor: string,
  root: string,
  relPath: string,
  work: (parent: DirHandle, leaf: string | undefined) => Promise<T>
): Promise<T> {
  return await withParentMode(anchor, root, relPath, false, work)
}

/** The exclusive-create variant may create each missing ancestor from its held parent handle. */
async function withCreatingParent<T>(
  anchor: string,
  root: string,
  relPath: string,
  work: (parent: DirHandle, leaf: string | undefined) => Promise<T>
): Promise<T> {
  return await withParentMode(anchor, root, relPath, true, work)
}

async function withParentMode<T>(
  anchor: string,
  root: string,
  relPath: string,
  createMissing: boolean,
  work: (parent: DirHandle, leaf: string | undefined) => Promise<T>
): Promise<T> {
  const requested = requestSegments(relPath)
  const segments = [...rootSegments(anchor, root), ...requested]
  const leaf = requested.length === 0 ? undefined : segments[segments.length - 1]
  const upto = leaf === undefined ? segments : segments.slice(0, -1)
  try {
    return await withDescent(anchor, upto, (parent) => work(parent, leaf), { createMissing })
  } catch (err) {
    return asViolation(err)
  }
}

export function createFdWorkspaceFiles(anchor: string): WorkspaceFiles {
  /** The directory a request names, or `undefined` when it (or a component above it) is absent. */
  async function withTargetDir<T>(
    root: string,
    relPath: string,
    work: (dir: DirHandle) => Promise<T>
  ): Promise<T | undefined> {
    try {
      const segments = [...rootSegments(anchor, root), ...requestSegments(relPath)]
      return await withDescent(anchor, segments, work)
    } catch (err) {
      if (err instanceof MissingPathError) return undefined
      return asViolation(err)
    }
  }

  return {
    async list(root, req: WorkspaceListReq): Promise<WorkspaceListPage> {
      const notFound = { agentId: req.agentId, path: req.path, exists: false, entries: [] as WorkspaceEntry[] }
      const page = await withTargetDir(root, req.path, async (dir) => {
        const entries: WorkspaceEntry[] = []
        for (const dirent of await dir.readdir()) {
          if (dirent.name === '.git') continue // git-repo mode internals
          const entry = workspaceEntryOf(dirent.name, {
            dir: dirent.isDirectory(),
            file: dirent.isFile(),
            symlink: dirent.isSymbolicLink()
          })
          if (entry.type === 'file') {
            // Relative to the handle, so a file swapped for a link between the readdir and this stat
            // is described as what it is rather than as what it points at.
            try {
              const st = await dir.lstatChild(dirent.name)
              entry.size = st.size
              entry.mtime = st.mtime.toISOString()
            } catch {
              // raced deletion — keep the name-only entry
            }
          }
          entries.push(entry)
        }
        return pageWorkspaceEntries(entries, req)
      })
      return page === undefined ? notFound : { agentId: req.agentId, path: req.path, ...page }
    },

    async read(root, req: WorkspaceReadReq): Promise<WorkspaceReadContent> {
      const notFound = { agentId: req.agentId, path: req.path, exists: false }
      return await withParent(anchor, root, req.path, async (parent, leaf) => {
        const asDir = async (dir: DirHandle) => ({
          agentId: req.agentId,
          path: req.path,
          exists: true as const,
          type: 'dir' as const,
          mtime: (await dir.stat()).mtime.toISOString()
        })
        if (leaf === undefined) return await asDir(parent)

        let stat
        try {
          stat = await parent.lstatChild(leaf)
        } catch (err) {
          if (err instanceof MissingPathError) return notFound
          throw err
        }
        if (stat.isDirectory()) {
          const dir = await parent.childDir(leaf)
          try {
            return await asDir(dir)
          } finally {
            await dir.close()
          }
        }
        if (!stat.isFile()) throw new WorkspaceViolationError('not a regular file', 'not-a-file')

        const file = await parent.childFile(leaf)
        try {
          const st = await file.stat()
          const size = st.size
          const mtime = st.mtime.toISOString()
          const head = {
            agentId: req.agentId,
            path: req.path,
            exists: true as const,
            type: 'file' as const,
            size,
            mtime
          }

          const sniffLen = Math.min(SNIFF_BYTES, size)
          if (sniffLen > 0) {
            const sniff = Buffer.alloc(sniffLen)
            const { bytesRead } = await file.read(sniff, 0, sniffLen, 0)
            if (sniff.subarray(0, bytesRead).includes(0)) return { ...head, encoding: 'none' as const }
          }

          const want = Math.min(req.limit, Math.max(0, size - req.offset))
          let slice = Buffer.alloc(0)
          if (want > 0) {
            const buf = Buffer.alloc(want)
            const { bytesRead } = await file.read(buf, 0, want, req.offset)
            slice = buf.subarray(0, bytesRead)
          }
          return { ...head, encoding: 'utf8' as const, ...sliceWorkspaceRead(slice, req, size) }
        } finally {
          await file.close()
        }
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) return notFound
        throw err
      })
    },

    async write(root, scratch, req: WorkspaceWriteReq): Promise<WorkspaceWriteOk> {
      assertScratch(scratch)
      const bytes = workspaceEditBytes(req)
      const resolveParent = req.ifMatchMtime === undefined ? withCreatingParent : withParent
      return await resolveParent(anchor, root, req.path, async (parent, leaf) => {
        if (leaf === undefined) throw new WorkspaceViolationError('not a regular file', 'not-a-file')
        const temp = parent.childPath(`.agentconnect-edit-${randomUUID()}.tmp`)
        const target = parent.childPath(leaf)

        if (req.ifMatchMtime === undefined) {
          await refuseExisting(parent, leaf)
          try {
            await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o666 })
            try {
              await fs.link(temp, target)
            } catch (err) {
              if (isErrno(err, 'EEXIST')) throw existingFile()
              throw err
            }
          } finally {
            await fs.rm(temp, { force: true }).catch(() => undefined)
          }
          return await wrote(parent, leaf, req)
        }

        const initial = await statForEdit(parent, leaf)
        if (initial.mtime.toISOString() !== req.ifMatchMtime) throw changedFile()
        const existing = await parent.childFile(leaf)
        try {
          const sniffLen = Math.min(SNIFF_BYTES, initial.size)
          if (sniffLen > 0) {
            const sniff = Buffer.alloc(sniffLen)
            const { bytesRead } = await existing.read(sniff, 0, sniffLen, 0)
            if (sniff.subarray(0, bytesRead).includes(0)) {
              throw new WorkspaceViolationError('binary files are not editable', 'binary')
            }
          }
        } finally {
          await existing.close()
        }

        try {
          await fs.writeFile(temp, bytes, { flag: 'wx', mode: initial.mode & 0o777 })
          await fs.chmod(temp, initial.mode & 0o777)
          const latest = await statForEdit(parent, leaf)
          if (!sameFileVersion(initial, latest)) throw changedFile()
          await fs.rename(temp, target)
        } catch (err) {
          await fs.rm(temp, { force: true }).catch(() => undefined)
          throw err
        }
        return await wrote(parent, leaf, req)
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) throw changedFile()
        throw err
      })
    },

    async delete(root, scratch, req: WorkspaceDeleteReq): Promise<WorkspaceDeleteOk> {
      assertScratch(scratch)
      return await withParent(anchor, root, req.path, async (parent, leaf) => {
        if (leaf === undefined) throw new WorkspaceViolationError('not a regular file', 'not-a-file')
        const initial = await statForEdit(parent, leaf)
        if (initial.mtime.toISOString() !== req.ifMatchMtime) throw changedFile()
        const latest = await statForEdit(parent, leaf)
        if (!sameFileVersion(initial, latest)) throw changedFile()
        await fs.unlink(parent.childPath(leaf))
        return { agentId: req.agentId, path: req.path }
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) throw changedFile()
        throw err
      })
    }
  }
}

function assertScratch(scratch: boolean): void {
  if (!scratch) {
    throw new WorkspaceViolationError('workspace files are editable only in scratch workspaces', 'read-only-workspace')
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** The target must not exist for a create; absence is what makes the hard-link publish exclusive. */
async function refuseExisting(parent: DirHandle, leaf: string): Promise<void> {
  try {
    await parent.lstatChild(leaf)
  } catch (err) {
    if (err instanceof MissingPathError) return
    throw err
  }
  throw existingFile()
}

/** The stat a mutation fences on. A missing or non-regular target is the conflict a caller reloads on,
 *  which is also what the path-based implementation answers. */
async function statForEdit(parent: DirHandle, leaf: string) {
  let stat
  try {
    stat = await parent.lstatChild(leaf)
  } catch (err) {
    if (err instanceof MissingPathError) throw changedFile()
    throw err
  }
  if (!stat.isFile()) throw new WorkspaceViolationError('not a regular file', 'not-a-file')
  return stat
}

async function wrote(
  parent: DirHandle,
  leaf: string,
  req: { agentId: string; path: string }
): Promise<WorkspaceWriteOk> {
  const written = await parent.lstatChild(leaf)
  return { agentId: req.agentId, path: req.path, size: written.size, mtime: written.mtime.toISOString() }
}

function sameFileVersion(a: { dev: number; ino: number; size: number; mtimeMs: number }, b: typeof a): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function changedFile(): WorkspaceConflictError {
  return new WorkspaceConflictError('the workspace file changed since it was read; reload and retry')
}

function existingFile(): WorkspaceConflictError {
  return new WorkspaceConflictError('the workspace file already exists; open it to edit')
}
