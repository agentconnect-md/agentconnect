import { createServer, type Server } from 'node:http'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { WebSocketServer } from 'ws'
import { WsServerTransport } from '@agentconnect.md/connection'
import { SHIM_SUBPROTOCOL, SHIM_WS_PATH } from './protocol.js'
import type { ShimTransport } from './client.js'

export interface ShimServerDeps {
  log?: { info: (message: string) => void; warn: (message: string) => void }
}

// A daemon socket accepted while the channel FSM is mid-backoff sits unclaimed; without
// buffering, its hello frame fires with no listener and binding stalls until the daemon's
// timeout. Capture inbound frames and a close until the first listener attaches, then replay.
function bufferInbound(raw: ShimTransport): Pick<ShimTransport, 'onMessage' | 'onClose'> {
  const frames: string[] = []
  const messageListeners: Array<(text: string) => void> = []
  const closeListeners: Array<(code: number, reason: string) => void> = []
  let closed: { code: number; reason: string } | undefined
  raw.onMessage((text) => {
    if (messageListeners.length === 0) frames.push(text)
    else for (const listener of messageListeners) listener(text)
  })
  raw.onClose((code, reason) => {
    closed = { code, reason }
    for (const listener of closeListeners) listener(code, reason)
  })
  return {
    onMessage: (listener) => {
      messageListeners.push(listener)
      // Replay only on a live socket: a buffered hello answered after close would send into a dead peer.
      if (messageListeners.length === 1 && !closed) for (const text of frames.splice(0)) listener(text)
    },
    onClose: (listener) => {
      closeListeners.push(listener)
      if (closed) listener(closed.code, closed.reason)
    }
  }
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
        const inbound = bufferInbound(raw)
        const transport: ShimTransport = {
          send: (text) => raw.send(text),
          onMessage: inbound.onMessage,
          onClose: inbound.onClose,
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
