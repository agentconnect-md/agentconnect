/**
 * `app.ts` — `buildApp(deps)`: the assembly factory BOTH production and tests
 * call (design §2.4, §6 Phase 5).
 *
 * It is the single composition entrypoint: production (`index.ts`) calls it with
 * a real `PrismaClient`, the `SystemClock`, and the real secrets provider; tests
 * call it with the shared Testcontainers `PrismaClient`, a `FakeClock`, and a
 * memory provider — constructing the IDENTICAL graph through the same seams. So
 * the REST surface and the daemon WS endpoint provably share one DB and one
 * orchestrator: a `POST /agents` and a later `register/ok` reconcile read/write
 * the same Postgres.
 *
 * `buildApp` delegates the bottom-up wiring to {@link buildContainer} and returns
 * the wired app the bootstrap drives: the Fastify instance, a `mountWs` to attach
 * the daemon gateway once the HTTP server is listening, and `shutdown`.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { PrismaClient } from './generated/prisma/client.js'
import type { WebSocket, WebSocketServer } from 'ws'

import { type AppConfig, loadConfig } from './config/env.js'
import { type Clock, systemClock } from './domain/clock.js'
import type { SecretsProvider } from './secrets/providers/provider.js'
import type { SecretCipher } from './secrets/cipher.js'
import type { DeploymentConfigRuntime } from './persistence/deployment-config.js'
import type { FetchLike } from './github/api.js'
import { makeSecretsProvider } from './secrets/providers/memory.js'
import { buildContainer } from './container.js'

/** The seams `buildApp` injects (each swappable for a fake in tests). */
export interface BuildAppDeps {
  /** The Postgres connection (the only Prisma touch is the repos behind it). */
  prisma: PrismaClient
  /** Validated config; defaults to `loadConfig()` (fail-fast on `process.env`). */
  config?: AppConfig
  /** The time seam — `SystemClock` in prod, `FakeClock` in tests. */
  clock?: Clock
  /** The C5 provider — memory in dev/tests, Vault/KMS later (same port). */
  secretsProvider?: SecretsProvider
  /** The at-rest transform every persisted secret VALUE passes through. Absent ⇒
   *  selected from `config.SECRET_CIPHER` (none → identity, vault-transit → Vault). */
  secretCipher?: SecretCipher
  /** Immutable deployment snapshot loaded before composition. It is used for
   *  authenticated startup projection to DB-less peers, never hot-reloaded. */
  deploymentConfig?: DeploymentConfigRuntime
  /** Fastify server options for the HTTP edge (e.g. `{ logger: true }`). */
  fastify?: FastifyServerOptions
  /** GitHub REST fetch override — integration tests stub the API without network. */
  githubFetch?: FetchLike
  /** npm dist-tags fetch override for the daemon "latest version" resolver — tests
   *  stub it (absent under NODE_ENV=test ⇒ the resolver is inert, no network). */
  daemonReleaseFetch?: FetchLike
  /** open-connector admin API fetch override — integration tests stub it (absent under
   *  NODE_ENV=test ⇒ the connectors client is not assembled). */
  connectorsFetch?: FetchLike
  /** Linear OAuth/GraphQL fetch override — the connect funnel's suites run a stubbed Linear. */
  linearFetch?: FetchLike
}

/** The wired app both prod and tests drive. */
export interface App {
  /** The Fastify instance serving the C2 BFF + `/health`. */
  http: FastifyInstance
  /**
   * Mount the daemon WS gateway on the live `http.Server`. Call AFTER
   * `http.listen()` resolves (so `http.server` exists). Idempotent: a second call
   * returns the already-mounted server.
   */
  mountWs(): WebSocketServer
  /** The single-tenant anchors (the devAuth principal's org/owner). */
  readonly defaults: { orgId: string; ownerId: string }
  /** Arm the background loops (cron-run reaper). Call after `listen`; tests skip
   *  it so no live timer runs under a `FakeClock`. */
  startBackground(): void
  /**
   * Flip the process into "shutting down" so `/readyz` reports 503 (issue #240).
   * The bootstrap calls this at the TOP of the SIGTERM handler — before
   * `drainWs()` — so Kubernetes removes the pod from the Service endpoints while
   * it can still serve in-flight requests, closing the rolling-update window
   * where a terminating pod keeps receiving new traffic. Idempotent.
   */
  beginShutdown(): void
  /**
   * Actively close every established daemon + relay WS socket with `1012`
   * (service restart). MUST run before `http.close()` on shutdown: Fastify's
   * close never destroys upgraded sockets, so with any WS client connected it
   * blocks until the pod is SIGKILLed — meanwhile daemons stay pinned to the
   * dying process instead of reconnecting. `1012` is non-fatal to the daemon
   * (only 4401 is), so clients reconnect immediately. Resolves once every
   * socket finished the close handshake (stragglers are force-terminated).
   */
  drainWs(): Promise<void>
  /** Graceful teardown — stops background loops, disconnects Prisma and closes the WS server. */
  shutdown(): Promise<void>
}

