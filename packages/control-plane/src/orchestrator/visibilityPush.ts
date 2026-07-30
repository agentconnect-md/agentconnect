/**
 * Session-visibility gate push (docs/designs/session-visibility.md §5.1).
 *
 * Console read gates alone do not contain private content: managed memory is
 * agent-scoped and shared across users, so a private turn distilled into agent
 * memory would resurface to anyone who can view the agent. The daemon therefore
 * runs a per-session capture gate, and the CP — the authority on effective
 * visibility (§4.3 changes, §4.5 settlements and cascades) — pushes the single
 * privacy bit that drives it. This is control signaling, not content.
 *
 * Durability is the whole design problem. The WS correlator retransmits only
 * within one live connection and rejects everything on socket close, so a live
 * push alone would leave a change unapplied across a reconnect. Two mechanisms
 * close that:
 *
 *  - **`visibilityRev`** — a durable per-session counter bumped in the same
 *    transaction as every visibility change. It orders competing deliveries, so
 *    at-least-once is safe: the daemon acks a stale revision `superseded`
 *    instead of erroring, and `visibilityAckedRev` records what actually landed.
 *  - **The register-time snapshot** (`replayTo`) — the full current gate set for
 *    a (re)connecting daemon's sessions. This is load-bearing, not a nicety: it
 *    is what makes a push lost to a dropped socket eventually converge.
 *
 * Both are best-effort at the moment of the call. A daemon that is offline,
 * unplaced, or too old to know the frame simply does not ack — the §4.3 endpoint
 * reports the tighten as `pending` until it does, and the daemon meanwhile fails
 * closed (unknown gate state ⇒ capture excluded).
 */
import { SESSION_VISIBILITY_FEATURE, type SessionVisibilityPush } from '@agentconnect.md/protocol'
import type { AgentRepo, SessionMetaRecord, SessionRepo } from '../persistence/ports.js'
import { SessionId, type DaemonId } from '../domain/ids.js'
import type { ConnectionRegistry } from '../ws/registry.js'
import { NoConnection, type ControlSender } from './outbound.js'

/** How many sessions one register-time snapshot covers, newest-active first.
 *  Older rows converge to the daemon's fail-closed default (capture excluded),
 *  which under-captures rather than leaking. */
const SNAPSHOT_LIMIT = 2000
/** Entries per snapshot frame. The schema caps at 1000; stay well under the
 *  256 KiB frame ceiling. */
const SNAPSHOT_CHUNK = 500

export interface VisibilityPushDeps {
  repos: { session: SessionRepo; agent: AgentRepo }
  control: ControlSender
  connReg: ConnectionRegistry
  log?: { warn(obj: unknown, msg?: string): void }
}

function toPush(s: SessionMetaRecord): SessionVisibilityPush {
  return { sessionId: s.id, visibility: s.visibility, visibilityRev: s.visibilityRev }
}

export class SessionVisibilityPushService {
  constructor(private readonly deps: VisibilityPushDeps) {}

  /**
   * A daemon can only be pushed to if it is connected AND advertises the
   * feature. An older daemon would fail to decode the frame and NAK
   * `UNKNOWN_FRAME`, which the correlator surfaces as a rejection — feature
   * gating keeps that off the §4.3 endpoint's pending/applied bookkeeping.
   */
  private supports(daemonId: string): boolean {
    const c = this.deps.connReg.get(daemonId)
    return c?.capabilities?.features?.includes(SESSION_VISIBILITY_FEATURE) ?? false
  }

  /**
   * Push the current gate state for these sessions to whichever daemons run
   * them, recording each ack. Descendants of a cascade legitimately live on
   * different daemons, so placement is resolved per row — via the AGENT (1 agent
   * : 1 machine), not `SessionMeta.daemonId`, which is provenance and may lag a
   * move.
   */
  async notifySessions(sessions: SessionMetaRecord[]): Promise<void> {
    const byAgent = new Map<string, string | null>()
    for (const s of sessions) {
      if (!byAgent.has(s.agentId)) {
        const agent = await this.deps.repos.agent.get(s.agentId)
        byAgent.set(s.agentId, agent?.daemonId ?? null)
      }
      const daemonId = byAgent.get(s.agentId)
      if (!daemonId || !this.supports(daemonId)) continue
      try {
        const ok = await this.deps.control.sessionVisibility(daemonId, toPush(s))
        await this.deps.repos.session.recordVisibilityAck(SessionId(ok.sessionId), ok.visibilityRev)
      } catch (err) {
        if (err instanceof NoConnection) continue // offline → the register snapshot carries it
        this.deps.log?.warn(
          { sessionId: s.id, daemonId, err: (err as Error).message },
          'session visibility push failed'
        )
      }
    }
  }

