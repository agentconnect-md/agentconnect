import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { startStunServer, stunReply, type StunServer } from './stun-server.js'

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function request(transactionId: Buffer, attributes: Buffer = Buffer.alloc(0), type = 0x0001): Buffer {
  const header = Buffer.alloc(20)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(attributes.length, 2)
  header.writeUInt32BE(0x2112a442, 4)
  transactionId.copy(header, 8)
  return Buffer.concat([header, attributes])
}

function attrs(message: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  for (let at = 20; at < message.length;) {
    const type = message.readUInt16BE(at)
    const size = message.readUInt16BE(at + 2)
    out.set(type, message.subarray(at + 4, at + 4 + size))
    at += 4 + ((size + 3) & ~3)
  }
  return out
}

function mapped(message: Buffer): { address: string; port: number } {
  const value = attrs(message).get(0x0020)!
  const port = value.readUInt16BE(2) ^ 0x2112
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), message.subarray(8, 20)])
  const raw = [...value.subarray(4)].map((b, i) => b ^ mask[i]!)
  if (value[1] === 0x01) return { address: raw.join('.'), port }
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(((raw[i]! << 8) | raw[i + 1]!).toString(16))
  return { address: groups.join(':'), port }
}

describe('stunReply', () => {
  it('answers a Binding request with the sender’s address and port, XORed, and a valid fingerprint', () => {
    const tid = randomBytes(12)
    const reply = stunReply(request(tid), { address: '203.0.113.7', port: 54321 })!
    expect(reply.readUInt16BE(0)).toBe(0x0101)
    expect(reply.readUInt16BE(2)).toBe(reply.length - 20)
    expect(reply.subarray(8, 20).equals(tid)).toBe(true)
    expect(mapped(reply)).toEqual({ address: '203.0.113.7', port: 54321 })
    const fingerprint = attrs(reply).get(0x8028)!
    expect(fingerprint.readUInt32BE(0)).toBe((crc32(reply.subarray(0, reply.length - 8)) ^ 0x5354554e) >>> 0)
  })

  it('reports an IPv4-mapped sender as IPv4 and a real IPv6 sender as IPv6', () => {
    expect(mapped(stunReply(request(randomBytes(12)), { address: '::ffff:198.51.100.2', port: 3 })!)).toEqual({
      address: '198.51.100.2',
      port: 3
    })
    expect(mapped(stunReply(request(randomBytes(12)), { address: '2001:db8::1', port: 9 })!)).toEqual({
      address: '2001:db8:0:0:0:0:0:1',
      port: 9
    })
  })

  it('ignores the attributes an ICE agent sends and refuses an unknown comprehension-required one with 420', () => {
    const priority = Buffer.from([0x00, 0x24, 0x00, 0x04, 1, 2, 3, 4])
    expect(stunReply(request(randomBytes(12), priority), { address: '192.0.2.1', port: 1 })!.readUInt16BE(0)).toBe(
      0x0101
    )
    const changeRequest = Buffer.from([0x00, 0x03, 0x00, 0x04, 0, 0, 0, 6])
    const refused = stunReply(request(randomBytes(12), changeRequest), { address: '192.0.2.1', port: 1 })!
    expect(refused.readUInt16BE(0)).toBe(0x0111)
    const error = attrs(refused).get(0x0009)!
    expect(error[2]! * 100 + error[3]!).toBe(420)
    expect(attrs(refused).get(0x000a)!.readUInt16BE(0)).toBe(0x0003)
  })

  it('drops anything that is not a well-formed Binding request', () => {
    const from = { address: '192.0.2.1', port: 1 }
    const tid = randomBytes(12)
    expect(stunReply(Buffer.alloc(10), from)).toBeNull()
    expect(stunReply(request(tid, Buffer.alloc(0), 0x0101), from)).toBeNull()
    const noCookie = request(tid)
    noCookie.writeUInt32BE(0, 4)
    expect(stunReply(noCookie, from)).toBeNull()
    const badLength = request(tid)
    badLength.writeUInt16BE(8, 2)
    expect(stunReply(badLength, from)).toBeNull()
    const truncated = request(tid, Buffer.from([0x80, 0x22, 0x00, 0x20, 0, 0, 0, 0]))
    expect(stunReply(truncated, from)).toBeNull()
    expect(stunReply(Buffer.alloc(600), from)).toBeNull()
  })
})

describe('startStunServer', () => {
  let server: StunServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('answers over UDP with the client’s source address', async () => {
    server = await startStunServer({ host: '127.0.0.1', port: 0, log: quiet })
    const client = createSocket('udp4')
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve))
    const reply = await new Promise<Buffer>((resolve) => {
      client.once('message', resolve)
      client.send(request(randomBytes(12)), server!.port, '127.0.0.1')
    })
    expect(mapped(reply)).toEqual({ address: '127.0.0.1', port: client.address().port })
    client.close()
  })
})
