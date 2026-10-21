// A minimal D-Bus client (EXTERNAL auth, marshalling, calls, signals, exported objects) for the tray; no libdbus binding.
import { createConnection, type Socket } from 'node:net'

/** A D-Bus variant: a value tagged with its single complete type. */
export class Variant {
  constructor(
    readonly signature: string,
    readonly value: unknown
  ) {}
}

const ALIGN: Record<string, number> = {
  y: 1,
  g: 1,
  v: 1,
  n: 2,
  q: 2,
  b: 4,
  i: 4,
  u: 4,
  s: 4,
  o: 4,
  a: 4,
  h: 4,
  x: 8,
  t: 8,
  d: 8,
  '(': 8,
  '{': 8
}

/** Index just past the single complete type that starts at `start`. */
export function typeEnd(signature: string, start: number): number {
  const c = signature[start]
  if (c === undefined) throw new Error(`truncated signature ${signature}`)
  if (c === 'a') return typeEnd(signature, start + 1)
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}'
    let i = start + 1
    while (signature[i] !== close) {
      if (i >= signature.length) throw new Error(`unbalanced signature ${signature}`)
      i = typeEnd(signature, i)
    }
    return i + 1
  }
  if (!(c in ALIGN)) throw new Error(`unsupported type ${c} in ${signature}`)
  return start + 1
}

/** Splits a signature into its single complete types. */
export function splitSignature(signature: string): string[] {
  const types: string[] = []
  for (let i = 0; i < signature.length;) {
    const end = typeEnd(signature, i)
    types.push(signature.slice(i, end))
    i = end
  }
  return types
}

// Dictionaries are written from a Map, an array of [key, value] pairs, or a plain object.
const entries = (value: unknown): [unknown, unknown][] =>
  value instanceof Map
    ? [...value.entries()]
    : Array.isArray(value)
      ? (value as [unknown, unknown][])
      : Object.entries(value as Record<string, unknown>)

export class Writer {
  private buffer = Buffer.alloc(256)
  length = 0

  private ensure(size: number): void {
    if (this.length + size <= this.buffer.length) return
    const next = Buffer.alloc(Math.max(this.buffer.length * 2, this.length + size))
    this.buffer.copy(next, 0, 0, this.length)
    this.buffer = next
  }

  align(n: number): void {
    const padding = (n - (this.length % n)) % n
    this.ensure(padding)
    this.buffer.fill(0, this.length, this.length + padding)
    this.length += padding
  }

  bytes(): Buffer {
    return this.buffer.subarray(0, this.length)
  }

  private raw(data: Buffer): void {
    this.ensure(data.length)
    data.copy(this.buffer, this.length)
    this.length += data.length
  }

  private u32(value: number, at = this.length): void {
    if (at === this.length) {
      this.ensure(4)
      this.length += 4
    }
    this.buffer.writeUInt32LE(value >>> 0, at)
  }

  writeAll(signature: string, values: unknown[]): void {
    splitSignature(signature).forEach((type, i) => this.write(type, values[i]))
  }

  write(type: string, value: unknown): void {
    const c = type[0]!
    this.align(ALIGN[c]!)
    switch (c) {
      case 'y':
        this.ensure(1)
        this.buffer[this.length++] = Number(value) & 0xff
        return
      case 'b':
        return this.u32(value ? 1 : 0)
      case 'n':
      case 'q':
        this.ensure(2)
        if (c === 'n') this.buffer.writeInt16LE(Number(value), this.length)
        else this.buffer.writeUInt16LE(Number(value), this.length)
        this.length += 2
        return
      case 'i':
        this.ensure(4)
        this.buffer.writeInt32LE(Number(value), this.length)
        this.length += 4
        return
      case 'u':
      case 'h':
        return this.u32(Number(value))
      case 'x':
      case 't':
        this.ensure(8)
        if (c === 'x') this.buffer.writeBigInt64LE(BigInt(value as number), this.length)
        else this.buffer.writeBigUInt64LE(BigInt(value as number), this.length)
        this.length += 8
        return
      case 'd':
        this.ensure(8)
        this.buffer.writeDoubleLE(Number(value), this.length)
        this.length += 8
        return
      case 's':
      case 'o': {
        const data = Buffer.from(String(value), 'utf8')
        this.u32(data.length)
        this.raw(data)
        return this.raw(Buffer.from([0]))
      }
      case 'g': {
        const data = Buffer.from(String(value), 'latin1')
        this.raw(Buffer.from([data.length]))
        this.raw(data)
        return this.raw(Buffer.from([0]))
      }
      case 'v': {
        const variant = value as Variant
        this.write('g', variant.signature)
        return this.write(variant.signature, variant.value)
      }
      case 'a': {
        const element = type.slice(1)
        const lengthAt = this.length
        this.u32(0)
        this.align(ALIGN[element[0]!]!)
        const start = this.length
        if (element === 'y' && Buffer.isBuffer(value)) this.raw(value)
        else if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1))
          for (const [k, v] of entries(value)) {
            this.align(8)
            this.write(keyType!, k)
            this.write(valueType!, v)
          }
        } else for (const item of value as unknown[]) this.write(element, item)
        return this.u32(this.length - start, lengthAt)
      }
      case '(':
        return this.writeAll(type.slice(1, -1), value as unknown[])
      default:
        throw new Error(`cannot write type ${type}`)
    }
  }
}

