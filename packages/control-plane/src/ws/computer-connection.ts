// The per-socket FSM of a desktop daemon's Computer channel (computer-use.md §3.6, §8.2): auth, heartbeat, renewal, revoke.
import {
  CloseCode,
  buildComputerCpFrame,
  decodeComputerCpFrame,
  type COMPUTER_CP_SCHEMAS,
  type ComputerAuth,
  type ComputerControlLease,
  type ComputerCpFrame,
  type ComputerCpFrameType,
  type ComputerHeartbeat,
  type ComputerPolicy,
  type ComputerRevoke,
  type ErrorCode
} from '@agentconnect.md/protocol'
import type { z } from 'zod'
import type { Clock } from '../domain/clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerRepo } from '../persistence/ports.js'
import type { ComputerPrincipal, ComputerService } from '../registry/computerService.js'
import type { ComputerChannelKeys } from '../registry/computerChannelKeys.js'
import type { ComputerLeaseService } from '../registry/computerLeaseService.js'
import type { ComputerChannel, ComputerChannelRegistry } from './computer-registry.js'
import type { HandshakeGate } from './handshake-gate.js'

/** The accept-side transport the FSM drives; production wraps a live socket, tests an in-memory pair. */
export interface ComputerTransport {
  send(text: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  close(code: number, reason: string): void
}

export interface ComputerConnDeps {
  computers: Pick<ComputerService, 'authenticate'>
  repo: Pick<ComputerRepo, 'get' | 'recordLive' | 'markOffline'>
  keys: ComputerChannelKeys
  registry: ComputerChannelRegistry
  /** The control lease the desktop enforces; absent in tests that do not exercise it. */
  leases?: Pick<ComputerLeaseService, 'observe' | 'current'>
  clock: Clock
  heartbeatSec: number
  /** A socket that has not authenticated by then is closed. */
  authTimeoutMs?: number
  /** Caps concurrent auth database work; a full gate answers a retryable RATE_LIMITED. */
  handshakes?: HandshakeGate
  log?: { warn(obj: object, msg: string): void }
}

type State = 'AUTHENTICATING' | 'READY' | 'CLOSED'

// 4401 means the key was refused or revoked and the desktop forgets it; every other close is retried.
const AUTH_FAILED = CloseCode.AUTH_FAILED
const BAD_HANDSHAKE = CloseCode.BAD_SUBPROTOCOL
const AUTH_TIMEOUT = 1008
const DEFAULT_AUTH_TIMEOUT_MS = 10_000

export class ComputerConnection implements ComputerChannel {
  state: State = 'AUTHENTICATING'
  computerId = ''
  orgId = ''
  ownerUserId = ''
  private principal: ComputerPrincipal | undefined
  private lastKeyId = ''
  // The lease id last told to the desktop ('' for none); undefined until the first push.
  private toldLease: string | undefined
  private authTimer: ReturnType<Clock['setTimeout']> | undefined
  // Frames are applied one at a time, so a heartbeat never overtakes the auth it follows.
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly transport: ComputerTransport,
    private readonly deps: ComputerConnDeps
  ) {}

  start(): void {
    this.transport.onMessage((text) => {
      this.queue = this.queue
        .then(() => this.onText(text))
        .catch(() => this.close(CloseCode.SERVER_INTERNAL, 'SERVER_INTERNAL'))
    })
    this.transport.onClose(() => void this.onClose())
    this.authTimer = this.deps.clock.setTimeout(() => {
      if (this.state === 'AUTHENTICATING') this.close(AUTH_TIMEOUT, 'auth timeout')
    }, this.deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS)
  }

