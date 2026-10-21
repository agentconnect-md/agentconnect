// The relay's TURN server (RFC 8656, computer-use.md §7.2): peers are only this instance's own allocations, relayed in process.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Logger } from '../log.js'
import { stunReply } from '../stun-server.js'
import {
  ATTR,
  attr,
  buildStun,
  channelData,
  CLASS,
  errorCodeValue,
  isChannelData,
  KNOWN_REQUIRED,
  METHOD,
  parseStun,
  readXorAddress,
  u32,
  verifyIntegrity,
  xorAddressValue,
  type StunMessage
} from './codec.js'
import { noTurnMetrics, type TurnEndReason, type TurnMetrics } from './metrics.js'

const DEFAULT_LIFETIME_SEC = 600
const MAX_LIFETIME_SEC = 3600
const PERMISSION_MS = 300_000
const CHANNEL_MS = 600_000
const NONCE_MS = 600_000
const RELAYED_PORT_MIN = 49152
const RELAYED_PORT_MAX = 65535
const UDP = 17
const SOFTWARE = Buffer.from('agentconnect-relay')

export type TurnTransport = 'udp' | 'tcp' | 'tls'

/** One client 5-tuple: a UDP source address, or one TCP / TLS connection. */
export interface TurnClient {
  key: string
  transport: TurnTransport
  address: string
  port: number
  send(frame: Buffer): void
  /** Closes a stream connection whose allocation ended; absent for UDP. */
  end?(): void
}

export interface TurnLimits {
  /** Allocations this instance holds at once; more get 508. */
  maxAllocations: number
  /** Allocations one credential holds at once; more get 486. */
  maxAllocationsPerUser: number
  /** What one allocation may send to its peers, in bits per second, with a one-second burst; the excess is dropped. */
  maxBitsPerSecond: number
  /** An allocation that relays nothing either way for this long is deleted. */
  idleTimeoutMs: number
}

export interface TurnServerOptions {
  realm: string
  /** The IPv4 address relayed candidates carry; peers are only this instance's own allocations. */
  relayedAddress: string
  /** The CP's REST-credential secret; until it arrives every request is refused. */
  secret: () => string | undefined
  limits: TurnLimits
  log: Logger
  metrics?: TurnMetrics
  now?: () => number
}

/** Who a credential was minted for: `<expiry>:computer-<id>` or `<expiry>:viewer-<user>` (control-plane computer-viewer/turn.ts). */
export interface TurnSubject {
  kind: 'computer' | 'viewer' | 'other'
  computerId?: string
}

export function turnSubject(username: string): TurnSubject {
  const who = username.slice(username.indexOf(':') + 1)
  if (who.startsWith('computer-')) return { kind: 'computer', computerId: who.slice('computer-'.length) }
  return { kind: who.startsWith('viewer-') ? 'viewer' : 'other' }
}

interface Allocation {
  client: TurnClient
  username: string
  subject: TurnSubject
  key: Buffer
  relayedPort: number
  createdAt: number
  expiresAt: number
  credentialExpiresAt: number
  lastActivityAt: number
  allocateTransaction: Buffer
  allocateResponse: Buffer
  /** Peer IP → expiry; the only IP a permission may name is the relayed address. */
  permissions: Map<string, number>
  channels: Map<number, { peerPort: number; expiresAt: number }>
  channelByPeer: Map<number, number>
  tokens: number
  tokensAt: number
  sentBytes: number
  receivedBytes: number
}

interface Credential {
  username: string
  key: Buffer
  expiresAt: number
}

