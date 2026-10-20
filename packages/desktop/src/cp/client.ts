// The desktop daemon's Computer channel client (computer-use.md §3.6): dial out, auth, heartbeat, renew, obey revoke.
import {
  Backoff,
  ClientTransport,
  ReqRep,
  WireError,
  systemClock,
  type Clock,
  type TimerHandle,
  type Transport
} from '@agentconnect.md/connection'
import {
  COMPUTER_AUDIT_FEATURE,
  COMPUTER_CP_SUBPROTOCOL,
  buildComputerCpFrame,
  decodeComputerCpFrameTolerant,
  type ComputerAuditEntry,
  type ComputerAuthOk,
  type ComputerControlLease,
  type ComputerCpFrame,
  type ComputerHeartbeat,
  type ComputerPolicy,
  type ComputerRelayEntry
} from '@agentconnect.md/protocol/computer'
import type { ChannelAuthority } from './authority.js'

const AUTH_TIMEOUT_MS = 15_000

/** What one heartbeat reports; the facts are sent only when they changed or right after auth. */
export interface HeartbeatReport {
  status: ComputerHeartbeat['status']
  // The local lease's holder and idle time, sent with every heartbeat so the CP's idle clock follows real use.
  lease?: ComputerHeartbeat['lease']
  facts?: Omit<ComputerHeartbeat, 'status' | 'lease'>
}

export interface ComputerCpClientDeps {
  channelUrl: string
  apiKey: string
  desktopDaemonVersion: string
  authority: ChannelAuthority
  report: () => HeartbeatReport
  onPolicy?: (policy: ComputerPolicy) => void
  // The CP granted, moved or ended the control lease (computer-use.md §4.4).
  onLease?: (lease: ComputerControlLease | null) => void
  // The relays to dial out to for the data plane (computer-use.md §3.7).
  onRelays?: (relays: ComputerRelayEntry[]) => void
  // The CP revoked or refused this key: persist it and stop for good.
  onRevoked: (reason: string) => void
  onReady?: (ok: ComputerAuthOk) => void
  log: (line: string) => void
  connect?: () => Promise<Transport>
  clock?: Clock
  jitter?: () => number
}

export type ComputerCpClientState =
  'IDLE' | 'CONNECTING' | 'AUTHENTICATING' | 'READY' | 'DEGRADED' | 'REVOKED' | 'STOPPED'

export class ComputerCpClient {
  state: ComputerCpClientState = 'IDLE'
  private transport: Transport | undefined
  private readonly clock: Clock
  private readonly backoff: Backoff
  private readonly correlator: ReqRep<ComputerCpFrame>
  private reconnectTimer: TimerHandle | undefined
  private heartbeatTimer: TimerHandle | undefined
  private heartbeatMs = 15_000
  private sentFacts: string | undefined
  // What the CP accepts beyond the base frames, from its last auth reply.
  private features = new Set<string>()

  constructor(private readonly deps: ComputerCpClientDeps) {
    this.clock = deps.clock ?? systemClock
    this.backoff = new Backoff(deps.jitter ? { jitter: deps.jitter } : {})
    this.correlator = new ReqRep<ComputerCpFrame>(this.clock, AUTH_TIMEOUT_MS, 1)
  }

  start(): void {
    if (this.state !== 'IDLE') return
    void this.attempt()
  }

  stop(): void {
    this.state = 'STOPPED'
    this.clearTimers()
    this.transport?.close(1000, 'shutdown')
    this.transport = undefined
  }

  /** Send a heartbeat now, e.g. when the status or the facts changed. */
  beat(): void {
    if (this.state !== 'READY' || !this.transport) return
    const report = this.deps.report()
    const facts = report.facts ? JSON.stringify(report.facts) : undefined
    const fresh = facts !== undefined && facts !== this.sentFacts
    const payload: ComputerHeartbeat = {
      status: report.status,
      ...(report.lease ? { lease: report.lease } : {}),
      ...(fresh ? report.facts : {})
    }
    try {
      this.transport.send(JSON.stringify(buildComputerCpFrame('computer/heartbeat', payload)))
      if (fresh) this.sentFacts = facts
    } catch (error) {
      this.deps.log(`computer channel: heartbeat failed: ${(error as Error).message}`)
    }
  }

  /** Send audit entries (computer-use.md §8.2); true once the CP stored them, false when it cannot take them now. */
  async reportAudit(entries: ComputerAuditEntry[]): Promise<boolean> {
    const transport = this.transport
    if (this.state !== 'READY' || !transport || !this.features.has(COMPUTER_AUDIT_FEATURE)) return false
    try {
      const reply = await this.correlator.request(buildComputerCpFrame('computer/audit', { entries }), (encoded) =>
        transport.send(encoded)
      )
      return reply.type === 'computer/audit/ok'
    } catch (error) {
      this.deps.log(`computer channel: audit report failed: ${(error as Error).message}`)
      return false
    }
  }

