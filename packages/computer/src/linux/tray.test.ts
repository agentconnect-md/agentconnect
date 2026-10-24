import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DBusConnection,
  MessageType,
  Reader,
  Variant,
  Writer,
  busSocketPath,
  decodeMessage,
  encodeMessage,
  messageLength,
  splitSignature,
  type Message
} from './dbus.js'
import { Tray, iconPixels, type TrayState } from './tray.js'

// A fake session bus: authenticates, answers the bus and watcher calls, and lets a test call into the client.
class FakeBus {
  readonly path = join(tmpdir(), `bus-${randomBytes(6).toString('hex')}.sock`)
  readonly registered: string[] = []
  readonly signals: Message[] = []
  readonly ownedNames: string[] = []
  private client: Socket | undefined
  private serial = 100
  private readonly replies = new Map<number, (message: Message) => void>()
  private readonly server: Server

  constructor(readonly options: { watcher?: boolean | 'hang' } = {}) {
    this.server = createServer((socket) => this.serve(socket))
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve))
  }

  close(): void {
    this.client?.destroy()
    this.server.close()
  }

  call(path: string, iface: string, member: string, signature = '', body: unknown[] = []): Promise<Message> {
    const serial = ++this.serial
    const reply = new Promise<Message>((resolve) => this.replies.set(serial, resolve))
    this.client!.write(
      encodeMessage({
        type: MessageType.MethodCall,
        flags: 0,
        serial,
        path,
        interface: iface,
        member,
        sender: ':1.9',
        destination: ':1.5',
        signature,
        body
      })
    )
    return reply
  }

  ownerChanged(name: string, owner: string): void {
    this.client!.write(
      encodeMessage({
        type: MessageType.Signal,
        flags: 1,
        serial: ++this.serial,
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'NameOwnerChanged',
        sender: 'org.freedesktop.DBus',
        signature: 'sss',
        body: [name, '', owner]
      })
    )
  }

  private serve(socket: Socket): void {
    this.client = socket
    let buffer = Buffer.alloc(0)
    let authed = false
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!authed) {
        const text = buffer.toString('latin1')
        if (text.includes('AUTH EXTERNAL') && !text.includes('BEGIN\r\n')) {
          if (text.endsWith('\r\n') && !text.includes('OK')) socket.write('OK 0123456789abcdef\r\n')
          return
        }
        const begin = text.indexOf('BEGIN\r\n')
        if (begin < 0) return
        buffer = buffer.subarray(begin + 7)
        authed = true
      }
      for (;;) {
        const length = messageLength(buffer)
        if (length === undefined || buffer.length < length) return
        this.handle(socket, decodeMessage(buffer.subarray(0, length)))
        buffer = buffer.subarray(length)
      }
    })
  }

  private handle(socket: Socket, message: Message): unknown {
    if (message.type === MessageType.Signal) return void this.signals.push(message)
    if (message.type !== MessageType.MethodCall) {
      this.replies.get(message.replySerial!)?.(message)
      return
    }
    const answer = (signature: string, body: unknown[]) =>
      socket.write(
        encodeMessage({
          type: MessageType.MethodReturn,
          flags: 1,
          serial: ++this.serial,
          replySerial: message.serial,
          destination: ':1.5',
          signature,
          body
        })
      )
    if (message.member === 'Hello') return answer('s', [':1.5'])
    if (message.member === 'RequestName') {
      this.ownedNames.push(String(message.body[0]))
      return answer('u', [1])
    }
    if (message.member === 'AddMatch') return answer('', [])
    if (message.member === 'RegisterStatusNotifierItem') {
      if (this.options.watcher === 'hang') return
      if (this.options.watcher === false) {
        return socket.write(
          encodeMessage({
            type: MessageType.Error,
            flags: 1,
            serial: ++this.serial,
            replySerial: message.serial,
            errorName: 'org.freedesktop.DBus.Error.ServiceUnknown',
            destination: ':1.5',
            signature: 's',
            body: ['The name is not activatable']
          })
        )
      }
      this.registered.push(String(message.body[0]))
      return answer('', [])
    }
  }
}

const buses: FakeBus[] = []
afterEach(() => {
  for (const bus of buses.splice(0)) bus.close()
})

