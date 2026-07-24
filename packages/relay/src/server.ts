/**
 * `buildRelayServer` — the relay's Fastify HTTP surface. Milestone A serves only
 * k8s liveness/readiness probes; the daemon-facing (`rd/*`) and browser-facing
 * (webchat) WS gateways attach to this same `http.Server` as `noServer` upgrades
 * in PR 2/3 (the CP two-gateways-on-one-server pattern), and the public webhook
 * POST ingress lands here in milestone B.
 *
 * `/healthz` is unconditional liveness (the process is up). `/readyz` reflects
 * the relay↔CP link: 503 until registration completes, so a rolling deploy keeps
 * a not-yet-registered pod out of the Service until it can actually route.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'

export interface RelayServerDeps {
  /** True once the relay↔CP link has registered and is heartbeating. */
  isReady: () => boolean
  /** The CP-assigned relayId, once registered (for the readiness body). */
  relayId: () => string | undefined
}

export function buildRelayServer(deps: RelayServerDeps, opts?: FastifyServerOptions): FastifyInstance {
  const app = Fastify(opts ?? { logger: true })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_req, reply) => {
    if (deps.isReady()) return { status: 'ready', relayId: deps.relayId() ?? null }
    reply.code(503)
    return { status: 'connecting' }
  })

  return app
}
