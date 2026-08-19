/**
 * The memory-fs primitives executed against open directory handles — the sandbox's side of
 * `memory-fs-channel.ts`.
 *
 * The memory root sits on the agent's volume, which the agent's runtime writes to, so the same
 * hazard the workspace channel closes with `safe-descent.ts` applies: a name is not a directory, and
 * a check by name followed by a use by name is a window. Every primitive here descends ONCE through
 * {@link withDescent} to a handle and does its work relative to that handle; the leaf is opened with
 * `O_NOFOLLOW`. What the two sides share is every rule about the ANSWER: the slice budget, the UTF-8
 * boundary, the mtime precondition, and the temp-then-rename publish.
 */
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { MemoryConflictError, MemoryPathError, memoryRelSegments, type MemoryFsEntry } from '../memory/fs.js'
import { fitToBudget, utf8Boundary } from '../wire-slice.js'
import type { MemoryFsExecutor } from './memory-fs-channel.js'
import { DirHandle, MissingPathError, withDescent } from './safe-descent.js'

/** Where the memory root sits under the anchor, as components; anything outside the mount is refused. */
function rootSegments(anchor: string, root: string): string[] {
  const rel = relative(anchor, root)
  if (rel === '') return []
  if (rel.startsWith('..') || isAbsolute(rel)) throw new MemoryPathError('the memory root is outside the sandbox mount')
  return rel.split(sep).filter(Boolean)
}