  /**
   * Replay the whole gate set to a (re)connecting daemon. Idempotent by
   * revision, so it runs on EVERY register: reconnect is convergence, not
   * replay. Failure is swallowed — the next register tries again.
   */
  async replayTo(daemonId: DaemonId): Promise<void> {
    if (!this.supports(daemonId)) return
    const snapshot = await this.deps.repos.session.visibilitySnapshotForDaemon(daemonId, SNAPSHOT_LIMIT)
    if (snapshot.length === 0) return
    // The snapshot is bounded, but ordered unacknowledged-first, so a change made
    // while this daemon was offline is always in it. If the cap still bit, say so
    // rather than let a truncated replay read as full convergence.
    if (snapshot.length === SNAPSHOT_LIMIT) {
      const unacked = await this.deps.repos.session.countUnackedVisibility(daemonId)
      if (unacked > SNAPSHOT_LIMIT) {
        this.deps.log?.warn(
          { daemonId, unacked, limit: SNAPSHOT_LIMIT },
          'session visibility snapshot truncated: unacknowledged gates exceed the replay cap'
        )
      }
    }
    for (let i = 0; i < snapshot.length; i += SNAPSHOT_CHUNK) {
      const chunk = snapshot.slice(i, i + SNAPSHOT_CHUNK)
      try {
        const ack = await this.deps.control.sessionVisibilitySnapshot(daemonId, chunk)
        if (!ack.ok) {
          this.deps.log?.warn({ daemonId, reason: ack.reason }, 'session visibility snapshot rejected')
          return
        }
        for (const entry of chunk) {
          await this.deps.repos.session.recordVisibilityAck(entry.sessionId, entry.visibilityRev)
        }
      } catch (err) {
        if (err instanceof NoConnection) return
        this.deps.log?.warn({ daemonId, err: (err as Error).message }, 'session visibility snapshot failed')
        return
      }
    }
  }

  /**
   * Has every affected daemon applied this change (§5.1)? The memory boundary
   * takes effect at ACK, so the §4.3 endpoint reports `pending` until then.
   *
   * Only an UNPLACED agent counts as vacuously applied: nothing is running it,
   * so nothing can capture. A placed daemon that is merely offline is still
   * `pending` — daemons keep serving established sessions while the CP is down
   * (that graceful degradation is the whole point of the edge), so its gate may
   * genuinely still be `org`. Claiming `applied` there would promise a boundary
   * that is not in force; it converges when the daemon reconnects and replays.
   */
  async isApplied(sessions: SessionMetaRecord[]): Promise<boolean> {
    for (const s of sessions) {
      if (s.visibilityAckedRev >= s.visibilityRev) continue
      const agent = await this.deps.repos.agent.get(s.agentId)
      if (!agent?.daemonId) continue // unplaced: no daemon runs it, nothing to stop
      return false
    }
    return true
  }
}

/** How much of a subtree one cutover-state read will consider. Beyond this the
 *  answer stays `pending` rather than silently ignoring the tail. */
const SUBTREE_LIMIT = 500

/**
 * The §4.3 cutover state for a session AND everything a tightening cascade would
 * have rewritten under it. The root's daemon acking first must not flip the UI to
 * `applied` while a descendant's daemon is still behind — the descendant holds
 * text copied from the root, and its capture is exactly what the change was for.
 */
export async function visibilityStateOf(
  push: SessionVisibilityPushService | undefined,
  repos: { session: SessionRepo },
  sessionIds: SessionId[]
): Promise<'pending' | 'applied'> {
  if (!push) return 'applied'
  const rows = new Map<string, SessionMetaRecord>()
  for (const id of sessionIds) {
    for (const row of await repos.session.visibilitySubtree(id, SUBTREE_LIMIT)) rows.set(row.id, row)
  }
  return (await push.isApplied([...rows.values()])) ? 'applied' : 'pending'
}
