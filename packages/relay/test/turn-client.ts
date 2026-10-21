// A minimal TURN client for the relay's TURN tests: long-term credentials, Allocate, permissions, channels and data.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import {
  ATTR,
  attr,
  buildStun,
  channelData,
  CLASS,
  isChannelData,
  METHOD,
  parseStun,
  readXorAddress,
  splitStreamFrames,
  u32,
  xorAddressValue,
  type StunMessage,
  type TransportAddress
} from '../src/turn/codec.js'

/** One way to reach the server: send a frame, and get every frame it sends back. */
export interface TurnLink {
  stream: boolean
  send(frame: Buffer): void
  onFrame(handler: (frame: Buffer) => void): void
  close(): void
}

/** REST-API credentials as the CP mints them: `<expiry>:<who>` and base64(HMAC-SHA1(secret, username)). */
export function restCredential(
  secret: string,
  who: string,
  expiresAtSec: number
): { username: string; password: string } {
  const username = `${expiresAtSec}:${who}`
  return { username, password: createHmac('sha1', secret).update(username).digest('base64') }
}

export class TestTurnClient {
  realm = ''
  nonce = ''
  relayed: TransportAddress | undefined
  readonly received: Array<{ peer: TransportAddress | number; data: Buffer }> = []
  private readonly waiting = new Map<string, (message: StunMessage) => void>()

  constructor(
    readonly link: TurnLink,
    private credential: { username: string; password: string }
  ) {
    link.onFrame((frame) => {
      if (isChannelData(frame)) {
        const length = frame.readUInt16BE(2)
        return void this.received.push({ peer: frame.readUInt16BE(0), data: frame.subarray(4, 4 + length) })
      }
      const message = parseStun(frame)
      if (!message) return
      if (message.method === METHOD.data && message.cls === CLASS.indication) {
        const peer = readXorAddress(attr(message, ATTR.xorPeerAddress)!)!
        return void this.received.push({ peer, data: attr(message, ATTR.data)! })
      }
      this.waiting.get(message.transactionId.toString('hex'))?.(message)
    })
  }

  useCredential(credential: { username: string; password: string }): void {
    this.credential = credential
  }

  private key(): Buffer {
    return createHash('md5').update(`${this.credential.username}:${this.realm}:${this.credential.password}`).digest()
  }

  /** Sends one request and resolves with its response; `raw` sends it unauthenticated. */
  send(
    method: number,
    attributes: Array<readonly [number, Buffer]>,
    opts: { raw?: boolean; transactionId?: Buffer } = {}
  ): Promise<StunMessage> {
    const transactionId = opts.transactionId ?? randomBytes(12)
    const auth: Array<readonly [number, Buffer]> = opts.raw
      ? []
      : [
          [ATTR.username, Buffer.from(this.credential.username)],
          [ATTR.realm, Buffer.from(this.realm)],
          [ATTR.nonce, Buffer.from(this.nonce)]
        ]
    const frame = buildStun(
      method,
      CLASS.request,
      transactionId,
      [...attributes, ...auth],
      opts.raw ? {} : { key: this.key() }
    )
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no TURN response')), 3000)
      this.waiting.set(transactionId.toString('hex'), (message) => {
        clearTimeout(timer)
        this.waiting.delete(transactionId.toString('hex'))
        resolve(message)
      })
      this.link.send(frame)
    })
  }

  /** An authenticated request, learning REALM and NONCE from a 401 or 438 first. */
  async request(method: number, attributes: Array<readonly [number, Buffer]> = []): Promise<StunMessage> {
    if (!this.nonce) this.learn(await this.send(method, attributes, { raw: true }))
    let response = await this.send(method, attributes)
    if (errorCode(response) === 438) {
      this.learn(response)
      response = await this.send(method, attributes)
    }
    return response
  }

  private learn(challenge: StunMessage): void {
    this.realm = attr(challenge, ATTR.realm)?.toString() ?? ''
    this.nonce = attr(challenge, ATTR.nonce)?.toString() ?? ''
  }

  async allocate(extra: Array<readonly [number, Buffer]> = []): Promise<StunMessage> {
    const response = await this.request(METHOD.allocate, [
      [ATTR.requestedTransport, Buffer.from([17, 0, 0, 0])],
      ...extra
    ])
    const relayed = attr(response, ATTR.xorRelayedAddress)
    if (relayed) this.relayed = readXorAddress(relayed)!
    return response
  }

  permit(peer: TransportAddress): Promise<StunMessage> {
    return this.request(METHOD.createPermission, [[ATTR.xorPeerAddress, xorAddressValue(peer.address, peer.port)]])
  }

  bind(channel: number, peer: TransportAddress): Promise<StunMessage> {
    return this.request(METHOD.channelBind, [
      [ATTR.channelNumber, Buffer.from([channel >> 8, channel & 0xff, 0, 0])],
      [ATTR.xorPeerAddress, xorAddressValue(peer.address, peer.port)]
    ])
  }

  refresh(lifetimeSec?: number): Promise<StunMessage> {
    return this.request(METHOD.refresh, lifetimeSec === undefined ? [] : [[ATTR.lifetime, u32(lifetimeSec)]])
  }

  sendTo(peer: TransportAddress, data: Buffer): void {
    this.link.send(
      buildStun(
        METHOD.send,
        CLASS.indication,
        randomBytes(12),
        [
          [ATTR.xorPeerAddress, xorAddressValue(peer.address, peer.port)],
          [ATTR.data, data]
        ],
        { fingerprint: false }
      )
    )
  }

  sendOnChannel(channel: number, data: Buffer): void {
    this.link.send(channelData(channel, data, this.link.stream))
  }
}

export function errorCode(message: StunMessage): number | undefined {
  const value = attr(message, ATTR.errorCode)
  return value ? value[2]! * 100 + value[3]! : undefined
}

export function lifetimeOf(message: StunMessage): number | undefined {
  return attr(message, ATTR.lifetime)?.readUInt32BE(0)
}

export async function udpLink(port: number, host = '127.0.0.1'): Promise<TurnLink> {
  const socket = createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const handlers: Array<(frame: Buffer) => void> = []
  socket.on('message', (frame) => handlers.forEach((handler) => handler(frame)))
  return {
    stream: false,
    send: (frame) => socket.send(frame, port, host),
    onFrame: (handler) => handlers.push(handler),
    close: () => socket.close()
  }
}

export async function streamLink(
  port: number,
  tls = false,
  host = '127.0.0.1'
): Promise<TurnLink & { socket: Socket }> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = tls
      ? connectTls({ port, host, rejectUnauthorized: false }, () => resolve(s))
      : connectTcp({ port, host }, () => resolve(s))
    s.once('error', reject)
  })
  const handlers: Array<(frame: Buffer) => void> = []
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    const { frames, rest } = splitStreamFrames(Buffer.concat([pending, chunk]))
    pending = Buffer.from(rest)
    for (const frame of frames) handlers.forEach((handler) => handler(frame))
  })
  return {
    socket,
    stream: true,
    send: (frame) => socket.write(frame),
    onFrame: (handler) => handlers.push(handler),
    close: () => socket.destroy()
  }
}
