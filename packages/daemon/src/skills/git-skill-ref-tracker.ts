// The anonymous github.com commit check for a public tracking skill ref, shared across agents (source-cache.md §5).
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import { MAX_RETRY_AFTER_MS } from '../codehost/rest-read.js'
import {
  GitSkillCommitResolutionError,
  isPinnedGitSkillRef,
  resolveBoundedGitSkillSource,
  resolveGitSkillCommit,
  type GitSkillCommitResolution,
  type ResolveGitSkillCommitOptions
} from './skill-git-source.js'

const DEFAULT_TTL_MS = 60_000
const FAILURE_BASE_MS = 5_000
const FAILURE_MAX_MS = 60_000
/** No credential ever rides this check, so no agent's identity does either. */
const ANONYMOUS_ASKER = 'anonymous-skill-ref-check'

interface TrackedRef {
  /** The last commit a 200 named; kept through failures only so a later 304 can revalidate it. */
  commit?: string
  etag?: string
  checkedAt: number
  failures: number
  /** While failing, the wall-clock ms before which no new call is spent. */
  retryAt?: number
}

export interface GitSkillRefTrackerOptions {
  /** Daemon-private directory the REST check may use as HOME. */
  stateRoot: string
  ttlMs?: number
  failureBaseMs?: number
  failureMaxMs?: number
  now?: () => number
  resolve?: (entry: AgentSkillEntry, opts: ResolveGitSkillCommitOptions) => Promise<GitSkillCommitResolution>
  warn?: (message: string) => void
}

export class GitSkillRefTracker {
  private readonly cache = new Map<string, TrackedRef>()
  private readonly inFlight = new Map<string, Promise<string | null>>()
  private readonly ttlMs: number
  private readonly failureBaseMs: number
  private readonly failureMaxMs: number
  private readonly now: () => number
  private readonly resolveCommit: NonNullable<GitSkillRefTrackerOptions['resolve']>
  private homeReady?: Promise<string>

  constructor(private readonly opts: GitSkillRefTrackerOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.failureBaseMs = opts.failureBaseMs ?? FAILURE_BASE_MS
    this.failureMaxMs = opts.failureMaxMs ?? FAILURE_MAX_MS
    this.now = opts.now ?? Date.now
    this.resolveCommit = opts.resolve ?? resolveGitSkillCommit
  }

  /** The commit a public tracking ref points at, or null when unknown, pinned, or the Source is credentialed. */
  async resolve(entry: AgentSkillEntry): Promise<string | null> {
    // A credentialed Source is never answered here: its answer would be shared across agents.
    if (entry.private === true || isPinnedGitSkillRef(entry)) return null
    const key = this.keyOf(entry)
    const cached = this.cache.get(key)
    if (cached && this.isFresh(cached)) return this.served(cached)
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const pending = this.refresh(key, entry, cached).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, pending)
    return pending
  }

  private isFresh(entry: TrackedRef): boolean {
    if (entry.failures > 0) return this.now() < (entry.retryAt ?? 0)
    return this.now() - entry.checkedAt < this.ttlMs
  }

  /** A failure replaces any earlier success at once: unknown, so the installed commit stands. */
  private served(entry: TrackedRef): string | null {
    return entry.failures > 0 ? null : (entry.commit ?? null)
  }

  private keyOf(entry: AgentSkillEntry): string {
    const source = resolveBoundedGitSkillSource(entry)
    return `${entry.githubRepoId}\u0000${source.cloneUrl}\u0000${source.ref ?? 'HEAD'}`
  }

  private async refresh(key: string, entry: AgentSkillEntry, cached: TrackedRef | undefined): Promise<string | null> {
    let next: TrackedRef
    try {
      const answer = await this.resolveCommit(entry, {
        agentId: ANONYMOUS_ASKER,
        useGitCredential: false,
        privateHome: await this.privateHome(),
        ...(cached?.etag && cached.commit ? { etag: cached.etag } : {})
      })
      next =
        answer.status === 'unchanged' && cached?.commit
          ? { commit: cached.commit, ...(cached.etag ? { etag: cached.etag } : {}), checkedAt: this.now(), failures: 0 }
          : answer.status === 'resolved'
            ? {
                commit: answer.commit,
                ...(answer.etag ? { etag: answer.etag } : {}),
                checkedAt: this.now(),
                failures: 0
              }
            : { checkedAt: this.now(), failures: 0 }
    } catch (error) {
      const failures = (cached?.failures ?? 0) + 1
      const backoff = Math.min(this.failureMaxMs, this.failureBaseMs * 2 ** (failures - 1))
      const asked = error instanceof GitSkillCommitResolutionError ? (error.retryAfterMs ?? 0) : 0
      const wait = Math.max(backoff, Math.min(asked, MAX_RETRY_AFTER_MS))
      next = {
        ...(cached?.commit ? { commit: cached.commit } : {}),
        ...(cached?.etag ? { etag: cached.etag } : {}),
        checkedAt: this.now(),
        failures,
        retryAt: this.now() + wait
      }
      this.opts.warn?.(`skills: ${entry.name} ref check failed (${(error as Error).message})`)
    }
    this.cache.set(key, next)
    return this.served(next)
  }

  private privateHome(): Promise<string> {
    return (this.homeReady ??= (async () => {
      const home = join(this.opts.stateRoot, 'ref-check-home')
      await fsp.mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 })
      return home
    })())
  }
}
