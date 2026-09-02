/**
 * `ConnectionRegistry` (design §4.3) — the derived in-memory index the
 * orchestrator queries to place sessions and the watchdog walks to find stale
 * daemons.
 *
 * Authoritative routing lives in C6 (the `assignment` table); this is the hot
 * lookup layer rebuilt from `auth`/`register`/`heartbeat`. The map key for a
 * session is the canonical `sessionKeyStr` (`domain/sessionKey.ts`).
 *
 * The `conn` reference is typed against the minimal {@link ConnChannel} firewall
 * (not the concrete `DaemonConnection`) so this module has no cycle with
 * `ws/connection.ts`.
 */
import type { ControlExt, RegisterReq } from '@agentconnect.md/protocol'
import { EventEmitter, once } from 'node:events'
import { sessionKeyStr, type SessionKey } from '../domain/sessionKey.js'
import type { RequestOpts } from './correlator.js'

/** Lifecycle states (protocol §2.1). */
export type LifecycleState = 'CONNECTING' | 'AUTHENTICATING' | 'REGISTERING' | 'READY' | 'DRAINING' | 'CLOSED'

/**
 * The minimal channel the registry/orchestrator holds — the `DaemonChannel`
 * firewall (design §2.3). C3 issues fenced control via `request`/`send` with no
 * knowledge that a WebSocket exists; tests inject a stub-backed connection.
 */
export interface ConnChannel {
  readonly daemonId: string
  /** Issue a fenced REQ and await its correlated REP. */
  request<TReply = unknown>(
    type: string,
    payload: unknown,
    ext?: ControlExt,
    opts?: RequestOpts,
    orgId?: string
  ): Promise<TReply>
  /** Fire-and-forget EVT (C→D). */
  send(type: string, payload: unknown, ext?: ControlExt, orgId?: string): void
  close(code: number, reason: string): void
}

export interface DaemonConnState {
  daemonId: string
  /** Null means the install-wide connection requires org context per scoped frame. */
  orgId?: string | null
  conn: ConnChannel
  sessionEpoch: number // current fencing epoch (bumped each auth)
  state: LifecycleState
  capabilities?: RegisterReq['capabilities']
  maxAgents: number
  load: { cpu: number; mem: number; agents: number }
  health: 'ok' | 'degraded'
  lastBeatAt: number // clock.now() of last heartbeat OR pong
  reachable: boolean
  assignments: Set<string> // sessionKeyStr owned by this daemon
  launches: Map<string, { launchId: string; acpSessionId?: string; runtime: string }> // agentId → launch
  orgByAgent?: Map<string, string>
  orgByIntegration?: Map<string, string>
  orgByCron?: Map<string, string>
  orgByMcpServer?: Map<string, string>
  orgByMemoryConnection?: Map<string, string>
}

/** A request was dispatched, but its daemon connection closed before a reply. */
export class ConnectionClosed extends Error {
  constructor() {
    super('connection closed')
    this.name = 'ConnectionClosed'
  }
}

export class ConnectionRegistry {
  private byDaemon = new Map<string, DaemonConnState>()
  private ownerByKey = new Map<string, string>() // sessionKeyStr → daemonId
  private readonly readyEvents = new EventEmitter().setMaxListeners(0)

  add(s: DaemonConnState): void {
    this.byDaemon.set(s.daemonId, s)
    if (s.state === 'READY') this.readyEvents.emit(s.daemonId, s)
  }

  get(daemonId: string): DaemonConnState | undefined {
    return this.byDaemon.get(daemonId)
  }

  reconnectForBootstrap(daemonId: string, sessionEpoch: number): boolean {
    const state = this.byDaemon.get(daemonId)
    if (!state?.reachable || state.state === 'READY' || state.sessionEpoch !== sessionEpoch) return false
    state.conn.close(1012, 'bootstrap upgrade queued')
    return true
  }

