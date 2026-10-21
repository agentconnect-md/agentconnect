import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { X11Connection, parseDisplay, parseSetup, xauthCookie } from './x11.js'
import { X11LocalControls, eventMask, keycodeFor, numLockMask, parseHotkey, xtestDevices } from './x11-local.js'

const XI = 131
const ROOT = 0x100

function reply(sequence: number, body: Buffer = Buffer.alloc(24), first = 0): Buffer {
  const out = Buffer.alloc(8 + Math.max(24, body.length))
  out[0] = 1
  out[1] = first
  out.writeUInt16LE(sequence, 2)
  out.writeUInt32LE((out.length - 32) / 4, 4)
  body.copy(out, 8)
  return out
}

function devices(list: [number, string][]): Buffer {
  const parts = list.map(([id, name]) => {
    const bytes = Buffer.from(name)
    const padded = bytes.length + ((4 - (bytes.length % 4)) % 4)
    const out = Buffer.alloc(12 + padded + 8)
    out.writeUInt16LE(id, 0)
    out.writeUInt16LE(1, 6)
    out.writeUInt16LE(bytes.length, 8)
    bytes.copy(out, 12)
    // One class of two 4-byte units.
    out.writeUInt16LE(2, 12 + padded + 2)
    return out
  })
  const head = Buffer.alloc(24)
  head.writeUInt16LE(list.length, 0)
  return Buffer.concat([head, ...parts])
}

const KEYSYMS = [
  [0x61, 0x41],
  [0xff1b, 0],
  [0xff7f, 0],
  [0xffe3, 0],
  [0x31, 0]
]

// A fake X server that speaks just enough of the protocol for X11LocalControls.
class FakeX {
  readonly path = join(tmpdir(), `x11-${randomBytes(6).toString('hex')}.sock`)
  readonly grabs: { modifiers: number; keycode: number }[] = []
  selected = false
  client: Socket | undefined
  sequence = 0
  private server: Server

  constructor(readonly options: { xinput?: boolean; grabTaken?: boolean; takenAfter?: number } = {}) {
    this.server = createServer((socket) => this.serve(socket))
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve))
  }

  close(): void {
    this.client?.destroy()
    this.server.close()
  }

  send(event: Buffer): void {
    event.writeUInt16LE(this.sequence, 2)
    this.client!.write(event)
  }

  raw(evtype: number, sourceid: number): void {
    const event = Buffer.alloc(40)
    event[0] = 35
    event[1] = XI
    event.writeUInt32LE(2, 4)
    event.writeUInt16LE(evtype, 8)
    event.writeUInt16LE(3, 10)
    event.writeUInt16LE(sourceid, 20)
    this.send(event)
  }

  keyPress(keycode: number): void {
    const event = Buffer.alloc(32)
    event[0] = 2
    event[1] = keycode
    event.writeUInt32LE(ROOT, 8)
    this.send(event)
  }

  private serve(socket: Socket): void {
    this.client = socket
    let buffer = Buffer.alloc(0)
    let setUp = false
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!setUp) {
        if (buffer.length < 12) return
        const length = 12 + buffer.readUInt16LE(6) + buffer.readUInt16LE(8)
        buffer = buffer.subarray(length + ((4 - (length % 4)) % 4))
        setUp = true
        const setup = Buffer.alloc(84)
        setup[0] = 1
        setup.writeUInt16LE(11, 2)
        setup.writeUInt16LE((84 - 8) / 4, 6)
        setup.writeUInt16LE(4, 24)
        setup[28] = 1
        setup[34] = 8
        setup[35] = 12
        setup.write('fake', 40)
        setup.writeUInt32LE(ROOT, 44)
        socket.write(setup)
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4
        if (buffer.length < length) return
        this.handle(socket, buffer.subarray(0, length))
        buffer = buffer.subarray(length)
      }
    })
  }

  private handle(socket: Socket, request: Buffer): void {
    const sequence = ++this.sequence
    const [opcode, minor] = [request[0], request[1]]
    if (opcode === 98) {
      const body = Buffer.alloc(24)
      body[0] = this.options.xinput === false ? 0 : 1
      body[1] = XI
      return void socket.write(reply(sequence, body))
    }
    if (opcode === XI && minor === 47) {
      const body = Buffer.alloc(24)
      body.writeUInt16LE(2, 0)
      body.writeUInt16LE(2, 2)
      return void socket.write(reply(sequence, body))
    }
    if (opcode === XI && minor === 48) {
      const body = devices([
        [2, 'Virtual core pointer'],
        [3, 'Virtual core keyboard'],
        [4, 'Virtual core XTEST pointer'],
        [5, 'Virtual core XTEST keyboard'],
        [9, 'AT keyboard']
      ])
      return void socket.write(reply(sequence, body))
    }
    if (opcode === XI && minor === 46) {
      this.selected = request.readUInt32LE(4) === ROOT
      return
    }
    if (opcode === 43) return void socket.write(reply(sequence))
    if (opcode === 101) {
      const body = Buffer.alloc(24 + KEYSYMS.length * 8)
      KEYSYMS.flat().forEach((keysym, i) => body.writeUInt32LE(keysym, 24 + i * 4))
      return void socket.write(reply(sequence, body, 2))
    }
    if (opcode === 119) {
      // One keycode per modifier: Control on 11 (Control_L), Mod2 on 10 (Num_Lock).
      const body = Buffer.alloc(24 + 8)
      body[24 + 2] = 11
      body[24 + 4] = 10
      return void socket.write(reply(sequence, body, 1))
    }
    if (opcode === 34) {
      const modifiers = request.readUInt16LE(8)
      const index = this.grabs.findIndex((grab) => grab.keycode === request[1] && grab.modifiers === modifiers)
      if (index >= 0) this.grabs.splice(index, 1)
      return
    }
    if (opcode === 33) {
      if (this.options.grabTaken || this.options.takenAfter === this.grabs.length) {
        const error = Buffer.alloc(32)
        error[1] = 10
        error.writeUInt16LE(sequence, 2)
        return void socket.write(error)
      }
      this.grabs.push({ modifiers: request.readUInt16LE(8), keycode: request[10]! })
    }
  }
}

