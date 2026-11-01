// Resolves the deployment channel's (`DAEMON_DIST_TAG`) latest daemon version: the console hint and the auto-upgrade announcement (daemon-auto-upgrade.md §4.1).
import type { Clock, TimerHandle } from '../domain/clock.js'

const NPM_PKG = '@agentconnect.md/daemon'
// The lightweight dist-tags document (a `{ tag: version }` map) rather than the
// full packument — a few bytes, cache-friendly, and all we need.
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${encodeURIComponent(NPM_PKG)}/dist-tags`
const STABLE_TTL_MS = 30 * 60_000 // 30 min — stable daemon releases are infrequent
const RC_TTL_MS = 2 * 60_000 // RC publishes are frequent; surface them promptly in the console
const FETCH_TIMEOUT_MS = 4_000
// Background refresh cadence, so a release reaches daemons without a console read.
const STABLE_REFRESH_MS = 5 * 60_000
const RC_REFRESH_MS = 2 * 60_000

// Same shape as the github `FetchLike` seam: the real `fetch` is assignable to it,
// and tests pass a stub — so no real npm call fires under Vitest.
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface DaemonRelease {
  /** The npm dist-tag the deployment pins (e.g. `latest`, `rc`). */
  channel: string
  /** Latest published version for that channel; null until resolved / on failure. */
  latestVersion: string | null
  /** Every distinct version behind a published dist-tag (the console upgrade picker's
   *  options), newest-first. Empty until the first fetch lands / on failure. */
  availableVersions: string[]
}

/** The announced release: the channel and the exact version behind it. */
export interface AnnouncedRelease {
  channel: string
  version: string
}

export type ReleaseListener = (release: AnnouncedRelease) => void

export class DaemonReleaseResolver {
  private version: string | null = null
  /** The full dist-tags map from the last successful fetch (tag → version). */
  private tags: Record<string, string> = {}
  /** Last refresh attempt (success or failure); 0 ⇒ never attempted. */
  private lastAttemptMs = 0
  private inFlight: Promise<void> | null = null
  private readonly listeners = new Set<ReleaseListener>()
  private timer: TimerHandle | undefined
  private stopped = true

  constructor(
    private readonly channel: string,
    private readonly clock: Clock,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly ttlMs: number = channel === 'rc' ? RC_TTL_MS : STABLE_TTL_MS,
    private readonly refreshMs: number = channel === 'rc' ? RC_REFRESH_MS : STABLE_REFRESH_MS
  ) {}

  /** The current best-known release for the channel; refreshes in the background when stale and never awaits. */
  get(): DaemonRelease {
    const now = this.clock.now()
    if (!this.inFlight && (this.lastAttemptMs === 0 || now - this.lastAttemptMs > this.ttlMs)) {
      void this.refresh(now)
    }
    return { channel: this.channel, latestVersion: this.version, availableVersions: this.availableVersions() }
  }

  /** The release to announce to daemons, or null before the first successful resolution. */
  current(): AnnouncedRelease | null {
    return this.version ? { channel: this.channel, version: this.version } : null
  }

  /** Subscribe to channel-version changes (the first resolution included); returns the unsubscribe. */
  onChange(listener: ReleaseListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Arm the Clock-driven background refresh, starting with an immediate one. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.poll()
  }

  /** Cancel the background refresh so no timer outlives the process. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** One background round: refresh (joining a lazy one in flight), then re-arm. Exposed for tests. */
  async poll(): Promise<void> {
    this.timer = undefined
    await (this.inFlight ?? this.refresh(this.clock.now()))
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.poll(), this.refreshMs)
  }

  /** Distinct versions behind the published dist-tags, channel version first, then the
   *  rest in a stable descending order — the console's upgrade-target options.
   *
   *  Prereleases are gated by the channel: an `rc` deployment may upgrade to both rc
   *  and release versions, but any other (stable) channel offers release versions
   *  only — never surfacing an rc as an upgrade target. A version is a prerelease iff
   *  its semver carries a `-` suffix (the same test `release.config.js` uses to route
   *  a publish to the `rc` vs `latest` dist-tag). */
  private availableVersions(): string[] {
    const includePrerelease = this.channel === 'rc'
    const keep = (v: string) => includePrerelease || !v.includes('-')
    const seen = new Set<string>()
    const out: string[] = []
    // Defensive: on a stable channel `this.version` is the `latest` release, which is
    // never a prerelease — but guard it anyway so the gate holds regardless.
    if (this.version && keep(this.version)) {
      seen.add(this.version)
      out.push(this.version)
    }
    for (const v of Object.values(this.tags).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      if (!seen.has(v) && keep(v)) {
        seen.add(v)
        out.push(v)
      }
    }
    return out
  }

  private refresh(startedMs: number): Promise<void> {
    this.inFlight = this.fetchTags(startedMs).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async fetchTags(startedMs: number): Promise<void> {
    this.lastAttemptMs = startedMs
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(DIST_TAGS_URL, {
        headers: { accept: 'application/json' },
        signal: ac.signal
      })
      if (!res.ok) return
      const tags = (await res.json()) as Record<string, unknown>
      // The full map feeds the upgrade picker; the channel's entry is the hint and the announcement.
      this.tags = Object.fromEntries(
        Object.entries(tags).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
      )
      const v = this.tags[this.channel]
      if (v && v !== this.version) {
        this.version = v
        this.emit({ channel: this.channel, version: v })
      }
    } catch {
      // Best-effort: keep the last good value (or null) and retry after the TTL.
    } finally {
      clearTimeout(timer)
    }
  }

  private emit(release: AnnouncedRelease): void {
    for (const listener of this.listeners) {
      try {
        listener(release)
      } catch {
        // A failing listener must not stop the others or the refresh loop.
      }
    }
  }
}
