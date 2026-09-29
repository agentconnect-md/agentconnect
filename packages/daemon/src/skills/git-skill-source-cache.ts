/**
 * Daemon-owned cache of acquired Git skill sources, one extracted archive per (agent, repository,
 * commit).
 *
 * A commit's tree never changes, so an entry needs no expiry to stay correct: a moving ref reaches
 * a new commit and with it a new key. The cache only saves the work — four GitHub API requests and
 * a whole-repository archive — that every new session's preparation otherwise repeats for a commit
 * it already has, which is what a session-isolated agent pays on each new conversation.
 *
 * Entries are keyed by agent as well: a pool member serves every organization, and an archive one
 * agent's scoped credential could read must never answer another agent that cannot. A hit needs
 * the commit up front (a pinned ref, the tracked head, or the prior install's resolution) and still
 * re-proves the agent's access with the one identity request an acquisition starts with, so a
 * revoked credential or a replaced repository stops a hit as it stops a download. What it saves is
 * the commit resolution, the second identity check, the archive redirect and the archive itself.
 *
 * What a hit returns is re-inspected by its caller exactly as a fresh acquisition is — every file
 * hashed before it is declared — so the cache changes where the bytes come from, not what is
 * checked about them. Eviction drops entries idle past `idleMs`, then the least recently used
 * beyond `maxBytes`, but never one used within `inUseMs`, so a preparation still reading an entry
 * cannot lose it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import { acquireGitSkillSource, resolveBoundedGitSkillSource, verifyGitSkillSourceAccess } from './skill-git-source.js'

const COMMIT_SHA = /^[a-f0-9]{40}$/
const REPOSITORY_DIR = 'repository'
const METADATA_FILE = 'entry.json'

export interface GitSkillSourceCacheOptions {
  /** Total bytes the cache keeps before evicting the least recently used entries. */
  maxBytes?: number
  /** An entry unused for longer than this is evicted. */
  idleMs?: number
  /** An entry used more recently than this is never evicted, whatever the size. */
  inUseMs?: number
  now?: () => number
  warn?: (message: string) => void
  /** The acquisition a miss runs; injectable for tests. */
  acquire?: typeof acquireGitSkillSource
  /** The access check a hit runs; injectable for tests. */
  verifyAccess?: typeof verifyGitSkillSourceAccess
}

interface EntryMetadata {
  version: 1
  agentId: string
  githubRepoId: string
  commit: string
  bytes: number
}

type AcquireOptions = Parameters<typeof acquireGitSkillSource>[1]

export class GitSkillSourceCache {
  private readonly maxBytes: number
  private readonly idleMs: number
  private readonly inUseMs: number
  private readonly now: () => number
  private readonly acquire: typeof acquireGitSkillSource
  private readonly verifyAccess: typeof verifyGitSkillSourceAccess
  /** Acquisitions in flight per entry, so sources that share a repository and commit download it once. */
  private readonly inflight = new Map<string, Promise<{ entryDir: string; cached: boolean }>>()

  constructor(
    private readonly root: string,
    private readonly options: GitSkillSourceCacheOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024
    this.idleMs = options.idleMs ?? 24 * 60 * 60_000
    this.inUseMs = options.inUseMs ?? 60 * 60_000
    this.now = options.now ?? Date.now
    this.acquire = options.acquire ?? acquireGitSkillSource
    this.verifyAccess = options.verifyAccess ?? verifyGitSkillSourceAccess
  }

  /**
   * The source's directory for `entry` at `plannedCommit` (or at whatever its ref resolves to when
   * no commit is planned yet), from the cache when this agent already acquired that commit.
   */
  async resolve(
    entry: AgentSkillEntry,
    plannedCommit: string | undefined,
    opts: Omit<AcquireOptions, 'destination'>
  ): Promise<{ sourceDir: string; resolvedCommit: string; cached: boolean }> {
    const githubRepoId = entry.githubRepoId
    if (!githubRepoId) throw new Error('a cached Git skill source needs its repository id')
    // The same parse the acquisition applies: a GitHub /tree/<ref>/<path> source names its folder in the URL.
    const subDir = resolveBoundedGitSkillSource(entry).subDir
    const planned = plannedCommit?.toLowerCase()
    if (!planned || !COMMIT_SHA.test(planned)) {
      // No commit to key on until the ref is resolved: acquire, then cache under what it resolved to.
      const { entryDir, commit } = await this.download(entry, undefined, opts, githubRepoId)
      return { sourceDir: sourceDirIn(entryDir, subDir), resolvedCommit: commit, cached: false }
    }
    // Claimed before the first await, so two sources of this agent that share a repository and
    // commit — two folders of one collection — look it up and download it once, not twice.
    const key = this.entryDir(opts.agentId, githubRepoId, planned)
    const pending = this.inflight.get(key)
    if (pending) {
      const claimed = await pending
      return { sourceDir: sourceDirIn(claimed.entryDir, subDir), resolvedCommit: planned, cached: claimed.cached }
    }
    const claim = this.claimEntry(entry, planned, opts, githubRepoId)
    this.inflight.set(key, claim)
    try {
      const claimed = await claim
      return { sourceDir: sourceDirIn(claimed.entryDir, subDir), resolvedCommit: planned, cached: claimed.cached }
    } finally {
      this.inflight.delete(key)
    }
  }

