/**
 * GithubInstallationDoorbell — applies the relay's `rc/github-installation`
 * pokes (webhook-triggers-and-github-events.md, decision 11: installation doorbell).
 *
 * The poke is a cache-invalidation signal, never a fact source: on a known
 * installation the CP re-pulls `GET /app/installations/{id}` with its App JWT
 * and writes what GITHUB says (200 ⇒ upsert under the EXISTING claim's org;
 * 404/410 ⇒ markRevoked), then recompiles that org's github hooks so the relay
 * pool's `installationIds` gates converge. An installation with no org claim
 * yet is ignored — claiming stays with the setup callback / manual Sync.
 *
 * Throttling: per-installation single-flight + a short cooldown, so an event
 * storm (bulk repo grants fan out one event per change) coalesces into one
 * GitHub read. Crucially the throttle DEFERS instead of dropping: a poke that
 * lands mid-pull or mid-cooldown schedules exactly one trailing re-pull, so a
 * state flip whose only event arrives inside the window (suspend→unsuspend is
 * a single `unsuspend` delivery — GitHub never re-sends it) still converges.
 * A silently dropped trailing poke would leave the org's github hooks evicted
 * until a manual Sync.
 */
import type { RcGithubInstallation } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type { GithubInstallationFacts, GithubInstallationRepo } from '../persistence/ports.js'

/** Default post-pull cooldown per installation. */
const COOLDOWN_MS = 30_000
/** lastPull map bound (daemon dedup-map precedent — flush, never grow unbounded). */
const MAX_TRACKED = 10_000

export interface DoorbellLog {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface InstallationDoorbellDeps {
  github: { pullInstallation(installationId: bigint): Promise<GithubInstallationFacts | null> }
  installations: Pick<
    GithubInstallationRepo,
    'getByInstallationId' | 'upsertFromGithub' | 'markRevokedByInstallationId'
  >
  /** Recompile + rebroadcast the org's github hooks after the pull lands. */
  recompileOrg: (orgId: OrgId) => Promise<void>
  /** Invalidate purpose-token caches and wake durable reporters after any
   * installation permission/lifecycle fact changes. */
  onFactsChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  clock: Clock
  log: DoorbellLog
  cooldownMs?: number
}

export class GithubInstallationDoorbell {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly lastPullMs = new Map<string, number>()
  /** One scheduled trailing re-pull per installation (poke inside the cooldown). */
  private readonly trailing = new Map<string, TimerHandle>()
  /** Installations poked while their pull was already past the GitHub GET. */
  private readonly pokedMidPull = new Set<string>()
  private readonly cooldownMs: number
  private stopped = false

  constructor(private readonly deps: InstallationDoorbellDeps) {
    this.cooldownMs = deps.cooldownMs ?? COOLDOWN_MS
  }

  /**
   * Fire-and-forget entry (the WS handler never awaits GitHub). Coalesces onto
   * an in-flight pull (re-pulling once it lands — the GET may already have
   * read pre-flip state) and DEFERS inside the cooldown window rather than
   * dropping: GitHub sends most installation transitions exactly once.
   */
  poke(m: RcGithubInstallation): void {
    if (this.stopped) return
    let id: bigint
    try {
      id = BigInt(m.installationId)
    } catch {
      this.deps.log.debug({ installationId: m.installationId }, 'doorbell: unparseable installation id — ignored')
      return
    }
    const key = id.toString()
    if (this.inflight.has(key)) {
      // The running pull's GET may predate whatever this poke reports — run
      // one more pull after it completes (the completion handler re-pokes,
      // which then defers through the cooldown).
      this.pokedMidPull.add(key)
      return
    }
    const last = this.lastPullMs.get(key)
    const waitMs = last === undefined ? 0 : this.cooldownMs - (this.deps.clock.now() - last)
    if (waitMs > 0) {
      if (!this.trailing.has(key)) {
        this.deps.log.debug({ installationId: key, action: m.action }, 'doorbell: inside cooldown — deferred')
        this.trailing.set(
          key,
          this.deps.clock.setTimeout(() => {
            this.trailing.delete(key)
            this.poke({ installationId: key, action: `${m.action}(deferred)` })
          }, waitMs)
        )
      }
      return
    }
    const run = this.pull(id, m.action).finally(() => {
      if (this.lastPullMs.size >= MAX_TRACKED) this.lastPullMs.clear()
      this.lastPullMs.set(key, this.deps.clock.now())
      this.inflight.delete(key)
      if (this.pokedMidPull.delete(key)) {
        this.poke({ installationId: key, action: 'coalesced' })
      }
    })
    this.inflight.set(key, run)
  }

  /** Cancel scheduled trailing pulls (shutdown; no timer outlives the process). */
  stop(): void {
    this.stopped = true
    for (const timer of this.trailing.values()) this.deps.clock.clearTimeout(timer)
    this.trailing.clear()
  }

  /** Await quiescence — used by tests and graceful shutdown. */
  async settle(): Promise<void> {
    await Promise.all([...this.inflight.values()])
  }

  private async pull(installationId: bigint, action: string): Promise<void> {
    const key = installationId.toString()
    try {
      const row = await this.deps.installations.getByInstallationId(installationId)
      if (!row) {
        // No org claim — the poke can't be attributed; claiming is the setup
        // callback's / Sync's job (never write from an unclaimed event).
        this.deps.log.debug({ installationId: key, action }, 'doorbell: unknown installation — ignored')
        return
      }
      const facts = await this.deps.github.pullInstallation(installationId)
      if (facts) {
        // The existing claim's org is authoritative — a doorbell never moves one.
        await this.deps.installations.upsertFromGithub(row.orgId, facts)
      } else {
        await this.deps.installations.markRevokedByInstallationId(installationId)
      }
      await this.deps.onFactsChanged?.(installationId, row.orgId)
      await this.deps.recompileOrg(row.orgId)
      this.deps.log.info(
        { installationId: key, action, orgId: row.orgId, revoked: !facts },
        'doorbell: installation re-pulled, org hooks recompiled'
      )
    } catch (err) {
      // GitHub 5xx / DB blip: swallow — the WS layer must never see this, and
      // the next poke (or Sync / mint-failure fallback) retries.
      this.deps.log.warn({ installationId: key, action, err }, 'doorbell: pull failed — skipped')
    }
  }
}