const servers: FakeX[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function start(options: ConstructorParameters<typeof FakeX>[0] = {}, hotkey = 'Ctrl+Escape') {
  const x = new FakeX(options)
  servers.push(x)
  await x.listen()
  const seen = { human: 0, stop: 0 }
  const controls = await X11LocalControls.start({
    hotkey: parseHotkey(hotkey),
    onHumanInput: () => seen.human++,
    onStopHotkey: () => seen.stop++,
    log: () => undefined,
    connect: () => X11Connection.connect({ display: ':0', socketPath: x.path, xauthority: '/nonexistent' })
  })
  return { x, controls, seen }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe.skipIf(process.platform === 'win32')('X11LocalControls', () => {
  it('counts raw keys and buttons from real devices, never from XTEST', async () => {
    const { x, controls, seen } = await start()
    expect(controls.keyboardProblem).toBeUndefined()
    expect(x.selected).toBe(true)
    x.raw(13, 5)
    x.raw(15, 4)
    await settle()
    expect(seen.human).toBe(0)
    x.raw(13, 9)
    x.raw(15, 9)
    await settle()
    expect(seen.human).toBe(2)
    controls.close()
  })

  it('grabs the hotkey under every Caps Lock and Num Lock state and stops once per press', async () => {
    const { x, controls, seen } = await start()
    expect(controls.hotkeyProblem).toBeUndefined()
    expect(x.grabs).toEqual([
      { modifiers: 4, keycode: 9 },
      { modifiers: 4 | 2, keycode: 9 },
      { modifiers: 4 | 16, keycode: 9 },
      { modifiers: 4 | 2 | 16, keycode: 9 }
    ])
    x.keyPress(9)
    x.keyPress(9)
    await settle()
    expect(seen.stop).toBe(1)
    x.keyPress(8)
    await settle()
    expect(seen.stop).toBe(1)
    controls.close()
  })

  it('reports a hotkey another app holds and a server without XInput', async () => {
    const taken = await start({ grabTaken: true })
    expect(taken.controls.hotkeyProblem).toBe('Ctrl+Escape is taken by another app')
    taken.controls.close()
    const partly = await start({ takenAfter: 2 })
    expect(partly.controls.hotkeyProblem).toBe('Ctrl+Escape is taken by another app')
    expect(partly.x.grabs).toEqual([])
    partly.controls.close()
    const bare = await start({ xinput: false })
    expect(bare.controls.keyboardProblem).toBe('the X server has no XInput extension')
    expect(bare.controls.hotkeyProblem).toBeUndefined()
    bare.controls.close()
  })

  it('reports a key the keyboard cannot produce', async () => {
    const { controls } = await start({}, 'Ctrl+F9')
    expect(controls.hotkeyProblem).toBe('no key on this keyboard produces Ctrl+F9')
    controls.close()
  })
})

describe('X11 parsing', () => {
  it('parses DISPLAY values', () => {
    expect(parseDisplay(':0')).toEqual({ path: '/tmp/.X11-unix/X0', number: 0 })
    expect(parseDisplay('unix:1.0')).toEqual({ path: '/tmp/.X11-unix/X1', number: 1 })
    expect(parseDisplay('localhost:10.0')).toEqual({ host: 'localhost', port: 6010, number: 10 })
    expect(parseDisplay(undefined)).toBeUndefined()
    expect(parseDisplay('wayland-0')).toBeUndefined()
  })

  it('picks the local cookie for the display from an Xauthority file', () => {
    const entry = (family: number, address: string, display: string, data: string): Buffer => {
      const field = (value: Buffer) => Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value])
      return Buffer.concat([
        Buffer.from([family >> 8, family & 0xff]),
        field(Buffer.from(address)),
        field(Buffer.from(display)),
        field(Buffer.from('MIT-MAGIC-COOKIE-1')),
        field(Buffer.from(data))
      ])
    }
    const file = Buffer.concat([
      entry(256, 'host', '1', 'other-display'),
      entry(0, '1.2.3.4', '0', 'remote'),
      entry(256, 'host', '0', 'local')
    ])
    expect(xauthCookie(file, 0, 'host')?.toString()).toBe('local')
    expect(xauthCookie(file, 0, 'elsewhere')?.toString()).toBe('remote')
    expect(xauthCookie(file, 7, 'host')).toBeUndefined()
    expect(xauthCookie(file.subarray(0, 10), 0, 'host')).toBeUndefined()
  })

  it('reads the root window past the vendor and formats', () => {
    const setup = Buffer.alloc(8 + 32 + 8 + 16 + 40)
    setup.writeUInt16LE(5, 24)
    setup[29] = 2
    setup[34] = 8
    setup[35] = 255
    setup.writeUInt32LE(0x1234, 40 + 8 + 16)
    expect(parseSetup(setup)).toEqual({ root: 0x1234, minKeycode: 8, maxKeycode: 255 })
  })
})

