import { Backoff, ClientTransport, systemClock, type BackoffOpts, type Clock } from '@agentconnect.md/connection'
import { noopClusterMetrics, type ClusterMetrics } from '../metrics/cluster-metrics.js'
import { ShimBindingRegistry, spawnSubject, type Binding, type SpawnRecord } from './binding.js'
import {
  DEFAULT_CREDENTIAL_TTL_MS,
  sanitizeWorkspaceRoot,
  withoutToken,
  type PodIdentityVerifier,
  type ShimConnection
} from './connection.js'
import {
  SHIM_SUBPROTOCOL,
  SHIM_TOKEN_AUDIENCE,
  SHIM_WS_PATH,
  parseShimFrame,
  type ShimFrame,
  type ShimIdentity,
  type ShimRejected
} from './protocol.js'
import type { ShimTransport } from './client.js'

/** What a supervised dial is waiting on: a pod whose listener is still coming up, or a peer that went away. */
export type ShimDialPhase = 'startup' | 'reconnect'

/** Startup pacing: the pod was created moments ago, so a refusal means "not listening yet" and is met in ~100ms. */
export const STARTUP_DIAL_BACKOFF: BackoffOpts = { baseMs: 100 }

/** First startup handshake's budget, doubling after it: a dropped SYN reaches the pacing above, not the 10s default. */
export const STARTUP_HANDSHAKE_TIMEOUT_MS = 1_000

export interface ShimDialerDeps {
  verifier: PodIdentityVerifier
  now?: () => number
  clock?: Clock
  dial?: (
    url: string,
    opts: { subprotocol: string; path: string; handshakeTimeoutMs?: number }
  ) => Promise<ShimTransport>
  /** Per-phase backoff factory. Injected so tests dial and reconnect in milliseconds. */
  backoff?: (phase: ShimDialPhase) => Backoff
  credentialTtlMs?: number
  metrics?: ClusterMetrics
  log: { info: (message: string) => void; warn: (message: string) => void }
  onConnection?: (connection: ShimConnection) => void
  /** Named by the launch's subject, which for the agent's own pod is the agent id. */
  onConnectionLost?: (subject: string, reason: string) => void
}

interface SupervisedDial {
  record: SpawnRecord
  endpoint: string
  stopped: boolean
  readySettled: boolean
  inFlight?: ShimTransport
  current?: ShimConnection
  ready: Promise<ShimConnection>
  resolveReady: (connection: ShimConnection) => void
  rejectReady: (error: Error) => void
}

