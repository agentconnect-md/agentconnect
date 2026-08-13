import { isAbsolute, normalize } from 'node:path'
import { Backoff, ClientTransport, systemClock, type Clock } from '@agentconnect.md/connection'
import { noopClusterMetrics, type ClusterMetrics } from '../k8s/cluster-metrics.js'
import { ShimBindingRegistry, type Binding, type SpawnRecord } from './binding.js'
import type { PodIdentityVerifier, ShimConnection } from './listener.js'
import {
  SHIM_SUBPROTOCOL,
  SHIM_TOKEN_AUDIENCE,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimFrame,
  type ShimRejected
} from './protocol.js'
import type { ShimTransport } from './client.js'

export interface ShimDialerDeps {
  verifier: PodIdentityVerifier
  now?: () => number
  clock?: Clock
  dial?: (url: string, opts: { subprotocol: string; path: string }) => Promise<ShimTransport>
  credentialTtlMs?: number
  metrics?: ClusterMetrics
  log: { info: (message: string) => void; warn: (message: string) => void }
  onConnection?: (connection: ShimConnection) => void
  onConnectionLost?: (agentId: string, reason: string) => void
}

interface SupervisedDial {
  record: SpawnRecord
  endpoint: string
  stopped: boolean
  readySettled: boolean
  current?: ShimConnection
  ready: Promise<ShimConnection>
  resolveReady: (connection: ShimConnection) => void
  rejectReady: (error: Error) => void
}

const DEFAULT_CREDENTIAL_TTL_MS = 10 * 60_000

function withoutToken(message: string, token: string): string {
  return token.length > 0 ? message.split(token).join('[redacted]') : message
}

function sanitizeWorkspaceRoot(reported: string | undefined): string | undefined {
  if (!reported || !isAbsolute(reported)) return undefined
  const normalized = normalize(reported).replace(/\/+$/, '')
  return normalized.length > 0 ? normalized : undefined
}

/** The daemon-side owner of outbound sandbox channels. */
export class ShimDialer {
  private readonly registry: ShimBindingRegistry
  private readonly metrics: ClusterMetrics
  private readonly clock: Clock
  private readonly now: () => number
  private readonly dials = new Map<string, SupervisedDial>()

  constructor(private readonly deps: ShimDialerDeps) {
    const now = deps.now ?? (() => Date.now())
    this.now = now
    this.registry = new ShimBindingRegistry(now, deps.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS)
    this.metrics = deps.metrics ?? noopClusterMetrics
    this.clock = deps.clock ?? systemClock
  }

  connect(endpoint: string, record: SpawnRecord, timeoutMs: number): Promise<ShimConnection> {
    const existing = this.dials.get(record.agentId)
    if (
      existing &&
      !existing.stopped &&
      existing.endpoint === endpoint &&
      existing.record.generation === record.generation
    ) {
      return existing.current ? Promise.resolve(existing.current) : existing.ready
    }
    if (existing) this.stopDial(existing, 'superseded by a newer launch')
    let resolveReady: (connection: ShimConnection) => void = () => {}
    let rejectReady: (error: Error) => void = () => {}
    const ready = new Promise<ShimConnection>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const dial: SupervisedDial = {
      endpoint,
      record,
      stopped: false,
      readySettled: false,
      ready,
      resolveReady,
      rejectReady
    }
    this.dials.set(record.agentId, dial)
    void this.supervise(dial, timeoutMs)
    return ready
  }

  connectionsFor(agentId: string): ShimConnection[] {
    const current = this.dials.get(agentId)?.current
    return current ? [current] : []
  }

  authorize(input: Parameters<ShimBindingRegistry['authorize']>[0]): ReturnType<ShimBindingRegistry['authorize']> {
    return this.registry.authorize(input)
  }

  revokeAgent(agentId: string): void {
    const dial = this.dials.get(agentId)
    if (dial) this.stopDial(dial, 'binding revoked')
    this.dials.delete(agentId)
    this.registry.revokeAgent(agentId)
  }

  stop(): void {
    for (const dial of this.dials.values()) this.stopDial(dial, 'daemon shutting down')
    this.dials.clear()
  }

  private stopDial(dial: SupervisedDial, reason: string): void {
    if (dial.stopped) return
    dial.stopped = true
    dial.current?.close(reason)
    dial.current = undefined
    if (!dial.readySettled) {
      dial.readySettled = true
      dial.rejectReady(new Error(reason))
    }
  }

  private async supervise(dial: SupervisedDial, timeoutMs: number): Promise<void> {
    const deadline = this.clock.now() + timeoutMs
    const backoff = new Backoff()
    let first = true
    while (!dial.stopped) {
      try {
        const transport = await (this.deps.dial ?? defaultDial)(dial.endpoint, {
          subprotocol: SHIM_SUBPROTOCOL,
          path: SHIM_WS_PATH
        })
        const { connection, closed } = await this.bind(transport, dial.record)
        if (dial.stopped) {
          connection.close('dial no longer current')
          return
        }
        dial.current = connection
        backoff.reset()
        first = false
        if (!dial.readySettled) {
          dial.readySettled = true
          dial.resolveReady(connection)
        }
        this.deps.onConnection?.(connection)
        const close = await closed
        if (dial.current === connection) dial.current = undefined
        this.registry.revokeIssued(connection.issuedCredential)
        if (dial.stopped) return
        this.deps.onConnectionLost?.(dial.record.agentId, `shim channel closed (${close.code})`)
        const delay = close.reason === 'rebinding' ? 0 : backoff.next()
        if (delay > 0) await this.delay(delay)
      } catch (error) {
        if (dial.stopped) return
        if (this.clock.now() >= deadline && first) {
          const failure = new Error(`could not connect to sandbox shim: ${(error as Error).message}`)
          if (!dial.readySettled) {
            dial.readySettled = true
            dial.rejectReady(failure)
          }
          dial.stopped = true
          if (this.dials.get(dial.record.agentId) === dial) this.dials.delete(dial.record.agentId)
          return
        }
        const delay = backoff.next()
        this.deps.log.warn(`shim: sandbox dial failed, retrying in ${delay}ms (${(error as Error).message})`)
        await this.delay(delay)
      }
    }
  }

