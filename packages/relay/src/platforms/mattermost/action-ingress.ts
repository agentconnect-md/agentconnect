// Mattermost interactive message button callback ingress (`POST /mattermost/actions`).
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Clock } from '@agentconnect.md/connection'
import {
  MATTERMOST_ACTION_PATH,
  MATTERMOST_CARD_NOTE_MAX,
  MATTERMOST_PLATFORM,
  verifyMattermostActionToken,
  verifyMattermostActionTokenWithMaster,
  WireMattermostCardActionResponse,
  type MattermostActionClaims,
  type RdMsgPlatformAction,
  type WireMattermostCardAction
} from '@agentconnect.md/protocol'
import type { HookRateLimiter } from '../../hooks/rate-limit.js'
import type { Logger } from '../../log.js'
import type { RelayDaemonConnection } from '../../relay-daemon-connection.js'
import { settleWithin } from '../settle-within.js'

/** Mattermost waits a few seconds for interactive action POST responses; bound Relay wait inside that window. */
export const MATTERMOST_ACTION_DEADLINE_MS = 4_000
export const MATTERMOST_ACTION_BODY_LIMIT = 64 * 1024
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const MattermostButtonCallbackBody = z.object({
  user_id: z.string().regex(SAFE_ID_RE),
  user_name: z.string().max(256).nullish(),
  channel_id: z.string().regex(SAFE_ID_RE),
  team_id: z.string().max(64).nullish(),
  post_id: z.string().regex(SAFE_ID_RE),
  trigger_id: z.string().max(1024).nullish(),
  context: z.object({
    token: z.string().min(1).max(8192)
  })
})
type MattermostButtonCallbackBody = z.infer<typeof MattermostButtonCallbackBody>

export interface MattermostActionIngressDeps {
  /** Org-scoped or standalone HMAC secret (test/legacy path when `masterSecret` is not configured). */
  secret?: () => string | undefined
  /** Deployment master HMAC secret for verifying `mm1` org-scoped tokens and deriving org secrets. */
  masterSecret?: () => string | undefined
  getDaemon: (daemonId: string) => Pick<RelayDaemonConnection, 'sendMsg'> | undefined
  daemonForAgent: (agentId: string) => string | undefined
  /** Authoritative agent -> orgId fencing map; required in `masterSecret` mode to stop cross-tenant replay. */
  orgForAgent?: (agentId: string) => string | undefined
  limiter?: Pick<HookRateLimiter, 'allow'>
  clock: Pick<Clock, 'now'>
  log: Pick<Logger, 'debug' | 'warn'>
  timeoutMs?: number
}

function ephemeralBody(text: string): { ephemeral_text: string } {
  return { ephemeral_text: text.slice(0, MATTERMOST_CARD_NOTE_MAX) }
}

/** Deterministic dedup identity per Mattermost button click delivery. */
export function mattermostActionMsgId(
  body: Pick<MattermostButtonCallbackBody, 'post_id' | 'user_id' | 'trigger_id'>,
  payload: Pick<WireMattermostCardAction, 'kind' | 'requestId' | 'option' | 'token' | 'cardId' | 'generation'>
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        postId: body.post_id,
        userId: body.user_id,
        ...(body.trigger_id ? { triggerId: body.trigger_id } : {}),
        kind: payload.kind,
        requestId: payload.requestId,
        ...(payload.option !== undefined ? { option: payload.option } : {}),
        ...(payload.token !== undefined ? { token: payload.token } : {}),
        ...(payload.cardId !== undefined ? { cardId: payload.cardId } : {}),
        ...(payload.generation !== undefined ? { generation: payload.generation } : {})
      })
    )
    .digest('hex')
  return `mattermost-action:${digest}`
}

