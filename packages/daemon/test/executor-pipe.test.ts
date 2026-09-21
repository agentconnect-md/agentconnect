import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { ClientTransport } from '@agentconnect.md/connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  dialPipe,
  PIPE_TLS,
  startPipeListener,
  type PipeAdmission,
  type PipeListener
} from '../src/execution/executor-pipe.js'
import { WAIT } from './wait-support.js'

/** In place of a shim: a unix-socket server that echoes, and remembers who reached it and what they sent. */
interface Stub {
  socketPath: string
  connections: Socket[]
  received: () => string
}

const IDENTITY = 'session-0123456789abcdef01234567'

describe('executor pipe listener', () => {
  let dir: string | undefined
  const servers: Array<{ close: (done: () => void) => unknown }> = []
  const clients: Array<{ destroy: () => unknown }> = []
  let listener: PipeListener | undefined
  const lines: string[] = []
  const log = { warn: (line: string) => void lines.push(line) }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy()
    await listener?.stop()
    listener = undefined
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
    lines.length = 0
  })

  async function socketPathFor(name: string): Promise<string> {
    // Short on purpose: a unix socket path has a budget of about a hundred bytes.
    dir ??= await mkdtemp(join(tmpdir(), 'ac-xp-'))
    return join(dir, `${name}.sock`)
  }

  async function stubShim(): Promise<Stub> {
    const socketPath = await socketPathFor('shim')
    const connections: Socket[] = []
    let received = ''
    const server: Server = createServer((socket) => {
      connections.push(socket)
      socket.on('data', (chunk) => {
        received += chunk.toString()
        socket.write(chunk)
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return { socketPath, connections, received: () => received }
  }

  async function listen(
    admission: (identity: string) => PipeAdmission | undefined,
    over: { maxPending?: number; handshakeTimeoutMs?: number; onPipe?: (identity: string, open: boolean) => void } = {}
  ): Promise<PipeListener> {
    listener = await startPipeListener({
      admission,
      onPipe: over.onPipe ?? (() => {}),
      maxPending: () => over.maxPending ?? 8,
      log,
      host: '127.0.0.1',
      ...(over.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: over.handshakeTimeoutMs })
    })
    return listener
  }

  /** A holder's dial: resolves once the handshake succeeded, rejects with the TLS failure otherwise. */
  function dial(port: number, key: Buffer, identity = IDENTITY, over: ConnectionOptions = {}): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: '127.0.0.1',
        port,
        ...PIPE_TLS,
        pskCallback: () => ({ psk: key, identity }),
        ...over
      })
      clients.push(socket)
      socket.once('secureConnect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  const closed = (socket: { destroyed: boolean; once: (event: 'close', done: () => void) => unknown }): Promise<void> =>
    new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))

  it('pipes an admitted dial to the shim socket byte for byte, on the pinned suite and with no certificate', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    const pipes: Array<[string, boolean]> = []
    const { port } = await listen(
      (identity) => (identity === IDENTITY ? { key, socketPath: shim.socketPath } : undefined),
      { onPipe: (identity, open) => pipes.push([identity, open]) }
    )
    const socket = await dial(port, key)
    expect(socket.getProtocol()).toBe('TLSv1.3')
    expect(socket.getCipher().name).toBe('TLS_AES_128_GCM_SHA256')
    expect(socket.getPeerCertificate()).toEqual({})

    // Anything at all goes through unread: what would be a `prepare` on the control connection is only bytes here.
    const bytes = '{"type":"executor/prepare","payload":{"generation":99}}\n not a frame'
    let echoed = ''
    socket.on('data', (chunk) => (echoed += chunk.toString()))
    socket.write(bytes)
    await vi.waitFor(() => expect(echoed).toBe(bytes), WAIT)
    expect(shim.received()).toBe(bytes)
    expect(shim.connections).toHaveLength(1)
    expect(listener!.piped(IDENTITY)).toBe(true)

    socket.destroy()
    await vi.waitFor(() => expect(listener!.piped(IDENTITY)).toBe(false), WAIT)
    await vi.waitFor(() => expect(shim.connections[0]!.destroyed).toBe(true), WAIT)
    expect(pipes).toEqual([
      [IDENTITY, true],
      [IDENTITY, false]
    ])
  })

  it('carries an unmodified WebSocket client that is handed the TLS socket through createConnection', async () => {
    const socketPath = await socketPathFor('ws')
    const wss = new WebSocketServer({ noServer: true })
    const upstream = createHttpServer()
    upstream.on('upgrade', (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`echo:${String(data)}`)))
    )
    servers.push(upstream, wss)
    await new Promise<void>((resolve) => upstream.listen(socketPath, resolve))
    const key = randomBytes(32)
    const { port } = await listen(() => ({ key, socketPath }))
    const transport = await ClientTransport.dial('ws://executor.example.test', {
      subprotocol: 'test.sub.v1',
      path: '/shim',
      createConnection: () =>
        connect({ host: '127.0.0.1', port, ...PIPE_TLS, pskCallback: () => ({ psk: key, identity: IDENTITY }) })
    })
    const got = new Promise<string>((resolve) => transport.onMessage(resolve))
    transport.send('ping')
    expect(await got).toBe('echo:ping')
    transport.close(1000, 'done')
  })

  it('never lets a dial without a live key reach a shim, and fails every such dial alike', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    let live = true
    const { port } = await listen((identity) =>
      live && identity === IDENTITY ? { key, socketPath: shim.socketPath } : undefined
    )
    const outcome = (attempt: Promise<TLSSocket>): Promise<string> =>
      attempt.then(
        () => 'admitted',
        (error: NodeJS.ErrnoException) => error.code ?? error.message
      )
    const wrongKey = await outcome(dial(port, randomBytes(32)))
    const unknownIdentity = await outcome(dial(port, key, 'session-ffffffffffffffffffffffff'))
    live = false
    const stopped = await outcome(dial(port, key))
    // One answer for all three, so the listener is no oracle for which sessions live on this machine.
    expect(wrongKey).toMatch(/DECRYPT_ERROR/)
    expect([unknownIdentity, stopped]).toEqual([wrongKey, wrongKey])
    // Without a key there is nothing to fall back on: the listener holds no certificate.
    expect(await outcome(dial(port, key, IDENTITY, { pskCallback: undefined }))).not.toBe('admitted')
    expect(shim.connections).toHaveLength(0)
    expect(listener!.pipeCount()).toBe(0)
  })

  it('accepts the pinned suite only, even from a peer that holds the key', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    const { port } = await listen(() => ({ key, socketPath: shim.socketPath }))
    // Another SHA-256 suite, which a callback-supplied key would work with, and TLS 1.2 PSK: the right key, not the pin.
    await expect(dial(port, key, IDENTITY, { ciphers: 'TLS_CHACHA20_POLY1305_SHA256' })).rejects.toThrow()
    await expect(
      dial(port, key, IDENTITY, {
        ciphers: 'ECDHE-PSK-CHACHA20-POLY1305',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2'
      })
    ).rejects.toThrow()
    expect(shim.connections).toHaveLength(0)
  })

  it('closes the pipe admitted under a rotated key, and stops admitting that key', async () => {
    const shim = await stubShim()
    let key = randomBytes(32)
    const { port } = await listen(() => ({ key, socketPath: shim.socketPath }))
    const old = await dial(port, key)
    await vi.waitFor(() => expect(listener!.piped(IDENTITY)).toBe(true), WAIT)
    const oldKey = key
    // What a higher-generation `prepare` does: a fresh key, and the pipe the old one admitted goes.
    key = randomBytes(32)
    listener!.close(IDENTITY)
    await closed(old)
    await expect(dial(port, oldKey)).rejects.toThrow(/decrypt error/i)
    const fresh = await dial(port, key)
    fresh.write('after rotation')
    await vi.waitFor(() => expect(shim.received()).toBe('after rotation'), WAIT)
  })

  it('keeps one pipe per identity: a newly admitted dial closes the one before it', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    const events: boolean[] = []
    const { port } = await listen(() => ({ key, socketPath: shim.socketPath }), {
      onPipe: (_identity, open) => events.push(open)
    })
    const first = await dial(port, key)
    await vi.waitFor(() => expect(shim.connections).toHaveLength(1), WAIT)
    const second = await dial(port, key)
    await closed(first)
    await vi.waitFor(() => expect(shim.connections[0]!.destroyed).toBe(true), WAIT)
    second.write('second')
    await vi.waitFor(() => expect(shim.received()).toBe('second'), WAIT)
    expect(listener!.pipeCount()).toBe(1)
    // A replacement is one more open and no close, so no idle linger starts between the two.
    expect(events).toEqual([true, true])
  })

  it('refuses a handshake whose key rotated before it finished', async () => {
    const shim = await stubShim()
    const first = randomBytes(32)
    let asked = 0
    // The first lookup is the handshake's and the second the admission's: a rotation landed in between.
    const { port } = await listen(() => ({ key: asked++ === 0 ? first : randomBytes(32), socketPath: shim.socketPath }))
    await closed(await dial(port, first))
    expect(shim.connections).toHaveLength(0)
    expect(listener!.pipeCount()).toBe(0)
  })

  it('bounds what an unauthenticated peer costs: a cap on waiting sockets, and only a count in the log', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    const { port } = await listen(() => ({ key, socketPath: shim.socketPath }), { maxPending: 2 })
    const waiting = [0, 1, 2].map(() => tcpConnect({ host: '127.0.0.1', port }))
    clients.push(...waiting)
    for (const socket of waiting) socket.on('error', () => {})
    // Two may wait for their handshake; one more is dropped unread.
    await vi.waitFor(() => expect(waiting.filter((socket) => socket.destroyed)).toHaveLength(1), WAIT)
    // A waiting socket is not a pipe: what it sends is a failed handshake, never bytes for a shim.
    const survivor = waiting.find((socket) => !socket.destroyed)!
    survivor.write(`GET / HTTP/1.1\r\nx-identity: ${IDENTITY}\r\n\r\n`)
    await closed(survivor)
    expect(shim.connections).toHaveLength(0)

    await listener!.stop()
    listener = undefined
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^executor: refused \d+ dial\(s\)/)
    // A count and nothing else: no identity, no address.
    expect(lines[0]).not.toContain(IDENTITY)
    expect(lines[0]).not.toContain('127.0.0.1')
  })

  it('closes a peer that never starts its handshake once the deadline passes', async () => {
    const shim = await stubShim()
    const { port } = await listen(() => ({ key: randomBytes(32), socketPath: shim.socketPath }), {
      handshakeTimeoutMs: 50
    })
    const socket = tcpConnect({ host: '127.0.0.1', port })
    clients.push(socket)
    socket.on('error', () => {})
    await closed(socket)
    expect(shim.connections).toHaveLength(0)
  })

  // The holder's own dial, against the listener it will meet in production.
  it('opens the holder side with the key its `prepare` returned, and fails with any other', async () => {
    const shim = await stubShim()
    const key = randomBytes(32)
    const { port } = await listen((identity) =>
      identity === IDENTITY ? { key, socketPath: shim.socketPath } : undefined
    )
    const socket = await dialPipe({
      host: '127.0.0.1',
      port,
      psk: key.toString('base64url'),
      identity: IDENTITY
    })
    clients.push(socket)
    expect(socket.getCipher().name).toBe('TLS_AES_128_GCM_SHA256')
    await vi.waitFor(() => expect(shim.connections).toHaveLength(1), WAIT)

    const wrongKey = dialPipe({
      host: '127.0.0.1',
      port,
      psk: randomBytes(32).toString('base64url'),
      identity: IDENTITY
    })
    await expect(wrongKey).rejects.toThrow()
    // An identity nobody holds fails exactly as a wrong key does: the listener is no oracle for which sessions live here.
    const unknownSession = dialPipe({
      host: '127.0.0.1',
      port,
      psk: key.toString('base64url'),
      identity: 'session-ffffffffffffffffffffffff'
    })
    await expect(unknownSession).rejects.toThrow()
    expect(shim.connections).toHaveLength(1)
  })
})
