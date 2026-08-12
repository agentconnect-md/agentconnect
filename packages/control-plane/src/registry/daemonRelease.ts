/**
 * `DaemonReleaseResolver` — resolves "the latest daemon version published in the
 * deployment's channel" so the console can flag daemons that are behind.
 *
 * A "channel" is the npm **dist-tag** the deployment pins via `DAEMON_DIST_TAG`
 * (default `latest`; the test CP uses `rc`) — the same tag baked into the
 * onboarding `npx @agentconnect.md/daemon@<tag> …` command. Every daemon in the
 * deployment therefore compares its running `agentVersion` against one value:
 * `dist-tags[<channel>]` for `@agentconnect.md/daemon`.
 *
 * Best-effort + non-blocking. `get()` never awaits the network: it returns the
 * cached value immediately and kicks off a background refresh when the cache is
 * empty or older than the TTL. A cold start (or an offline CP / npm hiccup)
 * returns `latestVersion: null`, and the console simply shows no upgrade hint
 * until the first fetch lands. `fetchImpl` + `Clock` are injected so unit tests
 * run with zero real I/O.
 */
import type { Clock } from '../domain/clock.js'

const NPM_PKG = '@agentconnect.md/daemon'
// The lightweight dist-tags document (a `{ tag: version }` map) rather than the
// full packument — a few bytes, cache-friendly, and all we need.
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${encodeURIComponent(NPM_PKG)}/dist-tags`
const STABLE_TTL_MS = 30 * 60_000 // 30 min — stable daemon releases are infrequent
const RC_TTL_MS = 2 * 60_000 // RC publishes are frequent; surface them promptly in the console
const FETCH_TIMEOUT_MS = 4_000

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

export class DaemonReleaseResolver {
  private version: string | null = null
  /** The full dist-tags map from the last successful fetch (tag → version). */
  private tags: Record<string, string> = {}
  /** Last refresh attempt (success OR failure); gates re-fetch so a down npm
   *  isn't hammered on every `GET /daemons`. 0 ⇒ never attempted (fetch on first read). */
  private lastAttemptMs = 0
  private inFlight = false

  constructor(
    private readonly channel: string,
    private readonly clock: Clock,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly ttlMs: number = channel === 'rc' ? RC_TTL_MS : STABLE_TTL_MS
  ) {}

  /** The current best-known release for the channel. Triggers a background
   *  refresh when stale; always returns synchronously. */
  get(): DaemonRelease {
    const now = this.clock.now()
    if (!this.inFlight && (this.lastAttemptMs === 0 || now - this.lastAttemptMs > this.ttlMs)) {
      void this.refresh(now)
    }
    return { channel: this.channel, latestVersion: this.version, availableVersions: this.availableVersions() }
  }

  /**
   * Await a refresh attempt, then report the best-known release. `get()` deliberately
   * never blocks because it serves a request; a one-shot boot task has nobody waiting on
   * it and everything to lose from reading an empty cache, so it uses this instead. Still
   * best-effort: a failed fetch resolves to whatever was already known (possibly null).
   */
  async resolve(): Promise<DaemonRelease> {
    const now = this.clock.now()
    if (!this.inFlight && (this.lastAttemptMs === 0 || now - this.lastAttemptMs > this.ttlMs)) {
      await this.refresh(now)
    }
    return { channel: this.channel, latestVersion: this.version, availableVersions: this.availableVersions() }
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

  private async refresh(startedMs: number): Promise<void> {
    this.inFlight = true
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
      // Keep the full map (string values only) for the upgrade picker, and pull the
      // deployment channel's version out of it for the "update available" hint.
      this.tags = Object.fromEntries(
        Object.entries(tags).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
      )
      const v = this.tags[this.channel]
      if (v) this.version = v
    } catch {
      // Best-effort: keep the last good value (or null) and retry after the TTL.
    } finally {
      clearTimeout(timer)
      this.inFlight = false
    }
  }
}
