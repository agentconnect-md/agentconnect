import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'

/**
 * What one path IS, resolved WITHOUT following a symlink.
 *
 * `other` is the answer for a symlink and for every non-regular entry, and every caller treats it
 * as a refusal — which is what the local code expressed by throwing on `lstatSync().isSymbolicLink()`.
 * `missing` is data, never an error: absence is the ordinary answer to "is the checkout there".
 */
export type WorkspaceFsKind = 'file' | 'dir' | 'missing' | 'other'

/**
 * The filesystem twin of `GitRunner`: the workspace file operations the daemon actually performs,
 * as a frozen inventory rather than a general-purpose `node:fs`.
 *
 * It exists for the same reason the git seam does. A cluster-backed agent's workspace lives on its
 * sandbox pod's volume, so every `existsSync`/`mkdirSync`/`rmSync` in the worktree paths inspects
 * the wrong disk — silently, because the daemon's own directory answers plausibly. The orchestration
 * stays here and only the execution moves.
 *
 * Paths are ABSOLUTE, in the coordinates of the filesystem that holds them: this daemon's disk for a
 * local agent, the pod's mount for a sandboxed one. Deriving the members from what the code already
 * calls (rather than from what a filesystem can do) is what keeps the move mechanical.
 */
export interface WorkspaceFs {
  /** Never follows a symlink — see {@link WorkspaceFsKind}. */
  stat(path: string): Promise<WorkspaceFsKind>
  /** Entry names, not paths. Callers prove the directory is there first; one that cannot be read
   *  must fail rather than read as empty, since "empty" is what licenses a removal. */
  readdir(path: string): Promise<string[]>
  /** Recursive, like `mkdir -p`. */
  mkdir(path: string, mode?: number): Promise<void>
  /** The file's text, or undefined when it is absent or unreadable — every caller reads a marker
   *  it is willing to find missing. */
  readFile(path: string): Promise<string | undefined>
  /** The file's BYTES, bounded: over `maxBytes` answers `{tooLarge}` without transferring, and
   *  absent/unreadable answers undefined. The binary sibling of {@link readFile}, added for the
   *  outbound file share (agent-authored-attachments.md §6). */
  readFileBytes(path: string, maxBytes: number): Promise<{ bytes: Buffer } | { tooLarge: number } | undefined>
  /** Atomic: staged beside the target, then published by one rename. */
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  /**
   * Remove a directory ONLY if it is empty, answering whether it went.
   *
   * Distinct from {@link rmTree} because "reclaim a provably empty leftover" is not a tree removal:
   * proving emptiness and then deleting recursively are two operations, and on a volume the agent's
   * runtime is writing to, anything that appears between them is deleted by a removal the proof
   * licensed. Here the kernel decides both at once, so the race resolves as "kept", not as data loss.
   */
  rmdir(path: string): Promise<boolean>
  /** Recursive and forgiving, like `rm -rf`. */
  rmTree(path: string): Promise<void>
}

/**
 * Where one agent's workspace files live: the filesystem that holds them, and the mount its paths
 * are composed in.
 *
 * The two travel together because they are one answer. A daemon that knew which filesystem to ask
 * but not which coordinates to ask in would compose `<agentDir>/worktrees` and send it to a pod that
 * has no such path — the exact failure this seam exists to remove.
 */
export interface WorkspacePlacement {
  fs: WorkspaceFs
  /** The pod's workspace mount; every path the manager composes for this agent hangs off it. */
  mount: string
}

/** Today's behaviour: the daemon's own disk, through `node:fs`. */
export class LocalWorkspaceFs implements WorkspaceFs {
  async stat(path: string): Promise<WorkspaceFsKind> {
    try {
      const stats = lstatSync(path)
      return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other'
    } catch {
      // Unreadable reads as absent, exactly as the `existsSync` this replaces did.
      return 'missing'
    }
  }

  async readdir(path: string): Promise<string[]> {
    return readdirSync(path)
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    mkdirSync(path, { recursive: true, ...(mode === undefined ? {} : { mode }) })
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }

  async readFileBytes(path: string, maxBytes: number): Promise<{ bytes: Buffer } | { tooLarge: number } | undefined> {
    try {
      const stats = lstatSync(path)
      if (!stats.isFile()) return undefined
      if (stats.size > maxBytes) return { tooLarge: stats.size }
      const bytes = readFileSync(path)
      // Re-check on the read bytes: the stat→read race on a growing file must refuse, not overrun.
      if (bytes.byteLength > maxBytes) return { tooLarge: bytes.byteLength }
      return { bytes }
    } catch {
      return undefined
    }
  }

  async writeFile(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
    // A per-write temp name rather than a fixed `.tmp`: two writers publishing the same marker must
    // not stage into one another's file, and the rename is what makes either one whole.
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, content, options.mode === undefined ? {} : { mode: options.mode })
      renameSync(temp, path)
    } catch (err) {
      rmSync(temp, { force: true })
      throw err
    }
  }

  async rename(from: string, to: string): Promise<void> {
    renameSync(from, to)
  }

  async rmdir(path: string): Promise<boolean> {
    try {
      rmdirSync(path)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Already gone counts as removed; anything the kernel refuses to empty is kept, not forced.
      if (code === 'ENOENT') return true
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false
      throw err
    }
  }

  async rmTree(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true })
  }
}

/** One instance is enough: it holds no state, and every local agent shares this disk. */
export const localWorkspaceFs = new LocalWorkspaceFs()
