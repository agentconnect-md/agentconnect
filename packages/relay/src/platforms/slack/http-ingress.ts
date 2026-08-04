/**
 * Slack HTTP ingress — `POST /slack/events` + `POST /slack/interactions`,
 * the relay pool's ONE inbound Events API surface for every HTTP Slack bot (the
 * successor to the per-bot Socket Mode consumer). One stable public URL behind the
 * LB; any pod may receive any bot's delivery, so this endpoint is stateless demux:
 *
 *  - `url_verification` (the manifest handshake) is answered 200 `{ challenge }`
 *    IMMEDIATELY, before any demux/verify — it carries no `api_app_id`/`team_id` and
 *    arrives before any assign. Echoing the non-secret challenge is the documented
 *    handshake;
 *  - every other POST is demuxed to a bot AND authenticated in one step by the Slack
 *    request signature (HMAC over the raw bytes, keyed by that bot's signing secret) —
 *    `resolveVerified`; a request that no assigned bot's secret verifies ⇒ 401;
 *  - Events are deduped by `(api_app_id, team_id, event_id)` (Slack redelivers on a
 *    slow/again-seen 200, while separate apps may receive the same underlying event),
 *    then ACK'd 200 and forwarded ASYNC (Slack's 3s window). Interactions run the
 *    handler to completion because `block_suggestion` must return its options on the
 *    200 body; all other interaction side-effects run after the return value.
 *
 * Raw-buffer parsers (both content types) live in an isolated plugin scope so they
 * never leak onto the relay's other JSON/health surfaces; the HMAC needs the exact
 * request bytes (Fastify's default urlencoded parser would destroy them).
 * Signing secrets + tokens are NEVER logged.
 */
import type { FastifyInstance } from 'fastify'
import type { Logger } from '../../log.js'
import type { SlackInteractiveBody, SlackMessageEvent } from './http-ingest.js'

/** Raw-body cap for the Slack endpoints (Slack payloads are well under 1 MiB). */
export const SLACK_BODY_LIMIT = 1024 * 1024

/** The §8 inbound seam the route drives (satisfied by `RelayIngressManager`):
 *  demux + verify + handle in one core-owned ladder; the plugin owns the
 *  cryptography and everything after authentication. `undefined` ⇒ 401. */
export interface SlackIngestResolver {
  handleInbound(
    platformId: string,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<import('../contract.js').HandledDelivery | undefined>
}

export interface SlackHttpIngressDeps {
  /** Late-bound — the manager is constructed alongside the rd/* server, after routes register. */
  manager: () => SlackIngestResolver | undefined
  log: Logger
}

function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function eventDedupKey(body: SlackEventEnvelope): string | undefined {
  if (!body.event_id) return undefined
  return `${body.api_app_id ?? ''}\0${body.team_id ?? ''}\0${body.event_id}`
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

export function registerSlackHttpIngress(app: FastifyInstance, deps: SlackHttpIngressDeps): void {
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
      const signature = headerString(req.headers['x-slack-signature'])
      const timestamp = headerString(req.headers['x-slack-request-timestamp'])

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

      // §8 verify → handle: demux/authentication and the dedup check (the plugin
      // mints the composite identity; core owns the table) run inside the seam.
      // Event handling is fired async by the plugin — the 200 stays inside
      // Slack's 3s window, exactly as before.
      const handled = await deps.manager()?.handleInbound('slack', raw, body, req.headers)
      if (!handled) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })
      return reply.code(200).send()
    })

    scope.post('/slack/interactions', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const signature = headerString(req.headers['x-slack-signature'])
      const timestamp = headerString(req.headers['x-slack-request-timestamp'])

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
