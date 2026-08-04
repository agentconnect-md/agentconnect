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
import type { SlackEventDedup } from '../../slack-event-dedup.js'
import type { SlackInteractiveBody, SlackMessageEvent } from './http-ingest.js'

/** Raw-body cap for the Slack endpoints (Slack payloads are well under 1 MiB). */
export const SLACK_BODY_LIMIT = 1024 * 1024

/** The minimum an ingest must expose to the route (satisfied by `SlackHttpIngest`). */
export interface SlackIngestHandlers {
  handleEvent(event: SlackMessageEvent | undefined, eventAtMs?: number): Promise<void>
  handleInteraction(body: SlackInteractiveBody): Promise<unknown>
}

/** Demux + authenticate an inbound POST to a bot's ingest (satisfied by `RelayIngressManager`). */
export interface SlackIngestResolver {
  resolveVerified(args: {
    apiAppId?: string
    teamId?: string
    timestamp: string | undefined
    rawBody: Buffer
    signature: string | undefined
  }): SlackIngestHandlers | undefined
}

export interface SlackHttpIngressDeps {
  /** Late-bound — the manager is constructed alongside the rd/* server, after routes register. */
  manager: () => SlackIngestResolver | undefined
  dedup: SlackEventDedup
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

      const ingest = deps.manager()?.resolveVerified({
        ...(body.api_app_id ? { apiAppId: body.api_app_id } : {}),
        ...(body.team_id ? { teamId: body.team_id } : {}),
        timestamp,
        rawBody: raw,
        signature
      })
      if (!ingest) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })

      // A retry for one app/install reuses this composite identity. Do not dedup on
      // event_id alone: one Slack message may be delivered to several explicitly
      // mentioned apps, and those callbacks must each reach their own agent.
      if (deps.dedup.seen(eventDedupKey(body))) return reply.code(200).send()

      // Ack NOW (Slack's 3s window); forward async. A forward miss is bounded loss.
      // `event_time` is seconds → ms for the CP's revocation fence.
      void ingest.handleEvent(body.event, body.event_time ? body.event_time * 1000 : undefined).catch((err) => {
        deps.log.warn(`slack ingress: event handler error: ${(err as Error).message}`)
      })
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

      const ingest = deps.manager()?.resolveVerified({
        ...(body.api_app_id ? { apiAppId: body.api_app_id } : {}),
        ...(body.team?.id ? { teamId: body.team.id } : {}),
        timestamp,
        rawBody: raw,
        signature
      })
      if (!ingest) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 })

      // block_suggestion needs its options ON the 200 body; every other branch returns ''.
      const result = await ingest.handleInteraction(body)
      return reply.code(200).send(result ?? '')
    })
  })
}
