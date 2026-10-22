// Microsoft Teams' messaging endpoint (teams-integration.md §3, §4.2): a message's HTTP answer IS its admission verdict; a card click is always answered 200.
import type { FastifyInstance } from 'fastify'
import { MSTEAMS_MESSAGES_PATH, MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import { MSTEAMS_BODY_LIMIT, msTeamsActivityOf, msTeamsInvokeNote } from './http-ingest.js'
import type { RelayIngressRouteDeps } from '../contract.js'
import { settleWithin } from '../settle-within.js'

/** The route settles a message within this, keeping relay requests bounded; Teams redelivers a 503 once (§4.2). */
export const MSTEAMS_ADMISSION_DEADLINE_MS = 10_000

/** The Teams client waits about five seconds for a click's answer, so the note must leave before that. */
export const MSTEAMS_INVOKE_DEADLINE_MS = 4_000

/** The note a click gets when the relay could not settle it in time. */
export const MSTEAMS_INVOKE_UNAVAILABLE = 'This answer could not be delivered. Please try again.'

function parseActivity(rawBody: Buffer): Record<string, unknown> | undefined {
  try {
    return msTeamsActivityOf(JSON.parse(rawBody.toString('utf8')))
  } catch {
    return undefined
  }
}

/** Mount the route; the deadlines are overridden only by tests that exercise their expiry. */
export function registerMsTeamsHttpIngress(
  app: FastifyInstance,
  deps: RelayIngressRouteDeps,
  deadlines: { admissionMs?: number; invokeMs?: number } = {}
): void {
  const admissionMs = deadlines.admissionMs ?? MSTEAMS_ADMISSION_DEADLINE_MS
  const invokeMs = deadlines.invokeMs ?? MSTEAMS_INVOKE_DEADLINE_MS
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MSTEAMS_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post(MSTEAMS_MESSAGES_PATH, { bodyLimit: MSTEAMS_BODY_LIMIT }, async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const activity = parseActivity(rawBody)
      if (!activity) return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      const invoke = activity.type === 'invoke'
      const manager = deps.manager()
      const outcome = await settleWithin(
        manager ? manager.handleInbound(MSTEAMS_PLATFORM, rawBody, activity, req.headers) : Promise.resolve(undefined),
        invoke ? invokeMs : admissionMs
      )
      if (outcome.kind !== 'handled') {
        deps.log.warn(`msteams ingress: handling ${outcome.kind} before an answer`)
        // A click is answered inside the client's window either way; a message gets the 503 Teams redelivers once.
        if (invoke) return reply.code(200).send(msTeamsInvokeNote(MSTEAMS_INVOKE_UNAVAILABLE))
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      }
      // No assigned bot owns the activity, or its token did not verify: 401, and nothing was routed.
      if (!outcome.handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      if (outcome.handled.admission?.disposition === 'retry')
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      // A click's note rides the 200 body; every other answer is empty.
      const body = outcome.handled.syncResponse
      return body === undefined ? reply.code(200).send() : reply.code(200).send(body)
    })
  })
}
