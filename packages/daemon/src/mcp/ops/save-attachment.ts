import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { sessionFileName } from '@agentconnect.md/protocol'
import { DirHandle, MissingPathError, UnsafePathError, withDescent } from '../../shim/safe-descent.js'
import { containedWorkspacePath, WorkspaceViolationError } from '../../workspace/workspace-files.js'
import { WorkspaceFileExistsError, type WorkspaceFs, type WorkspaceFsKind } from '../../workspace/workspace-fs.js'
import { ATTACHMENT_UPLOADS_DIR, type SaveAttachmentResult } from './platform-reads.js'

// The session files directory's `uploads/` (inbound-file-attachments.md §2.4) from a trusted root: the pod's descent or a realpath check (`workspace-fs`), or an O_NOFOLLOW descriptor descent on Linux (`pinned`).
export type SaveAttachmentTarget =
  | {
      kind: 'workspace-fs'
      fs: WorkspaceFs
      root: string
      segments: readonly string[]
      /** Realpath of `root/rel` (local fallback arm only); null when absent. */
      canonicalDir?: (root: string, rel: string) => Promise<string | null>
    }
  | { kind: 'pinned'; root: string; segments: readonly string[] }

/** One `uploads/` directory, however it is reached; every method takes a single leaf NAME. */
export interface AttachmentDir {
  kind(name: string): Promise<WorkspaceFsKind>
  /** The leaf's bytes when it is a regular file of at most `maxBytes`; undefined otherwise. */
  readBytes(name: string, maxBytes: number): Promise<Buffer | undefined>
  /** Exclusive publish: throws {@link WorkspaceFileExistsError} when ANYTHING is at `name`. */
  writeExclusive(name: string, bytes: Buffer): Promise<void>
}

/** Land `bytes` as `uploads/<name>` or a digest-suffixed sibling by exclusive create, never clobbering; throws what the seam throws for anything but containment or a taken name. */
export async function saveAttachmentTo(
  target: SaveAttachmentTarget,
  name: string,
  bytes: Buffer
): Promise<SaveAttachmentResult> {
  const segments = [...target.segments, ATTACHMENT_UPLOADS_DIR]
  const saved = (leaf: string | undefined): SaveAttachmentResult =>
    leaf === undefined
      ? { ok: false, reason: 'write-failed', detail: 'both candidate names are taken' }
      : { ok: true, path: join(target.root, ...segments, leaf), name: sessionFileName(ATTACHMENT_UPLOADS_DIR, leaf) }
  if (target.kind === 'pinned') {
    try {
      return saved(
        await withDescent(target.root, segments, (dir) => saveInto(new PinnedDir(dir), name, bytes), {
          createMissing: true
        })
      )
    } catch (err) {
      // A symlinked or otherwise unopenable segment is the boundary refusing, not the disk failing.
      if (err instanceof UnsafePathError) return { ok: false, reason: 'escape' }
      throw err
    }
  }

  const { fs, root } = target
  let dir: string
  try {
    dir = containedWorkspacePath(root, segments.join('/'))
  } catch (err) {
    return escapeOr(err)
  }
  if (target.canonicalDir) {
    // Before mkdir -p, which would follow a link: every existing prefix must already be where it is named.
    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('/')
      let canon: string | null
      try {
        canon = await target.canonicalDir(root, prefix)
      } catch (err) {
        return escapeOr(err)
      }
      if (canon === null) break
      if (canon !== join(root, prefix)) return { ok: false, reason: 'escape' }
    }
  }
  await fs.mkdir(dir)
  if (target.canonicalDir) {
    // Refuse a directory that is not plain (a symlink lstat's as `other`), THEN prove no link sits anywhere below `root`.
    if ((await fs.stat(dir)) !== 'dir') return { ok: false, reason: 'escape' }
    let canon: string | null
    try {
      canon = await target.canonicalDir(root, segments.join('/'))
    } catch (err) {
      return escapeOr(err)
    }
    if (!canon) return { ok: false, reason: 'write-failed', detail: 'uploads/ vanished after creation' }
    if (canon !== dir) return { ok: false, reason: 'escape' }
  }
  return saved(await saveInto(new WorkspaceFsDir(fs, dir), name, bytes))
}

