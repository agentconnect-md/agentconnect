// The anonymous github.com commit check for a public tracking skill ref, shared across agents (source-cache.md §5).
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import { MAX_RETRY_AFTER_MS } from '../codehost/rest-read.js'
import { parseResolvableRef } from '../codehost/ref-spec.js'
import { nameGitSkillRef, type GitSkillRefNaming, type NameGitSkillRefInput } from './git-skill-ref-name.js'
import {
  GitSkillCommitResolutionError,
  isPinnedGitSkillRef,
  resolveBoundedGitSkillSource,
  resolveGitSkillCommit,
  type GitSkillCommitResolution,
  type ResolveGitSkillCommitOptions
} from './skill-git-source.js'

const DEFAULT_TTL_MS = 60_000
const NAMING_RETRY_MS = 5 * 60_000
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
  /** The full ref the commit came from, once named. */
  ref?: string
  /** The commit a naming settled for (named or definitively unnamed); another commit names afresh. */
  namedFor?: string
  /** After a failed listing, the wall-clock ms before which no new listing is spent. */
  nameRetryAt?: number
  /** The commit whose naming last failed, so the warning is not repeated for it. */
  nameFailedFor?: string
}

/** A public tracking ref's answer: its commit, and the full ref it came from when that could be named. */
export interface TrackedSkillRef {
  commit: string
  ref?: string
}

export interface GitSkillRefTrackerOptions {
  /** Daemon-private directory the REST check may use as HOME. */
  stateRoot: string
  ttlMs?: number
  failureBaseMs?: number
  failureMaxMs?: number
  now?: () => number
  resolve?: (entry: AgentSkillEntry, opts: ResolveGitSkillCommitOptions) => Promise<GitSkillCommitResolution>
  /** Names the full ref behind a short or absent entry ref; defaults to a scoped anonymous `git ls-remote`. */
  nameRef?: (input: NameGitSkillRefInput) => Promise<GitSkillRefNaming>
  warn?: (message: string) => void
}

export class GitSkillRefTracker {
  private readonly cache = new Map<string, TrackedRef>()
  private readonly inFlight = new Map<string, Promise<TrackedSkillRef | null>>()
  private readonly namingInFlight = new Map<
    string,
    Promise<Pick<TrackedRef, 'ref' | 'namedFor' | 'nameRetryAt' | 'nameFailedFor'>>
  >()
  private readonly ttlMs: number
  private readonly failureBaseMs: number
  private readonly failureMaxMs: number
  private readonly now: () => number
  private readonly resolveCommit: NonNullable<GitSkillRefTrackerOptions['resolve']>
  private readonly nameRef: NonNullable<GitSkillRefTrackerOptions['nameRef']>
  private homeReady?: Promise<string>

  constructor(private readonly opts: GitSkillRefTrackerOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.failureBaseMs = opts.failureBaseMs ?? FAILURE_BASE_MS
    this.failureMaxMs = opts.failureMaxMs ?? FAILURE_MAX_MS
    this.now = opts.now ?? Date.now
    this.resolveCommit = opts.resolve ?? resolveGitSkillCommit
    this.nameRef = opts.nameRef ?? nameGitSkillRef
  }

  /** The commit a public tracking ref points at, or null when unknown, pinned, or the Source is credentialed. */
  async resolve(entry: AgentSkillEntry): Promise<string | null> {
    // Naming is left to resolveTracked, so a daemon that never keys the cache never spends the listing.
    return (await this.tracked(entry))?.commit ?? null
  }

  /** The commit and, when nameable, the full ref it came from; null exactly when {@link resolve} is. */
  async resolveTracked(entry: AgentSkillEntry): Promise<TrackedSkillRef | null> {
    const answer = await this.tracked(entry)
    if (!answer || answer.ref !== undefined) return answer
    const key = this.keyOf(entry)
    const row = this.cache.get(key)
    if (row?.namedFor === answer.commit || (row?.nameRetryAt ?? 0) > this.now()) return answer
    let naming = this.namingInFlight.get(key)
    if (!naming) {
      naming = this.named(entry, answer.commit, row).finally(() => this.namingInFlight.delete(key))
      this.namingInFlight.set(key, naming)
    }
    const named = await naming
    const current = this.cache.get(key)
    if (current?.commit === answer.commit) Object.assign(current, named)
    return { commit: answer.commit, ...(named.ref && named.namedFor === answer.commit ? { ref: named.ref } : {}) }
  }

