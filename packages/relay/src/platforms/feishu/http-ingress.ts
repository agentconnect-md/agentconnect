import type { FastifyInstance } from 'fastify'
import type { Logger } from '../../log.js'
import { type FeishuHttpIngest, type VerifiedFeishuCallback } from './http-ingest.js'

export const FEISHU_BODY_LIMIT = 1024 * 1024
const FEISHU_CARD_ACTION_RESPONSE_TIMEOUT_MS = 2_500

export interface FeishuVerifiedDelivery {
  ingest: FeishuHttpIngest
  callback: VerifiedFeishuCallback
}

export interface FeishuIngestResolver {
  handleInbound(
    platformId: string,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<import('../contract.js').HandledDelivery | undefined>
}

export interface FeishuHttpIngressDeps {
  manager: () => FeishuIngestResolver | undefined
  log: Logger
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function registerFeishuHttpIngress(app: FastifyInstance, deps: FeishuHttpIngressDeps): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: FEISHU_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/feishu/events', { bodyLimit: FEISHU_BODY_LIMIT }, async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      let body: unknown
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      }
      // §8 verify → handle: decode (token check / AES decrypt), the encrypted
      // challenge, per-bot dedup, and the plugin-owned card-action response
      // window all run inside the seam; the route returns the syncResponse.
      const handled = await deps.manager()?.handleInbound('feishu', rawBody, body, req.headers)
      if (!handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      return reply.code(200).send(handled.syncResponse ?? {})
    })
  })
}