export class TurnServer {
  private readonly byClient = new Map<string, Allocation>()
  private readonly byPort = new Map<number, Allocation>()
  private readonly perUser = new Map<string, number>()
  private readonly nonceKey = randomBytes(32)
  private readonly metrics: TurnMetrics
  private readonly now: () => number
  private sweeper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly opts: TurnServerOptions) {
    this.metrics = opts.metrics ?? noTurnMetrics
    this.now = opts.now ?? Date.now
    this.metrics.observeActive(() => this.byClient.size)
  }

  get allocations(): number {
    return this.byClient.size
  }

  /** Whether this 5-tuple holds an allocation. */
  holds(key: string): boolean {
    return this.byClient.has(key)
  }

  /** Starts the sweep that expires allocations, permissions and channels. */
  start(intervalMs = 1000): void {
    this.sweeper ??= setInterval(() => this.sweep(), intervalMs)
    this.sweeper.unref()
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    for (const allocation of [...this.byClient.values()]) this.remove(allocation, 'shutdown')
  }

  /** One frame from a client: a STUN message or ChannelData. */
  handle(client: TurnClient, frame: Buffer): void {
    if (isChannelData(frame)) return this.onChannelData(client, frame)
    const message = parseStun(frame)
    if (!message) return
    if (message.method === METHOD.binding) {
      if (message.cls !== CLASS.request) return
      const reply = stunReply(frame, client)
      if (reply) client.send(reply)
      return
    }
    if (message.cls === CLASS.indication) {
      if (message.method === METHOD.send) this.onSend(client, message)
      return
    }
    if (message.cls !== CLASS.request) return
    const unknown = message.attributes.filter((a) => a.type < 0x8000 && !KNOWN_REQUIRED.has(a.type)).map((a) => a.type)
    if (unknown.length > 0) {
      const list = Buffer.alloc(unknown.length * 2)
      unknown.forEach((type, i) => list.writeUInt16BE(type, i * 2))
      return this.fail(client, message, 420, 'Unknown Attribute', undefined, [[ATTR.unknownAttributes, list]])
    }
    switch (message.method) {
      case METHOD.allocate:
        return this.onAllocate(client, message)
      case METHOD.refresh:
        return this.onRefresh(client, message)
      case METHOD.createPermission:
        return this.onCreatePermission(client, message)
      case METHOD.channelBind:
        return this.onChannelBind(client, message)
      default:
        return this.fail(client, message, 400, 'Bad Request')
    }
  }

  /** A stream connection closed: its allocation goes with it. */
  clientClosed(key: string): void {
    const allocation = this.byClient.get(key)
    if (allocation) this.remove(allocation, 'client_closed')
  }

  /** Expires allocations past their lifetime, credential, or idle timeout, and stale permissions and channels. */
  sweep(): void {
    const now = this.now()
    for (const allocation of [...this.byClient.values()]) {
      if (now >= allocation.credentialExpiresAt) this.remove(allocation, 'credential_expired')
      else if (now >= allocation.expiresAt) this.remove(allocation, 'expired')
      else if (now - allocation.lastActivityAt >= this.opts.limits.idleTimeoutMs) this.remove(allocation, 'idle')
      else {
        for (const [ip, expiresAt] of allocation.permissions) if (now >= expiresAt) allocation.permissions.delete(ip)
        for (const [channel, binding] of allocation.channels) {
          if (now < binding.expiresAt) continue
          allocation.channels.delete(channel)
          allocation.channelByPeer.delete(binding.peerPort)
        }
      }
    }
  }

  // ---- requests ----

  private onAllocate(client: TurnClient, message: StunMessage): void {
    const credential = this.authenticate(client, message)
    if (!credential) return
    const existing = this.byClient.get(client.key)
    if (existing) {
      // A retransmitted Allocate gets the same answer; any other is a mismatch on a 5-tuple already in use.
      if (existing.allocateTransaction.equals(message.transactionId)) return client.send(existing.allocateResponse)
      return this.fail(client, message, 437, 'Allocation Mismatch', credential.key)
    }
    const transport = attr(message, ATTR.requestedTransport)
    if (!transport || transport.length !== 4) return this.fail(client, message, 400, 'Bad Request', credential.key)
    if (transport[0] !== UDP) return this.fail(client, message, 442, 'Unsupported Transport Protocol', credential.key)
    if (attr(message, ATTR.reservationToken))
      return this.fail(client, message, 508, 'Insufficient Capacity', credential.key)
    const family = attr(message, ATTR.requestedAddressFamily)
    if (family && family[0] !== 0x01)
      return this.fail(client, message, 440, 'Address Family not Supported', credential.key)
    if (this.byClient.size >= this.opts.limits.maxAllocations) {
      this.metrics.allocation('capacity')
      return this.fail(client, message, 508, 'Insufficient Capacity', credential.key)
    }
    if ((this.perUser.get(credential.username) ?? 0) >= this.opts.limits.maxAllocationsPerUser) {
      this.metrics.allocation('quota')
      return this.fail(client, message, 486, 'Allocation Quota Reached', credential.key)
    }
    const relayedPort = this.freePort(attr(message, ATTR.evenPort) !== undefined)
    if (relayedPort === undefined) return this.fail(client, message, 508, 'Insufficient Capacity', credential.key)
    const now = this.now()
    const lifetimeSec = this.lifetime(message, credential, now)
    const response = buildStun(
      METHOD.allocate,
      CLASS.success,
      message.transactionId,
      [
        [ATTR.xorRelayedAddress, xorAddressValue(this.opts.relayedAddress, relayedPort)],
        [ATTR.lifetime, u32(lifetimeSec)],
        [ATTR.xorMappedAddress, xorAddressValue(ipv4(client.address), client.port)],
        [ATTR.software, SOFTWARE]
      ],
      { key: credential.key }
    )
    const allocation: Allocation = {
      client,
      username: credential.username,
      subject: turnSubject(credential.username),
      key: credential.key,
      relayedPort,
      createdAt: now,
      expiresAt: now + lifetimeSec * 1000,
      credentialExpiresAt: credential.expiresAt,
      lastActivityAt: now,
      allocateTransaction: message.transactionId,
      allocateResponse: response,
      permissions: new Map(),
      channels: new Map(),
      channelByPeer: new Map(),
      tokens: this.bucketBytes(),
      tokensAt: now,
      sentBytes: 0,
      receivedBytes: 0
    }
    this.byClient.set(client.key, allocation)
    this.byPort.set(relayedPort, allocation)
    this.perUser.set(credential.username, (this.perUser.get(credential.username) ?? 0) + 1)
    this.metrics.allocation('created')
    client.send(response)
  }

  private onRefresh(client: TurnClient, message: StunMessage): void {
    const credential = this.authenticate(client, message)
    if (!credential) return
    const allocation = this.owned(client, message, credential)
    if (!allocation) return
    const requested = attr(message, ATTR.lifetime)
    if (requested?.length === 4 && requested.readUInt32BE(0) === 0) {
      this.reply(client, message, [[ATTR.lifetime, u32(0)]], credential.key)
      return this.remove(allocation, 'released')
    }
    const now = this.now()
    const lifetimeSec = this.lifetime(message, credential, now)
    allocation.expiresAt = now + lifetimeSec * 1000
    allocation.credentialExpiresAt = credential.expiresAt
    this.reply(client, message, [[ATTR.lifetime, u32(lifetimeSec)]], credential.key)
  }

  private onCreatePermission(client: TurnClient, message: StunMessage): void {
    const credential = this.authenticate(client, message)
    if (!credential) return
    const allocation = this.owned(client, message, credential)
    if (!allocation) return
    const peers = message.attributes.filter((a) => a.type === ATTR.xorPeerAddress).map((a) => readXorAddress(a.value))
    if (peers.length === 0 || peers.some((peer) => !peer))
      return this.fail(client, message, 400, 'Bad Request', credential.key)
    if (peers.some((peer) => peer!.family !== 4))
      return this.fail(client, message, 443, 'Peer Address Family Mismatch', credential.key)
    if (peers.some((peer) => peer!.address !== this.opts.relayedAddress))
      return this.fail(client, message, 403, 'Forbidden', credential.key)
    allocation.permissions.set(this.opts.relayedAddress, this.now() + PERMISSION_MS)
    this.reply(client, message, [], credential.key)
  }

  private onChannelBind(client: TurnClient, message: StunMessage): void {
    const credential = this.authenticate(client, message)
    if (!credential) return
    const allocation = this.owned(client, message, credential)
    if (!allocation) return
    const number = attr(message, ATTR.channelNumber)
    const peerValue = attr(message, ATTR.xorPeerAddress)
    const peer = peerValue ? readXorAddress(peerValue) : null
    if (!number || number.length !== 4 || !peer) return this.fail(client, message, 400, 'Bad Request', credential.key)
    const channel = number.readUInt16BE(0)
    if (channel < 0x4000 || channel > 0x4fff) return this.fail(client, message, 400, 'Bad Request', credential.key)
    if (peer.family !== 4) return this.fail(client, message, 443, 'Peer Address Family Mismatch', credential.key)
    if (peer.address !== this.opts.relayedAddress) return this.fail(client, message, 403, 'Forbidden', credential.key)
    const bound = allocation.channels.get(channel)
    const boundTo = allocation.channelByPeer.get(peer.port)
    if ((bound && bound.peerPort !== peer.port) || (boundTo !== undefined && boundTo !== channel))
      return this.fail(client, message, 400, 'Bad Request', credential.key)
    const now = this.now()
    allocation.channels.set(channel, { peerPort: peer.port, expiresAt: now + CHANNEL_MS })
    allocation.channelByPeer.set(peer.port, channel)
    allocation.permissions.set(this.opts.relayedAddress, now + PERMISSION_MS)
    this.reply(client, message, [], credential.key)
  }

  // ---- data ----

  private onSend(client: TurnClient, message: StunMessage): void {
    const allocation = this.byClient.get(client.key)
    if (!allocation) return
    const peerValue = attr(message, ATTR.xorPeerAddress)
    const data = attr(message, ATTR.data)
    const peer = peerValue ? readXorAddress(peerValue) : null
    if (!peer || !data || peer.family !== 4) return
    if (peer.address !== this.opts.relayedAddress) return this.metrics.dropped(data.length, 'no_peer')
    this.relay(allocation, peer.port, data)
  }

  private onChannelData(client: TurnClient, frame: Buffer): void {
    const allocation = this.byClient.get(client.key)
    if (!allocation) return
    const length = frame.readUInt16BE(2)
    if (frame.length < 4 + length) return
    const binding = allocation.channels.get(frame.readUInt16BE(0))
    if (!binding) return
    this.relay(allocation, binding.peerPort, frame.subarray(4, 4 + length))
  }

  // Hands one datagram from `from` to the allocation whose relayed port is `peerPort`, as the network would.
  private relay(from: Allocation, peerPort: number, data: Buffer): void {
    const now = this.now()
    if (!permitted(from, now, this.opts.relayedAddress)) return this.metrics.dropped(data.length, 'no_permission')
    const to = this.byPort.get(peerPort)
    if (!to || to === from) return this.metrics.dropped(data.length, 'no_peer')
    if (!permitted(to, now, this.opts.relayedAddress)) return this.metrics.dropped(data.length, 'no_permission')
    if (!this.take(from, data.length, now)) return this.metrics.dropped(data.length, 'bandwidth')
    const channel = to.channelByPeer.get(from.relayedPort)
    const frame =
      channel !== undefined
        ? channelData(channel, data, to.client.transport !== 'udp')
        : buildStun(
            METHOD.data,
            CLASS.indication,
            randomBytes(12),
            [
              [ATTR.xorPeerAddress, xorAddressValue(this.opts.relayedAddress, from.relayedPort)],
              [ATTR.data, data]
            ],
            { fingerprint: false }
          )
    from.lastActivityAt = now
    to.lastActivityAt = now
    from.sentBytes += data.length
    to.receivedBytes += data.length
    this.metrics.relayed(data.length, from.subject, to.subject)
    to.client.send(frame)
  }

  // A token bucket per allocation: refills at the cap, holds one second of it.
  private take(allocation: Allocation, bytes: number, now: number): boolean {
    const capacity = this.bucketBytes()
    allocation.tokens = Math.min(capacity, allocation.tokens + ((now - allocation.tokensAt) / 1000) * capacity)
    allocation.tokensAt = now
    if (allocation.tokens < bytes) return false
    allocation.tokens -= bytes
    return true
  }

  private bucketBytes(): number {
    return this.opts.limits.maxBitsPerSecond / 8
  }

  // ---- helpers ----

  // Long-term credentials (RFC 8489 §9.2) with the CP's REST secret: password = base64(HMAC-SHA1(secret, username)).
  private authenticate(client: TurnClient, message: StunMessage): Credential | null {
    const challenge = (code: number, reason: string): null => {
      if (message.method === METHOD.allocate) this.metrics.allocation(code === 438 ? 'stale_nonce' : 'unauthorized')
      this.send(client, message, CLASS.error, [
        [ATTR.errorCode, errorCodeValue(code, reason)],
        [ATTR.realm, Buffer.from(this.opts.realm)],
        [ATTR.nonce, Buffer.from(this.nonce())]
      ])
      return null
    }
    if (!attr(message, ATTR.messageIntegrity)) return challenge(401, 'Unauthorized')
    const username = attr(message, ATTR.username)?.toString('utf8')
    const realm = attr(message, ATTR.realm)?.toString('utf8')
    const nonce = attr(message, ATTR.nonce)?.toString('utf8')
    if (!username || !realm || !nonce) {
      this.fail(client, message, 400, 'Bad Request')
      return null
    }
    if (!this.nonceValid(nonce)) return challenge(438, 'Stale Nonce')
    const secret = this.opts.secret()
    const expiry = /^(\d{1,12}):[\x21-\x7e]{1,200}$/.exec(username)
    if (realm !== this.opts.realm || !secret || !expiry) return challenge(401, 'Unauthorized')
    const expiresAt = Number(expiry[1]) * 1000
    // An expired credential can neither open nor refresh an allocation.
    if (expiresAt <= this.now()) return challenge(401, 'Unauthorized')
    const password = createHmac('sha1', secret).update(username).digest('base64')
    const key = createHash('md5').update(`${username}:${realm}:${password}`).digest()
    if (!verifyIntegrity(message, key)) return challenge(401, 'Unauthorized')
    return { username, key, expiresAt }
  }

  // The allocation this 5-tuple holds, opened with the same credential (RFC 8656 §5).
  private owned(client: TurnClient, message: StunMessage, credential: Credential): Allocation | null {
    const allocation = this.byClient.get(client.key)
    if (!allocation) {
      this.fail(client, message, 437, 'Allocation Mismatch', credential.key)
      return null
    }
    if (allocation.username !== credential.username) {
      this.fail(client, message, 441, 'Wrong Credentials', credential.key)
      return null
    }
    return allocation
  }

  // RFC 8656 §7.2: min(requested, maximum), never under the default; never past the credential's expiry.
  private lifetime(message: StunMessage, credential: Credential, now: number): number {
    const requested = attr(message, ATTR.lifetime)
    const asked = requested?.length === 4 ? requested.readUInt32BE(0) : DEFAULT_LIFETIME_SEC
    const lifetime = Math.max(DEFAULT_LIFETIME_SEC, Math.min(asked, MAX_LIFETIME_SEC))
    return Math.max(1, Math.min(lifetime, Math.floor((credential.expiresAt - now) / 1000)))
  }

  private freePort(even: boolean): number | undefined {
    for (let attempt = 0; attempt < 64; attempt++) {
      let port = randomInt(RELAYED_PORT_MIN, RELAYED_PORT_MAX + 1)
      if (even) port &= ~1
      if (!this.byPort.has(port)) return port
    }
    for (let port = RELAYED_PORT_MIN; port <= RELAYED_PORT_MAX; port += even ? 2 : 1)
      if (!this.byPort.has(port)) return port
    return undefined
  }

  // A nonce is its expiry and a MAC over it, so it needs no state: `<expiry base36>.<mac>`.
  private nonce(): string {
    const expires = (this.now() + NONCE_MS).toString(36)
    return `${expires}.${createHmac('sha256', this.nonceKey).update(expires).digest('base64url').slice(0, 22)}`
  }

  private nonceValid(nonce: string): boolean {
    const [expires = '', mac = ''] = nonce.split('.')
    const expected = createHmac('sha256', this.nonceKey).update(expires).digest('base64url').slice(0, 22)
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false
    return parseInt(expires, 36) > this.now()
  }

  private reply(
    client: TurnClient,
    message: StunMessage,
    attributes: ReadonlyArray<readonly [number, Buffer]>,
    key: Buffer
  ): void {
    this.send(client, message, CLASS.success, [...attributes, [ATTR.software, SOFTWARE]], key)
  }

  private fail(
    client: TurnClient,
    message: StunMessage,
    code: number,
    reason: string,
    key?: Buffer,
    extra: ReadonlyArray<readonly [number, Buffer]> = []
  ): void {
    this.send(client, message, CLASS.error, [[ATTR.errorCode, errorCodeValue(code, reason)], ...extra], key)
  }

  private send(
    client: TurnClient,
    message: StunMessage,
    cls: (typeof CLASS)['success'] | (typeof CLASS)['error'],
    attributes: ReadonlyArray<readonly [number, Buffer]>,
    key?: Buffer
  ): void {
    client.send(buildStun(message.method, cls, message.transactionId, attributes, key ? { key } : {}))
  }

  private remove(allocation: Allocation, reason: TurnEndReason): void {
    if (this.byClient.get(allocation.client.key) !== allocation) return
    this.byClient.delete(allocation.client.key)
    this.byPort.delete(allocation.relayedPort)
    const left = (this.perUser.get(allocation.username) ?? 1) - 1
    if (left > 0) this.perUser.set(allocation.username, left)
    else this.perUser.delete(allocation.username)
    this.metrics.ended(reason, allocation.client.transport)
    const who =
      allocation.subject.kind === 'computer' ? `computer ${allocation.subject.computerId}` : allocation.subject.kind
    this.opts.log.info(
      `relay: turn allocation ended (${reason}): ${who} over ${allocation.client.transport}, ` +
        `${Math.round((this.now() - allocation.createdAt) / 1000)} s, sent ${allocation.sentBytes} B, received ${allocation.receivedBytes} B`
    )
    if (reason !== 'client_closed') allocation.client.end?.()
  }
}

function permitted(allocation: Allocation, now: number, address: string): boolean {
  const expiresAt = allocation.permissions.get(address)
  return expiresAt !== undefined && now < expiresAt
}

// XOR-MAPPED-ADDRESS for an IPv4-mapped IPv6 source; this server listens on IPv4.
function ipv4(address: string): string {
  return address.replace(/^::ffff:/, '')
}
