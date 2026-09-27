// Claims a Google Workspace customer of the multi-tenant deployment Chat app for one organization (google-chat-integration.md §10.5).
import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { HttpDeps } from '../../http/deps.js'
import type { GoogleChatRouteSeams } from '../../http/platform-route-seams.js'
import { IntegrationId, type OrgId } from '../../domain/ids.js'
import { denyViewerWrite, orgOf } from '../../http/rbac.js'
import { relayIngress } from '../../http/relay-ingress.js'
import { installNewBot } from '../../http/install-bot.js'
import { deleteBotIdentity, removeIntegrationRow } from '../../http/uninstall.js'
import { syncGoogleAccountId } from '../../http/google-account-id.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { ErrorDto } from '../../http/dto/index.js'
import type { BotRecord } from '../../persistence/ports.js'
import { checkServiceAccountKey, googleChatAppReader, type GoogleChatAppRead } from './credential.js'
import { buildGoogleChatInstall, googleChatRowTenantKeys } from './provider.js'
import { googleChatErrorLabel, googleChatInstallTarget } from './routes.js'
import {
  GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE,
  googleChatDomainAdditions,
  googleChatTenantOf,
  type GoogleChatTenant
} from './tenant.js'

/** Base64url JSON is short; anything longer is not a state the relay minted. */
const MAX_STATE_LENGTH = 4_096

/** Chat's `configCompleteRedirectUrl` is always on Chat's own origin; anything else is refused. */
export function isGoogleChatRedirect(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' && url.hostname === 'chat.google.com' && url.port === '' && !url.username && !url.password
  )
}

/** The unsigned claim state the relay mints; every fact the route acts on is re-derived from Google and the caller. */
export const GoogleChatClaimState = z.object({
  v: z.literal(1),
  app: z.string().regex(/^[1-9]\d{0,19}$/),
  space: z.string().regex(/^spaces\/[A-Za-z0-9_-]{1,128}$/),
  user: z.string().regex(/^users\/\d{1,64}$/),
  kind: z.enum(['dm', 'space']),
  tenant: z.string().max(256).optional(),
  // Absent when the event carried no completion URL, as the welcome card's click does; a present one must be Chat's.
  redirect: z.string().max(2_048).refine(isGoogleChatRedirect).optional(),
  iat: z.number().int().nonnegative()
})
export type GoogleChatClaimState = z.infer<typeof GoogleChatClaimState>

