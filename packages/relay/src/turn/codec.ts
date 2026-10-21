// STUN message codec for the relay's TURN server (RFC 8489 framing, RFC 8656 attributes); no I/O.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { crc32 } from 'node:zlib'

export const MAGIC_COOKIE = 0x2112a442
export const HEADER_BYTES = 20
const FINGERPRINT_XOR = 0x5354554e

export const METHOD = {
  binding: 0x001,
  allocate: 0x003,
  refresh: 0x004,
  send: 0x006,
  data: 0x007,
  createPermission: 0x008,
  channelBind: 0x009
} as const

export const CLASS = { request: 0b00, indication: 0b01, success: 0b10, error: 0b11 } as const
export type StunClass = (typeof CLASS)[keyof typeof CLASS]

export const ATTR = {
  username: 0x0006,
  messageIntegrity: 0x0008,
  errorCode: 0x0009,
  unknownAttributes: 0x000a,
  channelNumber: 0x000c,
  lifetime: 0x000d,
  xorPeerAddress: 0x0012,
  data: 0x0013,
  realm: 0x0014,
  nonce: 0x0015,
  xorRelayedAddress: 0x0016,
  requestedAddressFamily: 0x0017,
  evenPort: 0x0018,
  requestedTransport: 0x0019,
  dontFragment: 0x001a,
  xorMappedAddress: 0x0020,
  reservationToken: 0x0022,
  software: 0x8022,
  fingerprint: 0x8028
} as const

/** Comprehension-required attributes this server understands; any other below 0x8000 earns a 420. */
export const KNOWN_REQUIRED: ReadonlySet<number> = new Set([
  ATTR.username,
  ATTR.messageIntegrity,
  ATTR.channelNumber,
  ATTR.lifetime,
  ATTR.xorPeerAddress,
  ATTR.data,
  ATTR.realm,
  ATTR.nonce,
  ATTR.requestedAddressFamily,
  ATTR.evenPort,
  ATTR.requestedTransport,
  ATTR.dontFragment,
  ATTR.reservationToken
])

export const pad4 = (n: number): number => (n + 3) & ~3

export interface StunAttribute {
  type: number
  value: Buffer
  /** Byte offset of the attribute header within the message. */
  offset: number
}

export interface StunMessage {
  method: number
  cls: StunClass
  transactionId: Buffer
  attributes: StunAttribute[]
  raw: Buffer
}

export function messageType(method: number, cls: StunClass): number {
  return (
    (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 0b01) << 4) | ((cls & 0b10) << 7)
  )
}

/** Whether a frame is ChannelData (RFC 8656 §12.4): its first two bits are 01. */
export const isChannelData = (frame: Buffer): boolean => frame.length >= 4 && (frame[0]! & 0xc0) === 0x40

/** A well-formed STUN message, or null. */
export function parseStun(frame: Buffer): StunMessage | null {
  if (frame.length < HEADER_BYTES || (frame[0]! & 0xc0) !== 0) return null
  if (frame.readUInt32BE(4) !== MAGIC_COOKIE) return null
  const length = frame.readUInt16BE(2)
  if (length % 4 !== 0 || HEADER_BYTES + length !== frame.length) return null
  const type = frame.readUInt16BE(0)
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2)
  const cls = (((type >> 4) & 0b01) | ((type >> 7) & 0b10)) as StunClass
  const attributes: StunAttribute[] = []
  for (let at = HEADER_BYTES; at < frame.length;) {
    if (at + 4 > frame.length) return null
    const attrType = frame.readUInt16BE(at)
    const size = frame.readUInt16BE(at + 2)
    if (at + 4 + size > frame.length) return null
    attributes.push({ type: attrType, value: frame.subarray(at + 4, at + 4 + size), offset: at })
    at += 4 + pad4(size)
  }
  return { method, cls, transactionId: Buffer.from(frame.subarray(8, HEADER_BYTES)), attributes, raw: frame }
}

export const attr = (message: StunMessage, type: number): Buffer | undefined =>
  message.attributes.find((a) => a.type === type)?.value

export interface TransportAddress {
  address: string
  port: number
}

/** Decodes an XOR-*-ADDRESS value; IPv6 is reported with `family: 6` and no address, as this server relays IPv4 only. */
export function readXorAddress(value: Buffer): (TransportAddress & { family: 4 | 6 }) | null {
  if (value.length < 4) return null
  const family = value[1]
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16)
  if (family === 0x02 && value.length === 20) return { family: 6, address: '', port }
  if (family !== 0x01 || value.length !== 8) return null
  const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42])
  const bytes = [...value.subarray(4, 8)].map((b, i) => b ^ cookie[i]!)
  return { family: 4, address: bytes.join('.'), port }
}

