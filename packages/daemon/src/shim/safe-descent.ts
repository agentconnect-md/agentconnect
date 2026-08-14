/**
 * Path resolution that holds INODES instead of names, for the sandbox side of the workspace-file
 * channel.
 *
 * Everything else in this seam checks a path and then acts on that path, and on a volume the agent's
 * runtime owns those are two different resolutions of one name. Between them it can rename the
 * checkout aside, put a symlink at the same place, let the work follow it, and restore the original
 * before any closing check — which is how four rounds of progressively stricter path revalidation
 * each closed a window and exposed the next. The problem is not that the checks were too loose. It is
 * that a name is not a directory.
 *
 * A file descriptor is. Once `/agent/repo` is open, that handle refers to the inode: renaming the
 * path, replacing it with a symlink, even deleting it changes nothing about what the handle reaches.
 * So the rule here is that a path is resolved exactly ONCE, into a handle, and every step afterwards
 * is taken relative to a handle — never by naming the same place again.
 *
 * The kernel primitive for that is `openat(dirfd, name, …)`, which Node does not expose. On Linux
 * `/proc/self/fd/<n>/<name>` is the same thing: the kernel resolves the magic link straight to the
 * inode the descriptor holds rather than re-walking the path it came from. That is why this module is
 * Linux-only, and why it is here in `shim/` rather than in the shared placement layer — the daemon
 * serves self-hosted macOS and Windows installs, where its own workspace is not on a filesystem an
 * agent controls and this whole hazard is absent.
 *
 * `O_NOFOLLOW` covers only the LAST component of a path, so the descent takes one component at a
 * time: each step is a single name, opened from the previous handle, with symlinks refused. A
 * symlinked directory inside the workspace is therefore rejected rather than resolved — the one
 * behaviour that differs from the daemon-local path, which resolves it and then checks where it
 * landed. A leaf symlink was already refused on both.
 */
import { constants, promises as fs, type Dirent, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Raised when a component could not be opened as itself: a symlink, a non-directory, a race. */
export class UnsafePathError extends Error {
  constructor(
    message: string,
    /** `ELOOP` (a symlink), `ENOTDIR`, or whatever the kernel reported. */
    readonly code: string | undefined
  ) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

/** Raised when a component is simply not there. Absence is DATA to every caller here. */
export class MissingPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingPathError'
  }
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/** Reject anything that is not a single, ordinary component — the whole descent depends on it. */
function assertComponent(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new UnsafePathError(`"${name}" is not a single path component`, 'EINVAL')
  }
}

function classify(err: unknown, what: string): Error {
  const code = errno(err)
  if (code === 'ENOENT') return new MissingPathError(`${what} does not exist`)
  // The symlink refusal reports two different errnos, measured on Linux 6.8 rather than assumed: a
  // symlinked DIRECTORY component opened with `O_DIRECTORY|O_NOFOLLOW` gives `ENOTDIR` (the object is
  // a link, not a directory), while a symlinked FILE opened with `O_NOFOLLOW` alone gives `ELOOP`.
  // Both are the same answer to the caller — the ground is not what it was told — so neither is
  // singled out, and nothing here should ever branch on which one it was.
  return new UnsafePathError(`${what} could not be opened safely (${code ?? 'unknown'})`, code)
}

/**
 * An open directory, and the only way to reach anything under it.
 *
 * Handles are closed by their owner. Every method that opens something returns it to the caller, so
 * the ownership is always the caller's — see {@link withDescent} for the shape that guarantees it.
 */
export class DirHandle {
  private constructor(private readonly handle: FileHandle) {}

  /**
   * Open the anchor by name — the ONE name resolution in the whole descent.
   *
   * It is sound only because of what the anchor is: the sandbox's workspace mount. A mount point
   * cannot be renamed out from under itself (the kernel answers `EBUSY`), so unlike every path below
   * it, this one cannot be swapped between the resolution and the use.
   */
  static async openAnchor(path: string): Promise<DirHandle> {
    if (process.platform !== 'linux') {
      throw new UnsafePathError('fd-bound workspace access requires Linux (/proc/self/fd)', 'ENOTSUP')
    }
    if (!isAbsolute(path)) throw new UnsafePathError(`anchor must be absolute: ${path}`, 'EINVAL')
    try {
      return new DirHandle(await fs.open(path, DIR_FLAGS))
    } catch (err) {
      throw classify(err, `workspace anchor ${path}`)
    }
  }

  /** The path that names THIS handle's inode. Every filesystem call below goes through it. */
  fdPath(): string {
    return `/proc/self/fd/${this.handle.fd}`
  }

  /** Open one child directory, refusing a symlink. */
  async childDir(name: string): Promise<DirHandle> {
    assertComponent(name)
    try {
      return new DirHandle(await fs.open(join(this.fdPath(), name), DIR_FLAGS))
    } catch (err) {
      throw classify(err, `"${name}"`)
    }
  }

  /** Open one child file, refusing a symlink. The caller closes it. */
  async childFile(name: string): Promise<FileHandle> {
    assertComponent(name)
    try {
      return await fs.open(join(this.fdPath(), name), FILE_FLAGS)
    } catch (err) {
      throw classify(err, `"${name}"`)
    }
  }

  /**
   * `lstat` of one child — never following a final symlink, and resolved from this handle.
   *
   * There is deliberately no name-less form that goes through {@link fdPath}: `/proc/self/fd/<n>` is
   * itself a symlink, so `lstat` on it describes the MAGIC LINK rather than the directory, and its
   * mtime is the moment the descriptor was opened. That reads as a plausible answer and is wrong —
   * measured, after a directory's reported mtime tracked the read instead of the tree. Use
   * {@link stat} for the handle's own inode.
   */
  async lstatChild(name: string): Promise<Stats> {
    assertComponent(name)
    try {
      return await fs.lstat(join(this.fdPath(), name))
    } catch (err) {
      throw classify(err, `"${name}"`)
    }
  }

  /** This directory's own inode, straight from the descriptor. */
  async stat(): Promise<Stats> {
    return await this.handle.stat()
  }

  async readdir(): Promise<Dirent[]> {
    try {
      return await fs.readdir(this.fdPath(), { withFileTypes: true })
    } catch (err) {
      throw classify(err, 'this directory')
    }
  }

  /** A path for ONE child, for the calls Node offers no handle-relative form of — `rename`,
   *  `unlink`, `link`, `writeFile`. Each operates on the name itself rather than following it, and
   *  each resolves that name from this handle's inode, so they inherit the same binding. */
  childPath(name: string): string {
    assertComponent(name)
    return join(this.fdPath(), name)
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined)
  }
}

/**
 * Walk `segments` from the anchor, handing the final directory to `work` and closing every handle
 * afterwards.
 *
 * The intermediate handles are held for the whole call rather than closed as the walk proceeds:
 * releasing one would let its inode be recycled, and the descriptor is what keeps the chain the
 * caller validated alive.
 */
export async function withDescent<T>(
  anchorPath: string,
  segments: string[],
  work: (dir: DirHandle) => Promise<T>
): Promise<T> {
  const open: DirHandle[] = [await DirHandle.openAnchor(anchorPath)]
  try {
    for (const segment of segments) {
      open.push(await open[open.length - 1]!.childDir(segment))
    }
    return await work(open[open.length - 1]!)
  } finally {
    // Reverse order is not required by the kernel; it just keeps the close sequence the mirror of the
    // open sequence, so a leak shows up as an unbalanced pair rather than as a puzzle.
    for (const handle of [...open].reverse()) await handle.close()
  }
}
