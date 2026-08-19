/**
 * The workspace-tree half of the `read` capability: a cluster agent's worktrees live on its sandbox
 * volume, and this is how the daemon's `WorkspaceFs` seam reaches them.
 *
 * It is the same fd-anchored channel the managed memory tree rides — `memory-fs-channel.ts` — with
 * one more primitive (`stat`) and a different tree under the same mount. Reusing it rather than
 * opening a second one is the point: containment on the pod is the descent from an open descriptor,
 * which is stronger than any name check this side could make, and there must be exactly one
 * implementation of it.
 *
 * Paths arrive ABSOLUTE, in the pod's coordinates (`<mount>/worktrees/<sid>`), because that is what
 * the daemon composes and what git in the pod is given. They are turned into mount-relative ones
 * here; anything that is not under the mount is refused before it reaches the wire.
 */
import { isAbsolute, relative, sep } from 'node:path'
import { MemoryPathError } from '../memory/fs.js'
import type { WorkspaceFs, WorkspaceFsKind } from '../workspace/workspace-fs.js'
import { KindReplySchema, ShimMemoryFs, requestMemoryFs, type ShimMemoryChannel } from './memory-fs-channel.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** The daemon's side of the seam for one agent's sandbox volume. */
export class ShimWorkspaceFs implements WorkspaceFs {
  private readonly files: ShimMemoryFs

  constructor(
    private readonly channel: ShimMemoryChannel,
    /** The pod's workspace mount; every path handed to this instance must sit under it. */
    private readonly mount: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.files = new ShimMemoryFs(channel, mount, timeoutMs)
  }

  async stat(path: string): Promise<WorkspaceFsKind> {
    return await requestMemoryFs(
      this.channel,
      { op: 'memory-stat', root: this.mount, rel: this.rel(path) },
      KindReplySchema,
      this.timeoutMs
    )
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.files.readdir(this.rel(path))).map((entry) => entry.name)
  }

  async mkdir(path: string): Promise<void> {
    // No mode: the volume is this agent's alone, so the local 0o700 has no second principal to exclude.
    await this.files.mkdir(this.rel(path))
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return (await this.files.readFile(this.rel(path)))?.content
    } catch (err) {
      // A refusal reads as absent, like the local seam's catch. A transport failure must NOT: "the
      // channel dropped" is not evidence that the marker is missing, and a caller would act on it.
      if (err instanceof MemoryPathError) return undefined
      throw err
    }
  }

  async writeFile(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
    // Staged as appended chunks beside the target and published by one rename, on the pod.
    await this.files.writeFile(this.rel(path), content, options)
  }

  async rename(from: string, to: string): Promise<void> {
    // The pod answers a missing source as data; the local seam throws, so raise it here too.
    if (!(await this.files.rename(this.rel(from), this.rel(to)))) {
      throw new Error(`workspace rename source does not exist: ${from}`)
    }
  }

  async rmTree(path: string): Promise<void> {
    await this.files.rm(this.rel(path))
  }

  /** Mount-relative, POSIX-separated; a path the daemon did not compose under the mount is refused. */
  private rel(path: string): string {
    const rel = relative(this.mount, path)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`workspace path is outside the sandbox mount: ${path}`)
    }
    return rel.split(sep).join('/')
  }
}