/** A descent refusal reads as containment; absence stays absence, which callers answer as data. */
function asPathError(err: unknown): never {
  if (err instanceof MissingPathError || err instanceof MemoryPathError || err instanceof MemoryConflictError) throw err
  throw new MemoryPathError('the memory path could not be opened safely')
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

export function createFdMemoryFsExecutor(anchor: string): MemoryFsExecutor {
  /** Descend to the parent of `rel`, handing over the parent handle and the leaf name. */
  async function withParent<T>(
    root: string,
    rel: string,
    createMissing: boolean,
    work: (parent: DirHandle, leaf: string) => Promise<T>
  ): Promise<T> {
    const requested = memoryRelSegments(rel)
    if (requested.length === 0) throw new MemoryPathError('a file name is required')
    const segments = [...rootSegments(anchor, root), ...requested]
    const leaf = segments[segments.length - 1]!
    try {
      return await withDescent(anchor, segments.slice(0, -1), (parent) => work(parent, leaf), { createMissing })
    } catch (err) {
      return asPathError(err)
    }
  }

  /** Descend to the directory `rel` names itself. */
  async function withDir<T>(
    root: string,
    rel: string,
    createMissing: boolean,
    work: (dir: DirHandle) => Promise<T>
  ): Promise<T> {
    try {
      return await withDescent(anchor, [...rootSegments(anchor, root), ...memoryRelSegments(rel)], work, {
        createMissing
      })
    } catch (err) {
      return asPathError(err)
    }
  }

  return {
    async read(root, rel, offset, limit, encoding) {
      return await withParent(root, rel, false, async (parent, leaf) => {
        let stat
        try {
          stat = await parent.lstatChild(leaf)
        } catch (err) {
          if (err instanceof MissingPathError) return { exists: false as const }
          throw err
        }
        if (!stat.isFile()) throw new MemoryPathError('memory target is not a regular file')
        const file = await parent.childFile(leaf)
        try {
          const st = await file.stat()
          const want = Math.min(limit, Math.max(0, st.size - offset))
          let slice = Buffer.alloc(0)
          if (want > 0) {
            const buf = Buffer.alloc(want)
            const { bytesRead } = await file.read(buf, 0, want, offset)
            slice = buf.subarray(0, bytesRead)
          }
          const { end, content } =
            encoding === 'base64'
              ? { end: slice.length, content: slice.toString('base64') }
              : fitToBudget(slice, utf8Boundary(slice, slice.length))
          return {
            exists: true as const,
            size: st.size,
            mtime: st.mtime.toISOString(),
            content,
            nextOffset: offset + end
          }
        } finally {
          await file.close()
        }
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) return { exists: false as const }
        throw err
      })
    },

    async append(root, rel, content, create, mode) {
      return await withParent(root, rel, create, async (parent, leaf) => {
        const flags =
          constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          (create ? constants.O_CREAT | constants.O_EXCL : 0)
        const handle = await fs.open(parent.childPath(leaf), flags, mode ?? 0o644)
        try {
          const st = await handle.stat()
          if (!st.isFile()) throw new MemoryPathError('memory target is not a regular file')
          await handle.writeFile(content)
          return { size: (await handle.stat()).size }
        } finally {
          await handle.close()
        }
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) throw new MemoryPathError('memory staging file is missing')
        throw err
      })
    },

    async commit(root, rel, temp, ifMatchMtime) {
      return await withParent(root, rel, false, async (parent, leaf) => {
        const tempLeaf = memoryRelSegments(temp).pop()
        // The temp is staged beside its target, so one parent handle covers both names.
        if (
          !tempLeaf ||
          memoryRelSegments(temp).slice(0, -1).join('/') !== memoryRelSegments(rel).slice(0, -1).join('/')
        ) {
          throw new MemoryPathError('memory staging file must sit beside its target')
        }
        try {
          if (ifMatchMtime) {
            let current
            try {
              current = await parent.lstatChild(leaf)
            } catch (err) {
              if (err instanceof MissingPathError) throw changedFile()
              throw err
            }
            if (!current.isFile() || current.mtime.toISOString() !== ifMatchMtime) throw changedFile()
          } else {
            let current
            try {
              current = await parent.lstatChild(leaf)
            } catch (err) {
              if (!(err instanceof MissingPathError)) throw err
            }
            if (current && !current.isFile()) throw new MemoryPathError('memory target is not a regular file')
          }
          await fs.rename(parent.childPath(tempLeaf), parent.childPath(leaf))
        } catch (err) {
          await fs.rm(parent.childPath(tempLeaf), { force: true }).catch(() => undefined)
          throw err
        }
        const written = await parent.lstatChild(leaf)
        return { size: written.size, mtime: written.mtime.toISOString() }
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) throw changedFile()
        throw err
      })
    },

    async stat(root, rel) {
      // The root itself has no leaf to lstat, so it is answered by whether the descent reaches it.
      if (memoryRelSegments(rel).length === 0) {
        return await withDir(root, rel, false, async () => 'dir' as const).catch((err: unknown) => {
          if (err instanceof MissingPathError) return 'missing' as const
          throw err
        })
      }
      return await withParent(root, rel, false, async (parent, leaf) => {
        const st = await parent.lstatChild(leaf)
        return st.isDirectory() ? ('dir' as const) : st.isFile() ? ('file' as const) : ('other' as const)
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) return 'missing' as const
        throw err
      })
    },

    async readdir(root, rel) {
      return await withDir(root, rel, false, async (dir) => {
        const entries: MemoryFsEntry[] = []
        for (const dirent of await dir.readdir()) {
          const kind: MemoryFsEntry['kind'] = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other'
          const entry: MemoryFsEntry = { name: dirent.name, kind }
          if (kind === 'file') {
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
        return entries
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) return []
        throw err
      })
    },

    async mkdir(root, rel) {
      await withDir(root, rel, true, async () => undefined)
    },

    async rename(root, from, to) {
      return await withParent(root, from, false, async (source, sourceLeaf) => {
        try {
          await source.lstatChild(sourceLeaf)
        } catch (err) {
          if (err instanceof MissingPathError) return false
          throw err
        }
        // Both parents held for the rename: the source handle keeps its chain alive while the target's
        // is opened, so neither name can be re-pointed between the checks and the move.
        await withParent(root, to, true, async (target, targetLeaf) => {
          await fs.rename(source.childPath(sourceLeaf), target.childPath(targetLeaf))
        })
        return true
      }).catch((err: unknown) => {
        if (err instanceof MissingPathError) return false
        throw err
      })
    },

    async rm(root, rel) {
      await withParent(root, rel, false, async (parent, leaf) => {
        await fs.rm(parent.childPath(leaf), { recursive: true, force: true })
      }).catch((err: unknown) => {
        if (!(err instanceof MissingPathError)) throw err
      })
    },

    async utimes(root, rel, mtime) {
      const when = new Date(mtime)
      await withParent(root, rel, false, async (parent, leaf) => {
        try {
          await fs.lutimes(parent.childPath(leaf), when, when)
        } catch (err) {
          if (!isErrno(err, 'ENOENT')) throw err
        }
      }).catch((err: unknown) => {
        if (!(err instanceof MissingPathError)) throw err
      })
    }
  }
}

function changedFile(): MemoryConflictError {
  return new MemoryConflictError('the memory file changed since it was read; reload and retry')
}