export class Reader {
  offset: number
  constructor(
    private readonly buffer: Buffer,
    private readonly littleEndian = true,
    start = 0
  ) {
    this.offset = start
  }

  align(n: number): void {
    this.offset += (n - (this.offset % n)) % n
  }

  private need(size: number): void {
    if (this.offset + size > this.buffer.length) throw new Error('D-Bus message truncated')
  }

  private u32(): number {
    this.need(4)
    const value = this.littleEndian ? this.buffer.readUInt32LE(this.offset) : this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    return value
  }

  readAll(signature: string): unknown[] {
    return splitSignature(signature).map((type) => this.read(type))
  }

  read(type: string): unknown {
    const c = type[0]!
    this.align(ALIGN[c]!)
    const le = this.littleEndian
    const b = this.buffer
    switch (c) {
      case 'y':
        this.need(1)
        return b[this.offset++]
      case 'b':
        return this.u32() !== 0
      case 'n':
      case 'q': {
        this.need(2)
        const value =
          c === 'n'
            ? le
              ? b.readInt16LE(this.offset)
              : b.readInt16BE(this.offset)
            : le
              ? b.readUInt16LE(this.offset)
              : b.readUInt16BE(this.offset)
        this.offset += 2
        return value
      }
      case 'i': {
        this.need(4)
        const value = le ? b.readInt32LE(this.offset) : b.readInt32BE(this.offset)
        this.offset += 4
        return value
      }
      case 'u':
      case 'h':
        return this.u32()
      case 'x':
      case 't': {
        this.need(8)
        const value =
          c === 'x'
            ? le
              ? b.readBigInt64LE(this.offset)
              : b.readBigInt64BE(this.offset)
            : le
              ? b.readBigUInt64LE(this.offset)
              : b.readBigUInt64BE(this.offset)
        this.offset += 8
        return Number(value)
      }
      case 'd': {
        this.need(8)
        const value = le ? b.readDoubleLE(this.offset) : b.readDoubleBE(this.offset)
        this.offset += 8
        return value
      }
      case 's':
      case 'o': {
        const length = this.u32()
        this.need(length + 1)
        const value = b.toString('utf8', this.offset, this.offset + length)
        this.offset += length + 1
        return value
      }
      case 'g': {
        this.need(1)
        const length = b[this.offset]!
        this.need(length + 2)
        const value = b.toString('latin1', this.offset + 1, this.offset + 1 + length)
        this.offset += length + 2
        return value
      }
      case 'v': {
        const signature = this.read('g') as string
        return new Variant(signature, this.read(signature))
      }
      case 'a': {
        const element = type.slice(1)
        const length = this.u32()
        this.align(ALIGN[element[0]!]!)
        const end = this.offset + length
        if (end > b.length) throw new Error('D-Bus array overruns the message')
        if (element === 'y') {
          const value = Buffer.from(b.subarray(this.offset, end))
          this.offset = end
          return value
        }
        const items: unknown[] = []
        if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1))
          while (this.offset < end) {
            this.align(8)
            items.push([this.read(keyType!), this.read(valueType!)])
          }
        } else while (this.offset < end) items.push(this.read(element))
        return items
      }
      case '(':
        return this.readAll(type.slice(1, -1))
      default:
        throw new Error(`cannot read type ${type}`)
    }
  }
}

export const MessageType = { MethodCall: 1, MethodReturn: 2, Error: 3, Signal: 4 } as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export interface Message {
  type: MessageType
  flags: number
  serial: number
  path?: string
  interface?: string
  member?: string
  errorName?: string
  replySerial?: number
  destination?: string
  sender?: string
  signature: string
  body: unknown[]
}

