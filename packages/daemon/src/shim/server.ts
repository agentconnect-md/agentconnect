import { createServer, type Server } from 'node:http'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { WebSocketServer } from 'ws'
import { WsServerTransport } from '@agentconnect.md/connection'
import { SHIM_SUBPROTOCOL, SHIM_WS_PATH } from './protocol.js'
import type { ShimTransport } from './client.js'

export interface ShimServerDeps {
  log?: { info: (message: string) => void; warn: (message: string) => void }
}

/** The sandbox-side WebSocket endpoint; one daemon channel may be active at a time. */
export class ShimServer {
  private server?: Server
  private wss?: WebSocketServer
  private active?: ShimTransport
  private queued?: ShimTransport
  private waiter?: { resolve: (transport: ShimTransport) => void; reject: (error: Error) => void }
  private port?: number

  constructor(private readonly deps: ShimServerDeps = {}) {}

  async start(port: number, host = '0.0.0.0'): Promise<number> {
    const server = createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      handleProtocols: (protocols) => (protocols.has(SHIM_SUBPROTOCOL) ? SHIM_SUBPROTOCOL : false)
    })
    server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?', 1)[0] !== SHIM_WS_PATH) {
        socket.destroy()
        return
      }
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .toString()
        .split(',')
        .map((value) => value.trim())
      if (!offered.includes(SHIM_SUBPROTOCOL)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const raw = new WsServerTransport(ws, req.socket.remoteAddress ?? 'unknown')
        const transport: ShimTransport = {
          send: (text) => raw.send(text),
          onMessage: (listener) => raw.onMessage(listener),
          onClose: (listener) => raw.onClose(listener),
          close: (code, reason) => {
            if (this.active === transport) this.active = undefined
            if (this.queued === transport) this.queued = undefined
            raw.close(code, reason)
          }
        }
        if (this.active || this.queued) {
          this.deps.log?.warn('shim: refusing a second daemon connection')
          transport.close(4403, 'unavailable')
          return
        }
        transport.onClose(() => {
          if (this.active === transport) this.active = undefined
          if (this.queued === transport) this.queued = undefined
        })
        if (this.waiter) {
          const { resolve } = this.waiter
          this.waiter = undefined
          this.active = transport
          resolve(transport)
        } else {
          this.queued = transport
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.wss = wss
    this.port = (server.address() as { port: number }).port
    this.deps.log?.info(`shim: listening on ${host}:${this.port}${SHIM_WS_PATH}`)
    return this.port
  }

  /** Supply the next accepted daemon socket to the existing sandbox channel FSM. */
  nextTransport(): Promise<ShimTransport> {
    if (this.queued) {
      const transport = this.queued
      this.queued = undefined
      this.active = transport
      return Promise.resolve(transport)
    }
    if (this.waiter) return Promise.reject(new Error('shim: already waiting for a daemon connection'))
    return new Promise<ShimTransport>((resolve, reject) => (this.waiter = { resolve, reject }))
  }

  listeningPort(): number | undefined {
    return this.port
  }

  async stop(): Promise<void> {
    this.active?.close(1000, 'shim stopping')
    this.queued?.close(1000, 'shim stopping')
    this.active = undefined
    this.queued = undefined
    this.waiter?.reject(new Error('shim: server stopped'))
    this.waiter = undefined
    this.wss?.close()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = undefined
    this.wss = undefined
    this.port = undefined
  }
}
