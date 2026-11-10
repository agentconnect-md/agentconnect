// The Console's personal-WeChat QR login (wechat-integration.md §2.2, §5); the bot token never leaves the Control Plane.
import { z } from 'zod'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { integrationPlatformAvailability, noInstallDaemonMessage } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { integrationToSpec } from '../../orchestrator/placement.js'
import { AgentId, BotId, IntegrationId, type OrgId } from '../../domain/ids.js'
import type { AgentRecord, BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import {
  WeChatLoginConflictError,
  WeChatLoginSetupError,
  type WeChatConfirmedLogin,
  type WeChatLoginService
} from './login.js'
import { WECHAT_PLATFORM_ID, weChatBotIdentity } from './provider.js'

export const WeChatLoginStartBody = z.object({
  agentId: z.string().uuid(),
  /** Reconnect: re-bind this WeChat bot instead of creating one. */
  botId: z.string().uuid().optional(),
  name: z.string().trim().max(80).optional()
})

export const WeChatLoginDto = z.object({
  id: z.string(),
  status: z.enum(['waiting', 'scanned', 'verify_code', 'completed', 'failed']),
  /** The WeChat login link to render as a QR code; it changes when WeChat expires the code. */
  qrUrl: z.string().nullable(),
  /** When the current QR code stops being offered (unscanned), for the Console's countdown. */
  expiresAt: z.string(),
  failureReason: z.enum(['expired', 'verify_code_blocked', 'agent_unavailable', 'setup_failed']).nullable(),
  integrationId: z.string().nullable(),
  botId: z.string().nullable(),
  /** The last characters of the bound WeChat user id, once connected. */
  wechatUserTail: z.string().nullable()
})

const PollQuery = z.object({
  verifyCode: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/)
    .optional()
})

/** The agent placement fence is held by a move; the confirmed login stays retryable. */
class PlacementBusy extends Error {}

const notFound = (message: string) => ({ error: 'Not Found', statusCode: 404, message })
const conflict = (message: string) => ({ error: 'Conflict', statusCode: 409, message })

function material(login: WeChatConfirmedLogin): BotSecretMaterial {
  return { botToken: login.botToken, appToken: login.ilinkBotId, signingSecret: null }
}

async function installable(
  deps: HttpDeps,
  req: FastifyRequest,
  agent: AgentRecord
): Promise<{ ok: true } | { ok: false; status: 404 | 409; message: string }> {
  const daemonId = await deps.placementResolver.installDaemon(agent)
  if (!daemonId) return { ok: false, status: 409, message: noInstallDaemonMessage(agent) }
  const availability = await integrationPlatformAvailability(deps, {
    daemonId,
    orgId: orgOf(req),
    viewer: ctxOf(req),
    platform: WECHAT_PLATFORM_ID
  })
  if (availability === 'not_found') return { ok: false, status: 404, message: 'daemon not found' }
  if (availability === 'unsupported') {
    return { ok: false, status: 409, message: "this agent's daemon does not have WeChat turned on" }
  }
  return { ok: true }
}

// Push the bot's current spec to every agent it serves, as any credential replacement does.
async function republish(deps: HttpDeps, req: FastifyRequest, orgId: OrgId, bot: BotRecord): Promise<void> {
  const secret = await deps.repos.botSecret.get(orgId, bot.id)
  if (!secret) return
  for (const integration of await deps.repos.integration.listForBot(bot.id)) {
    const agent = await deps.repos.agent.get(orgId, integration.agentId)
    if (!agent) continue
    const channels = await deps.repos.integrationChannel.listForIntegration(integration.id)
    const spec = await integrationToSpec(deps.platforms, deps.repos.session, integration, bot, secret, channels, agent)
    if (spec) {
      await deps.agentDelivery.integrationUpsert(agent, spec, () => {
        req.log.info('WeChat reconnect will be applied when the agent reconnects')
      })
    }
  }
}

