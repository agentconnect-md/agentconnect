// The per-socket FSM of a desktop daemon's Computer channel (computer-use.md §3.6, §8.2): auth, heartbeat, renewal, revoke.
import {
  buildComputerCpFrame,
  decodeComputerCpFrame,
  type COMPUTER_CP_SCHEMAS,
  type ComputerAuth,
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
import type { ComputerChannel, ComputerChannelRegistry } from './computer-registry.js'

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
  clock: Clock
  heartbeatSec: number
  /** A socket that has not authenticated by then is closed. */
  authTimeoutMs?: number
  log?: { warn(obj: object, msg: string): void }
}

type State = 'AUTHENTICATING' | 'READY' | 'CLOSED'

const AUTH_FAILED = 4401
const DEFAULT_AUTH_TIMEOUT_MS = 10_000

export class ComputerConnection implements ComputerChannel {
  state: State = 'AUTHENTICATING'
  computerId = ''
  orgId = ''
  ownerUserId = ''
  private principal: ComputerPrincipal | undefined
  private lastKeyId = ''
  private authTimer: ReturnType<Clock['setTimeout']> | undefined
  // Frames are applied one at a time, so a heartbeat never overtakes the auth it follows.
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly transport: ComputerTransport,
    private readonly deps: ComputerConnDeps
  ) {}

  start(): void {
    this.transport.onMessage((text) => {
      this.queue = this.queue.then(() => this.onText(text)).catch(() => this.close(1011, 'SERVER_INTERNAL'))
    })
    this.transport.onClose(() => void this.onClose())
    this.authTimer = this.deps.clock.setTimeout(() => {
      if (this.state === 'AUTHENTICATING') this.close(AUTH_FAILED, 'auth timeout')
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
      if (this.state === 'AUTHENTICATING') this.close(AUTH_FAILED, 'auth failed')
      return
    }
    const frame = decoded.frame
    if (this.state === 'AUTHENTICATING') {
      if (frame.type !== 'computer/auth') {
        this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal before computer/auth`)
        this.close(AUTH_FAILED, 'auth failed')
        return
      }
      return this.handleAuth(frame, frame.payload)
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
    this.clearAuthTimer()
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
    const credential = this.deps.keys.current(this.computerId, principal.apiKeyId, now)
    if (credential.keyId !== this.lastKeyId) {
      this.lastKeyId = credential.keyId
      this.send('computer/credential', { credential })
    }
  }

  pushPolicy(policy: ComputerPolicy): void {
    if (this.state === 'READY') this.send('computer/policy', { policy })
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

  private sendError(corr: string, code: ErrorCode, message: string): void {
    this.transport.send(JSON.stringify(buildComputerCpFrame('error', { code, message, retryable: false }, { corr })))
  }
}
