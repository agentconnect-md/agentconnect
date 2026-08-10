import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ShimBindingRegistry, type Binding, type SpawnRecord } from './binding.js'
import {
  SHIM_SUBPROTOCOL,
  SHIM_TOKEN_AUDIENCE,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimFrame,
  type ShimRejected
} from './protocol.js'

/** Verifies a presented token and reports which pod it was issued to. Satisfied by
 *  the Kubernetes client's TokenReview; injected so tests need no API server. */
export interface PodIdentityVerifier {
  reviewToken(
    token: string,
    audiences: string[]
  ): Promise<{
    authenticated: boolean
    podName?: string
    podUid?: string
    error?: string
  }>
}

export interface ShimListenerDeps {
  verifier: PodIdentityVerifier
  /** The spawn record for a pod, or undefined when this daemon did not launch it. */
  spawnRecordForPod: (pod: { name: string; uid: string }) => SpawnRecord | undefined
  now: () => number
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  /** Session-credential lifetime; a shim re-handshakes rather than refreshing. */
  credentialTtlMs?: number
}

const DEFAULT_CREDENTIAL_TTL_MS = 10 * 60_000

/** A bound shim connection the daemon can send requests on. */
export interface ShimConnection {
  binding: Binding
  send(frame: ShimFrame): void
  close(reason: string): void
}

/**
 * The daemon's shim endpoint: the shim dials out, this listens.
 *
 * Direction is deliberate — the sandbox needs zero inbound, so its NetworkPolicy keeps
 * an empty ingress list and no per-sandbox Service exists. Binding is proved by the
 * pod's own audience-restricted ServiceAccount token, reviewed through the API server,
 * because a pod IP is reusable and the Sandbox status that mirrors it is asynchronous:
 * within that stale window a sibling sandbox could otherwise claim a victim's channel.
 * The connection's source address is therefore logged as a hint and never trusted.
 */
export class ShimListener {
  private server?: Server
  private wss?: WebSocketServer
  private readonly registry: ShimBindingRegistry
  private readonly connections = new Set<ShimConnection>()
  private port?: number

  constructor(private readonly deps: ShimListenerDeps) {
    this.registry = new ShimBindingRegistry(deps.now, deps.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS)
  }

  async start(port = 0, host = '0.0.0.0'): Promise<number> {
    const server = createServer((_req, res) => {
      // The endpoint speaks only the WS upgrade; a plain GET is not a health surface.
      res.statusCode = 404
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      if (!(req.url ?? '').startsWith(SHIM_WS_PATH)) {
        socket.destroy()
        return
      }
      // Refuse an upgrade that does not offer our subprotocol: a browser or scanner
      // reaching this port should not get as far as the handshake.
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .toString()
        .split(',')
        .map((value) => value.trim())
      if (!offered.includes(SHIM_SUBPROTOCOL)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req.socket.remoteAddress ?? 'unknown'))
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
    this.deps.log.info(`shim: listening on ${host}:${this.port}${SHIM_WS_PATH}`)
    return this.port
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections]) connection.close('daemon shutting down')
    this.connections.clear()
    this.wss?.close()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = undefined
    this.wss = undefined
  }

  listeningPort(): number | undefined {
    return this.port
  }

  /** Bound connections for an agent — the channels a turn is delivered over. */
  connectionsFor(agentId: string): ShimConnection[] {
    return [...this.connections].filter((connection) => connection.binding.agentId === agentId)
  }

  /** Forget an agent's bindings; its sandbox is gone or its claim was deleted. */
  revokeAgent(agentId: string): void {
    for (const connection of this.connectionsFor(agentId)) connection.close('binding revoked')
    this.registry.revokeAgent(agentId)
  }

  /** Authorize an inbound post-binding frame. Exposed for the channels landing later. */
  authorize(input: Parameters<ShimBindingRegistry['authorize']>[0]): ReturnType<ShimBindingRegistry['authorize']> {
    return this.registry.authorize(input)
  }

  private accept(ws: WebSocket, remoteAddress: string): void {
    let bound: ShimConnection | undefined
    const reject = (rejected: ShimRejected): void => {
      // One coarse reason, never which check failed: a caller must not be able to probe
      // for valid pod names by comparing responses.
      try {
        ws.send(JSON.stringify(rejected))
      } catch {
        /* peer already gone */
      }
      ws.close(4403, rejected.reason)
    }

    ws.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary) return
      const frame = parseShimFrame(typeof data === 'string' ? data : String(data))
      if (!frame) {
        ws.close(4400, 'malformed frame')
        return
      }
      if (frame.type === 'shim/hello') {
        if (bound) {
          ws.close(4400, 'already bound')
          return
        }
        void this.bindFrom(frame.token, remoteAddress).then(
          (result) => {
            if (!result.ok) return reject(result.rejected)
            const connection: ShimConnection = {
              binding: result.binding,
              send: (outbound) => ws.send(JSON.stringify(outbound)),
              close: (reason) => ws.close(4000, reason)
            }
            bound = connection
            this.connections.add(connection)
            connection.send({
              type: 'shim/bound',
              sessionCredential: result.credential,
              expiresInSeconds: Math.max(1, Math.floor((result.binding.expiresAtMs - this.deps.now()) / 1000)),
              agentId: result.binding.agentId,
              generation: result.binding.generation,
              grants: result.binding.grants
            })
            this.deps.log.info(
              `shim: bound agent ${result.binding.agentId} generation ${result.binding.generation} ` +
                `(pod ${result.binding.podName}, from ${remoteAddress})`
            )
          },
          (err: unknown) => {
            this.deps.log.warn(`shim: binding failed (${(err as Error).message})`)
            reject({ type: 'shim/rejected', reason: 'unavailable', message: 'binding unavailable' })
          }
        )
        return
      }
      // Only the hello frame is accepted before binding; a request that arrives first
      // has no credential to authorize and must not be treated as anything else.
      if (!bound) {
        ws.close(4403, 'not bound')
        return
      }
      if (frame.type === 'shim/request') {
        // The daemon is the requester on this channel; a request FROM the sandbox is
        // out of protocol and closing is the safe response.
        ws.close(4400, 'unexpected request from sandbox')
      }
    })

    ws.on('close', () => {
      if (bound) this.connections.delete(bound)
    })
  }

  private async bindFrom(
    token: string,
    remoteAddress: string
  ): Promise<{ ok: true; credential: string; binding: Binding } | { ok: false; rejected: ShimRejected }> {
    const review = await this.deps.verifier.reviewToken(token, [SHIM_TOKEN_AUDIENCE])
    if (!review.authenticated || !review.podName || !review.podUid) {
      this.deps.log.warn(
        `shim: rejected an unauthenticated callback from ${remoteAddress}${review.error ? ` (${review.error})` : ''}`
      )
      return {
        ok: false,
        rejected: { type: 'shim/rejected', reason: 'unauthenticated', message: 'token not accepted' }
      }
    }
    const pod = { name: review.podName, uid: review.podUid }
    const record = this.deps.spawnRecordForPod(pod)
    if (!record) {
      // Authenticated, but not a pod this daemon launched — or one whose spawn record is
      // gone. Either way there is nothing to bind it to.
      this.deps.log.warn(`shim: no spawn record for pod ${pod.name} (${remoteAddress})`)
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'unknown_pod', message: 'pod not recognized' } }
    }
    const { credential, binding } = this.registry.bind(record, pod)
    return { ok: true, credential, binding }
  }
}
