// Reads of a path a sandboxed runtime can write: a FIFO must not park the caller, and only a bounded regular file is read.
import { closeSync, constants, fstatSync, lstatSync, openSync, promises as fsp, readSync, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/** Raised when a bounded read meets anything but a regular file, or a file past its bound. */
export class RegularFileError extends Error {
  constructor(
    readonly reason: 'not-a-file' | 'too-large',
    path: string,
    /** The size that broke the bound, for `too-large`. */
    readonly size?: number
  ) {
    super(reason === 'not-a-file' ? `${path} is not a regular file` : `${path} is larger than its read bound`)
    this.name = 'RegularFileError'
  }
}

export interface RegularFileOptions {
  /** Follow a final-component symlink; the default refuses one as not a regular file. */
  followSymlinks?: boolean
}

function openFlags(opts: RegularFileOptions): number {
  // O_NONBLOCK returns at once from a FIFO with no writer; fstat then refuses it.
  return constants.O_RDONLY | constants.O_NONBLOCK | (opts.followSymlinks ? 0 : constants.O_NOFOLLOW)
}

// Windows has no O_NOFOLLOW: there an lstat refuses the link, and the descriptor judges whatever is swapped in after.
const LSTAT_REFUSES_LINKS = !('O_NOFOLLOW' in constants)

function refuseLink(stat: Stats, path: string): void {
  if (stat.isSymbolicLink()) throw new RegularFileError('not-a-file', path)
}

function openFailure(err: unknown, path: string, opts: RegularFileOptions): unknown {
  return !opts.followSymlinks && (err as NodeJS.ErrnoException | null)?.code === 'ELOOP'
    ? new RegularFileError('not-a-file', path)
    : err
}

function checkedStat(stat: Stats, path: string, maxBytes: number): Stats {
  if (!stat.isFile()) throw new RegularFileError('not-a-file', path)
  if (stat.size > maxBytes) throw new RegularFileError('too-large', path, stat.size)
  return stat
}

// A file still growing past its fstat size reads whole under the bound and refuses past it.
function grown(buffer: Buffer, length: number, maxBytes: number, path: string): Buffer {
  if (length > maxBytes) throw new RegularFileError('too-large', path, length)
  const next = Buffer.alloc(Math.min(buffer.length * 2, maxBytes + 1))
  buffer.copy(next, 0, 0, length)
  return next
}

/** Open `path` as a regular file for reading; the caller closes the handle. ENOENT and other open errors propagate. */
export async function openRegularFile(
  path: string,
  opts: RegularFileOptions = {}
): Promise<{ handle: FileHandle; stat: Stats }> {
  let handle: FileHandle
  try {
    if (!opts.followSymlinks && LSTAT_REFUSES_LINKS) refuseLink(await fsp.lstat(path), path)
    handle = await fsp.open(path, openFlags(opts))
  } catch (err) {
    throw openFailure(err, path, opts)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new RegularFileError('not-a-file', path)
    return { handle, stat }
  } catch (err) {
    await handle.close().catch(() => undefined)
    throw err
  }
}

/** Read a whole regular file of at most `maxBytes`. */
export async function readRegularFile(path: string, maxBytes: number, opts: RegularFileOptions = {}): Promise<Buffer> {
  const { handle, stat } = await openRegularFile(path, opts)
  try {
    let buffer: Buffer = Buffer.alloc(checkedStat(stat, path, maxBytes).size + 1)
    let length = 0
    for (;;) {
      if (length === buffer.length) buffer = grown(buffer, length, maxBytes, path)
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) return buffer.subarray(0, length)
      length += bytesRead
    }
  } finally {
    await handle.close()
  }
}

/** The synchronous {@link readRegularFile}, for launch preparation and credential discovery. */
export function readRegularFileSync(path: string, maxBytes: number, opts: RegularFileOptions = {}): Buffer {
  let fd: number
  try {
    if (!opts.followSymlinks && LSTAT_REFUSES_LINKS) refuseLink(lstatSync(path), path)
    fd = openSync(path, openFlags(opts))
  } catch (err) {
    throw openFailure(err, path, opts)
  }
  try {
    let buffer: Buffer = Buffer.alloc(checkedStat(fstatSync(fd), path, maxBytes).size + 1)
    let length = 0
    for (;;) {
      if (length === buffer.length) buffer = grown(buffer, length, maxBytes, path)
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) return buffer.subarray(0, length)
      length += count
    }
  } finally {
    closeSync(fd)
  }
}
