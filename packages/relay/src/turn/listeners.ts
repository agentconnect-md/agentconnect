// The TURN server's client transports: UDP, TCP, and TLS for networks that only let 443 out (computer-use.md §7.2).
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import type { Logger } from '../log.js'
import { splitStreamFrames } from './codec.js'
import { noTurnMetrics, type TurnMetrics } from './metrics.js'
import type { TurnServer, TurnTransport } from './server.js'

// A connection that has not allocated within this long is closed.
const STREAM_ALLOCATE_TIMEOUT_MS = 30_000
// Writes queued on a slow stream past this are dropped rather than buffered.
const STREAM_MAX_BUFFERED_BYTES = 512 * 1024
// A partial frame never exceeds one STUN or ChannelData message.
const STREAM_MAX_PENDING_BYTES = 70 * 1024
const TLS_RELOAD_MS = 3_600_000

export interface TurnListenerOptions {
  turn: TurnServer
  host: string
  /** UDP and TCP on the same port. */
  port: number
  tls?: { port: number; certFile: string; keyFile: string }
  /** Concurrent TCP and TLS connections, each of which can hold one allocation. */
  maxConnections: number
  log: Logger
  metrics?: TurnMetrics
}

export interface TurnListeners {
  udpPort: number
  tcpPort: number
  tlsPort?: number
  close(): Promise<void>
}

export async function startTurnListeners(opts: TurnListenerOptions): Promise<TurnListeners> {
  const metrics = opts.metrics ?? noTurnMetrics
  const udp = createSocket({ type: 'udp4', reuseAddr: false })
  udp.on('message', (frame, from) =>
    opts.turn.handle(
      {
        key: `udp:${from.address}:${from.port}`,
        transport: 'udp',
        address: from.address,
        port: from.port,
        send: (out) => udp.send(out, from.port, from.address)
      },
      frame
    )
  )
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject)
    udp.bind(opts.port, opts.host, () => {
      udp.off('error', reject)
      resolve()
    })
  })
  // ICMP errors for a vanished client concern one datagram, never the server.
  udp.on('error', (err) => opts.log.debug(`relay: turn udp socket error: ${err.message}`))

  let connectionId = 0
  const sockets = new Set<Socket>()
  const accept = (transport: TurnTransport) => (socket: Socket) => {
    if (sockets.size >= opts.maxConnections) return void socket.destroy()
    sockets.add(socket)
    const key = `${transport}:${socket.remoteAddress}:${socket.remotePort}:${++connectionId}`
    const client = {
      key,
      transport,
      address: socket.remoteAddress ?? '0.0.0.0',
      port: socket.remotePort ?? 0,
      send: (out: Buffer) => {
        if (socket.writableLength > STREAM_MAX_BUFFERED_BYTES) return metrics.dropped(out.length, 'backpressure')
        socket.write(out)
      },
      end: () => socket.end()
    }
    socket.setNoDelay(true)
    const deadline = setTimeout(() => {
      if (!opts.turn.holds(key)) socket.destroy()
    }, STREAM_ALLOCATE_TIMEOUT_MS)
    deadline.unref()
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest, bad } = splitStreamFrames(pending.length ? Buffer.concat([pending, chunk]) : chunk)
      for (const frame of frames) opts.turn.handle(client, frame)
      if (bad || rest.length > STREAM_MAX_PENDING_BYTES) return void socket.destroy()
      pending = Buffer.from(rest)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(deadline)
      sockets.delete(socket)
      opts.turn.clientClosed(key)
    })
  }

  const tcp = createTcpServer(accept('tcp'))
  await listen(tcp, opts.port, opts.host)
  let tls: Server | undefined
  let reload: ReturnType<typeof setInterval> | undefined
  if (opts.tls) {
    const { certFile, keyFile } = opts.tls
    const read = () => ({ cert: readFileSync(certFile), key: readFileSync(keyFile) })
    const secure = createTlsServer(read(), accept('tls'))
    // A rotated certificate (cert-manager) is picked up without a restart.
    reload = setInterval(() => {
      try {
        secure.setSecureContext(read())
      } catch (err) {
        opts.log.warn(`relay: turn tls certificate reload failed: ${(err as Error).message}`)
      }
    }, TLS_RELOAD_MS)
    reload.unref()
    secure.on('tlsClientError', () => {})
    await listen(secure, opts.tls.port, opts.host)
    tls = secure
  }
  const tcpPort = (tcp.address() as AddressInfo).port
  const tlsPort = tls ? (tls.address() as AddressInfo).port : undefined
  const udpPort = udp.address().port
  opts.log.info(
    `relay: TURN listening on udp/tcp ${opts.host}:${udpPort}${tlsPort ? `, tls ${opts.host}:${tlsPort}` : ''}`
  )
  return {
    udpPort,
    tcpPort,
    ...(tlsPort ? { tlsPort } : {}),
    close: async () => {
      if (reload) clearInterval(reload)
      for (const socket of sockets) socket.destroy()
      await Promise.all([
        new Promise<void>((done) => udp.close(() => done())),
        new Promise<void>((done) => tcp.close(() => done())),
        ...(tls ? [new Promise<void>((done) => tls.close(() => done()))] : [])
      ])
    }
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