/** Decode base64url JSON into a claim state; undefined for anything malformed. */
export function decodeGoogleChatClaimState(raw: string): GoogleChatClaimState | undefined {
  if (raw.length > MAX_STATE_LENGTH || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  const result = GoogleChatClaimState.safeParse(parsed)
  return result.success ? result.data : undefined
}

export type GoogleChatClaimRefusal = { status: 403 | 404 | 503; code: string; message: string }

/** What Google proved about the claimant's own Workspace customer, or why it proved nothing. */
export type GoogleChatTenantProof = { ok: true; tenant: GoogleChatTenant } | ({ ok: false } & GoogleChatClaimRefusal)

const CONVERSATION_MESSAGE =
  'The Google Chat app cannot read this conversation, or you are not a member of it. Send the app a message in Google Chat again.'
const WORKSPACE_MESSAGE = 'Only a Google Workspace account can connect this Google Chat app.'

function readRefusal(read: Exclude<GoogleChatAppRead, { status: 'ok' }>): { ok: false } & GoogleChatClaimRefusal {
  if (read.status === 'not_found' || read.status === 'refused') {
    return { ok: false, status: 404, code: 'GOOGLE_CHAT_CLAIM_CONVERSATION', message: CONVERSATION_MESSAGE }
  }
  const code = read.status === 'key_rejected' ? 'GOOGLE_CHAT_KEY_REJECTED' : 'GOOGLE_CHAT_UNREACHABLE'
  return { ok: false, status: 503, code, message: read.message }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function domainIdOf(member: Record<string, unknown> | undefined): string | undefined {
  const domainId = member?.domainId
  return typeof domainId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(domainId) ? domainId : undefined
}

/** Bind only the claimant's own customer: an INTERNAL Space membership, or the claimant alone in a DM (§10.5 step 3). */
export async function proveGoogleChatTenant(
  state: GoogleChatClaimState,
  read: (path: string) => Promise<GoogleChatAppRead>
): Promise<GoogleChatTenantProof> {
  const userId = state.user.slice('users/'.length)
  if (state.kind === 'space') {
    const membership = await read(`${state.space}/members/${userId}`)
    if (membership.status !== 'ok') return readRefusal(membership)
    if (membership.body.affiliation !== 'INTERNAL') {
      return {
        ok: false,
        status: 403,
        code: 'GOOGLE_CHAT_CLAIM_EXTERNAL',
        message:
          'You are a guest in this space, so it belongs to another organization. Connect the app from a conversation in your own Google Workspace.'
      }
    }
    const space = await read(state.space)
    if (space.status !== 'ok') return readRefusal(space)
    const customer = typeof space.body.customer === 'string' ? space.body.customer : ''
    const customerId = /^customers\/([A-Za-z0-9_-]{1,128})$/.exec(customer)?.[1]
    // An INTERNAL member's domain is the Space customer's domain, the proof §10.3 asks for to attach it.
    const domainId = domainIdOf(record(membership.body.member))
    if (!customerId && !domainId) {
      return { ok: false, status: 403, code: 'GOOGLE_CHAT_CLAIM_WORKSPACE_REQUIRED', message: WORKSPACE_MESSAGE }
    }
    return {
      ok: true,
      tenant: { ...(customerId ? { customerId } : {}), ...(domainId ? { domainIds: [domainId] } : {}) }
    }
  }
  const listed = await read(`${state.space}/members?pageSize=100`)
  if (listed.status !== 'ok') return readRefusal(listed)
  const memberships: unknown[] = Array.isArray(listed.body.memberships) ? listed.body.memberships : []
  const humans = memberships
    .map((membership) => record(record(membership)?.member))
    .filter((member) => member?.type === 'HUMAN')
  if (humans.length !== 1 || humans[0]?.name !== state.user) {
    return {
      ok: false,
      status: 403,
      code: 'GOOGLE_CHAT_CLAIM_CONVERSATION',
      message: 'This conversation is not a direct message between you and the Google Chat app.'
    }
  }
  const domainId = domainIdOf(humans[0])
  if (!domainId)
    return { ok: false, status: 403, code: 'GOOGLE_CHAT_CLAIM_WORKSPACE_REQUIRED', message: WORKSPACE_MESSAGE }
  return { ok: true, tenant: { domainIds: [domainId] } }
}

const GoogleChatClaimBody = z.object({ state: z.string().min(1).max(MAX_STATE_LENGTH) })

/** Where the browser goes next: the Chat prompt's completion URL when the state carried one; absent, the person returns to Chat. */
const GoogleChatClaimDto = z.object({ redirect: z.string().optional() })

/** The success body: the completion URL when the prompt carried one. */
function claimed(state: GoogleChatClaimState): { redirect?: string } {
  return state.redirect ? { redirect: state.redirect } : {}
}

/** How a proof lands on the app's customer rows (§10.3, §10.5 step 5); `retire` is a domain row a Space proof folds in. */
export type GoogleChatClaimPlan<Row> =
  | { kind: 'taken' }
  | { kind: 'conflict'; row: Row }
  | { kind: 'create' }
  | { kind: 'held'; row: Row }
  | { kind: 'append'; row: Row; domainId: string }
  | { kind: 'upgrade'; row: Row; customerId: string }
  | { kind: 'consolidate'; row: Row; retire: Row; domainId: string }

/** Resolve a proof against the customer rows of one app; a proof carries at most one domain and one customer. */
export function planGoogleChatClaim<Row extends Pick<BotRecord, 'orgId' | 'externalTenantId' | 'platformConfig'>>(
  rows: readonly Row[],
  orgId: string,
  proven: GoogleChatTenant
): GoogleChatClaimPlan<Row> {
  const knows = (row: Row, key: string) => googleChatRowTenantKeys(row).includes(key)
  const domainId = proven.domainIds?.[0]
  const customerId = proven.customerId
  const byDomain = domainId ? rows.find((row) => knows(row, `domains/${domainId}`)) : undefined
  const byCustomer = customerId ? rows.find((row) => knows(row, `customers/${customerId}`)) : undefined
  if ((byDomain && byDomain.orgId !== orgId) || (byCustomer && byCustomer.orgId !== orgId)) return { kind: 'taken' }
  // A domain alone never names a customer, so it only matches the row that lists it.
  if (!customerId) return byDomain ? { kind: 'held', row: byDomain } : { kind: 'create' }
  if (!domainId) return byCustomer ? { kind: 'held', row: byCustomer } : { kind: 'create' }
  // A domain already bound to another Workspace customer contradicts the proof; it is never overwritten.
  const bound = googleChatTenantOf(byDomain?.platformConfig).customerId
  if (byDomain && bound && bound !== customerId) return { kind: 'conflict', row: byDomain }
  if (byDomain && byCustomer) {
    return byDomain === byCustomer
      ? { kind: 'held', row: byCustomer }
      : { kind: 'consolidate', row: byCustomer, retire: byDomain, domainId }
  }
  if (byCustomer) return { kind: 'append', row: byCustomer, domainId }
  if (byDomain) return { kind: 'upgrade', row: byDomain, customerId }
  return { kind: 'create' }
}

/** Thrown under the row lock when the row turned out bound to another Workspace customer. */
class GoogleChatClaimConflict extends Error {}

/** The 409 copy when a proven domain is bound to a different Workspace customer. */
const GOOGLE_CHAT_CLAIM_CONFLICT_MESSAGE =
  'This Google Workspace domain is already connected under a different Google Workspace organization. Ask an administrator to check the connection.'

/** Retire a folded-in domain row through the same teardown the console's integration removal and bot deletion use. */
async function retireGoogleChatRow(
  deps: HttpDeps,
  log: FastifyBaseLogger,
  orgId: OrgId,
  bot: BotRecord
): Promise<boolean> {
  const installs = await deps.repos.integration.listForBot(bot.id)
  const release = deps.agentMutations.tryBeginMutation([...new Set(installs.map((install) => install.agentId))])
  if (!release) return false
  try {
    await deps.httpBot.prepareIntegrationRemoval(bot.id)
    for (const install of installs) {
      const agent = await deps.repos.agent.get(orgId, install.agentId)
      await removeIntegrationRow(deps, log, { orgId, integration: install, agent: agent ?? null })
    }
    await deps.httpBot.syncBot(bot.id)
    await deleteBotIdentity(deps, log, orgId, bot)
    return true
  } finally {
    release()
  }
}

function refuse(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: googleChatErrorLabel(status), statusCode: status, code, message })
}

