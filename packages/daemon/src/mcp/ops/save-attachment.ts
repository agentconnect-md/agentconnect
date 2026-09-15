import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { DirHandle, MissingPathError, UnsafePathError, withDescent } from '../../shim/safe-descent.js'
import { containedWorkspacePath, WorkspaceViolationError } from '../../workspace/workspace-files.js'
import { WorkspaceFileExistsError, type WorkspaceFs, type WorkspaceFsKind } from '../../workspace/workspace-fs.js'
import { ATTACHMENT_UPLOADS_DIR, type SaveAttachmentResult } from './platform-reads.js'

/**
 * Where an inbound attachment lands (inbound-file-attachments.md §2): the session's `uploads/`,
 * reached in one of two ways that differ ONLY in who supplies the containment.
 *
 * - `workspace-fs`: a {@link WorkspaceFs} plus the working root. The pod arm — the shim's
 *   fd-anchored descent is the containment, so the daemon composes paths and nothing more. Also
 *   the local arm on a platform without a local sandbox (macOS, Windows: microsandbox is
 *   Linux-only), where `canonicalDir` re-verifies `uploads/` by realpath; a name check is all
 *   Node offers there, and an unsandboxed agent already holds the daemon's own authority.
 * - `pinned`: the local arm on Linux. The agent may be sandboxed to its workspace while the
 *   daemon is not, so a name validated now can be swapped for a symlink before the write
 *   (PR review P1). The directory is therefore OPENED once (`O_DIRECTORY|O_NOFOLLOW`) and every
 *   leaf operation — stat, compare, stage, exclusive publish — resolves from that descriptor
 *   via `/proc/self/fd`, exactly as the shim does on the pod. A later rename of `uploads` moves
 *   the inode we hold; it cannot redirect us to one we never validated.
 */
export type SaveAttachmentTarget =
  | {
      kind: 'workspace-fs'
      fs: WorkspaceFs
      root: string
      /** Realpath re-verification of `uploads/` (local fallback arm only). Answers the canonical
       *  path, or null when the directory is absent. */
      canonicalDir?: (root: string, rel: string) => Promise<string | null>
    }
  | { kind: 'pinned'; root: string }

/** One `uploads/` directory, however it is reached; every method takes a single leaf NAME. */
export interface AttachmentDir {
  kind(name: string): Promise<WorkspaceFsKind>
  /** The leaf's bytes when it is a regular file of at most `maxBytes`; undefined otherwise. */
  readBytes(name: string, maxBytes: number): Promise<Buffer | undefined>
  /** Exclusive publish: throws {@link WorkspaceFileExistsError} when ANYTHING is at `name`. */
  writeExclusive(name: string, bytes: Buffer): Promise<void>
}

/**
 * Land `bytes` as `uploads/<name>` (or a digest-suffixed sibling), never clobbering.
 *
 * Publication is an EXCLUSIVE create, so two concurrent saves that both saw the name free cannot
 * both "succeed" at one path with one of them lost (PR review P2): the kernel decides, the loser
 * re-reads what won — same bytes ⇒ reuse, different bytes ⇒ next candidate.
 *
 * Throws whatever the filesystem seam throws for anything other than containment or a taken
 * name: on the pod arm that is the channel, and the caller maps it to "sandbox unreachable".
 */
export async function saveAttachmentTo(
  target: SaveAttachmentTarget,
  name: string,
  bytes: Buffer
): Promise<SaveAttachmentResult> {
  if (target.kind === 'pinned') {
    try {
      return await withDescent(
        target.root,
        [ATTACHMENT_UPLOADS_DIR],
        (dir) => saveInto(new PinnedDir(dir), name, bytes),
        {
          createMissing: true
        }
      )
    } catch (err) {
      // A symlinked or otherwise unopenable `uploads` is the boundary refusing, not the disk failing.
      if (err instanceof UnsafePathError) return { ok: false, reason: 'escape' }
      throw err
    }
  }

  const { fs, root } = target
  let dir: string
  try {
    dir = containedWorkspacePath(root, ATTACHMENT_UPLOADS_DIR)
  } catch (err) {
    return escapeOr(err)
  }
  await fs.mkdir(dir)
  if (target.canonicalDir) {
    // Refuse `uploads` that is not a plain directory (a symlink lstat's as `other`), THEN prove the
    // realpath is still under the root: mkdir -p on an existing symlink-to-dir succeeds silently.
    if ((await fs.stat(dir)) !== 'dir') return { ok: false, reason: 'escape' }
    let canon: string | null
    try {
      canon = await target.canonicalDir(root, ATTACHMENT_UPLOADS_DIR)
    } catch (err) {
      return escapeOr(err)
    }
    if (!canon) return { ok: false, reason: 'write-failed', detail: 'uploads/ vanished after creation' }
    dir = canon
  }
  return await saveInto(new WorkspaceFsDir(fs, dir), name, bytes)
}

/** The candidate loop, over an already-anchored directory. Exported for the adversarial tests. */
export async function saveInto(dir: AttachmentDir, name: string, bytes: Buffer): Promise<SaveAttachmentResult> {
  const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const candidates = [name, name.replace(/(\.[A-Za-z0-9]{1,10})?$/, (ext) => `-${sha8}${ext}`)]
  for (const candidate of candidates) {
    const rel = `${ATTACHMENT_UPLOADS_DIR}/${candidate}`
    if (await sameBytesAt(dir, candidate, bytes)) return { ok: true, path: rel }
    try {
      await dir.writeExclusive(candidate, bytes)
      return { ok: true, path: rel }
    } catch (err) {
      if (!(err instanceof WorkspaceFileExistsError)) throw err
      // Lost the race (or the stat above saw a non-file): does the winner hold our bytes?
      if (await sameBytesAt(dir, candidate, bytes)) return { ok: true, path: rel }
    }
  }
  return { ok: false, reason: 'write-failed', detail: 'both candidate names are taken' }
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