describe('hotkeys and replies', () => {
  it('parses hotkey specs', () => {
    expect(parseHotkey('Ctrl+Alt+Shift+Escape')).toEqual({
      modifiers: 4 | 8 | 1,
      keysym: 0xff1b,
      label: 'Ctrl+Alt+Shift+Escape'
    })
    expect(parseHotkey('super+F12')?.keysym).toBe(0xffc9)
    expect(parseHotkey('Ctrl+Alt+p')?.keysym).toBe(0x70)
    expect(parseHotkey('Pause')?.modifiers).toBe(0)
    expect(parseHotkey('Escape')).toBeUndefined()
    expect(parseHotkey('Hyper+Escape')).toBeUndefined()
    expect(parseHotkey('Ctrl+Tab')).toBeUndefined()
    expect(parseHotkey('')).toBeUndefined()
  })

  it('finds keycodes, the Num Lock bit, XTEST devices and event masks', () => {
    const mapping = reply(1, Buffer.concat([Buffer.alloc(24), Buffer.alloc(KEYSYMS.length * 8)]), 2)
    KEYSYMS.flat().forEach((keysym, i) => mapping.writeUInt32LE(keysym, 32 + i * 4))
    expect(keycodeFor(mapping, 8, 0xff1b)).toBe(9)
    expect(keycodeFor(mapping, 8, 0x41)).toBe(8)
    expect(keycodeFor(mapping, 8, 0xffff)).toBeUndefined()
    const modifiers = reply(1, Buffer.alloc(24 + 8), 1)
    modifiers[32 + 4] = 10
    expect(numLockMask(modifiers, 10)).toBe(16)
    expect(numLockMask(modifiers, undefined)).toBe(0)
    const list = reply(
      1,
      devices([
        [4, 'Virtual core XTEST pointer'],
        [9, 'AT keyboard'],
        [5, 'Virtual core XTEST keyboard']
      ])
    )
    expect([...xtestDevices(list)]).toEqual([4, 5])
    expect([...eventMask(13, 15)]).toEqual([0, 0xa0, 0, 0])
  })
})