  /** The entry for one planned commit: a hit whose access this agent re-proves, else a download. */
  private async claimEntry(
    entry: AgentSkillEntry,
    planned: string,
    opts: Omit<AcquireOptions, 'destination'>,
    githubRepoId: string
  ): Promise<{ entryDir: string; cached: boolean }> {
    const hit = await this.lookup(opts.agentId, githubRepoId, planned)
    if (hit) {
      const staging = await this.newStaging()
      try {
        // Throws, like an acquisition would, when the agent can no longer read the repository.
        await this.verifyAccess(entry, { ...opts, privateHome: join(staging, 'home') })
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
      return { entryDir: hit, cached: true }
    }
    const { entryDir, commit } = await this.download(entry, planned, opts, githubRepoId)
    if (commit !== planned) throw new Error('skill Git source did not resolve to its planned commit')
    return { entryDir, cached: false }
  }

  private async download(
    entry: AgentSkillEntry,
    planned: string | undefined,
    opts: Omit<AcquireOptions, 'destination'>,
    githubRepoId: string
  ): Promise<{ entryDir: string; commit: string }> {
    const staging = await this.newStaging()
    try {
      const acquired = await this.acquire(planned ? { ...entry, ref: planned } : entry, {
        ...opts,
        destination: staging
      })
      const commit = acquired.resolvedCommit.toLowerCase()
      if (!COMMIT_SHA.test(commit)) throw new Error('skill Git source resolved to an invalid commit')
      const entryDir = await this.publish(opts.agentId, githubRepoId, commit, join(staging, REPOSITORY_DIR))
      await this.prune()
      return { entryDir, commit }
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async newStaging(): Promise<string> {
    await fsp.mkdir(this.stagingRoot(), { recursive: true, mode: 0o700 })
    await fsp.chmod(this.root, 0o700).catch(() => undefined)
    return join(this.stagingRoot(), randomUUID())
  }

  /** Evict idle entries, then the least recently used beyond the byte budget; never one in use. */
  async prune(): Promise<void> {
    const entries = await this.entries()
    const now = this.now()
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of entries.sort((a, b) => a.usedAt - b.usedAt)) {
      const idle = now - entry.usedAt
      if (idle < this.inUseMs) continue
      if (idle <= this.idleMs && total <= this.maxBytes) continue
      await fsp.rm(entry.dir, { recursive: true, force: true }).catch((error: unknown) => {
        this.options.warn?.(`skills: could not evict cached Git source (${(error as Error).message})`)
      })
      total -= entry.bytes
    }
  }

  private stagingRoot(): string {
    return join(this.root, '.staging')
  }

  private entryDir(agentId: string, githubRepoId: string, commit: string): string {
    const key = createHash('sha256').update(`${agentId}\0${githubRepoId}\0${commit}`).digest('hex')
    return join(this.root, key)
  }

  private async lookup(agentId: string, githubRepoId: string, commit: string): Promise<string | undefined> {
    const dir = this.entryDir(agentId, githubRepoId, commit)
    try {
      const metadata = JSON.parse(await fsp.readFile(join(dir, METADATA_FILE), 'utf8')) as EntryMetadata
      if (
        metadata.version !== 1 ||
        metadata.agentId !== agentId ||
        metadata.githubRepoId !== githubRepoId ||
        metadata.commit !== commit
      ) {
        return undefined
      }
      const stat = await fsp.lstat(join(dir, REPOSITORY_DIR))
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
      // The entry's mtime is its last use: what eviction orders by.
      const at = new Date(this.now())
      await fsp.utimes(dir, at, at)
      return dir
    } catch {
      return undefined
    }
  }

  private async publish(agentId: string, githubRepoId: string, commit: string, repository: string): Promise<string> {
    const dir = this.entryDir(agentId, githubRepoId, commit)
    const temp = `${dir}.${randomUUID()}`
    try {
      await fsp.mkdir(temp, { mode: 0o700 })
      await fsp.rename(repository, join(temp, REPOSITORY_DIR))
      const metadata: EntryMetadata = { version: 1, agentId, githubRepoId, commit, bytes: await treeBytes(temp) }
      await fsp.writeFile(join(temp, METADATA_FILE), `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
      try {
        await fsp.rename(temp, dir)
      } catch (error) {
        // A concurrent preparation published the same commit first; its tree is the same tree.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        if (!(await this.lookup(agentId, githubRepoId, commit))) throw error
      }
      const at = new Date(this.now())
      await fsp.utimes(dir, at, at)
      return dir
    } finally {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async entries(): Promise<Array<{ dir: string; bytes: number; usedAt: number }>> {
    let names: string[]
    try {
      names = await fsp.readdir(this.root)
    } catch {
      return []
    }
    const out: Array<{ dir: string; bytes: number; usedAt: number }> = []
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const dir = join(this.root, name)
      try {
        const metadata = JSON.parse(await fsp.readFile(join(dir, METADATA_FILE), 'utf8')) as EntryMetadata
        out.push({ dir, bytes: metadata.bytes, usedAt: (await fsp.stat(dir)).mtimeMs })
      } catch {
        // Not an entry this cache wrote whole; leave it to a later pass rather than guess.
      }
    }
    return out
  }
}

function sourceDirIn(entryDir: string, subDir: string | undefined): string {
  return subDir ? join(entryDir, REPOSITORY_DIR, ...subDir.split('/')) : join(entryDir, REPOSITORY_DIR)
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await treeBytes(path)
    else if (entry.isFile()) total += (await fsp.lstat(path)).size
  }
  return total
}