/** The candidate loop over an already-anchored directory: the leaf the bytes landed at, or undefined when both are taken. Exported for the adversarial tests. */
export async function saveInto(dir: AttachmentDir, name: string, bytes: Buffer): Promise<string | undefined> {
  const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const candidates = [name, name.replace(/(\.[A-Za-z0-9]{1,10})?$/, (ext) => `-${sha8}${ext}`)]
  for (const candidate of candidates) {
    if (await sameBytesAt(dir, candidate, bytes)) return candidate
    try {
      await dir.writeExclusive(candidate, bytes)
      return candidate
    } catch (err) {
      if (!(err instanceof WorkspaceFileExistsError)) throw err
      // Lost the race (or the stat above saw a non-file): does the winner hold our bytes?
      if (await sameBytesAt(dir, candidate, bytes)) return candidate
    }
  }
  return undefined
}

/** True when a regular file at `name` holds exactly `bytes` — the digest-reuse rule (§2.1). */
async function sameBytesAt(dir: AttachmentDir, name: string, bytes: Buffer): Promise<boolean> {
  if ((await dir.kind(name)) !== 'file') return false
  const existing = await dir.readBytes(name, bytes.byteLength)
  return !!existing && existing.equals(bytes)
}

function escapeOr(err: unknown): SaveAttachmentResult {
  return err instanceof WorkspaceViolationError
    ? { ok: false, reason: 'escape' }
    : { ok: false, reason: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
}

/** `uploads/` through a {@link WorkspaceFs}: the pod arm, and the non-Linux local fallback. */
export class WorkspaceFsDir implements AttachmentDir {
  constructor(
    private readonly fs: WorkspaceFs,
    private readonly dir: string
  ) {}
  private leaf(name: string): string {
    // `dir` as the root: the candidate is one component, and this keeps it one.
    return containedWorkspacePath(this.dir, name)
  }
  kind(name: string): Promise<WorkspaceFsKind> {
    return this.fs.stat(this.leaf(name))
  }
  async readBytes(name: string, maxBytes: number): Promise<Buffer | undefined> {
    const read = await this.fs.readFileBytes(this.leaf(name), maxBytes)
    return read && 'bytes' in read ? read.bytes : undefined
  }
  writeExclusive(name: string, bytes: Buffer): Promise<void> {
    return this.fs.writeFile(this.leaf(name), bytes, { ifAbsent: true })
  }
}

/**
 * `uploads/` as an OPEN descriptor (Linux local arm). Nothing here resolves the directory by
 * name again: `lstat`, `open(O_NOFOLLOW)`, `writeFile(wx)` and `link` all take
 * `/proc/self/fd/<n>/<leaf>`, so they operate on the inode the descent validated even if the
 * agent has since renamed it or planted a symlink under its old name.
 */
export class PinnedDir implements AttachmentDir {
  constructor(private readonly dir: DirHandle) {}

  async kind(name: string): Promise<WorkspaceFsKind> {
    try {
      const st = await this.dir.lstatChild(name)
      return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
    } catch (err) {
      if (err instanceof MissingPathError) return 'missing'
      throw err
    }
  }

  async readBytes(name: string, maxBytes: number): Promise<Buffer | undefined> {
    let handle
    try {
      handle = await this.dir.childFile(name) // O_NOFOLLOW: a symlink leaf reads as absent, not followed
    } catch (err) {
      if (err instanceof MissingPathError || err instanceof UnsafePathError) return undefined
      throw err
    }
    try {
      const st = await handle.stat()
      if (!st.isFile() || st.size > maxBytes) return undefined
      const bytes = await handle.readFile()
      return bytes.byteLength > maxBytes ? undefined : bytes
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  async writeExclusive(name: string, bytes: Buffer): Promise<void> {
    // Staged in the SAME pinned directory (so the link stays on one filesystem) under a name no
    // agent can predict, then published by link(2): fails EEXIST when anything is at `name`,
    // never follows it, and is one kernel step with the existence check.
    const temp = `.agentconnect-upload-${randomUUID()}.tmp`
    const tempPath = this.dir.childPath(temp)
    try {
      await nodeFs.writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 })
      try {
        await nodeFs.link(tempPath, this.dir.childPath(name))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw new WorkspaceFileExistsError(join(ATTACHMENT_UPLOADS_DIR, name))
        throw err
      }
    } finally {
      await nodeFs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }
}
