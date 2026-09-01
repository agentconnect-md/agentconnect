// Linear's public callback route (§6.1). ONE static, shared URL: a Linear app configures
// exactly one webhook URL, and the signature authenticates while the payload identity demuxes.
import type { FastifyInstance } from 'fastify'
import { LINEAR_BODY_LIMIT } from './http-ingest.js'
import type { RelayIngressRouteDeps } from '../contract.js'

export function registerLinearHttpIngress(app: FastifyInstance, deps: RelayIngressRouteDeps): void {
  void app.register(async (scope) => {
    // Raw buffer: the HMAC covers the exact request bytes, so the parser must not reserialize.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: LINEAR_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/linear/events', { bodyLimit: LINEAR_BODY_LIMIT }, async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      let body: unknown
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      }
      // A delivery no assigned bot owns answers 401 — no oracle, and Linear retries it.
      const handled = await deps.manager()?.handleInbound('linear', rawBody, body, req.headers)
      if (!handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      // Always 200 once the signature verified, BEFORE daemon delivery resolves (§6.1): Linear's
      // 1 min/1 h/6 h ladder is too slow and too dangerous to use as our queue.
      return reply.code(200).send({})
    })
  })
}