  /** A membership change reaches a connected daemon by making it handshake again: `auth/ok` is
   *  where it is told its set (daemon-groups.md §3), and the reconnect's register reconcile
   *  settles what it should be running. `1012` is transient to the daemon, so it comes straight
   *  back. False ⇒ nothing was connected, and the next auth reads the change anyway. */
  reconnectForMemberSet(daemonId: string): boolean {
    const state = this.byDaemon.get(daemonId)
    if (!state?.reachable) return false
    state.conn.close(1012, 'member set changed — reconnect to re-register')
    return true
  }

  has(daemonId: string): boolean {
    return this.byDaemon.has(daemonId)
  }

  /** Per-daemon tail of approval-state writes — `agent/activity` persists and the register/close clears — so they commit in arrival order (slack-approval-dm.md §7). */
  private readonly approvalMutations = new Map<string, Promise<unknown>>()

  /** Run one approval-state mutation after every earlier one for the daemon; a failed predecessor never blocks the next. */
  runApprovalMutation<T>(daemonId: string, mutate: () => Promise<T>): Promise<T> {
    const prior = this.approvalMutations.get(daemonId) ?? Promise.resolve()
    const run = prior.then(mutate, mutate)
    const tracked: Promise<unknown> = run.then(
      () => undefined,
      () => undefined
    )
    void tracked.then(() => {
      if (this.approvalMutations.get(daemonId) === tracked) this.approvalMutations.delete(daemonId)
    })
    this.approvalMutations.set(daemonId, tracked)
    return run
  }

  /** Resolves once every queued approval-state mutation for the daemon has settled; immediately when none is in flight. */
  approvalMutationsSettled(daemonId: string): Promise<void> {
    return (this.approvalMutations.get(daemonId) ?? Promise.resolve()).then(() => undefined)
  }

  /** Publish the point at which a newly-authenticated connection may accept
   * control frames, waking idempotent commands interrupted on an older epoch. */
  markReady(daemonId: string, conn: ConnChannel): DaemonConnState | undefined {
    const state = this.byDaemon.get(daemonId)
    if (!state || state.conn !== conn) return undefined
    state.state = 'READY'
    this.readyEvents.emit(daemonId, state)
    return state
  }

  async waitForReadyAfter(daemonId: string, afterEpoch: number, signal: AbortSignal): Promise<DaemonConnState> {
    for (;;) {
      const current = this.byDaemon.get(daemonId)
      if (current?.state === 'READY' && current.sessionEpoch > afterEpoch) return current
      const [ready] = (await once(this.readyEvents, daemonId, { signal })) as [DaemonConnState]
      if (ready.sessionEpoch > afterEpoch) return ready
    }
  }

  /** The live connection state that currently owns a sessionKey, if any. */
  ownerOf(key: SessionKey): DaemonConnState | undefined {
    const did = this.ownerByKey.get(sessionKeyStr(key))
    return did ? this.byDaemon.get(did) : undefined
  }

  bindSession(key: SessionKey, daemonId: string): void {
    const k = sessionKeyStr(key)
    this.ownerByKey.set(k, daemonId)
    this.byDaemon.get(daemonId)?.assignments.add(k)
  }

  releaseSession(key: SessionKey): void {
    const k = sessionKeyStr(key)
    const did = this.ownerByKey.get(k)
    if (did) this.byDaemon.get(did)?.assignments.delete(k)
    this.ownerByKey.delete(k)
  }

  remove(daemonId: string): void {
    const s = this.byDaemon.get(daemonId)
    if (s) for (const k of s.assignments) this.ownerByKey.delete(k)
    this.byDaemon.delete(daemonId)
  }

  /** Placement candidate pool — reachable, connected daemons. */
  reachableDaemons(): DaemonConnState[] {
    return [...this.byDaemon.values()].filter((s) => s.reachable)
  }

  /** Daemons whose last beat predates `deadline` — watchdog scan (§4.9). */
  staleSince(deadline: number): DaemonConnState[] {
    return [...this.byDaemon.values()].filter((s) => s.lastBeatAt < deadline)
  }
}