  private bind(
    transport: ShimTransport,
    record: SpawnRecord
  ): Promise<{ connection: ShimConnection; closed: Promise<{ code: number; reason: string }> }> {
    let resolveClosed: (value: { code: number; reason: string }) => void = () => {}
    const closed = new Promise<{ code: number; reason: string }>((resolve) => (resolveClosed = resolve))
    return new Promise((resolve, reject) => {
      let settled = false
      let binding = false
      const frameListeners: Array<(text: string) => void> = []
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const rejectPeer = (frame: ShimRejected): void => {
        try {
          transport.send(JSON.stringify(frame))
        } catch {
          // The peer is already gone.
        }
        transport.close(4403, frame.reason)
      }
      transport.onClose((code, reason) => {
        resolveClosed({ code, reason })
        fail(new Error(`connection closed (${code}${reason ? ` ${reason}` : ''})`))
      })
      transport.onMessage((text) => {
        const frame = parseShimFrame(text)
        if (!frame) {
          this.metrics.handshakeRejected('malformed')
          transport.close(4400, 'malformed frame')
          fail(new Error('malformed shim frame'))
          return
        }
        if (frame.type === 'shim/rejected') {
          fail(new Error(`rejected: ${frame.reason}`))
          return
        }
        if (frame.type === 'shim/identity' || (frame.type === 'shim/hello' && 'token' in frame)) {
          if (settled || binding) {
            transport.close(4400, 'already binding')
            return
          }
          binding = true
          void this.bindHello(frame.token, record)
            .then((result) => {
              binding = false
              if (settled) {
                if (result.ok) this.registry.revokeIssued(result.credential)
                return
              }
              if (!result.ok) {
                rejectPeer(result.rejected)
                fail(new Error(result.rejected.message))
                return
              }
              const workspaceRoot = sanitizeWorkspaceRoot(frame.workspaceRoot)
              const connection: ShimConnection = {
                binding: result.binding,
                issuedCredential: result.credential,
                ...(workspaceRoot ? { workspaceRoot } : {}),
                send: (outbound) => transport.send(JSON.stringify(outbound)),
                onFrame: (listener) => frameListeners.push(listener),
                close: (reason) => transport.close(4000, reason)
              }
              const remainingMs = result.binding.expiresAtMs - this.now()
              try {
                connection.send({
                  type: 'shim/bound',
                  sessionCredential: result.credential,
                  expiresInSeconds: Math.max(1, Math.floor(remainingMs / 1000)),
                  agentId: result.binding.agentId,
                  generation: result.binding.generation,
                  grants: result.binding.grants
                })
              } catch (error) {
                this.registry.revokeIssued(result.credential)
                throw error
              }
              settled = true
              const expiry = this.clock.setTimeout(
                () => connection.close('credential expired'),
                Math.max(0, remainingMs)
              )
              void closed.then(() => this.clock.clearTimeout(expiry))
              this.deps.log.info(
                `shim: bound agent ${result.binding.agentId} generation ${result.binding.generation} at ${record.podName}`
              )
              resolve({ connection, closed })
            })
            .catch((error: unknown) => {
              binding = false
              if (settled) return
              this.metrics.handshakeRejected('unavailable')
              rejectPeer({ type: 'shim/rejected', reason: 'unavailable', message: 'binding unavailable' })
              fail(error as Error)
            })
          return
        }
        if (!settled) {
          transport.close(4403, 'not bound')
          fail(new Error('shim did not present its identity'))
          return
        }
        if (frame.type === 'shim/response' || frame.type === 'shim/event') {
          for (const listener of frameListeners) listener(text)
        }
      })
      transport.send(
        JSON.stringify({
          type: 'shim/hello',
          agentId: record.agentId,
          generation: record.generation
        } satisfies Extract<ShimFrame, { type: 'shim/hello' }>)
      )
    })
  }

  private async bindHello(
    token: string,
    record: SpawnRecord
  ): Promise<
    { ok: true; credential: string; binding: Binding; superseded: Binding[] } | { ok: false; rejected: ShimRejected }
  > {
    const review = await this.deps.verifier.reviewToken(token, [SHIM_TOKEN_AUDIENCE])
    if (!review.authenticated || !review.podName || !review.podUid) {
      this.metrics.tokenReviewRejected()
      this.metrics.handshakeRejected('unauthenticated')
      this.deps.log.warn(
        `shim: sandbox token was not accepted${review.error ? ` (${withoutToken(review.error, token)})` : ''}`
      )
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'unauthenticated', message: 'not accepted' } }
    }
    if (review.podName !== record.podName) {
      this.metrics.handshakeRejected('unknown_pod')
      this.deps.log.warn(`shim: dialed pod ${record.podName} presented identity for ${review.podName}`)
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'unknown_pod', message: 'not accepted' } }
    }
    const bound = this.registry.bind(record, { name: review.podName, uid: review.podUid })
    if (!bound.ok) {
      this.metrics.handshakeRejected('stale_generation')
      return { ok: false, rejected: { type: 'shim/rejected', reason: 'stale_generation', message: 'superseded' } }
    }
    return bound
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms))
  }
}

function defaultDial(url: string, opts: { subprotocol: string; path: string }): Promise<ShimTransport> {
  return ClientTransport.dial(url, opts) as Promise<ShimTransport>
}
