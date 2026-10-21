// A stateless STUN Binding server (RFC 8489) so viewer peers learn their public address and hole-punch (computer-use.md §7.2).
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { crc32 } from 'node:zlib'
import type { Logger } from './log.js'

const MAGIC_COOKIE = 0x2112a442
const HEADER_BYTES = 20
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const BINDING_ERROR = 0x0111
const ATTR_XOR_MAPPED_ADDRESS = 0x0020
const ATTR_ERROR_CODE = 0x0009
const ATTR_UNKNOWN_ATTRIBUTES = 0x000a
const ATTR_SOFTWARE = 0x8022
const ATTR_FINGERPRINT = 0x8028
const FINGERPRINT_XOR = 0x5354554e
// Comprehension-required attributes a plain Binding server may see and safely ignore.
const KNOWN_REQUIRED = new Set([0x0006, 0x0008, 0x0014, 0x0015, 0x0024, 0x0025])
const SOFTWARE = Buffer.from('agentconnect-relay')
// A request is a few attributes at most; anything larger is not a Binding request we answer.
const MAX_REQUEST_BYTES = 548

const pad4 = (n: number) => (n + 3) & ~3

function attribute(type: number, value: Buffer): Buffer {
  const out = Buffer.alloc(4 + pad4(value.length))
  out.writeUInt16BE(type, 0)
  out.writeUInt16BE(value.length, 2)
  value.copy(out, 4)
  return out
}

function xorMappedAddress(address: string, port: number, transactionId: Buffer): Buffer {
  const v4 = isIPv4(address)
  const value = Buffer.alloc(v4 ? 8 : 20)
  value.writeUInt8(v4 ? 0x01 : 0x02, 1)
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2)
  const raw = v4 ? Buffer.from(address.split('.').map(Number)) : ipv6Bytes(address)
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transactionId])
  for (let i = 0; i < raw.length; i++) value[4 + i] = raw[i]! ^ mask[i]!
  return attribute(ATTR_XOR_MAPPED_ADDRESS, value)
}

function ipv6Bytes(address: string): Buffer {
  const [head = '', tail = ''] = address.split('%')[0]!.split('::')
  const groups = (part: string) => (part ? part.split(':') : [])
  const left = groups(head)
  const right = groups(tail)
  const out = Buffer.alloc(16)
  const fill = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  fill.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16) || 0, i * 2))
  return out
}

function message(type: number, transactionId: Buffer, attributes: Buffer[]): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt16BE(type, 0)
  header.writeUInt32BE(MAGIC_COOKIE, 4)
  transactionId.copy(header, 8)
  const body = Buffer.concat(attributes)
  // The length covers the FINGERPRINT that follows, which is computed over everything before it.
  header.writeUInt16BE(body.length + 8, 2)
  const unsigned = Buffer.concat([header, body])
  const fingerprint = Buffer.alloc(4)
  fingerprint.writeUInt32BE((crc32(unsigned) ^ FINGERPRINT_XOR) >>> 0, 0)
  return Buffer.concat([unsigned, attribute(ATTR_FINGERPRINT, fingerprint)])
}

/** The reply to one datagram from `from`, or null to drop it (not a well-formed Binding request). */
export function stunReply(datagram: Buffer, from: Pick<RemoteInfo, 'address' | 'port'>): Buffer | null {
  if (datagram.length < HEADER_BYTES || datagram.length > MAX_REQUEST_BYTES) return null
  // The top two bits of a STUN message are zero, and the magic cookie tells it from RFC 3489 and other protocols.
  if ((datagram[0]! & 0xc0) !== 0 || datagram.readUInt32BE(4) !== MAGIC_COOKIE) return null
  const length = datagram.readUInt16BE(2)
  if (length % 4 !== 0 || HEADER_BYTES + length !== datagram.length) return null
  if (datagram.readUInt16BE(0) !== BINDING_REQUEST) return null
  const transactionId = datagram.subarray(8, HEADER_BYTES)
  const unknown: number[] = []
  for (let at = HEADER_BYTES; at < datagram.length;) {
    if (at + 4 > datagram.length) return null
    const type = datagram.readUInt16BE(at)
    const size = datagram.readUInt16BE(at + 2)
    if (at + 4 + size > datagram.length) return null
    if (type < 0x8000 && !KNOWN_REQUIRED.has(type)) unknown.push(type)
    at += 4 + pad4(size)
  }
  const address = from.address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')
  if (unknown.length > 0) {
    const code = Buffer.concat([Buffer.from([0, 0, 4, 20]), Buffer.from('Unknown Attribute')])
    const list = Buffer.alloc(unknown.length * 2)
    unknown.forEach((type, i) => list.writeUInt16BE(type, i * 2))
    return message(BINDING_ERROR, transactionId, [
      attribute(ATTR_ERROR_CODE, code),
      attribute(ATTR_UNKNOWN_ATTRIBUTES, list)
    ])
  }
  return message(BINDING_SUCCESS, transactionId, [
    xorMappedAddress(address, from.port, transactionId),
    attribute(ATTR_SOFTWARE, SOFTWARE)
  ])
}

export interface StunServer {
  /** The bound UDP port (useful when 0 was asked for). */
  port: number
  close(): Promise<void>
}

/** Listen for Binding requests on `host:port`; it keeps no state per client, so it holds no media or session data. */
export function startStunServer(opts: { host: string; port: number; log: Logger }): Promise<StunServer> {
  const socket: Socket = createSocket({ type: opts.host.includes(':') ? 'udp6' : 'udp4', reuseAddr: false })
  socket.on('message', (datagram, from) => {
    const reply = stunReply(datagram, from)
    if (reply) socket.send(reply, from.port, from.address)
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(opts.port, opts.host, () => {
      socket.off('error', reject)
      // A send to a vanished client can surface ICMP errors; they concern one datagram, never the server.
      socket.on('error', (err) => opts.log.debug(`relay: stun socket error: ${err.message}`))
      const port = socket.address().port
      opts.log.info(`relay: STUN listening on udp ${opts.host}:${port}`)
      resolve({ port, close: () => new Promise((done) => socket.close(() => done())) })
    })
  })
}