/** The daemon-side owner of outbound sandbox channels, one supervised dial per launch subject. */
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
    const existing = this.dials.get(spawnSubject(record))
    if (
      existing &&
      !existing.stopped &&
      existing.endpoint === endpoint &&
      existing.record.generation === record.generation
    ) {
      return existing.current ? Promise.resolve(existing.current) : this.awaitReady(existing, timeoutMs)
    }
    if (existing) this.stopDial(existing, 'superseded by a newer launch')
    const dial: SupervisedDial = {
      endpoint,
      record,
      stopped: false,
      readySettled: false,
      ...this.freshReady()
    }
    this.dials.set(spawnSubject(record), dial)
    void this.supervise(dial, timeoutMs)
    return this.awaitReady(dial, timeoutMs)
  }

  connectionsFor(subject: string): ShimConnection[] {
    const current = this.dials.get(subject)?.current
    return current ? [current] : []
  }

  authorize(input: Parameters<ShimBindingRegistry['authorize']>[0]): ReturnType<ShimBindingRegistry['authorize']> {
    return this.registry.authorize(input)
  }

  /** Stop a subject's dial and drop its credentials; the agent's other pods are untouched. */
  revoke(subject: string): void {
    const dial = this.dials.get(subject)
    if (dial) this.stopDial(dial, 'binding revoked')
    this.dials.delete(subject)
    this.registry.revokeSubject(subject)
  }

  stop(): void {
    for (const dial of this.dials.values()) this.stopDial(dial, 'daemon shutting down')
    this.dials.clear()
  }

  private stopDial(dial: SupervisedDial, reason: string): void {
    if (dial.stopped) return
    dial.stopped = true
    dial.inFlight?.close(4408, reason)
    dial.inFlight = undefined
    dial.current?.close(reason)
    dial.current = undefined
    if (!dial.readySettled) {
      dial.readySettled = true
      dial.rejectReady(new Error(reason))
    }
  }

  private async supervise(dial: SupervisedDial, timeoutMs: number): Promise<void> {
    const deadline = this.clock.now() + timeoutMs
    // Two policies, because a refused dial means something different before the first bind than after it.
    const startup = this.deps.backoff?.('startup') ?? new Backoff(STARTUP_DIAL_BACKOFF)
    const reconnect = this.deps.backoff?.('reconnect') ?? new Backoff()
    let everBound = false
    let startupAttempt = 0
    while (!dial.stopped) {
      try {
        const handshakeMs = everBound
          ? undefined
          : Math.min(STARTUP_HANDSHAKE_TIMEOUT_MS * 2 ** startupAttempt++, timeoutMs)
        const { connection, closed } = await this.dialAndBind(dial, timeoutMs, handshakeMs)
        if (dial.stopped) {
          connection.close('dial no longer current')
          return
        }
        dial.current = connection
        reconnect.reset()
        everBound = true
        if (!dial.readySettled) {
          dial.readySettled = true
          dial.resolveReady(connection)
        }
        this.deps.onConnection?.(connection)
        const close = await closed
        if (dial.current === connection) {
          dial.current = undefined
          this.resetReady(dial)
        }
        this.registry.revokeIssued(connection.issuedCredential)
        if (dial.stopped) return
        this.deps.onConnectionLost?.(spawnSubject(dial.record), `shim channel closed (${close.code})`)
        const delay = close.reason === 'rebinding' ? 0 : reconnect.next()
        if (delay > 0) await this.delay(delay)
      } catch (error) {
        if (dial.stopped) return
        if (this.clock.now() >= deadline && !everBound) {
          const failure = new Error(`could not connect to sandbox shim: ${(error as Error).message}`)
          if (!dial.readySettled) {
            dial.readySettled = true
            dial.rejectReady(failure)
          }
          dial.stopped = true
          if (this.dials.get(spawnSubject(dial.record)) === dial) this.dials.delete(spawnSubject(dial.record))
          return
        }
        const delay = everBound ? reconnect.next() : startup.next()
        this.deps.log.warn(`shim: sandbox dial failed, retrying in ${delay}ms (${(error as Error).message})`)
        await this.delay(delay)
      }
    }
  }

  private dialAndBind(
    dial: SupervisedDial,
    timeoutMs: number,
    /** This attempt's handshake budget, absent ⇒ the transport's default; binding keeps the full one either way. */
    handshakeTimeoutMs?: number
  ): Promise<{ connection: ShimConnection; closed: Promise<{ code: number; reason: string }> }> {
    const boundedMs = Math.max(1, timeoutMs)
    let transport: ShimTransport | undefined
    let timedOut = false
    let timeoutHandle: ReturnType<Clock['setTimeout']> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.clock.setTimeout(() => {
        timedOut = true
        transport?.close(4408, 'binding timeout')
        reject(new Error(`binding timed out after ${boundedMs}ms`))
      }, boundedMs)
    })
    const attempt = (async () => {
      transport = await (this.deps.dial ?? defaultDial)(dial.endpoint, {
        subprotocol: SHIM_SUBPROTOCOL,
        path: SHIM_WS_PATH,
        ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs })
      })
      if (timedOut || dial.stopped) {
        transport.close(4408, timedOut ? 'binding timeout' : 'dial no longer current')
        throw new Error(timedOut ? `binding timed out after ${boundedMs}ms` : 'dial no longer current')
      }
      dial.inFlight = transport
      try {
        return await this.bind(transport, dial.record)
      } finally {
        if (dial.inFlight === transport) dial.inFlight = undefined
      }
    })()
    return Promise.race([attempt, timeout]).finally(() => {
      if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle)
    })
  }

  private awaitReady(dial: SupervisedDial, timeoutMs: number): Promise<ShimConnection> {
    const boundedMs = Math.max(1, timeoutMs)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = this.clock.setTimeout(() => {
        if (settled) return
        settled = true
        dial.inFlight?.close(4408, 'binding timeout')
        reject(new Error(`could not connect to sandbox shim: binding timed out after ${boundedMs}ms`))
      }, boundedMs)
      void dial.ready.then(
        (connection) => {
          if (settled) return
          settled = true
          this.clock.clearTimeout(timer)
          resolve(connection)
        },
        (error: Error) => {
          if (settled) return
          settled = true
          this.clock.clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private resetReady(dial: SupervisedDial): void {
    Object.assign(dial, this.freshReady(), { readySettled: false })
  }

  /**
   * A fresh "next connection" promise for a dial.
   *
   * Its rejection is pre-observed, deliberately: a revoke or a supersede stops the dial whether
   * or not anything is waiting for its next connection, and that teardown is expected — the
   * caller that IS waiting still receives it through {@link awaitReady}, which attaches its own
   * handlers. Without this, an ordinary `revoke` surfaced as an unhandled rejection.
   */
  private freshReady(): Pick<SupervisedDial, 'ready' | 'resolveReady' | 'rejectReady'> {
    let resolveReady: (connection: ShimConnection) => void = () => {}
    let rejectReady: (error: Error) => void = () => {}
    const ready = new Promise<ShimConnection>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    return { ready, resolveReady, rejectReady }
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
        if (frame.type === 'shim/identity') {
          if (settled || binding) {
            transport.close(4400, 'already binding')
            return
          }
          binding = true
          const negotiated = this.negotiate(record, frame)
          void this.bindHello(frame.token, negotiated)
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

  private negotiate(record: SpawnRecord, identity: ShimIdentity): SpawnRecord {
    const supportsSkills = identity.features?.includes('cluster-skills-v1') === true
    const supportsWideSkills = supportsSkills && identity.features?.includes('cluster-skills-v2') === true
    return {
      ...record,
      grants: record.grants.filter((grant) =>
        grant === 'skills' ? supportsSkills : grant === 'skills-wide' ? supportsWideSkills : true
      )
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms))
  }
}

function defaultDial(
  url: string,
  opts: { subprotocol: string; path: string; handshakeTimeoutMs?: number }
): Promise<ShimTransport> {
  return ClientTransport.dial(url, opts) as Promise<ShimTransport>
}
