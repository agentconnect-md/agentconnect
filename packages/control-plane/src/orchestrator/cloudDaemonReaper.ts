/**
 * `CloudDaemonReaper` (agentconnect-org-operator.md §"The cloud daemon, which serves every
 * org") — retires the daemon rows replaced cloud Pods leave behind.
 *
 * A cloud member is bound to its reviewed Pod UID, so a replacement Pod gets a NEW daemon
 * record and the old one lingers: org-less, never reachable again, and visible in every
 * organization's fleet because install-wide infrastructure is shared. Nothing else can clear
 * them — no org owns the row, so `DELETE /daemons/:id` cannot name it.
 *
 * Liveness is judged by `lastSeenAt`, not by this process's connection index: with several
 * control-plane replicas a member's socket may be held by a peer, and only the heartbeat
 * write is common ground. A member connected HERE is skipped as well, which costs nothing
 * and covers the row whose heartbeat write is lagging.
 *
 * Clock-driven via a self-rescheduling `setTimeout` (like {@link RelaySweeper}) so tests
 * advance a `FakeClock`; armed by the container's `startBackground()`, never in tests.
 * Every replica running it is fine — the delete is idempotent and fenced to the org-less
 * cloud shape, so a row another replica just retired reads as "no longer retired".
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { DaemonId } from '../domain/ids.js'
import type { DaemonLiveness } from '../ports.js'
import type { DaemonRepo } from '../persistence/ports.js'

/** How often the sweep runs. */
export const CLOUD_DAEMON_REAP_INTERVAL_MS = 5 * 60_000

/**
 * How long a cloud member must go unheard-from before its row is retired. Two orders of
 * magnitude past the watchdog's freeze threshold (missed beats × heartbeat): by then its
 * sessions have long been rebalanced, and the window is what keeps a network partition from
 * deleting the record of a Pod that is still running.
 */
export const CLOUD_DAEMON_REAP_AFTER_MS = 15 * 60_000

/** Optional structured log sink (the Fastify logger in prod; omitted in tests). */
export interface CloudDaemonReaperLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface CloudDaemonReaperConfig {
  /** Silence after which a member's row is retired. */
  retireAfterMs: number
  /** How often the sweep runs. */
  intervalMs: number
}

export class CloudDaemonReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly daemons: Pick<DaemonRepo, 'findRetiredCloudMembers'>,
    /** The full detach sequence for one member (`http/daemon-removal.ts`); false ⇒ not
     *  retired after all (a reconnect, or a peer replica got there first). */
    private readonly retire: (daemonId: DaemonId) => Promise<boolean>,
    private readonly liveness: DaemonLiveness,
    private readonly clock: Clock,
    private readonly cfg: CloudDaemonReaperConfig,
    private readonly log?: CloudDaemonReaperLog
  ) {}

  /** Arm the periodic sweep. Idempotent — a second call re-arms from now. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  /** Cancel the loop — call on shutdown so no timer outlives the process. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  /**
   * One sweep. Members are retired one at a time: each carries a cascade plus a
   * collaboration push, and a failure on one must not cost the rest of the batch. Errors
   * are logged and swallowed — a transient DB failure waits for the next tick rather than
   * killing the loop. Exposed for tests (call directly).
   */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const cutoff = new Date(this.clock.now() - this.cfg.retireAfterMs)
      const retired = await this.daemons.findRetiredCloudMembers(cutoff)
      let removed = 0
      for (const member of retired) {
        if (this.stopped) break
        // Connected here despite a stale `lastSeenAt` — leave it to the heartbeat.
        if (this.liveness.get(member.id)) continue
        try {
          if (await this.retire(member.id)) removed++
        } catch (err) {
          this.log?.warn({ err, daemonId: member.id }, 'cloud-daemon-reaper: retiring one member failed')
        }
      }
      if (removed > 0) {
        this.log?.info(
          { removed, considered: retired.length, cutoff: cutoff.toISOString() },
          'cloud-daemon-reaper: retired cloud members whose Pods are gone'
        )
      }
    } catch (err) {
      this.log?.error({ err }, 'cloud-daemon-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