/** Register `POST /mattermost/actions` for Mattermost interactive message attachment button clicks. */
export function registerMattermostActionIngress(app: FastifyInstance, deps: MattermostActionIngressDeps): void {
  const timeoutMs = deps.timeoutMs ?? MATTERMOST_ACTION_DEADLINE_MS

  app.post(MATTERMOST_ACTION_PATH, { bodyLimit: MATTERMOST_ACTION_BODY_LIMIT }, async (req, reply) => {
    const parsedBody = MattermostButtonCallbackBody.safeParse(req.body)
    if (!parsedBody.success) {
      deps.log.debug(
        `mattermost action: invalid callback payload fields: ${parsedBody.error.issues.map((i) => i.path.join('.')).join(', ')}`
      )
      return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
    }
    const body = parsedBody.data
    const rawTeamId = body.team_id?.trim()
    if (rawTeamId && !SAFE_ID_RE.test(rawTeamId)) {
      return reply.code(400).send({ error: 'Bad Request', statusCode: 400 })
    }

    const useMaster = Boolean(deps.masterSecret)
    const configuredSecret = useMaster ? deps.masterSecret?.() : deps.secret?.()
    if (!configuredSecret) {
      return reply.code(503).send({ error: 'Mattermost action callback unavailable' })
    }

    const claims: MattermostActionClaims | null = useMaster
      ? verifyMattermostActionTokenWithMaster(body.context.token, configuredSecret, deps.clock.now())
      : verifyMattermostActionToken(body.context.token, configuredSecret, deps.clock.now())
    if (!claims) {
      deps.log.debug('mattermost action: rejected invalid or expired callback token')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    if (body.channel_id !== claims.channelId) {
      deps.log.warn('mattermost action: channel_id mismatch against signed token')
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (useMaster) {
      const liveOrgId = deps.orgForAgent?.(claims.agentId)
      if (!liveOrgId || liveOrgId !== claims.orgId) {
        deps.log.warn('mattermost action: agent org mismatch or unknown agent for signed token')
        return reply.code(403).send({ error: 'Forbidden' })
      }
    }

    if (deps.limiter && !deps.limiter.allow(claims.integrationId)) {
      deps.log.warn(`mattermost action: rate limited callbacks for integration ${claims.integrationId}`)
      return reply.code(429).send({ error: 'Too Many Requests', statusCode: 429 })
    }

    const targetDaemonId = useMaster
      ? deps.daemonForAgent(claims.agentId)
      : (deps.daemonForAgent(claims.agentId) ?? claims.daemonId)
    const daemon = targetDaemonId ? deps.getDaemon(targetDaemonId) : undefined
    if (!daemon) {
      return reply
        .code(200)
        .send(
          ephemeralBody(
            'AgentConnect daemon is offline right now. Try again in a moment or answer in the AgentConnect console.'
          )
        )
    }

    const userName = body.user_name?.trim()
    const teamId = rawTeamId
    const payload: WireMattermostCardAction = {
      postId: body.post_id,
      channelId: body.channel_id,
      ...(teamId ? { teamId } : {}),
      userId: body.user_id,
      ...(userName ? { userName } : {}),
      kind: claims.kind,
      requestId: claims.requestId,
      ...(claims.option !== undefined ? { option: claims.option } : {}),
      ...(claims.token !== undefined ? { token: claims.token } : {}),
      ...(claims.cardId !== undefined ? { cardId: claims.cardId } : {}),
      ...(claims.generation !== undefined ? { generation: claims.generation } : {})
    }

    const rd: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: MATTERMOST_PLATFORM,
      agentId: claims.agentId,
      sessionKey: `mattermost-action:${body.post_id}`,
      msgId: mattermostActionMsgId(body, payload),
      botId: claims.integrationId,
      integrationId: claims.integrationId,
      userId: body.user_id,
      payload
    }

    const outcome = await settleWithin(daemon.sendMsg(rd), timeoutMs)
    if (outcome.kind === 'expired') {
      deps.log.warn(`mattermost action: timed out forwarding click for post ${body.post_id}`)
      return reply.code(200).send(ephemeralBody('Processing your response…'))
    }
    if (outcome.kind === 'failed') {
      deps.log.warn(`mattermost action: failed forwarding click for post ${body.post_id}`)
      return reply
        .code(200)
        .send(ephemeralBody('Could not deliver your action. Try again or answer in the AgentConnect console.'))
    }

    const ack = outcome.handled
    const parsedResponse = ack.response === undefined ? null : WireMattermostCardActionResponse.safeParse(ack.response)
    if (parsedResponse?.success && parsedResponse.data.ephemeralText) {
      return reply.code(200).send(ephemeralBody(parsedResponse.data.ephemeralText))
    }
    if (!ack.accepted) {
      return reply.code(200).send(ephemeralBody('This action is no longer available.'))
    }
    return reply.code(200).send({})
  })
}