async function start(options: ConstructorParameters<typeof FakeBus>[0] = {}, timeoutMs = 1000) {
  const bus = new FakeBus(options)
  buses.push(bus)
  await bus.listen()
  const clicks = { stop: 0, resume: 0 }
  const tray = await Tray.start({
    onStop: () => clicks.stop++,
    onResume: () => clicks.resume++,
    hotkeyLabel: 'Ctrl+Alt+Shift+Escape',
    log: () => undefined,
    connect: () => DBusConnection.session(`unix:path=${bus.path}`, 1000, timeoutMs)
  })
  return { bus, tray, clicks }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const prop = (props: unknown, name: string): unknown =>
  ((props as [string, Variant][]).find(([key]) => key === name)?.[1] as Variant | undefined)?.value

describe.skipIf(process.platform === 'win32')('Tray', () => {
  it('registers with the watcher and serves the item and its menu', async () => {
    const { bus, tray } = await start()
    expect(tray.problem).toBeUndefined()
    expect(bus.registered).toEqual([`org.kde.StatusNotifierItem-${process.pid}-1`])
    expect(bus.ownedNames).toEqual(bus.registered)
    const all = await bus.call('/StatusNotifierItem', 'org.freedesktop.DBus.Properties', 'GetAll', 's', [
      'org.kde.StatusNotifierItem'
    ])
    expect(all.signature).toBe('a{sv}')
    expect(prop(all.body[0], 'Menu')).toBe('/MenuBar')
    expect(prop(all.body[0], 'ItemIsMenu')).toBe(true)
    expect(prop(all.body[0], 'Title')).toBe('AgentConnect Computer: online')
    const pixmaps = prop(all.body[0], 'IconPixmap') as [number, number, Buffer][]
    expect(pixmaps.map(([w, h, data]) => [w, h, data.length])).toEqual([
      [22, 22, 22 * 22 * 4],
      [44, 44, 44 * 44 * 4]
    ])
    const layout = await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'GetLayout', 'iias', [0, -1, []])
    const [revision, [rootId, , children]] = layout.body as [number, [number, unknown, Variant[]]]
    expect(revision).toBe(1)
    expect(rootId).toBe(0)
    const labels = children.map((child) => prop((child.value as unknown[])[1], 'label'))
    expect(labels).toEqual([
      'Agents: online',
      undefined,
      'Stop all agent input (Ctrl+Alt+Shift+Escape)',
      'Resume agent input'
    ])
    const resume = children.at(-1)!.value as unknown[]
    expect(prop(resume[1], 'visible')).toBe(false)
    const introspect = await bus.call('/StatusNotifierItem', 'org.freedesktop.DBus.Introspectable', 'Introspect')
    expect(String(introspect.body[0])).toContain('org.kde.StatusNotifierItem')
    const unknown = await bus.call('/StatusNotifierItem', 'org.kde.StatusNotifierItem', 'Nope')
    expect(unknown.type).toBe(MessageType.Error)
    expect(unknown.errorName).toBe('org.freedesktop.DBus.Error.UnknownMethod')
    tray.close()
  })

  it('stops from the menu, and resumes only a pause the owner made here', async () => {
    const { bus, tray, clicks } = await start()
    await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'Event', 'isvu', [3, 'clicked', new Variant('i', 0), 0])
    expect(clicks.stop).toBe(1)
    await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'Event', 'isvu', [4, 'clicked', new Variant('i', 0), 0])
    expect(clicks.resume).toBe(0)
    const paused: TrayState = {
      tone: 'paused',
      status: 'paused, stopped from the tray',
      canResume: true,
      canStop: false
    }
    tray.update(paused)
    await settle()
    expect(bus.signals.map((signal) => signal.member)).toEqual(['NewIcon', 'NewToolTip', 'NewTitle', 'LayoutUpdated'])
    const group = await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'GetGroupProperties', 'aias', [[3, 4], []])
    const items = group.body[0] as [number, unknown][]
    expect(prop(items[0]![1], 'enabled')).toBe(false)
    expect(prop(items[1]![1], 'visible')).toBe(true)
    await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'EventGroup', 'a(isvu)', [
      [[4, 'clicked', new Variant('i', 0), 0]]
    ])
    expect(clicks.resume).toBe(1)
    tray.close()
  })

  it('keeps Stop enabled while a console viewer is in control', async () => {
    const { bus, tray } = await start()
    tray.update({ tone: 'paused', status: 'a console viewer is in control', canResume: false, canStop: true })
    const group = await bus.call('/MenuBar', 'com.canonical.dbusmenu', 'GetGroupProperties', 'aias', [[3], []])
    expect(prop((group.body[0] as [number, unknown][])[0]![1], 'enabled')).toBe(true)
    tray.close()
  })

  it('reports a session without a tray, and registers again when one appears', async () => {
    const { bus, tray } = await start({ watcher: false })
    expect(tray.problem).toBe('no system tray in this session (no StatusNotifierWatcher)')
    bus.options.watcher = true
    bus.ownerChanged('org.kde.StatusNotifierWatcher', ':1.42')
    await settle()
    expect(tray.problem).toBeUndefined()
    bus.ownerChanged('org.kde.StatusNotifierWatcher', '')
    await settle()
    expect(tray.problem).toBe('the system tray went away')
    tray.close()
  })

  it('gives up on a watcher that never answers instead of hanging startup', async () => {
    const { tray } = await start({ watcher: 'hang' }, 150)
    expect(tray.problem).toMatch(/RegisterStatusNotifierItem .* timed out after 150 ms/)
    tray.close()
  })
})

