// The relay pool's Slack Events API + interactivity routes for every HTTP bot: demux by signature, and an event's answer is its delivery outcome (shared-bot-relay.md §12).
import type { FastifyInstance } from 'fastify'
import type { RelayIngressRouteDeps } from '../contract.js'
import { settleWithin } from '../settle-within.js'
import type { SlackInteractiveBody, SlackMessageEvent } from './http-ingest.js'

/** Raw-body cap for the Slack endpoints (Slack payloads are well under 1 MiB). */
export const SLACK_BODY_LIMIT = 1024 * 1024

/** Slack waits 3 s for an answer; settling at 2 s leaves time to still send the 503 it redelivers on. */
export const SLACK_EVENT_ANSWER_DEADLINE_MS = 2_000

/** Slack's last scheduled redelivery (`x-slack-retry-num`): failing it loses the event all the same and only counts toward Slack's auto-disable threshold. */
const SLACK_LAST_RETRY_NUM = 3

function slackRetryNum(headers: Record<string, string | string[] | undefined>): number {
  const value = Number(headers['x-slack-retry-num'])
  return Number.isInteger(value) ? value : 0
}

/** The subset of a Slack Events API envelope the route reads for demux + dispatch. */
interface SlackEventEnvelope {
  type?: string
  token?: string
  challenge?: string
  api_app_id?: string
  team_id?: string
  event_id?: string
  /** Seconds since epoch — when the event HAPPENED (not when it was delivered).
   *  Load-bearing for app-lifecycle events: Slack does not order them, so the CP
   *  needs the occurrence time to reject an uninstall that predates the
   *  credential it would revoke. */
  event_time?: number
  event?: SlackMessageEvent
}

/** Mount the routes; `deadlineMs` bounds an event's answer and is overridden only by tests that exercise its expiry. */
export function registerSlackHttpIngress(
  app: FastifyInstance,
  deps: RelayIngressRouteDeps,
  deadlineMs = SLACK_EVENT_ANSWER_DEADLINE_MS
): void {
  void app.register(async (scope) => {
    // Raw bytes for the HMAC — one isolated scope for both Slack content types.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: SLACK_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer', bodyLimit: SLACK_BODY_LIMIT },
      (_req, body, done) => done(null, body)
    )

    scope.post('/slack/events', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)

      let body: SlackEventEnvelope
      try {
        body = JSON.parse(raw.toString('utf8')) as SlackEventEnvelope
      } catch {
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      }

      // Manifest handshake: answer BEFORE demux/verify — it carries no app/team id and
      // arrives before any assign. The challenge is non-secret; echoing it is the flow.
      if (body.type === 'url_verification') {
        return reply.code(200).send({ challenge: body.challenge ?? '' })
      }

      // §8 verify → handle: demux, authentication, dedup and the forward all run inside the seam.
      const manager = deps.manager()
      const outcome = await settleWithin(
        manager ? manager.handleInbound('slack', raw, body, req.headers) : Promise.resolve(undefined),
        deadlineMs
      )
      // No assigned bot owns the delivery, or its signature did not verify: 401, and nothing was routed.
      if (outcome.kind === 'handled' && !outcome.handled) {
        return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      }
      if (outcome.kind === 'handled' && outcome.handled?.admission?.disposition !== 'retry')
        return reply.code(200).send()
      // No daemon took the event (or the outcome is unknown): a 503 makes Slack redeliver it, and a copy that did land is deduplicated.
      const why = outcome.kind === 'handled' ? 'reached no daemon' : `handling ${outcome.kind}`
      if (slackRetryNum(req.headers) >= SLACK_LAST_RETRY_NUM) {
        deps.log.warn(`slack ingress: event ${body.event_id ?? '?'} ${why} on Slack's last redelivery — answering 200`)
        return reply.code(200).send()
      }
      deps.log.warn(`slack ingress: event ${body.event_id ?? '?'} ${why} — asking Slack to redeliver`)
      return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
    })

    scope.post('/slack/interactions', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)

      // The interaction payload is urlencoded `payload=<json>`. The HMAC is over the
      // RAW urlencoded bytes (not the decoded JSON).
      const encoded = new URLSearchParams(raw.toString('utf8')).get('payload')
      if (!encoded) return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      let body: SlackInteractiveBody
      try {
        body = JSON.parse(encoded) as SlackInteractiveBody
      } catch {
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
      }

      // block_suggestion needs its options ON the 200 body — the plugin's
      // handler returns it as the syncResponse.
      const handled = await deps.manager()?.handleInbound('slack', raw, body, req.headers)
      if (!handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      return reply.code(200).send(handled.syncResponse ?? '')
    })
  })
}