const FIELD = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8
}
const FIELD_TYPES: Record<number, string> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' }
export const NO_REPLY_EXPECTED = 1

export function encodeMessage(message: Omit<Message, 'serial'> & { serial: number }): Buffer {
  const body = new Writer()
  if (message.signature) body.writeAll(message.signature, message.body)
  const fields: [number, Variant][] = []
  for (const [name, code] of Object.entries(FIELD) as [keyof typeof FIELD, number][]) {
    const value = name === 'signature' ? message.signature || undefined : message[name]
    if (value !== undefined) fields.push([code, new Variant(FIELD_TYPES[code]!, value)])
  }
  const header = new Writer()
  header.write('y', 0x6c)
  header.write('y', message.type)
  header.write('y', message.flags)
  header.write('y', 1)
  header.write('u', body.length)
  header.write('u', message.serial)
  header.write('a(yv)', fields)
  header.align(8)
  return Buffer.concat([header.bytes(), body.bytes()])
}

/** Total length of the message at the start of the buffer, or undefined until its fixed header has arrived. */
export function messageLength(buffer: Buffer): number | undefined {
  if (buffer.length < 16) return undefined
  const le = buffer[0] === 0x6c
  const body = le ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4)
  const fields = le ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12)
  return 16 + fields + ((8 - ((16 + fields) % 8)) % 8) + body
}

export function decodeMessage(buffer: Buffer): Message {
  const le = buffer[0] === 0x6c
  const reader = new Reader(buffer, le, 4)
  const bodyLength = reader.read('u') as number
  const serial = reader.read('u') as number
  const fields = reader.read('a(yv)') as [number, Variant][]
  reader.align(8)
  const message: Message = { type: buffer[1]! as MessageType, flags: buffer[2]!, serial, signature: '', body: [] }
  const names = Object.fromEntries(Object.entries(FIELD).map(([name, code]) => [code, name])) as Record<
    number,
    keyof typeof FIELD
  >
  for (const [code, variant] of fields) {
    const name = names[code]
    if (name) (message as unknown as Record<string, unknown>)[name] = variant.value
  }
  if (message.signature && bodyLength > 0) {
    // Body alignment is relative to the message start, which the reader's offsets already are.
    message.body = new Reader(buffer.subarray(0, reader.offset + bodyLength), le, reader.offset).readAll(
      message.signature
    )
  }
  return message
}

export class DBusError extends Error {
  constructor(
    readonly errorName: string,
    message: string
  ) {
    super(`${errorName}: ${message}`)
    this.name = 'DBusError'
  }
}

/** The socket path a bus address names (`unix:path=…` or `unix:abstract=…`); the first usable entry wins. */
export function busSocketPath(address: string | undefined): string | undefined {
  for (const entry of (address ?? '').split(';')) {
    const [transport, params] = entry.split(/:(.*)/s)
    if (transport !== 'unix' || !params) continue
    const values = Object.fromEntries(
      params.split(',').map((pair) => {
        const [key, value = ''] = pair.split(/=(.*)/s)
        return [key, decodeURIComponent(value)]
      })
    )
    if (values.path) return values.path
    if (values.abstract) return `\0${values.abstract}`
  }
  return undefined
}

export type CallHandler = (message: Message) => { signature: string; body: unknown[] } | undefined

interface PendingCall {
  resolve: (message: Message) => void
  reject: (error: Error) => void
}

export class DBusConnection {
  uniqueName = ''
  private serial = 0
  private buffer: Buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingCall>()
  private closed = false
  private handler: CallHandler = () => undefined
  private signalListener: (message: Message) => void = () => undefined
  private closeListener: () => void = () => undefined

  private constructor(
    private readonly socket: Socket,
    private readonly callTimeoutMs: number
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
  }

