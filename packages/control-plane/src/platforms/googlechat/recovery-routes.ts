import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { GoogleChatRouteSeams } from '../../http/platform-route-seams.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto } from '../../http/dto/index.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { syncGoogleAccountId } from '../../http/google-account-id.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { installNewBot } from '../../http/install-bot.js'
import { notifyIntegrationRemoved } from '../../http/uninstall.js'
import { BotId, IntegrationId } from '../../domain/ids.js'
import { decodeGoogleChatClaimState, proveGoogleChatTenant, type GoogleChatClaimState } from './claim.js'
import { checkServiceAccountKey, googleChatAppReader } from './credential.js'
import { buildGoogleChatClaimInstall, googleChatRowTenantKeys } from './provider.js'
import { googleChatInstallTarget } from './routes.js'
import {
  checkRecoveryCustomer,
  GoogleChatRecoveryError,
  googleChatRecoveryRows,
  googleChatRecoverySnapshot,
  recoveryExpired,
  type GoogleChatRecoveryAttempt
} from './recovery.js'
import type { GoogleChatTenant } from './tenant.js'

const State = z.string().min(1).max(16_384)
const REFUSALS = { 400: ErrorDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }

export function googleChatRecoveryRoutes(deps: HttpDeps, googleChat: GoogleChatRouteSeams) {
  return async (app: FastifyInstance): Promise<void> => {
    const r = app.withTypeProvider<ZodTypeProvider>()

    function configured() {
      if (!googleChat.app || !googleChat.recovery || !googleChat.bindingMutations) {
        throw new GoogleChatRecoveryError(
          503,
          'GOOGLE_CHAT_RECOVERY_UNAVAILABLE',
          'Administrator recovery is not configured. Contact support or your deployment administrator.'
        )
      }
      return { platform: googleChat.app, oauth: googleChat.recovery, mutations: googleChat.bindingMutations }
    }

    async function account(req: FastifyRequest): Promise<string> {
      if (!req.principal)
        throw new GoogleChatRecoveryError(
          403,
          'GOOGLE_CHAT_RECOVERY_IDENTITY',
          'Sign in with Google to recover this connection.'
        )
      const userId = req.principal.userId
      const subject = req.oidcSubject ?? (await deps.repos.user.getOidcSubject(userId))
      let accountId: string | null
      try {
        accountId =
          googleChat.identity && subject
            ? await syncGoogleAccountId(
                { identity: googleChat.identity, users: deps.repos.user },
                { userId, oidcSubject: subject, fresh: true }
              )
            : await deps.repos.user.getGoogleAccountId(userId)
      } catch {
        throw new GoogleChatRecoveryError(
          503,
          'GOOGLE_CHAT_RECOVERY_UNAVAILABLE',
          'Your Google account could not be checked. Try again later.'
        )
      }
      if (!accountId)
        throw new GoogleChatRecoveryError(
          403,
          'GOOGLE_CHAT_RECOVERY_IDENTITY',
          'Link your Google Workspace administrator account in Profile first.'
        )
      return accountId
    }

    async function prove(state: GoogleChatClaimState, accountId: string): Promise<GoogleChatTenant> {
      const { platform } = configured()
      if (state.app !== platform.projectNumber || (state.user && state.user !== `users/${accountId}`))
        throw recoveryExpired()
      const key = checkServiceAccountKey(platform.serviceAccountKey, platform.projectId)
      if (key.status !== 'ok')
        throw new GoogleChatRecoveryError(
          503,
          'GOOGLE_CHAT_RECOVERY_UNAVAILABLE',
          'The Google Chat app is unavailable. Contact support.'
        )
      const proof = await proveGoogleChatTenant(
        { ...state, user: `users/${accountId}` },
        googleChatAppReader(key.key, googleChat.fetch, () => new Date(deps.clock.now()))
      )
      if (!proof.ok)
        throw new GoogleChatRecoveryError(proof.status === 404 ? 403 : proof.status, proof.code, proof.message)
      return proof.tenant
    }

    async function bound(req: FastifyRequest, attempt: GoogleChatRecoveryAttempt): Promise<void> {
      const { platform } = configured()
      if (
        attempt.orgId !== orgOf(req) ||
        attempt.userId !== req.principal?.userId ||
        attempt.appId !== platform.projectNumber
      )
        throw recoveryExpired()
      if ((await account(req)) !== attempt.accountId) throw recoveryExpired()
    }

    async function rows(tenant: GoogleChatTenant) {
      return googleChatRecoveryRows(
        await deps.repos.bot.listForPlatform(GOOGLE_CHAT_PLATFORM),
        configured().platform.projectNumber,
        tenant
      )
    }

    async function run<T>(req: FastifyRequest, reply: FastifyReply, action: () => Promise<T>) {
      if (denyViewerWrite(req, reply)) return
      try {
        return await action()
      } catch (err) {
        if (!(err instanceof GoogleChatRecoveryError)) throw err
        return reply
          .code(err.status)
          .send({ error: 'Google Chat recovery failed', statusCode: err.status, code: err.code, message: err.message })
      }
    }

    r.post(
      '/integrations/googlechat/recovery/start',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Verify a Workspace administrator for recovery',
          description:
            'Start administrator verification only when this Google Chat Workspace is connected to another organization. Does not change a binding.',
          operationId: 'startGoogleChatRecovery',
          body: z.object({ state: z.string().min(1).max(4096) }),
          response: { 200: z.object({ authorizeUrl: z.string(), state: z.string() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { platform, oauth } = configured()
          const state = decodeGoogleChatClaimState(req.body.state)
          if (!state) throw recoveryExpired()
          const accountId = await account(req)
          const tenant = await prove(state, accountId)
          const held = await rows(tenant)
          if (!held.some((row) => row.orgId !== orgOf(req))) throw recoveryExpired()
          return oauth.start({
            orgId: orgOf(req),
            userId: req.principal!.userId,
            appId: platform.projectNumber,
            accountId,
            claim: state,
            snapshot: googleChatRecoverySnapshot(held)
          })
        })
    )

    r.post(
      '/integrations/googlechat/recovery/verify',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check Google Workspace administrator authority',
          description:
            'Exchange the one-use OAuth code and verify the linked account is a current super administrator of the conflicting Workspace. Returns an encrypted, expiring confirmation ticket without releasing the connection.',
          operationId: 'verifyGoogleChatRecovery',
          body: z.object({ state: State, code: z.string().min(1).max(8192) }),
          response: { 200: z.object({ ticket: z.string() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { oauth } = configured()
          const attempt = await oauth.attempt(req.body.state)
          await bound(req, attempt)
          const tenant = await prove(attempt.claim, attempt.accountId)
          if (googleChatRecoverySnapshot(await rows(tenant)) !== attempt.snapshot) throw recoveryExpired()
          const ticket = await oauth.verify(req.body.state, req.body.code)
          if (tenant.customerId && tenant.customerId !== ticket.customerId) throw recoveryExpired()
          const held = await rows({ ...tenant, customerId: ticket.customerId })
          checkRecoveryCustomer(held, ticket.customerId)
          if (!held.some((row) => row.orgId !== orgOf(req))) throw recoveryExpired()
          return { ticket: await oauth.seal({ ...ticket, snapshot: googleChatRecoverySnapshot(held) }) }
        })
    )

    r.post(
      '/integrations/googlechat/recovery/confirm',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Integrations],
          summary: 'Recover a Google Chat Workspace connection',
          description:
            'After explicit confirmation, recheck current administrator authority, release the verified conflicting bindings and create a new connection in the selected organization. Old conversations and settings are not transferred.',
          operationId: 'confirmGoogleChatRecovery',
          body: z.object({ ticket: State }),
          response: { 200: z.object({ redirect: z.string().optional() }), ...REFUSALS }
        }
      },
      async (req, reply) =>
        run(req, reply, async () => {
          const { oauth, platform, mutations } = configured()
          const ticket = await oauth.open(req.body.ticket)
          await bound(req, ticket)
          if ((await oauth.admin(ticket.accessToken, ticket.accountId)) !== ticket.customerId) throw recoveryExpired()
          const tenant = await prove(ticket.claim, ticket.accountId)
          if (tenant.customerId && tenant.customerId !== ticket.customerId) throw recoveryExpired()
          const proven = { ...tenant, customerId: ticket.customerId }
          const ingress = relayIngress(deps)
          if (!ingress.ok) throw new GoogleChatRecoveryError(409, 'GOOGLE_CHAT_RECOVERY_UNAVAILABLE', ingress.message)
          return mutations.runExclusive(platform.projectNumber, async () => {
            const target = await googleChatInstallTarget(deps, req)
            if (!('agent' in target))
              throw new GoogleChatRecoveryError(
                target.status === 404 ? 409 : target.status,
                'GOOGLE_CHAT_CLAIM_NO_AGENT',
                target.message
              )
            if (ticket.exp * 1000 <= deps.clock.now()) throw recoveryExpired()
            const held = await rows(proven)
            if (!held.some((row) => row.orgId !== orgOf(req)) || googleChatRecoverySnapshot(held) !== ticket.snapshot)
              throw recoveryExpired()
            checkRecoveryCustomer(held, ticket.customerId)
            const installs = (await Promise.all(held.map((row) => deps.repos.integration.listForBot(row.id)))).flat()
            const release = deps.agentMutations.tryBeginMutation([
              ...new Set([target.agent.id, ...installs.map((i) => i.agentId)])
            ])
            if (!release)
              throw new GoogleChatRecoveryError(
                409,
                'GOOGLE_CHAT_RECOVERY_BUSY',
                'An affected agent is being moved. Try again in a moment.'
              )
            try {
              for (const bot of held) await deps.httpBot.prepareIntegrationRemoval(bot.id)
              const install = buildGoogleChatClaimInstall(platform, {
                ...proven,
                domainIds: [
                  ...new Set([
                    ...(proven.domainIds ?? []),
                    ...held.flatMap((row) =>
                      googleChatRowTenantKeys(row)
                        .filter((key) => key.startsWith('domains/'))
                        .map((key) => key.slice('domains/'.length))
                    )
                  ])
                ]
              })
              const replacement = await mutations.replace({
                held,
                userId: req.principal!.userId,
                accountId: ticket.accountId,
                agentId: target.agent.id,
                replacement: {
                  ...install.bot,
                  id: BotId(randomUUID()),
                  orgId: orgOf(req),
                  platform: GOOGLE_CHAT_PLATFORM,
                  name: 'Google Chat',
                  transport: 'http',
                  prebuilt: true,
                  createdByUserId: req.principal!.userId
                }
              })
              for (const bot of held) await deps.httpBot.unassign(bot)
              for (const integration of replacement.removed) {
                const agent = await deps.repos.agent.get(integration.orgId, integration.agentId)
                await notifyIntegrationRemoved(deps, req.log, integration, agent)
              }
              await installNewBot(deps, req.log, {
                ...install,
                orgId: orgOf(req),
                agent: target.agent,
                reservedIds: { botId: replacement.bot.id, integrationId: IntegrationId(randomUUID()) },
                platform: GOOGLE_CHAT_PLATFORM,
                name: 'Google Chat',
                transport: 'http',
                prebuilt: true,
                createdByUserId: req.principal!.userId
              })
              req.log.info(
                { userId: req.principal!.userId, orgId: orgOf(req), replacedBotIds: held.map((row) => row.id) },
                'google chat: administrator recovered Workspace connection'
              )
              return ticket.claim.redirect ? { redirect: ticket.claim.redirect } : {}
            } finally {
              release()
            }
          })
        })
    )
  }
}
