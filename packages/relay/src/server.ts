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
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import { relayOtelFastifyPlugin } from './observability.js'

export interface RelayServerDeps {
  /** True once the relay↔CP link has registered and is heartbeating. */
  isReady: () => boolean
  /** The CP-assigned relayId, once registered (for the readiness body). */
  relayId: () => string | undefined
}

/**
 * The generic-webhook ingress carries its capability token IN the path
 * (`POST /webhooks/in/<token>`), and that token is the ONLY authenticator when a
 * hook is configured without an HMAC — the default. Fastify logs `req.url` on
 * every request, so an ordinary access log hands anyone who can read it (an
 * operator, a log-shipping vendor, a crash bundle) the ability to fire that hook
 * into the owning org's agent. Redact the token segment before it is ever
 * serialized.
 */
export function redactUrl(url: string): string {
  return url.replace(/^(\/webhooks\/in\/)[^/?#]+/, '$1<redacted>')
}

/** Fastify's default `req` serializer, with the url redacted. Applied at the
 *  serializer rather than per-route so unmatched paths (404s from probes and
 *  typo'd tokens) are covered by the same rule. */
function redactingReqSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url ?? ''),
    host: req.headers.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort
  }
}

/**
 * Attach the redacting serializer to whatever logging the caller configured, so no
 * supported Fastify option can route around it. `logger: true` has to be widened to
 * an object to carry serializers at all; `loggerInstance` is a pre-built pino whose
 * serializers were fixed at construction, so it is replaced by a child that redacts
 * (children inherit into Fastify's own per-request children). Logging switched off
 * stays off — nothing is serialized, so there is nothing to redact.
 */
function withRedactedRequestLog(opts?: FastifyServerOptions): FastifyServerOptions {
  const base = opts ?? { logger: true }
  const out: FastifyServerOptions = { ...base }
  if (base.loggerInstance) {
    out.loggerInstance = base.loggerInstance.child({}, { serializers: { req: redactingReqSerializer } })
  }
  if (base.logger) {
    const logger = base.logger === true ? {} : base.logger
    out.logger = {
      ...logger,
      serializers: { ...(typeof logger === 'object' ? logger.serializers : {}), req: redactingReqSerializer }
    }
  }
  return out
}

export function buildRelayServer(deps: RelayServerDeps, opts?: FastifyServerOptions): FastifyInstance {
  const app = Fastify(withRedactedRequestLog(opts))

  // Route-level spans. Absent unless the SDK started, so tests and
  // self-hosted relays build the same server without it.
  const otelPlugin = relayOtelFastifyPlugin()
  if (otelPlugin) void app.register(otelPlugin)

  // Fastify's built-in 404 logs `Route POST:/webhooks/in/<token> not found`, which
  // would re-leak the very token the serializer redacts — and an unknown or typo'd
  // token is exactly the request that 404s. Answer without echoing the path.
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'route not found' })
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_req, reply) => {
    if (deps.isReady()) return { status: 'ready', relayId: deps.relayId() ?? null }
    reply.code(503)
    return { status: 'connecting' }
  })

  return app
}
