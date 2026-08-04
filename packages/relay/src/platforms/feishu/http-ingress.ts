import type { FastifyInstance } from 'fastify'
import type { Logger } from '../../log.js'
import {
  type FeishuCallbackHeaders,
  type FeishuHttpIngest,
  feishuCallbackAppId,
  type VerifiedFeishuCallback
} from './http-ingest.js'

export const FEISHU_BODY_LIMIT = 1024 * 1024
const FEISHU_CARD_ACTION_RESPONSE_TIMEOUT_MS = 2_500

export interface FeishuVerifiedDelivery {
  ingest: FeishuHttpIngest
  callback: VerifiedFeishuCallback
}

export interface FeishuIngestResolver {
  resolveFeishuVerified(args: {
    appId?: string
    rawBody: Buffer
    body: unknown
    headers: FeishuCallbackHeaders
  }): FeishuVerifiedDelivery | undefined
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
      const appId = feishuCallbackAppId(body)
      const timestamp = headerString(req.headers['x-lark-request-timestamp'])
      const nonce = headerString(req.headers['x-lark-request-nonce'])
      const signature = headerString(req.headers['x-lark-signature'])
      const resolved = deps.manager()?.resolveFeishuVerified({
        ...(appId ? { appId } : {}),
        rawBody,
        body,
        headers: {
          ...(timestamp ? { timestamp } : {}),
          ...(nonce ? { nonce } : {}),
          ...(signature ? { signature } : {})
        }
      })
      if (!resolved) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      if (resolved.callback.kind === 'challenge') {
        return reply.code(200).send({ challenge: resolved.callback.challenge })
      }
      if (resolved.ingest.seen(resolved.callback.eventId)) return reply.code(200).send({})
      if (resolved.callback.eventType === 'card.action.trigger') {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const response = await Promise.race([
          resolved.ingest.handle(resolved.callback).catch((error) => {
            deps.log.warn(`feishu ingress: card action handler error: ${(error as Error).message}`)
            return undefined
          }),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(() => resolve(undefined), FEISHU_CARD_ACTION_RESPONSE_TIMEOUT_MS)
          })
        ])
        if (timeout) clearTimeout(timeout)
        return reply.code(200).send(response ?? {})
      }
      void resolved.ingest.handle(resolved.callback).catch((error) => {
        deps.log.warn(`feishu ingress: event handler error: ${(error as Error).message}`)
      })
      return reply.code(200).send({})
    })
  })
}
