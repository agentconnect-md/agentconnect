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
  request<TReply = unknown>(type: string, payload: unknown, ext?: ControlExt, opts?: RequestOpts): Promise<TReply>
  /** Fire-and-forget EVT (C→D). */
  send(type: string, payload: unknown, ext?: ControlExt): void
  close(code: number, reason: string): void
}

export interface DaemonConnState {
  daemonId: string
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

  has(daemonId: string): boolean {
    return this.byDaemon.has(daemonId)
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
