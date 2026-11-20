// An address's two settings in its integration panel (email-integration.md §4.1): read by anyone who sees the agent, changed by an Agent editor.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { EMAIL_PLATFORM, EmailWhoMayWrite } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'
import { pushBotConfig } from '../../http/bot-config-push.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { IntegrationId } from '../../domain/ids.js'
import { emailAddressSettings, emailSettingsEntries } from './settings.js'

const OutsideSessionsBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('editors') }),
  z.object({ kind: z.literal('org') }),
  z.object({ kind: z.literal('member'), userId: z.string().min(1).max(256) })
])

const EmailSettingsBody = z.object({
  whoMayWrite: EmailWhoMayWrite.describe(
    '`members`: members who may use the agent; `anyone`: any authenticated sender.'
  ),
  outsideSessions: OutsideSessionsBody.describe(
    'Who sees a session a message from outside the organization opens: whoever can edit the agent when it is read, the organization, or one member.'
  )
})

const EmailSettingsDto = z.object({
  whoMayWrite: EmailWhoMayWrite,
  outsideSessions: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('editors') }),
    z.object({ kind: z.literal('org') }),
    z.object({
      kind: z.literal('member'),
      userId: z.string().describe('The member.'),
      active: z.boolean().describe('Whether that member is an active member now; while not, outside mail is refused.')
    })
  ])
})
type EmailSettingsDto = z.infer<typeof EmailSettingsDto>

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'email integration not found' })

export function emailSettingsRoutes(deps: HttpDeps) {
  // The integration, its address row and its agent, as the caller may see them; null reads as missing.
  const resolve = async (req: FastifyRequest, id: string) => {
    const integration = await deps.repos.integration.get(orgOf(req), IntegrationId(id))
    if (!integration || integration.platform !== EMAIL_PLATFORM) return null
    const [agent, bot] = await Promise.all([
      deps.repos.agent.get(orgOf(req), integration.agentId),
      deps.repos.bot.get(orgOf(req), integration.botId)
    ])
    if (!agent || !bot || !canView(agent, ctxOf(req))) return null
    return { integration, agent, bot }
  }

  const toDto = async (orgId: string, settings: ReturnType<typeof emailAddressSettings>): Promise<EmailSettingsDto> => {
    const outside = settings.outsideSessions
    if (outside.kind !== 'member') return { whoMayWrite: settings.whoMayWrite, outsideSessions: outside }
    const active = (await deps.repos.user.activeMember(orgId, outside.userId)) !== null
    return { whoMayWrite: settings.whoMayWrite, outsideSessions: { kind: 'member', userId: outside.userId, active } }
  }

  return async function emailSettingsRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/integrations/:id/email/settings',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Read an email address’s settings',
          description:
            'Who may write to an Email integration’s address, and who sees the sessions a message from outside the organization opens. By default only members who may use the agent write, and outside senders’ sessions are seen by whoever can edit the agent.',
          operationId: 'getEmailIntegrationSettings',
          params: IdParam,
          response: { 200: EmailSettingsDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const found = await resolve(req, req.params.id)
        if (!found) return notFound(reply)
        return await toDto(found.bot.orgId, emailAddressSettings(found.bot))
      }
    )

    r.put(
      '/integrations/:id/email/settings',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Change an email address’s settings',
          description:
            'Set who may write to an Email integration’s address (`members` or `anyone`) and who sees the sessions a message from outside the organization opens (whoever can edit the agent when the session is read, the organization, or one active member). Under `anyone` every authenticated sender that is not automatic and is within the rate limit may write. Refusals carry `code` EMAIL_OUTSIDE_MEMBER_UNKNOWN (400) for a user who is not an active member of the organization. Requires edit access to the agent.',
          operationId: 'updateEmailIntegrationSettings',
          params: IdParam,
          body: EmailSettingsBody,
          response: { 200: EmailSettingsDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const found = await resolve(req, req.params.id)
        if (!found) return notFound(reply)
        if (!canEdit(found.agent, ctxOf(req)))
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        const outside = req.body.outsideSessions
        if (outside.kind === 'member' && !(await deps.repos.user.activeMember(found.bot.orgId, outside.userId)))
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'Outside senders’ sessions go to an active member of the organization.',
            code: 'EMAIL_OUTSIDE_MEMBER_UNKNOWN'
          })
        await deps.repos.bot.mergeBotIdentity(found.bot.orgId, found.bot.id, () => ({
          platformConfig: emailSettingsEntries(req.body)
        }))
        const updated = (await deps.repos.bot.get(found.bot.orgId, found.bot.id)) ?? found.bot
        // Who may write rides the spec, so the daemon drops the answers it holds once this lands.
        await pushBotConfig(deps, req.log, updated)
        return await toDto(updated.orgId, emailAddressSettings(updated))
      }
    )
  }
}