  private async tracked(entry: AgentSkillEntry): Promise<TrackedSkillRef | null> {
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
  private served(entry: TrackedRef): TrackedSkillRef | null {
    if (entry.failures > 0 || entry.commit === undefined) return null
    return { commit: entry.commit, ...(entry.ref && entry.namedFor === entry.commit ? { ref: entry.ref } : {}) }
  }

  private keyOf(entry: AgentSkillEntry): string {
    const source = resolveBoundedGitSkillSource(entry)
    return `${entry.githubRepoId}\u0000${source.cloneUrl}\u0000${source.ref ?? 'HEAD'}`
  }

  private async refresh(
    key: string,
    entry: AgentSkillEntry,
    cached: TrackedRef | undefined
  ): Promise<TrackedSkillRef | null> {
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
          ? {
              commit: cached.commit,
              ...(cached.etag ? { etag: cached.etag } : {}),
              ...namingOf(cached),
              checkedAt: this.now(),
              failures: 0
            }
          : answer.status === 'resolved'
            ? {
                commit: answer.commit,
                ...(answer.etag ? { etag: answer.etag } : {}),
                ...(cached?.commit === answer.commit ? namingOf(cached) : {}),
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
        ...(cached ? namingOf(cached) : {}),
        checkedAt: this.now(),
        failures,
        retryAt: this.now() + wait
      }
      this.opts.warn?.(`skills: ${entry.name} ref check failed (${(error as Error).message})`)
    }
    this.cache.set(key, next)
    return this.served(next)
  }

  /** The full ref behind `commit`; unnamed when the listing disagrees with the commit, fails, or the name is ambiguous. */
  private async named(
    entry: AgentSkillEntry,
    commit: string,
    cached: TrackedRef | undefined
  ): Promise<Pick<TrackedRef, 'ref' | 'namedFor' | 'nameRetryAt' | 'nameFailedFor'>> {
    if (cached?.namedFor === commit) return { ...(cached.ref ? { ref: cached.ref } : {}), namedFor: commit }
    const source = resolveBoundedGitSkillSource(entry)
    const name = source.ref === 'HEAD' ? undefined : source.ref
    // A full name spelled in the entry is the ref itself.
    if (name?.startsWith('refs/')) {
      const spec = parseResolvableRef(name)
      return spec?.kind === 'branch' || spec?.kind === 'tag' ? { ref: name, namedFor: commit } : { namedFor: commit }
    }
    try {
      const naming = await this.nameRef({
        url: source.cloneUrl,
        ...(name !== undefined ? { name } : {}),
        privateHome: await this.privateHome()
      })
      if (naming.kind === 'unnamed') return { namedFor: commit }
      // The pod clones the planned commit through this ref, so a listing that saw another commit names nothing yet.
      return naming.commit === commit ? { ref: naming.ref, namedFor: commit } : { nameRetryAt: this.now() + this.ttlMs }
    } catch (error) {
      // Warned once per commit and retried after a pause, so an unreachable github.com is not a line per refresh.
      if (cached?.nameFailedFor !== commit)
        this.opts.warn?.(`skills: ${entry.name} ref naming failed (${(error as Error).message})`)
      return { nameRetryAt: this.now() + NAMING_RETRY_MS, nameFailedFor: commit }
    }
  }

  private privateHome(): Promise<string> {
    return (this.homeReady ??= (async () => {
      const home = join(this.opts.stateRoot, 'ref-check-home')
      await fsp.mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 })
      return home
    })())
  }
}

const namingOf = (row: TrackedRef): Pick<TrackedRef, 'ref' | 'namedFor' | 'nameRetryAt' | 'nameFailedFor'> => ({
  ...(row.ref ? { ref: row.ref } : {}),
  ...(row.namedFor ? { namedFor: row.namedFor } : {}),
  ...(row.nameRetryAt ? { nameRetryAt: row.nameRetryAt } : {}),
  ...(row.nameFailedFor ? { nameFailedFor: row.nameFailedFor } : {})
})