export function xorAddressValue(address: string, port: number): Buffer {
  const value = Buffer.alloc(8)
  value.writeUInt8(0x01, 1)
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2)
  const cookie = [0x21, 0x12, 0xa4, 0x42]
  address.split('.').forEach((octet, i) => value.writeUInt8((Number(octet) ^ cookie[i]!) & 0xff, 4 + i))
  return value
}

export function u32(n: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n >>> 0, 0)
  return out
}

export function errorCodeValue(code: number, reason: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(reason, 'utf8')])
}

/** Builds a message; with `key` it appends MESSAGE-INTEGRITY, then always FINGERPRINT. */
export function buildStun(
  method: number,
  cls: StunClass,
  transactionId: Buffer,
  attributes: ReadonlyArray<readonly [number, Buffer]>,
  opts: { key?: Buffer; fingerprint?: boolean } = {}
): Buffer {
  const parts: Buffer[] = []
  for (const [type, value] of attributes) {
    const out = Buffer.alloc(4 + pad4(value.length))
    out.writeUInt16BE(type, 0)
    out.writeUInt16BE(value.length, 2)
    value.copy(out, 4)
    parts.push(out)
  }
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt16BE(messageType(method, cls), 0)
  header.writeUInt32BE(MAGIC_COOKIE, 4)
  transactionId.copy(header, 8)
  let message = Buffer.concat([header, ...parts])
  if (opts.key) {
    message.writeUInt16BE(message.length - HEADER_BYTES + 24, 2)
    const mac = createHmac('sha1', opts.key).update(message).digest()
    message = Buffer.concat([message, Buffer.from([0x00, 0x08, 0x00, 0x14]), mac])
  }
  if (opts.fingerprint !== false) {
    message.writeUInt16BE(message.length - HEADER_BYTES + 8, 2)
    const fingerprint = u32((crc32(message) ^ FINGERPRINT_XOR) >>> 0)
    message = Buffer.concat([message, Buffer.from([0x80, 0x28, 0x00, 0x04]), fingerprint])
  } else {
    message.writeUInt16BE(message.length - HEADER_BYTES, 2)
  }
  return message
}

/** Checks MESSAGE-INTEGRITY (HMAC-SHA1 over the message up to it, length adjusted to end after it). */
export function verifyIntegrity(message: StunMessage, key: Buffer): boolean {
  const integrity = message.attributes.find((a) => a.type === ATTR.messageIntegrity)
  if (!integrity || integrity.value.length !== 20) return false
  const signed = Buffer.from(message.raw.subarray(0, integrity.offset))
  signed.writeUInt16BE(integrity.offset - HEADER_BYTES + 24, 2)
  const expected = createHmac('sha1', key).update(signed).digest()
  return timingSafeEqual(expected, integrity.value)
}

/** One ChannelData frame; stream transports pad it to four bytes (RFC 8656 §12.5). */
export function channelData(channel: number, data: Buffer, stream: boolean): Buffer {
  const out = Buffer.alloc(4 + (stream ? pad4(data.length) : data.length))
  out.writeUInt16BE(channel, 0)
  out.writeUInt16BE(data.length, 2)
  data.copy(out, 4)
  return out
}

/** Splits a stream buffer into STUN / ChannelData frames; `rest` is an incomplete tail, `bad` a framing error. */
export function splitStreamFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer; bad: boolean } {
  const frames: Buffer[] = []
  let at = 0
  while (buffer.length - at >= 4) {
    const first = buffer[at]!
    let size: number
    if ((first & 0xc0) === 0x40) size = 4 + pad4(buffer.readUInt16BE(at + 2))
    else if ((first & 0xc0) === 0) size = HEADER_BYTES + buffer.readUInt16BE(at + 2)
    else return { frames, rest: Buffer.alloc(0), bad: true }
    if (buffer.length - at < size) break
    const frame = buffer.subarray(at, at + size)
    // A padded ChannelData frame is trimmed back to its declared length.
    frames.push((first & 0xc0) === 0x40 ? frame.subarray(0, 4 + frame.readUInt16BE(2)) : frame)
    at += size
  }
  return { frames, rest: buffer.subarray(at), bad: false }
}