export function googleChatClaimRoutes(deps: HttpDeps, googleChat: GoogleChatRouteSeams) {
  return async function googleChatClaimRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/googlechat/claim',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Claim a Google Workspace customer for Google Chat',
          description:
            'Connect the caller’s Google Workspace customer to this organization on the deployment’s multi-tenant Google Chat app. `state` is the unsigned base64url JSON the Chat prompt carried; every fact is re-derived: the caller’s linked Google account must be the Chat user who asked, a Space claim requires the caller’s membership in that Space to be INTERNAL, and a DM claim requires the caller to be its only human member, whose domain is the one bound. A DM claim matches only the row that already lists its domain; a Space claim’s domain and customer append the domain to the customer’s row, upgrade and re-key a domain-only row, or consolidate the two rows into the customer’s. A new customer is installed on the organization’s preset agent (201). A customer this organization already holds answers 200; one held by another organization answers 409 without naming it, and a domain bound to a different customer answers 409 GOOGLE_CHAT_CLAIM_CONFLICT. Answers the Chat prompt’s completion URL when the state carried one.',
          operationId: 'claimGoogleChatCustomer',
          body: GoogleChatClaimBody,
          response: {
            200: GoogleChatClaimDto,
            201: GoogleChatClaimDto,
            400: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!req.principal) {
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'authentication required' })
        }
        const orgId = orgOf(req)
        const userId = req.principal.userId
        const state = decodeGoogleChatClaimState(req.body.state)
        if (!state) {
          return refuse(
            reply,
            400,
            'GOOGLE_CHAT_CLAIM_STATE_INVALID',
            'This Google Chat link is not valid. Send the app a message in Google Chat to get a new one.'
          )
        }
        const platform = googleChat.app
        if (!platform?.multiTenant || state.app !== platform.projectNumber) {
          return refuse(reply, 404, 'GOOGLE_CHAT_CLAIM_APP_UNKNOWN', 'This Google Chat app cannot be connected here.')
        }

        // The caller's Google account must be the Chat user who asked, read from the identity provider, never the console token.
        const expected = state.user.slice('users/'.length)
        let accountId = await deps.repos.user.getGoogleAccountId(userId)
        if (accountId !== expected && googleChat.identity) {
          const oidcSubject = req.oidcSubject ?? (await deps.repos.user.getOidcSubject(userId))
          if (oidcSubject) {
            try {
              accountId = await syncGoogleAccountId(
                { identity: googleChat.identity, users: deps.repos.user },
                { userId, oidcSubject, fresh: true }
              )
            } catch (err) {
              req.log.warn({ err }, 'google chat claim: identity provider read failed')
              return refuse(
                reply,
                503,
                'GOOGLE_CHAT_CLAIM_IDENTITY_UNAVAILABLE',
                'Your Google account could not be checked right now. Try again in a moment.'
              )
            }
          }
        }
        if (!accountId) {
          return refuse(
            reply,
            403,
            'GOOGLE_CHAT_CLAIM_IDENTITY',
            'Sign in with Google, using the account you use in Google Chat, then try again.'
          )
        }
        if (accountId !== expected) {
          return refuse(
            reply,
            403,
            'GOOGLE_CHAT_CLAIM_IDENTITY',
            'You are signed in with a different Google account than the one that asked in Google Chat.'
          )
        }

        const key = checkServiceAccountKey(platform.serviceAccountKey, platform.projectId)
        if (key.status !== 'ok') {
          req.log.error({ status: key.status }, 'google chat claim: the deployment app key does not parse')
          return refuse(
            reply,
            503,
            'GOOGLE_CHAT_KEY_INVALID',
            'The Google Chat app is misconfigured on this deployment.'
          )
        }
        const proof = await proveGoogleChatTenant(
          state,
          googleChatAppReader(key.key, googleChat.fetch, () => new Date(deps.clock.now()))
        )
        if (!proof.ok) return refuse(reply, proof.status, proof.code, proof.message)

        // One customer maps to one organization: the customer rows of this app that know a proven key decide.
        const rows = (await deps.repos.bot.listForPlatform(GOOGLE_CHAT_PLATFORM)).filter(
          (bot) => bot.externalAppId === platform.projectNumber && googleChatRowTenantKeys(bot).length > 0
        )
        const plan = planGoogleChatClaim(rows, orgId, proof.tenant)
        if (plan.kind === 'taken') return refuse(reply, 409, 'GOOGLE_CHAT_CLAIM_TAKEN', GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE)
        const conflict = (row: BotRecord) => {
          req.log.warn(
            { botId: row.id, customerId: proof.tenant.customerId },
            'google chat claim: the proven domain is bound to another Workspace customer'
          )
          return refuse(reply, 409, 'GOOGLE_CHAT_CLAIM_CONFLICT', GOOGLE_CHAT_CLAIM_CONFLICT_MESSAGE)
        }
        if (plan.kind === 'conflict') return conflict(plan.row)
        const install = buildGoogleChatInstall(
          { projectId: platform.projectId, projectNumber: platform.projectNumber, serviceAccountKey: key.key.json },
          proof.tenant
        )

        if (plan.kind !== 'create') {
          const held = plan.row
          // Whether the surviving row's assignment still has to be re-sent.
          let resync = false
          try {
            if (plan.kind === 'append') {
              resync = await deps.repos.bot.mergeBotIdentity(orgId, held.id, (current) => ({
                platformConfig: googleChatDomainAdditions(current.platformConfig, [plan.domainId])
              }))
            } else if (plan.kind === 'upgrade') {
              // The domain row learns its customer and is re-keyed by it; no customer row exists, so the key is free.
              resync = await deps.repos.bot.mergeBotIdentity(orgId, held.id, (current) => {
                const bound = googleChatTenantOf(current.platformConfig).customerId
                if (bound && bound !== plan.customerId) throw new GoogleChatClaimConflict()
                return {
                  platformConfig: { customerId: plan.customerId },
                  externalTenantId: `customers/${plan.customerId}`
                }
              })
            } else if (plan.kind === 'consolidate') {
              // The domain row's domains move onto the customer row, which then keys the customer alone.
              const retiring = await deps.repos.bot.get(orgId, plan.retire.id)
              const bound = googleChatTenantOf(retiring?.platformConfig).customerId
              if (retiring && bound && bound !== proof.tenant.customerId) return conflict(retiring)
              const domains = [...(googleChatTenantOf(retiring?.platformConfig).domainIds ?? []), plan.domainId]
              await deps.repos.bot.mergeBotIdentity(orgId, held.id, (current) => ({
                platformConfig: googleChatDomainAdditions(current.platformConfig, domains)
              }))
              await deps.httpBot.syncBot(held.id)
              if (retiring && !(await retireGoogleChatRow(deps, req.log, orgId, retiring))) {
                return refuse(
                  reply,
                  409,
                  'GOOGLE_CHAT_CLAIM_UNAVAILABLE',
                  'An agent is being moved right now. Try connecting again in a moment.'
                )
              }
            }
          } catch (err) {
            if (err instanceof GoogleChatClaimConflict) return conflict(held)
            if (err instanceof BotExternalIdentityTaken) {
              return refuse(reply, 409, 'GOOGLE_CHAT_CLAIM_TAKEN', GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE)
            }
            throw err
          }
          // A freed customer row goes back on the preset agent with the current deployment key, or Chat would prompt forever.
          if (held.agentIds.length === 0) {
            const target = await googleChatInstallTarget(deps, req)
            if (!('agent' in target)) return refuse(reply, target.status, 'GOOGLE_CHAT_CLAIM_NO_AGENT', target.message)
            await deps.repos.botCredential.install(orgId, held.id, install.secrets, new Date(deps.clock.now()))
            const admission = await deps.repos.integration.addBotMembership({
              id: IntegrationId(randomUUID()),
              orgId,
              agentId: target.agent.id,
              botId: held.id,
              platform: GOOGLE_CHAT_PLATFORM,
              name: held.name,
              createdByUserId: userId
            })
            if (admission.outcome === 'revoked' || admission.outcome === 'not_shareable') {
              await deps.httpBot.syncBot(held.id)
              return refuse(
                reply,
                409,
                'GOOGLE_CHAT_CLAIM_NO_AGENT',
                'The Google Chat app could not be added to the agent.'
              )
            }
          }
          if (resync || held.agentIds.length === 0) await deps.httpBot.syncBot(held.id)
          return reply.code(200).send(claimed(state))
        }

        const ingress = relayIngress(deps)
        if (!ingress.ok) return refuse(reply, 409, 'GOOGLE_CHAT_CLAIM_UNAVAILABLE', ingress.message)
        const target = await googleChatInstallTarget(deps, req)
        if (!('agent' in target)) return refuse(reply, target.status, 'GOOGLE_CHAT_CLAIM_NO_AGENT', target.message)
        try {
          await installNewBot(deps, req.log, {
            ...install,
            orgId,
            agent: target.agent,
            platform: GOOGLE_CHAT_PLATFORM,
            name: `Google Chat · ${platform.projectId}`,
            transport: 'http',
            prebuilt: true,
            createdByUserId: userId
          })
        } catch (err) {
          // The composite unique fired between the lookup and the insert.
          if (err instanceof BotExternalIdentityTaken) {
            return refuse(reply, 409, 'GOOGLE_CHAT_CLAIM_TAKEN', GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE)
          }
          throw err
        }
        return reply.code(201).send(claimed(state))
      }
    )
  }
}
