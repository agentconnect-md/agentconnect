import { createServer, type Server } from 'node:http'
import { isAbsolute, normalize } from 'node:path'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { noopClusterMetrics, type ClusterMetrics } from '../k8s/cluster-metrics.js'
import { systemClock, type Clock } from '@agentconnect.md/connection'
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
  /** Time seam for the credential-expiry backstop; a FakeClock drives it in tests. */
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  /** Session-credential lifetime; a shim re-handshakes rather than refreshing. */
  credentialTtlMs?: number
  /** Operability counters; omit to record nothing. */
  metrics?: ClusterMetrics
  /** A channel bound — including a renewal, which is a NEW connection for the same launch, so
   *  whoever owns the session must re-attach rather than assume the old socket still works. */
  onConnection?: (connection: ShimConnection) => void
  /** A bound channel went away, so a caller waiting on it learns instead of hanging. */
  onConnectionLost?: (agentId: string, reason: string) => void
}

const DEFAULT_CREDENTIAL_TTL_MS = 10 * 60_000

// A verifier's error is an unbounded string from an external system, and it reaches a log. Keep
// the diagnostic but never the credential inside it: a token in a log outlives the request by
// however long the logs are kept, and by then it is somewhere nobody is auditing.
function withoutToken(message: string, token: string): string {
  return token.length > 0 ? message.split(token).join('[redacted]') : message
}

/** A usable pod workspace root: absolute, normalized, never `/`. Anything else ⇒ unreported. */
function sanitizeWorkspaceRoot(reported: string | undefined): string | undefined {
  if (!reported || !isAbsolute(reported)) return undefined
  const normalized = normalize(reported).replace(/\/+$/, '')
  return normalized.length > 0 ? normalized : undefined
}

/** A bound shim connection the daemon can send requests on. */
export interface ShimConnection {
  binding: Binding
  /** The credential issued to THIS channel, so teardown can revoke exactly it rather than
   *  whatever the pod currently holds — a renewal may already have replaced that. */
  issuedCredential: string
  /** The pod's workspace mount as the shim reported it; absent on legacy shims. Pod-reported
   *  and only ever used to build paths sent back INTO that pod, never on this filesystem. */
  workspaceRoot?: string
  send(frame: ShimFrame): void
  /** Observe inbound frames — how a ShimChannel receives the replies to its requests. */
  onFrame(listener: (text: string) => void): void
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
  private readonly metrics: ClusterMetrics
  private readonly clock: Clock
  private readonly connections = new Set<ShimConnection>()
  private port?: number

  constructor(private readonly deps: ShimListenerDeps) {
    this.registry = new ShimBindingRegistry(deps.now, deps.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS)
    this.metrics = deps.metrics ?? noopClusterMetrics
    this.clock = deps.clock ?? systemClock
  }

