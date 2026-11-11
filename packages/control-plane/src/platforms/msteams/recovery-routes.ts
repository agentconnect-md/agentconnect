import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { installNewBot } from '../../http/install-bot.js'
import { notifyBotDeleted, notifyIntegrationRemoved } from '../../http/uninstall.js'
import { BotId, IntegrationId } from '../../domain/ids.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { connectTarget, type MsTeamsConnectSeams } from './connect-routes.js'
import { msTeamsDeploymentSecrets } from './deployment-app.js'
import {
  MsTeamsRecoveryError,
  msTeamsRecoveryChanged,
  msTeamsRecoveryRows,
  msTeamsRecoverySnapshot,
  type MsTeamsRecoveryAttempt
} from './recovery.js'

const State = z.string().min(1).max(16_384)
const REFUSALS = { 403: ErrorDto, 409: ErrorDto, 503: ErrorDto }

export function msTeamsRecoveryRoutes(deps: HttpDeps, seams: MsTeamsConnectSeams) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>()
    function configured() {
      if (!seams.app || !seams.recovery)
        throw new MsTeamsRecoveryError(
          503,
          'MSTEAMS_RECOVERY_UNAVAILABLE',
          'Administrator recovery is unavailable. Contact support or your deployment administrator.'
        )
      return { platform: seams.app, oauth: seams.recovery, mutations: seams.bindingMutations }
    }
    async function target(req: FastifyRequest, agentId: string) {
      const agent = await connectTarget(deps, req, agentId)
      if (typeof agent === 'string') throw msTeamsRecoveryChanged()
      return agent
    }
    async function rows(tenantId: string) {
      return msTeamsRecoveryRows(
        await deps.repos.bot.listForPlatform(MSTEAMS_PLATFORM),
        configured().platform.appId,
        tenantId
      )
    }
    async function bound(req: FastifyRequest, attempt: MsTeamsRecoveryAttempt) {
      if (
        attempt.orgId !== orgOf(req) ||
        attempt.userId !== req.principal?.userId ||
        attempt.appId !== configured().platform.appId
      )
        throw msTeamsRecoveryChanged()
      await target(req, attempt.agentId)
      const held = await rows(attempt.tenantId)
      if (!held.some((row) => row.orgId !== orgOf(req)) || msTeamsRecoverySnapshot(held) !== attempt.snapshot)
        throw msTeamsRecoveryChanged()
      return held
    }
    async function run<T>(req: FastifyRequest, reply: FastifyReply, action: () => Promise<T>) {
      if (denyViewerWrite(req, reply)) return
      try {
        return await action()
      } catch (err) {
        if (!(err instanceof MsTeamsRecoveryError)) throw err
        return reply
          .code(err.status)
          .send({ error: 'Teams recovery failed', statusCode: err.status, code: err.code, message: err.message })
      }
    }

    r.post(
      '/integrations/msteams/recovery/start',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Verify a Teams administrator for recovery',
          description:
            'Start administrator verification only for a tenant connected to another organization. Leaves the existing connection unchanged.',
          operationId: 'startMsTeamsRecovery',
          body: z.object({ tenantId: z.uuid(), agentId: z.uuid() }),
          response: { 200: z.object({ authorizeUrl: z.string(), state: z.string() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { oauth } = configured()
          if (!req.principal) throw msTeamsRecoveryChanged()
          const agent = await target(req, req.body.agentId)
          const tenantId = req.body.tenantId.toLowerCase()
          const held = await rows(tenantId)
          if (!held.some((row) => row.orgId !== orgOf(req))) throw msTeamsRecoveryChanged()
          return oauth.start({
            orgId: orgOf(req),
            userId: req.principal.userId,
            agentId: agent.id,
            tenantId,
            snapshot: msTeamsRecoverySnapshot(held)
          })
        })
    )

    r.post(
      '/integrations/msteams/recovery/verify',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check Microsoft tenant administrator authority',
          description:
            'Validate the tenant-specific Microsoft sign-in and current Teams or Global Administrator role. Returns a short-lived encrypted confirmation ticket without changing any connection.',
          operationId: 'verifyMsTeamsRecovery',
          body: z.object({ state: State, code: z.string().min(1).max(8192) }),
          response: { 200: z.object({ ticket: z.string() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { oauth } = configured()
          const attempt = await oauth.attempt(req.body.state)
          await bound(req, attempt)
          return { ticket: await oauth.seal(await oauth.verify(req.body.state, req.body.code)) }
        })
    )

    r.post(
      '/integrations/msteams/recovery/confirm',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Recover a Teams tenant connection',
          description:
            'After explicit confirmation, recheck administrator authority, release all conflicting deployment-owned Teams bots, and connect the selected agent. Original agents, history and settings are not transferred.',
          operationId: 'confirmMsTeamsRecovery',
          body: z.object({ ticket: State }),
          response: { 200: z.object({ agentId: z.string() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { platform, oauth, mutations } = configured()
          const ticket = await oauth.open(req.body.ticket)
          await bound(req, ticket)
          await oauth.admin(ticket.accessToken, ticket.objectId)
          if (!relayIngress(deps).ok)
            throw new MsTeamsRecoveryError(
              503,
              'MSTEAMS_RECOVERY_UNAVAILABLE',
              'The relay is unavailable. Try again later.'
            )
          const deletedBots = new Map<BotRecord, BotSecretMaterial | null>()
          try {
            return await mutations.runExclusive(ticket.tenantId, async () => {
              const held = await bound(req, ticket)
              const agent = await target(req, ticket.agentId)
              if (ticket.exp * 1000 <= deps.clock.now()) throw msTeamsRecoveryChanged()
              const installs = (await Promise.all(held.map((row) => deps.repos.integration.listForBot(row.id)))).flat()
              const release = deps.agentMutations.tryBeginMutation([
                ...new Set([agent.id, ...installs.map((i) => i.agentId)])
              ])
              if (!release)
                throw new MsTeamsRecoveryError(
                  409,
                  'MSTEAMS_RECOVERY_BUSY',
                  'An affected agent is being moved. Try again in a moment.'
                )
              try {
                const secrets = new Map<BotId, BotSecretMaterial | null>()
                for (const bot of held) {
                  await deps.httpBot.prepareIntegrationRemoval(bot.id)
                  if (deps.platforms.get(bot.platform)?.sideEffects?.onBotDelete)
                    secrets.set(bot.id, await deps.repos.botSecret.get(bot.orgId, bot.id))
                }
                const store = held.some(
                  (row) => row.externalAppId === platform.appId && row.platformConfig?.source === 'store'
                )
                const identity = {
                  externalAppId: platform.appId,
                  externalTenantId: ticket.tenantId,
                  platformConfig: {
                    tenantId: ticket.tenantId,
                    tokenTenantId: platform.tenantId,
                    appOwner: 'deployment',
                    ...(store ? { source: 'store' } : {})
                  }
                }
                const replacement = await mutations.replace({
                  held,
                  userId: ticket.userId,
                  agentId: agent.id,
                  replacement: {
                    ...identity,
                    id: BotId(randomUUID()),
                    orgId: orgOf(req),
                    platform: MSTEAMS_PLATFORM,
                    name: 'Microsoft Teams',
                    transport: 'http',
                    prebuilt: true,
                    createdByUserId: ticket.userId
                  }
                })
                for (const bot of held) deletedBots.set(bot, secrets.get(bot.id) ?? null)
                for (const bot of held) {
                  await deps.httpBot.unassign(bot)
                }
                for (const integration of replacement.removed) {
                  const previousAgent = await deps.repos.agent.get(integration.orgId, integration.agentId)
                  await notifyIntegrationRemoved(deps, req.log, integration, previousAgent)
                }
                await installNewBot(deps, req.log, {
                  bot: identity,
                  secrets: msTeamsDeploymentSecrets(),
                  orgId: orgOf(req),
                  agent,
                  reservedIds: { botId: replacement.bot.id, integrationId: IntegrationId(randomUUID()) },
                  platform: MSTEAMS_PLATFORM,
                  name: 'Microsoft Teams',
                  transport: 'http',
                  prebuilt: true,
                  createdByUserId: ticket.userId
                })
                if (store)
                  await deps.repos.bot.mergeBotIdentity(orgOf(req), replacement.bot.id, () => ({
                    platformConfig: { source: 'store' }
                  }))
                return { agentId: agent.id }
              } finally {
                release()
              }
            })
          } finally {
            // Provider cleanup may call remote APIs, so release the tenant mutation lock first.
            for (const [bot, secrets] of deletedBots) await notifyBotDeleted(deps, req.log, bot, secrets)
          }
        })
    )
  }
}