  private async onText(text: string): Promise<void> {
    if (this.state === 'CLOSED') return
    const decoded = decodeComputerCpFrame(text)
    if (!decoded.ok) {
      const code: ErrorCode =
        decoded.msg === 'FRAME_TOO_LARGE' || decoded.msg === 'UNKNOWN_FRAME' ? decoded.msg : 'BAD_PAYLOAD'
      // An unreadable first frame cannot authenticate; anything later is answered and the link stays.
      this.sendError(decoded.id, code, decoded.msg)
      if (this.state === 'AUTHENTICATING') this.close(BAD_HANDSHAKE, 'bad auth frame')
      return
    }
    const frame = decoded.frame
    if (this.state === 'AUTHENTICATING') {
      if (frame.type !== 'computer/auth') {
        this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal before computer/auth`)
        this.close(BAD_HANDSHAKE, 'bad auth frame')
        return
      }
      const release = this.deps.handshakes ? this.deps.handshakes.tryAcquire() : () => {}
      if (!release) {
        this.sendError(frame.id, 'RATE_LIMITED', 'computer handshake limit reached; retry shortly', true)
        this.close(CloseCode.RATE_LIMITED, 'handshake limit reached')
        return
      }
      // The auth is in flight now; a slow database must not turn it into a timeout close.
      this.clearAuthTimer()
      try {
        return await this.handleAuth(frame, frame.payload)
      } finally {
        release()
      }
    }
    if (frame.type === 'computer/heartbeat') return this.handleHeartbeat(frame.payload)
    this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`)
  }

  private async handleAuth(frame: ComputerCpFrame, auth: ComputerAuth): Promise<void> {
    const principal = await this.deps.computers.authenticate(auth.apiKey)
    const computer = principal ? await this.deps.repo.get(principal.orgId, principal.computerId) : null
    const now = new Date(this.deps.clock.now())
    const live =
      principal && computer
        ? await this.deps.repo.recordLive(
            principal.orgId,
            principal.computerId,
            principal.apiKeyId,
            { status: 'online', desktopDaemonVersion: auth.desktopDaemonVersion },
            now
          )
        : false
    if (this.state === 'CLOSED') return
    if (!principal || !computer || !live) {
      this.sendError(frame.id, 'AUTH_FAILED', 'invalid or revoked computer key')
      this.close(AUTH_FAILED, 'auth failed')
      return
    }
    this.principal = principal
    this.computerId = principal.computerId
    this.orgId = principal.orgId
    this.ownerUserId = computer.ownerUserId
    this.state = 'READY'
    this.deps.registry.add(this)
    const credential = this.deps.keys.current(this.computerId, principal.apiKeyId, now.getTime())
    this.lastKeyId = credential.keyId
    this.reply(frame, 'computer/auth/ok', {
      computerId: this.computerId,
      orgId: this.orgId,
      name: computer.name,
      heartbeatSec: this.deps.heartbeatSec,
      serverTime: now.toISOString(),
      credential,
      policy: computer.policy
    })
    await this.syncLease(() => this.deps.leases?.current(this.orgId, this.computerId))
  }

  private async handleHeartbeat(beat: ComputerHeartbeat): Promise<void> {
    const principal = this.principal!
    const now = this.deps.clock.now()
    const { status, osVersion, session, desktopDaemonVersion, driverVersion, capabilities, doctor } = beat
    const live = await this.deps.repo.recordLive(
      OrgId(principal.orgId),
      ComputerId(principal.computerId),
      principal.apiKeyId,
      {
        status,
        ...(osVersion ? { osVersion } : {}),
        ...(session ? { session } : {}),
        ...(desktopDaemonVersion ? { desktopDaemonVersion } : {}),
        ...(driverVersion ? { driverVersion } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(doctor ? { doctor } : {})
      },
      new Date(now)
    )
    if (this.state !== 'READY') return
    // The conditional write is the backstop: a revoke this replica never heard of still ends the channel here.
    if (!live) return this.revoke('revoked')
    await this.syncLease(() =>
      this.deps.leases?.observe(this.orgId, this.computerId, { status, ...(beat.lease ? { lease: beat.lease } : {}) })
    )
    if (this.state !== 'READY') return
    const credential = this.deps.keys.current(this.computerId, principal.apiKeyId, now)
    if (credential.keyId !== this.lastKeyId) {
      this.lastKeyId = credential.keyId
      this.send('computer/credential', { credential })
    }
  }

  pushPolicy(policy: ComputerPolicy): void {
    if (this.state === 'READY') this.send('computer/policy', { policy })
  }

  // The re-read runs on the frame queue, after any heartbeat's lease read in flight, so the last push is the newest commit.
  leaseChanged(): void {
    if (this.state !== 'READY') return
    this.queue = this.queue.then(() => this.syncLease(() => this.deps.leases?.current(this.orgId, this.computerId)))
  }

  private pushLease(lease: ComputerControlLease | null): void {
    if (this.state !== 'READY') return
    const id = lease?.leaseId ?? ''
    if (id === this.toldLease) return
    this.toldLease = id
    this.send('computer/lease', { lease })
  }

  // A lease read that fails leaves the desktop on what it was last told; the next heartbeat retries.
  private async syncLease(read: () => Promise<ComputerControlLease | null> | undefined): Promise<void> {
    try {
      const pending = read()
      if (pending) this.pushLease(await pending)
    } catch (err) {
      this.deps.log?.warn({ err: (err as Error).message }, 'computer: lease sync failed')
    }
  }

  revoke(reason: ComputerRevoke['reason']): void {
    if (this.state === 'CLOSED') return
    if (this.state === 'READY') this.send('computer/revoke', { reason })
    this.close(AUTH_FAILED, 'computer revoked')
  }

  close(code: number, reason: string): void {
    if (this.state === 'CLOSED') return
    this.state = 'CLOSED'
    this.clearAuthTimer()
    this.transport.close(code, reason)
  }

  private async onClose(): Promise<void> {
    this.state = 'CLOSED'
    this.clearAuthTimer()
    // Only the registered socket marks the Computer offline; a superseded one leaves its successor alone.
    if (!this.principal || !this.deps.registry.remove(this)) return
    await this.deps.repo
      .markOffline(OrgId(this.orgId), ComputerId(this.computerId), new Date(this.deps.clock.now()))
      .catch((err: Error) => this.deps.log?.warn({ err: err.message }, 'computer: offline write failed'))
  }

  private clearAuthTimer(): void {
    if (this.authTimer === undefined) return
    this.deps.clock.clearTimeout(this.authTimer)
    this.authTimer = undefined
  }

  private reply<T extends ComputerCpFrameType>(
    req: ComputerCpFrame,
    type: T,
    payload: z.input<(typeof COMPUTER_CP_SCHEMAS)[T]>
  ): void {
    this.transport.send(JSON.stringify(buildComputerCpFrame(type, payload, { corr: req.id })))
  }

  private send<T extends ComputerCpFrameType>(type: T, payload: z.input<(typeof COMPUTER_CP_SCHEMAS)[T]>): void {
    this.transport.send(JSON.stringify(buildComputerCpFrame(type, payload)))
  }

  private sendError(corr: string, code: ErrorCode, message: string, retryable = false): void {
    this.transport.send(JSON.stringify(buildComputerCpFrame('error', { code, message, retryable }, { corr })))
  }
}
