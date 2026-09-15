import { createHash } from 'node:crypto'
import { containedWorkspacePath, WorkspaceViolationError } from '../../workspace/workspace-files.js'
import { WorkspaceFileExistsError, type WorkspaceFs } from '../../workspace/workspace-fs.js'
import { ATTACHMENT_UPLOADS_DIR, type SaveAttachmentResult } from './platform-reads.js'

/**
 * Where an inbound attachment lands (inbound-file-attachments.md §2): ONE session workspace,
 * in the coordinates of the filesystem that holds it.
 */
export interface SaveAttachmentTarget {
  fs: WorkspaceFs
  /** The session working root — the daemon's disk for a local agent, the pod mount for a cluster one. */
  root: string
  /**
   * Local arm only: canonicalize `uploads/` with realpath and prove it is still under the root.
   * `containedWorkspacePath` is lexical, and every `node:fs` call after it FOLLOWS symlinks — so
   * without this a locally sandboxed agent that swaps `uploads` for a symlink would have the
   * unsandboxed daemon write outside its workspace (PR review P1). The pod arm needs none: the
   * shim descends from an open descriptor, which no name check on this side could improve on.
   * Answers the canonical path, or null when the directory is absent.
   */
  canonicalDir?: (root: string, rel: string) => Promise<string | null>
}

/**
 * Land `bytes` as `uploads/<name>` (or a digest-suffixed sibling), never clobbering.
 *
 * Publication is an EXCLUSIVE create (`ifAbsent`), so two concurrent saves that both saw the name
 * free cannot both "succeed" at one path with one of them lost (PR review P2): the kernel decides,
 * the loser re-reads what won — same bytes ⇒ reuse, different bytes ⇒ next candidate.
 *
 * Throws whatever the filesystem seam throws for anything other than containment or a taken
 * name: on the pod arm that is the channel, and the caller maps it to "sandbox unreachable".
 */
export async function saveAttachmentTo(
  target: SaveAttachmentTarget,
  name: string,
  bytes: Buffer
): Promise<SaveAttachmentResult> {
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

  const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const candidates = [name, name.replace(/(\.[A-Za-z0-9]{1,10})?$/, (ext) => `-${sha8}${ext}`)]
  for (const candidate of candidates) {
    const rel = `${ATTACHMENT_UPLOADS_DIR}/${candidate}`
    let resolved: string
    try {
      // `dir` as the root: the candidate is one component, and this keeps it one.
      resolved = containedWorkspacePath(dir, candidate)
    } catch (err) {
      return escapeOr(err)
    }
    if (await sameBytesAt(fs, resolved, bytes)) return { ok: true, path: rel }
    try {
      await fs.writeFile(resolved, bytes, { ifAbsent: true })
      return { ok: true, path: rel }
    } catch (err) {
      if (!(err instanceof WorkspaceFileExistsError)) throw err
      // Lost the race (or the stat above saw a non-file): does the winner hold our bytes?
      if (await sameBytesAt(fs, resolved, bytes)) return { ok: true, path: rel }
    }
  }
  return { ok: false, reason: 'write-failed', detail: 'both candidate names are taken' }
}

/** True when a regular file at `path` holds exactly `bytes` — the digest-reuse rule (§2.1). */
async function sameBytesAt(fs: WorkspaceFs, path: string, bytes: Buffer): Promise<boolean> {
  if ((await fs.stat(path)) !== 'file') return false
  const existing = await fs.readFileBytes(path, bytes.byteLength)
  return !!existing && 'bytes' in existing && existing.bytes.equals(bytes)
}

function escapeOr(err: unknown): SaveAttachmentResult {
  return err instanceof WorkspaceViolationError
    ? { ok: false, reason: 'escape' }
    : { ok: false, reason: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
}