  async start(port = 0, host = '0.0.0.0'): Promise<number> {
    const server = createServer((_req, res) => {
      // The endpoint speaks only the WS upgrade; a plain GET is not a health surface.
      res.statusCode = 404
      res.end()
    })
    // Same 256 KiB cap the CP gateways use: a half-trusted peer must not be able to make
    // the daemon buffer an arbitrarily large frame.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
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
  /**
   * Wait for this launch's channel to bind.
   *
   * Keyed on the generation, not just the agent: a channel left over from a previous launch is
   * the one case that must NOT satisfy this wait, since handing it back would run the new
   * runtime's traffic down the old pod's socket.
   */
  async awaitConnection(agentId: string, generation: number, timeoutMs: number): Promise<ShimConnection> {
    const deadline = this.deps.now() + timeoutMs
    for (;;) {
      const match = this.connectionsFor(agentId).find((connection) => connection.binding.generation === generation)
      if (match) return match
      if (this.deps.now() >= deadline) {
        throw new Error(`no shim channel bound for agent ${agentId} generation ${generation} in time`)
      }
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 100))
    }
  }

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
    let binding = false
    const frameListeners: Array<(text: string) => void> = []
    // TokenReview is a network round trip, so the socket can close while it is pending.
    // The continuation must not then issue a credential, supersede a live binding, or
    // publish a connection for a socket that is already gone.
    let socketOpen = true
    ws.once('close', () => (socketOpen = false))
    const reject = (rejected: ShimRejected): void => {
      // The wire answer is identical for every pre-binding failure. An earlier version
      // sent the precise reason, which let a caller distinguish "token not accepted" from
      // "pod not recognized" and probe for pods this daemon launched — the exact thing the
      // anti-probing claim rules out. The precise reason stays in the daemon's own logs.
      try {
        ws.send(JSON.stringify(rejected))
      } catch {
        /* peer already gone */
      }
      ws.close(4403, rejected.reason)
    }
    const uniformRejection: ShimRejected = {
      type: 'shim/rejected',
      reason: 'unauthenticated',
      message: 'not accepted'
    }

    ws.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary) return
      const frame = parseShimFrame(typeof data === 'string' ? data : String(data))
      if (!frame) {
        this.metrics.handshakeRejected('malformed')
        ws.close(4400, 'malformed frame')
        return
      }
      if (frame.type === 'shim/hello') {
        // Single-flight: a second hello arriving while TokenReview is in flight would bind
        // twice and leave a stale connection entry behind.
        if (bound || binding) {
          ws.close(4400, 'already binding')
          return
        }
        binding = true
        // Sanitized here, once, so no consumer has to re-decide what a usable root looks like.
        const workspaceRoot = sanitizeWorkspaceRoot(frame.workspaceRoot)
        if (frame.workspaceRoot && !workspaceRoot) {
          this.deps.log.warn(`shim: ignoring a non-absolute workspace root from ${remoteAddress}`)
        }
        void this.bindFrom(frame.token, remoteAddress, () => socketOpen).then(
          (result) => {
            binding = false
            if (!result.ok && 'abandoned' in result) {
              // The socket closed mid-review; bindFrom stopped before the registry.
              this.deps.log.info('shim: callback closed before its token review finished')
              return
            }
            if (!socketOpen) return
            if (!result.ok) return reject(uniformRejection)
            // Close the superseded incarnation's channel: its credential is already gone
            // from the registry, and leaving the socket open would keep a dead binding in
            // connectionsFor().
            for (const previous of result.superseded) {
              for (const connection of [...this.connections]) {
                if (connection.binding.podUid !== previous.podUid) continue
                this.connections.delete(connection)
                connection.close('superseded by a newer launch')
              }
            }
            const connection: ShimConnection = {
              binding: result.binding,
              issuedCredential: result.credential,
              ...(workspaceRoot ? { workspaceRoot } : {}),
              send: (outbound) => ws.send(JSON.stringify(outbound)),
              onFrame: (listener) => frameListeners.push(listener),
              close: (reason) => ws.close(4000, reason)
            }
            bound = connection
            this.connections.add(connection)
            const remainingMs = result.binding.expiresAtMs - this.deps.now()
            connection.send({
              type: 'shim/bound',
              sessionCredential: result.credential,
              expiresInSeconds: Math.max(1, Math.floor(remainingMs / 1000)),
              agentId: result.binding.agentId,
              generation: result.binding.generation,
              grants: result.binding.grants
            })
            // AFTER the bound frame is on the wire, not before. An observer may send a request the
            // moment it learns of this connection, and the shim refuses anything that reaches it
            // ahead of its own binding as `not bound` — for a renewal that meant the daemon's
            // cleanup of an interrupted stream was rejected, leaving the in-pod client waiting.
            // Ordering on the socket is the guarantee: the peer processes frames in sequence, so a
            // request queued after this send is served with the binding already in place.
            this.deps.onConnection?.(connection)
            // Backstop the shim's own re-handshake: if it never comes, close at expiry so
            // the peer observes a dead channel instead of holding an expired credential.
            const expiry = this.clock.setTimeout(
              () => {
                if (bound !== connection) return
                this.connections.delete(connection)
                this.deps.log.info(`shim: credential expired for agent ${result.binding.agentId} — closing channel`)
                connection.close('credential expired')
              },
              Math.max(0, remainingMs)
            )
            ws.once('close', () => this.clock.clearTimeout(expiry))
            this.deps.log.info(
              `shim: bound agent ${result.binding.agentId} generation ${result.binding.generation} ` +
                `(pod ${result.binding.podName}, from ${remoteAddress})`
            )
          },
          (err: unknown) => {
            binding = false
            this.metrics.handshakeRejected('unavailable')
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
      if (frame.type === 'shim/response' || frame.type === 'shim/event') {
        // A reply, or a recurring event on a stream the daemon opened: hand it to whoever is
        // waiting. Neither is trusted beyond its correlation id — a channel only resolves a
        // request it actually issued, and a stream consumer only accepts its own stream id.
        const text = typeof data === 'string' ? data : String(data)
        for (const listener of frameListeners) listener(text)
        return
      }
      if (frame.type === 'shim/request') {
        // The daemon is the requester on this channel; a request FROM the sandbox is
        // out of protocol and closing is the safe response.
        ws.close(4400, 'unexpected request from sandbox')
      }
    })

    ws.on('close', () => {
      if (bound) {
        this.connections.delete(bound)
        this.deps.onConnectionLost?.(bound.binding.agentId, 'shim channel closed')
        // Revoke this channel's OWN credential: a same-pod renewal may already hold the
        // pod's index, and revoking by pod here would delete the live replacement.
        this.registry.revokeIssued(bound.issuedCredential)
      }
    })
  }

  private async bindFrom(
    token: string,
    remoteAddress: string,
    stillOpen: () => boolean
  ): Promise<
    | { ok: true; credential: string; binding: Binding; superseded: Binding[] }
    | { ok: false; rejected: ShimRejected }
    | { ok: false; abandoned: true }
  > {
    const review = await this.deps.verifier.reviewToken(token, [SHIM_TOKEN_AUDIENCE])
    if (!review.authenticated || !review.podName || !review.podUid) {
      // The API server did not accept the token: an identity failure, counted apart from our
      // own fencing refusals below, which are this daemon working as designed.
      this.metrics.tokenReviewRejected()
      this.metrics.handshakeRejected('unauthenticated')
      this.deps.log.warn(
        `shim: rejected an unauthenticated callback from ${remoteAddress}` +
          `${review.error ? ` (${withoutToken(review.error, token)})` : ''}`
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
      this.metrics.handshakeRejected('unknown_pod')
      this.deps.log.warn(`shim: no spawn record for pod ${pod.name} (${remoteAddress})`)
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'unknown_pod', message: 'pod not recognized' } }
    }
    // Last check before the only mutation in this path: the registry must not be touched
    // on behalf of a socket that closed while the review was in flight.
    if (!stillOpen()) return { ok: false, abandoned: true }
    const bound = this.registry.bind(record, pod)
    if (!bound.ok) {
      // A newer launch already holds this sandbox. Refusing without mutating is what stops
      // a terminating pod from reclaiming the channel during overlap.
      this.metrics.handshakeRejected('stale_generation')
      this.deps.log.warn(
        `shim: refused generation ${record.generation} for agent ${record.agentId} — ` +
          `generation ${bound.current} already holds the channel`
      )
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'stale_generation', message: 'superseded' } }
    }
    return { ok: true, credential: bound.credential, binding: bound.binding, superseded: bound.superseded }
  }
}
