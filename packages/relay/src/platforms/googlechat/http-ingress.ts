// Google Chat's public callback route (google-chat-integration.md §4): the HTTP answer IS the admission verdict.
import type { FastifyInstance } from 'fastify'
import { GOOGLE_CHAT_EVENTS_PATH, GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import { GOOGLE_CHAT_BODY_LIMIT } from './http-ingest.js'
import type { HandledDelivery, RelayIngressRouteDeps } from '../contract.js'

/** Google allows 30 s for the synchronous answer; expiring earlier leaves room to still send the 503 it retries on. */
export const GOOGLE_CHAT_ADMISSION_DEADLINE_MS = 20_000

type Outcome = { kind: 'handled'; handled: HandledDelivery | undefined } | { kind: 'expired' } | { kind: 'failed' }

// Settle the handling within `deadlineMs`; the work keeps running past an expiry, and a late admission is marked as usual.
function settleWithin(work: Promise<HandledDelivery | undefined>, deadlineMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'expired' }), deadlineMs)
    work.then(
      (handled) => {
        clearTimeout(timer)
        resolve({ kind: 'handled', handled })
      },
      () => {
        clearTimeout(timer)
        resolve({ kind: 'failed' })
      }
    )
  })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// An add-on `EventObject` with its `chat` object is the least a delivery can be (§11.3).
function parseEventBody(rawBody: Buffer): Record<string, unknown> | undefined {
  let body: unknown
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return undefined
  }
  return isObject(body) && isObject(body.chat) ? body : undefined
}

/** Mount the route; `deadlineMs` is the admission deadline, overridden only by tests that exercise its expiry. */
export function registerGoogleChatHttpIngress(
  app: FastifyInstance,
  deps: RelayIngressRouteDeps,
  deadlineMs = GOOGLE_CHAT_ADMISSION_DEADLINE_MS
): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: GOOGLE_CHAT_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post(GOOGLE_CHAT_EVENTS_PATH, { bodyLimit: GOOGLE_CHAT_BODY_LIMIT }, async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const body = parseEventBody(rawBody)
      if (!body) return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      const manager = deps.manager()
      const outcome = await settleWithin(
        manager ? manager.handleInbound(GOOGLE_CHAT_PLATFORM, rawBody, body, req.headers) : Promise.resolve(undefined),
        deadlineMs
      )
      // An unknown outcome is answered 503 so Google may redeliver; the daemon's receipt settles a copy that did land.
      if (outcome.kind !== 'handled') {
        deps.log.warn(`googlechat ingress: handling ${outcome.kind} before an answer — asking Google to redeliver`)
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      }
      // No assigned bot owns the delivery, or its token did not verify: 401, and nothing was routed.
      if (!outcome.handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      if (outcome.handled.admission?.disposition === 'retry')
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      // An unclaimed tenant's welcome card or authorization prompt (§10.4) rides the 200 body; every other answer is empty.
      return reply.code(200).send(outcome.handled.syncResponse ?? {})
    })
  })
}
