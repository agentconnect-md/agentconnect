// A minimal X11 protocol client: just the requests the local controls need (computer-use.md §6), no libX11 binding.
import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export type DisplayAddress = { path: string; number: number } | { host: string; port: number; number: number }

/** Parses DISPLAY (`:0`, `:0.0`, `unix:1`, `host:10.0`) into the socket it names. */
export function parseDisplay(display: string | undefined): DisplayAddress | undefined {
  const match = /^([^:]*):(\d+)(?:\.\d+)?$/.exec(display ?? '')
  if (!match) return undefined
  const host = match[1] ?? ''
  const number = Number(match[2])
  if (host === '' || host === 'unix') return { path: `/tmp/.X11-unix/X${number}`, number }
  return { host, port: 6000 + number, number }
}

const FAMILY_LOCAL = 256
const FAMILY_WILD = 65535
const COOKIE = 'MIT-MAGIC-COOKIE-1'

/** The MIT-MAGIC-COOKIE-1 for a display from an Xauthority file; local entries for this host win. */
export function xauthCookie(file: Buffer, number: number, host = hostname()): Buffer | undefined {
  let offset = 0
  let fallback: Buffer | undefined
  const field = (): Buffer => {
    const length = file.readUInt16BE(offset)
    const value = file.subarray(offset + 2, offset + 2 + length)
    offset += 2 + length
    return value
  }
  try {
    while (offset < file.length) {
      const family = file.readUInt16BE(offset)
      offset += 2
      const address = field().toString('latin1')
      const display = field().toString('latin1')
      const name = field().toString('latin1')
      const data = field()
      if (name !== COOKIE || (display !== '' && display !== String(number))) continue
      if (family === FAMILY_WILD || (family === FAMILY_LOCAL && address === host)) return Buffer.from(data)
      fallback ??= Buffer.from(data)
    }
  } catch {
    // A truncated file yields what was read before the damage.
  }
  return fallback
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4

export class X11Error extends Error {
  constructor(
    readonly code: number,
    readonly sequence: number
  ) {
    super(`X11 error ${code} (request ${sequence})`)
    this.name = 'X11Error'
  }
}

interface Pending {
  resolve: (reply: Buffer) => void
  reject: (error: Error) => void
}

export interface X11Setup {
  root: number
  minKeycode: number
  maxKeycode: number
}

// One connection; replies resolve by sequence number and everything else goes to the event listener.
export class X11Connection {
  private buffer: Buffer = Buffer.alloc(0)
  private sequence = 0
  private readonly pending = new Map<number, Pending>()
  private readonly errors = new Map<number, X11Error>()
  private closed = false
  private onEvent: (event: Buffer) => void = () => undefined
  private onClose: (error?: Error) => void = () => undefined

  private constructor(
    private readonly socket: Socket,
    readonly setup: X11Setup
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', (error) => this.close(error))
    socket.on('close', () => this.close())
  }

  static async connect(
    options: { display?: string; xauthority?: string; timeoutMs?: number; socketPath?: string } = {}
  ): Promise<X11Connection> {
    const address = parseDisplay(options.display ?? process.env.DISPLAY)
    if (!address) throw new Error('DISPLAY is not set to an X11 display')
    const authFile = options.xauthority ?? process.env.XAUTHORITY ?? join(homedir(), '.Xauthority')
    let cookie: Buffer | undefined
    try {
      cookie = xauthCookie(readFileSync(authFile), address.number)
    } catch {
      // No Xauthority: the server may still accept this user (SI:localuser).
    }
    const socket = options.socketPath
      ? createConnection(options.socketPath)
      : 'path' in address
        ? createConnection(address.path)
        : createConnection(address.port, address.host)
    socket.setNoDelay(true)
    const timeoutMs = options.timeoutMs ?? 5000
    const setup = await new Promise<{ setup: X11Setup; rest: Buffer }>((resolve, reject) => {
      let data = Buffer.alloc(0)
      const timer = setTimeout(() => fail(new Error('X11 connection setup timed out')), timeoutMs)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.destroy()
        reject(error)
      }
      const onData = (chunk: Buffer): void => {
        data = Buffer.concat([data, chunk])
        if (data.length < 8) return
        const total = 8 + data.readUInt16LE(6) * 4
        if (data.length < total) return
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', fail)
        if (data[0] !== 1) {
          const reason = data.subarray(8, 8 + (data[1] ?? 0)).toString('latin1')
          socket.destroy()
          return reject(new Error(`X11 server refused the connection: ${reason || 'authorization required'}`))
        }
        try {
          resolve({ setup: parseSetup(data.subarray(0, total)), rest: data.subarray(total) })
        } catch (error) {
          fail(error as Error)
        }
      }
      socket.once('error', fail)
      socket.on('data', onData)
      socket.write(setupRequest(cookie))
    })
    const connection = new X11Connection(socket, setup.setup)
    if (setup.rest.length) connection.receive(setup.rest)
    return connection
  }

  listen(listener: (event: Buffer) => void): void {
    this.onEvent = listener
  }

  whenClosed(listener: (error?: Error) => void): void {
    this.onClose = listener
  }

  /** Sends a request that has a reply and resolves with the whole reply. */
  request(body: Buffer): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('X11 connection closed'))
    const sequence = this.send(body)
    return new Promise((resolve, reject) => this.pending.set(sequence, { resolve, reject }))
  }

  /** Sends a request without a reply; resolves once the server processed it, rejecting with its error. */
  async checked(body: Buffer): Promise<void> {
    const sequence = this.send(body)
    // GetInputFocus has a reply, so its arrival means every earlier request was handled.
    await this.request(request(43, 0, Buffer.alloc(0)))
    const error = this.errors.get(sequence)
    this.errors.delete(sequence)
    if (error) throw error
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    for (const pending of this.pending.values()) pending.reject(error ?? new Error('X11 connection closed'))
    this.pending.clear()
    this.onClose(error)
  }

  private send(body: Buffer): number {
    this.sequence = (this.sequence + 1) & 0xffff
    this.socket.write(body)
    return this.sequence
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0]! & 0x7f
      const total = kind === 1 || kind === 35 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32
      if (this.buffer.length < total) return
      const message = this.buffer.subarray(0, total)
      this.buffer = this.buffer.subarray(total)
      this.dispatch(kind, message)
    }
  }

  private dispatch(kind: number, message: Buffer): void {
    const sequence = message.readUInt16LE(2)
    if (kind === 1 || kind === 0) {
      const pending = this.pending.get(sequence)
      if (pending) {
        this.pending.delete(sequence)
        if (kind === 1) pending.resolve(Buffer.from(message))
        else pending.reject(new X11Error(message[1]!, sequence))
        return
      }
      if (kind === 0) {
        this.errors.set(sequence, new X11Error(message[1]!, sequence))
        // Errors of unchecked requests are kept only briefly.
        if (this.errors.size > 64) this.errors.delete(this.errors.keys().next().value!)
      }
      return
    }
    this.onEvent(Buffer.from(message))
  }
}