function finalizer(deps: HttpDeps, req: FastifyRequest) {
  return async (login: WeChatConfirmedLogin): Promise<{ integrationId: IntegrationId; botId: BotId }> => {
    const orgId = login.orgId
    // The agent is read and authorized under the move gate, so the install lands on its current placement.
    const release = deps.agentMutations.tryBeginMutation(login.agentId)
    if (!release) throw new PlacementBusy('agent placement is changing')
    try {
      const agent = await deps.repos.agent.get(orgId, login.agentId)
      if (!agent || !canView(agent, ctxOf(req)) || !canEdit(agent, ctxOf(req))) {
        throw new WeChatLoginSetupError('agent_unavailable')
      }
      const identity = weChatBotIdentity(login)
      if (login.botId) {
        const bot = await deps.repos.bot.get(orgId, login.botId)
        if (!bot || bot.platform !== WECHAT_PLATFORM_ID) throw new WeChatLoginSetupError('setup_failed')
        const integration = (await deps.repos.integration.listForBot(bot.id)).find((i) => i.agentId === agent.id)
        if (!integration) throw new WeChatLoginSetupError('agent_unavailable')
        // A re-scan issues a new bot id and token for the same WeChat user (§2.3), replaced in place.
        await deps.repos.botCredential.install(orgId, bot.id, material(login), new Date(deps.clock.now()))
        await deps.repos.bot.mergeBotIdentity(orgId, bot.id, () => ({ platformConfig: identity }))
        const current = await deps.repos.bot.get(orgId, bot.id)
        if (current) await republish(deps, req, orgId, current)
        return { integrationId: integration.id, botId: bot.id }
      }
      const placed = await installable(deps, req, agent)
      if (!placed.ok) throw new WeChatLoginSetupError('agent_unavailable')
      const { integration, bot } = await installNewBot(deps, req.log, {
        orgId,
        agent,
        reservedIds: { botId: BotId(login.id), integrationId: IntegrationId(login.id) },
        platform: WECHAT_PLATFORM_ID,
        name: login.requestedName || `${agent.name} · WeChat`,
        bot: { platformConfig: identity },
        secrets: material(login),
        createdByUserId: login.createdByUserId
      })
      return { integrationId: integration.id, botId: bot.id }
    } finally {
      release()
    }
  }
}

export function weChatLoginRoutes(deps: HttpDeps, service: WeChatLoginService): FastifyPluginAsync {
  return async function weChatLoginRoutesPlugin(app) {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/wechat/login',
      {
        // A login installs a bot credential, so only a signed-in member may run it, never an API key or token.
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start a WeChat QR login',
          description:
            'Start connecting a personal WeChat account to an agent: returns a WeChat login link to show as a QR code. Whoever scans it becomes the bot’s only counterpart. With `botId`, re-binds that WeChat bot in place. The bot token stays on the server.',
          operationId: 'startWeChatLogin',
          body: WeChatLoginStartBody,
          response: { 201: WeChatLoginDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = orgOf(req)
        const agent = await deps.repos.agent.get(orgId, AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return reply.code(404).send(notFound('agent not found'))
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        const botId = req.body.botId ? BotId(req.body.botId) : undefined
        if (botId) {
          const bot = await deps.repos.bot.get(orgId, botId)
          const serves = bot && (await deps.repos.integration.listForBot(bot.id)).some((i) => i.agentId === agent.id)
          if (!bot || bot.platform !== WECHAT_PLATFORM_ID || !serves) {
            return reply.code(404).send(notFound('WeChat bot not found on this agent'))
          }
        } else {
          const placed = await installable(deps, req, agent)
          if (!placed.ok)
            return reply
              .code(placed.status)
              .send(placed.status === 404 ? notFound(placed.message) : conflict(placed.message))
        }
        try {
          const started = await service.start({
            orgId,
            agentId: agent.id,
            ...(botId ? { botId } : {}),
            ...(req.body.name ? { requestedName: req.body.name } : {}),
            createdByUserId: req.principal.userId
          })
          return reply.code(201).send(started)
        } catch (error) {
          if (error instanceof WeChatLoginConflictError) return reply.code(409).send(conflict(error.message))
          req.log.warn({ provider: WECHAT_PLATFORM_ID, stage: 'qr_login' }, 'wechat login unavailable')
          return reply.code(503).send({
            error: 'Service Unavailable',
            statusCode: 503,
            code: 'WECHAT_LOGIN_UNAVAILABLE',
            message: 'AgentConnect could not reach WeChat to start the login. Try again in a moment.'
          })
        }
      }
    )

    r.get(
      '/integrations/wechat/login/:id',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Poll a WeChat QR login',
          description:
            'Wait up to about 40 seconds for the login to move on, then return it. An unscanned code expires after about two minutes; start a new login for a fresh one. Once WeChat confirms, the Control Plane installs the integration itself; the token is never returned.',
          operationId: 'getWeChatLogin',
          params: IdParam,
          querystring: PollQuery,
          response: { 200: WeChatLoginDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal?.userId
        const finalize = finalizer(deps, req)
        const polled = userId
          ? await service.poll(orgOf(req), userId, req.params.id, finalize, req.query.verifyCode)
          : null
        if (!polled) return reply.code(404).send(notFound('login not found'))
        return polled
      }
    )
  }
}