/** How long drainWs waits for a client to finish the close handshake before force-terminating it. */
const DRAIN_GRACE_MS = 2000

async function drainServer(s: WebSocketServer | undefined): Promise<void> {
  if (!s) return
  // Flip the server out of RUNNING first (synchronous): from here on ws aborts
  // any in-flight/new upgrade with a 503, so a client reconnecting mid-drain
  // cannot slip in a fresh upgraded socket and wedge the http.close() that
  // follows. In noServer mode close()'s callback also only fires once the
  // client set empties — which the drain below guarantees.
  const serverClosed = new Promise<void>((resolve) => s.close(() => resolve()))
  const sockets: WebSocket[] = [...s.clients]
  const allClosed = Promise.all(
    sockets.map(
      (sock) =>
        new Promise<void>((resolve) => {
          if (sock.readyState === sock.CLOSED) resolve()
          else sock.once('close', () => resolve())
        })
    )
  )
  for (const sock of sockets) sock.close(1012, 'control plane restarting')
  const hardStop = setTimeout(() => {
    for (const sock of sockets) if (sock.readyState !== sock.CLOSED) sock.terminate()
  }, DRAIN_GRACE_MS)
  hardStop.unref()
  await Promise.all([allClosed, serverClosed])
  clearTimeout(hardStop)
}

export function buildApp(deps: BuildAppDeps): App {
  const config = deps.config ?? loadConfig()
  const clock = deps.clock ?? systemClock
  const secretsProvider = deps.secretsProvider ?? makeSecretsProvider(config)

  const container = buildContainer(config, deps.prisma, clock, secretsProvider, {
    ...(deps.fastify ? { fastify: deps.fastify } : {}),
    ...(deps.githubFetch ? { githubFetch: deps.githubFetch } : {}),
    ...(deps.daemonReleaseFetch ? { daemonReleaseFetch: deps.daemonReleaseFetch } : {}),
    ...(deps.connectorsFetch ? { connectorsFetch: deps.connectorsFetch } : {}),
    ...(deps.linearFetch ? { linearFetch: deps.linearFetch } : {}),
    ...(deps.secretCipher ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.deploymentConfig ? { deploymentConfig: deps.deploymentConfig } : {})
  })

  let wss: WebSocketServer | undefined
  let relayWss: WebSocketServer | undefined

  return {
    http: container.http,
    mountWs() {
      if (!wss) {
        // Fastify drops its bind-failure listener once listen() resolves, so a later accept error is fatal unheard.
        container.http.server.on('error', (err) => container.http.log.warn(`http server socket error: ${err.message}`))
        wss = container.wsGateway(container.http)
        // The relay control gateway rides the same http.Server on its own path;
        // mount it alongside so one `mountWs()` call attaches both edges.
        relayWss = container.relayGateway(container.http)
      }
      return wss
    },
    defaults: container.defaults,
    startBackground() {
      container.startBackground()
    },
    beginShutdown() {
      container.readiness.beginShutdown()
    },
    async drainWs() {
      await Promise.all([drainServer(wss), drainServer(relayWss)])
    },
    async shutdown() {
      // Drain any still-connected clients first: in noServer mode `wss.close()`
      // never closes established sockets — its callback only fires once the
      // client set empties, so without the drain this await can hang forever.
      await Promise.all([drainServer(wss), drainServer(relayWss)])
      // Close all WS servers so no upgrade races the Prisma disconnect.
      const close = (s: WebSocketServer | undefined): Promise<void> =>
        new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()))
      await Promise.all([close(wss), close(relayWss)])
      await container.shutdown()
    }
  }
}