  static async session(
    address = process.env.DBUS_SESSION_BUS_ADDRESS,
    uid = process.getuid?.() ?? 0,
    timeoutMs = 5000
  ): Promise<DBusConnection> {
    const path = busSocketPath(address)
    if (!path) throw new Error('no session bus (DBUS_SESSION_BUS_ADDRESS is unset or not a unix socket)')
    const socket = createConnection(path)
    await new Promise<void>((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => fail(new Error('D-Bus authentication timed out')), timeoutMs)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      const onData = (chunk: Buffer): void => {
        data += chunk.toString('latin1')
        if (!data.includes('\r\n')) return
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', fail)
        if (!data.startsWith('OK ')) return fail(new Error(`D-Bus refused authentication: ${data.trim()}`))
        socket.write('BEGIN\r\n')
        resolve()
      }
      socket.once('error', fail)
      socket.on('data', onData)
      socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid), 'latin1').toString('hex')}\r\n`)
    })
    const connection = new DBusConnection(socket, timeoutMs)
    const hello = await connection.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'Hello'
    })
    connection.uniqueName = String(hello[0])
    return connection
  }

  /** Serves incoming method calls; a handler that returns undefined answers UnknownMethod. */
  serve(handler: CallHandler): void {
    this.handler = handler
  }

  onSignal(listener: (message: Message) => void): void {
    this.signalListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  async call(call: {
    destination: string
    path: string
    interface: string
    member: string
    signature?: string
    body?: unknown[]
    timeoutMs?: number
  }): Promise<unknown[]> {
    if (this.closed) throw new Error('D-Bus connection closed')
    const serial = this.nextSerial()
    const timeoutMs = call.timeoutMs ?? this.callTimeoutMs
    const reply = new Promise<Message>((resolve, reject) => {
      // The bus's default reply timeout is unbounded, so a hung peer would otherwise stall the caller forever.
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(
          new Error(
            `D-Bus call ${call.interface}.${call.member} to ${call.destination} timed out after ${timeoutMs} ms`
          )
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(serial, {
        resolve: (message) => (clearTimeout(timer), resolve(message)),
        reject: (error) => (clearTimeout(timer), reject(error))
      })
    })
    this.socket.write(
      encodeMessage({
        type: MessageType.MethodCall,
        flags: 0,
        serial,
        destination: call.destination,
        path: call.path,
        interface: call.interface,
        member: call.member,
        signature: call.signature ?? '',
        body: call.body ?? []
      })
    )
    const message = await reply
    if (message.type === MessageType.Error) {
      throw new DBusError(message.errorName ?? 'org.freedesktop.DBus.Error.Failed', String(message.body[0] ?? ''))
    }
    return message.body
  }

  emit(signal: { path: string; interface: string; member: string; signature?: string; body?: unknown[] }): void {
    if (this.closed) return
    this.socket.write(
      encodeMessage({
        type: MessageType.Signal,
        flags: NO_REPLY_EXPECTED,
        serial: this.nextSerial(),
        path: signal.path,
        interface: signal.interface,
        member: signal.member,
        signature: signal.signature ?? '',
        body: signal.body ?? []
      })
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    for (const pending of this.pending.values()) pending.reject(new Error('D-Bus connection closed'))
    this.pending.clear()
    this.closeListener()
  }

  private nextSerial(): number {
    this.serial = this.serial >= 0xffffffff ? 1 : this.serial + 1
    return this.serial
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const length = messageLength(this.buffer)
      if (length === undefined || this.buffer.length < length) return
      const raw = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      let message: Message
      try {
        message = decodeMessage(raw)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Message): void {
    if (message.type === MessageType.MethodReturn || message.type === MessageType.Error) {
      const pending = message.replySerial === undefined ? undefined : this.pending.get(message.replySerial)
      if (!pending) return
      this.pending.delete(message.replySerial!)
      return pending.resolve(message)
    }
    if (message.type === MessageType.Signal) return this.signalListener(message)
    if (message.type !== MessageType.MethodCall) return
    let reply: { signature: string; body: unknown[] } | undefined
    let failure: DBusError | undefined
    try {
      reply = this.handler(message)
      if (!reply)
        failure = new DBusError(
          'org.freedesktop.DBus.Error.UnknownMethod',
          `${message.interface ?? ''}.${message.member ?? ''}`
        )
    } catch (error) {
      failure = error instanceof DBusError ? error : new DBusError('org.freedesktop.DBus.Error.Failed', String(error))
    }
    if (message.flags & NO_REPLY_EXPECTED || !message.sender) return
    this.socket.write(
      encodeMessage({
        type: failure ? MessageType.Error : MessageType.MethodReturn,
        flags: NO_REPLY_EXPECTED,
        serial: this.nextSerial(),
        replySerial: message.serial,
        destination: message.sender,
        ...(failure ? { errorName: failure.errorName } : {}),
        signature: failure ? 's' : reply!.signature,
        body: failure ? [failure.message] : reply!.body
      })
    )
  }
}