  private connect(): Promise<Transport> {
    if (this.deps.connect) return this.deps.connect()
    return ClientTransport.dial(this.deps.channelUrl, {
      subprotocol: COMPUTER_CP_SUBPROTOCOL,
      path: new URL(this.deps.channelUrl).pathname
    })
  }

  private async attempt(): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'REVOKED') return
    this.state = 'CONNECTING'
    let transport: Transport
    try {
      transport = await this.connect()
    } catch (error) {
      this.deps.log(`computer channel: cannot reach the Control Plane: ${(error as Error).message}`)
      return this.scheduleReconnect()
    }
    if (this.state !== 'CONNECTING') return void transport.close(1000, 'shutdown')
    this.transport = transport
    transport.onMessage((text) => this.onText(text))
    transport.onClose((code, reason) => this.onClose(transport, code, reason))
    this.state = 'AUTHENTICATING'
    try {
      const reply = await this.correlator.request(
        buildComputerCpFrame('computer/auth', {
          apiKey: this.deps.apiKey,
          desktopDaemonVersion: this.deps.desktopDaemonVersion
        }),
        (encoded) => transport.send(encoded)
      )
      if (reply.type !== 'computer/auth/ok') throw new Error(`unexpected ${reply.type}`)
      this.ready(reply.payload)
    } catch (error) {
      if (this.transport !== transport) return
      // A refused key arrives as an AUTH_FAILED reply, which onText already turned into a revoke.
      if (error instanceof WireError && error.code === 'AUTH_FAILED') return
      this.deps.log(`computer channel: auth failed: ${(error as Error).message}`)
      transport.close(1000, 'auth failed')
    }
  }

  private ready(ok: ComputerAuthOk): void {
    this.state = 'READY'
    this.backoff.reset()
    this.sentFacts = undefined
    this.features = new Set(ok.features ?? [])
    this.deps.authority.syncClock(ok.serverTime)
    this.deps.authority.accept(ok.credential)
    this.deps.onPolicy?.(ok.policy)
    this.heartbeatMs = ok.heartbeatSec * 1000
    this.deps.log(`computer channel: connected as ${ok.name} (${ok.computerId})`)
    this.deps.onReady?.(ok)
    this.beat()
    this.armHeartbeat()
  }

  private onText(text: string): void {
    const decoded = decodeComputerCpFrameTolerant(text)
    if (!decoded.ok) {
      if (decoded.corr) this.correlator.reject(decoded.corr, new WireError('BAD_PAYLOAD', decoded.msg, false))
      this.deps.log(`computer channel: unreadable frame (${decoded.msg})`)
      return
    }
    const frame = decoded.frame
    // Only an explicit refusal or revoke forgets the key; a bare close 4401 is redialed like any other.
    if (frame.type === 'error' && frame.payload.code === 'AUTH_FAILED' && this.state === 'AUTHENTICATING') {
      this.revoked('key refused by the Control Plane')
    }
    if (frame.corr && this.correlator.settle(frame)) return
    switch (frame.type) {
      case 'computer/credential':
        this.deps.authority.accept(frame.payload.credential)
        return
      case 'computer/policy':
        this.deps.onPolicy?.(frame.payload.policy)
        return
      case 'computer/lease':
        this.deps.onLease?.(frame.payload.lease)
        return
      case 'computer/relays':
        this.deps.onRelays?.(frame.payload.relays)
        return
      case 'computer/revoke':
        return this.revoked(`${frame.payload.reason} by the Control Plane`)
      case 'error':
        this.deps.log(`computer channel: ${frame.payload.code}: ${frame.payload.message}`)
        return
      default:
        this.deps.log(`computer channel: ignoring ${frame.type}`)
    }
  }

  private revoked(reason: string): void {
    if (this.state === 'REVOKED') return
    this.state = 'REVOKED'
    this.clearTimers()
    this.deps.authority.revoke(reason)
    this.deps.onRevoked(reason)
  }

  private onClose(transport: Transport, code: number, reason: string): void {
    if (this.transport !== transport) return
    this.transport = undefined
    this.stopHeartbeat()
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (this.state === 'STOPPED' || this.state === 'REVOKED') return
    this.deps.log(`computer channel: closed (${code}${reason ? ` ${reason}` : ''}); reconnecting`)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.state === 'STOPPED' || this.state === 'REVOKED' || this.reconnectTimer !== undefined) return
    this.state = 'DEGRADED'
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.attempt()
    }, this.backoff.next())
  }

  private armHeartbeat(): void {
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = undefined
      if (this.state !== 'READY') return
      this.beat()
      this.armHeartbeat()
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.clock.clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer !== undefined) this.clock.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}
