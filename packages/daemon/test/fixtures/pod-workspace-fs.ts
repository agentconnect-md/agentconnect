import type { WorkspaceFs, WorkspaceFsKind } from '../../src/workspace/workspace-fs.js'

/**
 * A pod volume as a map of paths, for tests whose subject is WHICH pod path the daemon touches.
 *
 * The real sandbox side is `ShimWorkspaceFs` over the fd-anchored channel and is exercised against a
 * real tree in `workspace-fs.test.ts`; here the point is that the daemon composes and inspects the
 * pod's coordinates at all, so an in-memory tree keeps the assertions about coordinates rather than
 * about a filesystem.
 */
export class PodWorkspaceFs implements WorkspaceFs {
  readonly dirs = new Set<string>()
  readonly files = new Map<string, string>()
  /** Paths the pod reports as neither file nor directory — a symlink is the one that matters. */
  readonly links = new Set<string>()
  readonly removed: string[] = []
  /** Paths whose listing the channel cannot answer — a dropped shim connection, not an empty tree. */
  readonly unreadable = new Set<string>()
  /** Whether the pod that owns a path is unbound: every operation on it then fails as the routed filesystem's does, so a question asked of that pod is visible. */
  ownerAsleep: (path: string) => boolean = () => false

  constructor(...seedDirs: string[]) {
    for (const dir of seedDirs) this.dirs.add(dir)
  }

  private reach(path: string): void {
    if (this.ownerAsleep(path)) throw new Error(`sandbox that owns ${path} has no bound channel`)
  }

  async readFileBytes(path: string, maxBytes: number): Promise<{ bytes: Buffer } | { tooLarge: number } | undefined> {
    this.reach(path)
    const content = this.files.get(path)
    if (content === undefined) return undefined
    const bytes = Buffer.from(content, 'utf8')
    return bytes.byteLength > maxBytes ? { tooLarge: bytes.byteLength } : { bytes }
  }

  async stat(path: string): Promise<WorkspaceFsKind> {
    this.reach(path)
    if (this.links.has(path)) return 'other'
    if (this.dirs.has(path)) return 'dir'
    if (this.files.has(path)) return 'file'
    return 'missing'
  }

  async readdir(path: string): Promise<string[]> {
    this.reach(path)
    if (this.unreadable.has(path)) throw new Error(`workspace channel cannot list ${path}`)
    const prefix = `${path}/`
    const names = new Set<string>()
    for (const entry of [...this.dirs, ...this.files.keys()]) {
      if (!entry.startsWith(prefix)) continue
      names.add(entry.slice(prefix.length).split('/')[0]!)
    }
    return [...names]
  }

  async mkdir(path: string): Promise<void> {
    this.reach(path)
    for (const part of ancestors(path)) this.dirs.add(part)
  }

  /** A test's inspection of what the daemon wrote; the seam itself only reads through {@link readFileBytes}. */
  async readFile(path: string): Promise<string | undefined> {
    this.reach(path)
    return this.files.get(path)
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.reach(path)
    this.files.set(path, content)
  }

  async rename(from: string, to: string): Promise<void> {
    this.reach(from)
    this.reach(to)
    if ((await this.stat(from)) === 'missing') throw new Error(`rename source does not exist: ${from}`)
    for (const entry of [...this.dirs]) {
      if (entry === from || entry.startsWith(`${from}/`)) {
        this.dirs.delete(entry)
        this.dirs.add(to + entry.slice(from.length))
      }
    }
    for (const [entry, value] of [...this.files]) {
      if (entry === from || entry.startsWith(`${from}/`)) {
        this.files.delete(entry)
        this.files.set(to + entry.slice(from.length), value)
      }
    }
  }

  async rmdir(path: string): Promise<boolean> {
    this.reach(path)
    if ((await this.readdir(path)).length > 0) return false
    this.dirs.delete(path)
    this.removed.push(path)
    return true
  }

  async rmTree(path: string): Promise<void> {
    this.reach(path)
    this.removed.push(path)
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry)
    for (const entry of [...this.files.keys()]) {
      if (entry === path || entry.startsWith(`${path}/`)) this.files.delete(entry)
    }
  }
}

/** Every directory on the way to `path`, so a recursive mkdir leaves each one stat-able. */
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}