describe('D-Bus marshalling', () => {
  it('round-trips nested types with alignment', () => {
    const signature = 'ya{sv}(ia{sv}av)asbdxu'
    const values = [
      7,
      [
        ['a', new Variant('s', 'x')],
        ['b', new Variant('ai', [1, -2])]
      ],
      [5, [['label', new Variant('s', 'Stop')]], [new Variant('(ia{sv}av)', [6, [], []])]],
      ['one', 'two'],
      true,
      1.5,
      -3,
      42
    ]
    const writer = new Writer()
    writer.writeAll(signature, values)
    const read = new Reader(writer.bytes()).readAll(signature)
    expect(read).toEqual(values)
    expect(splitSignature(signature)).toEqual(['y', 'a{sv}', '(ia{sv}av)', 'as', 'b', 'd', 'x', 'u'])
  })

  it('encodes and decodes a whole message, including big-endian ones', () => {
    const message = {
      type: MessageType.MethodCall,
      flags: 0,
      serial: 9,
      path: '/MenuBar',
      interface: 'com.canonical.dbusmenu',
      member: 'Event',
      signature: 'isvu',
      body: [3, 'clicked', new Variant('s', ''), 0]
    }
    const encoded = encodeMessage(message)
    expect(messageLength(encoded)).toBe(encoded.length)
    expect(decodeMessage(encoded)).toMatchObject(message)
    // A big-endian NewStatus("Active") signal, laid out by hand.
    const big = Buffer.alloc(91)
    big.write('B', 0, 'latin1')
    big.set([MessageType.Signal, 1, 1], 1)
    big.writeUInt32BE(11, 4)
    big.writeUInt32BE(5, 8)
    big.writeUInt32BE(63, 12)
    big.set([1, 1, 0x6f, 0], 16)
    big.writeUInt32BE(19, 20)
    big.write('/StatusNotifierItem', 24, 'latin1')
    big.set([3, 1, 0x73, 0], 48)
    big.writeUInt32BE(9, 52)
    big.write('NewStatus', 56, 'latin1')
    big.set([8, 1, 0x67, 0, 1, 0x73, 0], 72)
    big.writeUInt32BE(6, 80)
    big.write('Active', 84, 'latin1')
    expect(messageLength(big)).toBe(91)
    expect(decodeMessage(big)).toMatchObject({
      type: MessageType.Signal,
      serial: 5,
      path: '/StatusNotifierItem',
      member: 'NewStatus',
      signature: 's',
      body: ['Active']
    })
  })

  it('reads bus addresses', () => {
    expect(busSocketPath('unix:path=/run/user/1000/bus')).toBe('/run/user/1000/bus')
    expect(busSocketPath('unix:abstract=/tmp/dbus-x,guid=abc')).toBe('\0/tmp/dbus-x')
    expect(busSocketPath('tcp:host=a,port=1;unix:path=/b')).toBe('/b')
    expect(busSocketPath(undefined)).toBeUndefined()
  })

  it('draws a disc per tone with bars when paused', () => {
    const online = iconPixels('online', 22)
    const paused = iconPixels('paused', 22)
    const at = (pixels: Buffer, x: number, y: number) => [...pixels.subarray((y * 22 + x) * 4, (y * 22 + x) * 4 + 4)]
    expect(at(online, 0, 0)[0]).toBe(0)
    expect(at(online, 11, 11)).toEqual([255, 0x2e, 0x9d, 0x57])
    expect(at(paused, 8, 11)).toEqual([255, 255, 255, 255])
    expect(at(paused, 11, 3)).toEqual([255, 0xd6, 0x45, 0x45])
  })
})