function setupRequest(cookie: Buffer | undefined): Buffer {
  const name = cookie ? Buffer.from(COOKIE, 'latin1') : Buffer.alloc(0)
  const data = cookie ?? Buffer.alloc(0)
  const out = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length))
  out.write('l', 0, 'latin1')
  out.writeUInt16LE(11, 2)
  out.writeUInt16LE(0, 4)
  out.writeUInt16LE(name.length, 6)
  out.writeUInt16LE(data.length, 8)
  name.copy(out, 12)
  data.copy(out, 12 + name.length + pad4(name.length))
  return out
}

/** Reads the parts of the server's setup reply the local controls use: the first screen's root and the keycode range. */
export function parseSetup(reply: Buffer): X11Setup {
  const vendorLength = reply.readUInt16LE(24)
  const formats = reply[29]!
  const minKeycode = reply[34]!
  const maxKeycode = reply[35]!
  const screens = 40 + vendorLength + pad4(vendorLength) + formats * 8
  if (reply.length < screens + 4) throw new Error('X11 setup reply has no screen')
  return { root: reply.readUInt32LE(screens), minKeycode, maxKeycode }
}

/** Encodes a core or extension request: opcode, minor byte (or data byte), length, then the body. */
export function request(opcode: number, minor: number, body: Buffer): Buffer {
  const out = Buffer.alloc(4 + body.length + pad4(body.length))
  out[0] = opcode
  out[1] = minor
  out.writeUInt16LE(out.length / 4, 2)
  body.copy(out, 4)
  return out
}

export const OP_GRAB_KEY = 33
export const OP_QUERY_EXTENSION = 98
export const OP_GET_KEYBOARD_MAPPING = 101
export const OP_GET_MODIFIER_MAPPING = 119

/** QueryExtension: the extension's major opcode, or undefined when the server lacks it. */
export async function queryExtension(x: X11Connection, name: string): Promise<number | undefined> {
  const bytes = Buffer.from(name, 'latin1')
  const body = Buffer.alloc(4 + bytes.length)
  body.writeUInt16LE(bytes.length, 0)
  bytes.copy(body, 4)
  const reply = await x.request(request(OP_QUERY_EXTENSION, 0, body))
  return reply[8] ? reply[9] : undefined
}
