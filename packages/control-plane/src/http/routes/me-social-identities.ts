/**
 * The signed-in user's social sign-in methods. These routes deliberately use
 * `oidcAuth` (never devAuth or API keys). The current OIDC session is the
 * authorization boundary; unlinking does not add a second email-code step.
 *
 * Linking and unlinking deliberately run over DIFFERENT Logto surfaces:
 *
 *  - **Unlink** stays here, on the Management API, because it enforces a
 *    server-side invariant the browser cannot be trusted with: the last social
 *    sign-in method may not be removed, serialized per user by
 *    `SocialIdentityMutationGate`. It needs no connector session.
 *  - **Link** is driven by the browser against Logto's Account API, with the
 *    user's OWN token — the Management API has no session context, so any
 *    connector that persists state in `getAuthorizationUri` (Slack, Apple,
 *    standard OIDC/OAuth 2.0) fails inside Logto with a 500. That path needs
 *    nothing from the M2M credential, so it never reaches the browser either.
 *
 * What the browser still cannot do is discover the connector id, so this
 * module resolves target → connector id and stops there.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { resolveWebAppUrl } from '../../config/env.js'
import { LogtoApiError, type SlackIdentity } from '../../github/logto-identity.js'
import { convergeIntegrationGating } from '../../orchestrator/integrationPush.js'
import { reconcileLinkedDms } from '../../orchestrator/linkedDmReconcile.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'

const ConnectorId = z.string().trim().min(1).max(128)
const ConnectorDto = z.object({ connectorId: ConnectorId })
const State = z.string().min(32).max(256)
const ConnectorData = z
  .record(z.string().max(64), z.string().max(4096))
  .refine((value) => Object.keys(value).length <= 32, 'too many connector response fields')

/** `direct` carries the URI Logto built; `verified` says the browser has to
 *  drive this connector itself, and hands it the id it needs to do so. */
const AuthorizationDto = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('direct'), connectorId: ConnectorId, authorizationUri: z.url() }),
  z.object({ mode: z.literal('verified'), connectorId: ConnectorId })
])
const LinkBody = z.object({ connectorId: ConnectorId, connectorData: ConnectorData }).strict()
const LinkDto = z.object({ linked: z.literal(true) })
/** Unlink takes any stored target, including one this deployment has since
 *  stopped offering — you must always be able to remove what you linked. */
const TargetParam = z.object({ target: z.string().trim().min(1).max(128) })

/** The Slack workspace behind the caller's account. `linked: false` is a real
 *  answer (no Slack identity), not an error — a Logto 404 for the user resolves
 *  to it too, since an account that is gone has no identity to report. */
const SlackIdentityDto = z.discriminatedUnion('linked', [
  z.object({ linked: z.literal(false) }),
  z.object({
    linked: z.literal(true),
    /** Slack workspace id (`T…`). */
    teamId: z.string(),
    /** Slack user id (`U…`) — scoped to that workspace. */
    userId: z.string(),
    /** Workspace display name / subdomain, when Slack sent them. */
    teamName: z.string().optional(),
    teamDomain: z.string().optional()
  })
])

/** One linked sign-in method, narrowed to what the Profile card renders. The
 *  connector's `rawData` is deliberately absent — it is a whole OIDC payload,
 *  and none of it needs to reach a browser. */
const SocialIdentitySummaryDto = z.object({
  target: z.string(),
  userId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  avatar: z.string().optional(),
  /** Where this account lives at its provider, when that is addressable. */
  profileUrl: z.string().optional(),
  /** Slack only — the workspace it belongs to. */
  workspace: z
    .object({
      teamId: z.string(),
      name: z.string().optional(),
      domain: z.string().optional(),
      url: z.string().optional()
    })
    .optional()
})

const SocialAccountDto = z.object({
  identities: z.array(SocialIdentitySummaryDto),
  /** Logto refuses an identity change the caller has not re-proven while this
   *  holds, so the console collects a code before starting one. */
  hasSecurityVerificationMethod: z.boolean(),
  primaryEmail: z.string().optional()
})

// No 'link': that runs in the browser against the Account API, so its provider
// errors (422 "already in use" and friends) are mapped there, not here.
type Operation = 'authorize' | 'link' | 'unlink' | 'read'

function socialCallbackUrl(deps: HttpDeps): string | undefined {
  const webUrl = resolveWebAppUrl(deps.config)
  return webUrl ? new URL('/auth/social/callback', webUrl).toString() : undefined
}

function logtoFailure(reply: FastifyReply, error: unknown, operation: Operation) {
  if (!(error instanceof LogtoApiError)) throw error
  // The upstream reason never reaches the caller — the mapping below flattens it
  // to a generic status — so record it once here. Without this an operator has
  // nothing to go on when Logto starts refusing.
  reply.log.warn(
    { operation, upstreamStatus: error.status, upstreamCode: error.code, retryable: error.retryable },
    'logto request failed'
  )
  if (operation === 'unlink' && error.status === 409 && error.code === 'LAST_SOCIAL_IDENTITY') {
    return reply.code(409).send({
      error: 'Conflict',
      statusCode: 409,
      code: error.code,
      message: 'connect another sign-in method before removing this one'
    })
  }
  // Logto says the just-authorized identity belongs to a different user. A real
  // conflict the user must resolve — never the 502 fallback, which the edge
  // (Cloudflare) replaces with its own CORS-less error page.
  if (error.status === 422 && error.code === 'user.identity_already_in_use') {
    return reply.code(409).send({
      error: 'Conflict',
      statusCode: 409,
      code: error.code,
      message: 'this social account is already linked to another user'
    })
  }
  // Logto reports the other connector-response problems as 422s too — same
  // remedy as a 400: the authorization is unusable, start over.
  if (error.status === 400 || error.status === 422) {
    return reply.code(400).send({
      error: 'Bad Request',
      statusCode: 400,
      code: 'SOCIAL_AUTHORIZATION_INVALID',
      message: 'the social authorization response is invalid or expired'
    })
  }
  if (error.status === 404) {
    return reply.code(404).send({
      error: 'Not Found',
      statusCode: 404,
      message: operation === 'unlink' ? 'social identity not linked' : 'social connector not found'
    })
  }
  if (error.status === 429) {
    return reply.code(429).send({
      error: 'Too Many Requests',
      statusCode: 429,
      message: 'the sign-in provider is rate limiting requests; try again shortly'
    })
  }
  return reply.code(502).send({
    error: 'Bad Gateway',
    statusCode: 502,
    message: 'the sign-in provider is temporarily unavailable'
  })
}

export function meSocialIdentityRoutes(deps: HttpDeps) {
  return async function meSocialIdentityRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // Shape only. WHICH methods a deployment offers is the console's call
    // (SOCIAL_PROVIDERS, web lib/social-login-providers) and duplicating that
    // decision here is what made the two sides disagree: the console owns its
    // safe fallback for an unrecognizable setting, and any second implementation
    // of that rule drifts from it. The real gate is the tenant —
    // socialConnectorIdFor 404s unless the admin configured that connector — so
    // this route can never reject a method the console legitimately offers.
    const SocialTarget = z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/, 'not a connector target')
    const TargetParamStrict = z.object({ target: SocialTarget })
    const AuthorizationBody = z.object({ target: SocialTarget, state: State }).strict()
    const unavailable = {
      error: 'Service Unavailable',
      statusCode: 503,
      message: 'social sign-in management is not configured'
    } as const

    type LinkedReq = {
      principal?: { userId: string }
      oidcSubject?: string
      log: { debug(obj: object, msg: string): void; warn(obj: object, msg?: string): void }
    }

    /** The Slack identity this account carries right now, or null. Cheap and cached —
     *  the point of reading it is to have a BEFORE to compare an AFTER against. */
    const slackIdentityOf = async (sub: string): Promise<SlackIdentity | null> => {
      try {
        return (await deps.logtoIdentity?.slackIdentityFor(sub)) ?? null
      } catch {
        // Unknown reads as "unchanged": the catch-up below is an optimization, and
        // refusing it costs a DM that stays Off, which is where it already was.
        return null
      }
    }

    /**
     * §14.8 catch-up (resource-visibility.md): a link that JUST landed may authorize
     * DMs this person already has open with a private agent they are shared with.
     *
     * `before` is what the account carried when the request started. Only a genuine
     * change fires the catch-up — neither of these routes means "a Slack link
     * appeared": the refresh is also used after a reauthorization, and the link route
     * also links providers other than Slack. Re-deriving on every call would let the
     * default reassert itself over an editor's per-conversation Off.
     *
     * Awaited so the Console read that follows already shows the opened rows, and
     * swallowed — the link itself succeeded, and a failure leaves the rows put.
     */
    const openLinkedDms = async (req: LinkedReq, before: SlackIdentity | null): Promise<void> => {
      const userId = req.principal?.userId
      if (!userId || !req.oidcSubject || !deps.logtoIdentity) return
      const after = await slackIdentityOf(req.oidcSubject)
      if (!after || (before?.teamId === after.teamId && before?.userId === after.userId)) return
      try {
        await reconcileLinkedDms(userId, after, {
          users: deps.repos.user,
          orgs: deps.repos.org,
          agents: deps.repos.agent,
          integrations: deps.repos.integration,
          bots: deps.repos.bot,
          channels: deps.repos.integrationChannel,
          identity: deps.logtoIdentity,
          push: (agent) => convergeIntegrationGating(deps, agent, req.log),
          log: req.log
        })
      } catch (err) {
        req.log.warn({ err, userId }, 'gated DM: opening conversations after an identity link failed')
      }
    }

    // The counterpart to linking happening in the browser: that write never
    // passes through the CP, so the console has to say when one landed or the
    // cached read would hide the new identity for its full TTL.
    r.post(
      '/me/social-identities/refresh',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Refresh your cached sign-in methods',
          description:
            'Discard the cached copy of your sign-in methods, so the next read reflects a link completed directly against the sign-in provider.',
          operationId: 'refreshMySocialIdentities',
          response: { 204: z.null(), 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        if (!identity) return reply.code(503).send(unavailable)
        // Read the pre-change identity BEFORE dropping the cache, so the comparison
        // has something to be a comparison against.
        const before = await slackIdentityOf(req.oidcSubject!)
        identity.forgetUser(req.oidcSubject!)
        await openLinkedDms(req, before)
        return reply.code(204).send(null)
      }
    )

    // Where a link begins. The reply says which of the two ways this provider
    // has to be linked; the console does not decide, and does not keep a list.
    r.post(
      '/me/social-identities/authorization-uri',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Start linking a social sign-in method',
          description:
            'Resolve the provider and report how it must be linked. `direct` returns an authorization URI Logto built, and the link completes server-side. `verified` means the connector cannot be driven without a session, so the browser drives it against the Account API and Logto requires an ownership proof.',
          operationId: 'createMySocialIdentityAuthorization',
          body: AuthorizationBody,
          response: { 200: AuthorizationDto, 400: ErrorDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        const redirectUri = socialCallbackUrl(deps)
        if (!identity || !redirectUri) return reply.code(503).send(unavailable)
        try {
          return await identity.socialAuthorizationFor(req.body.target, redirectUri, req.body.state)
        } catch (error) {
          return logtoFailure(reply, error, 'authorize')
        }
      }
    )

    // The `direct` half of the link. Deliberately no ownership proof: the M2M
    // credential is the authority on this path, which is the whole reason it
    // spares the user a code.
    r.post(
      '/me/social-identities',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Link a social sign-in method',
          description:
            'Link the identity the provider just authenticated to the signed-in user. Only for providers that reported `direct`; existing accounts are not merged.',
          operationId: 'linkMySocialIdentity',
          body: LinkBody,
          response: {
            200: LinkDto,
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        const redirectUri = socialCallbackUrl(deps)
        if (!identity || !redirectUri) return reply.code(503).send(unavailable)
        // Before the link invalidates the cache — this route links any provider, so
        // only a comparison can say whether the SLACK identity is what changed.
        const before = await slackIdentityOf(req.oidcSubject!)
        try {
          // redirectUri last: Logto exchanges the code against the URI it
          // authorized with, and only the server knows that one.
          await identity.linkSocialIdentity(req.oidcSubject!, req.body.connectorId, {
            ...req.body.connectorData,
            redirectUri
          })
          await openLinkedDms(req, before)
          return { linked: true as const }
        } catch (error) {
          return logtoFailure(reply, error, 'link')
        }
      }
    )

    r.get(
      '/me/social-identities/connectors/:target',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Resolve a social connector id',
          description:
            "The tenant's connector id for a supported provider target, so the console can start the Account API link flow. Resolution only — the authorization URI is built by the browser, which is the only side with the connector session Logto needs.",
          operationId: 'getMySocialConnectorId',
          params: TargetParamStrict,
          response: {
            200: ConnectorDto,
            400: ErrorDto,
            404: ErrorDto,
            429: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        if (!identity) return reply.code(503).send(unavailable)
        try {
          return { connectorId: await identity.socialConnectorIdFor(req.params.target) }
        } catch (error) {
          return logtoFailure(reply, error, 'authorize')
        }
      }
    )

    r.delete(
      '/me/social-identities/:target',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Unlink a social sign-in method',
          description:
            'Remove one social identity from the signed-in user. The last social sign-in method cannot be removed.',
          operationId: 'unlinkMySocialIdentity',
          params: TargetParam,
          response: {
            204: z.null(),
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        if (!identity) return reply.code(503).send(unavailable)
        try {
          await identity.unlinkSocialIdentity(req.oidcSubject!, req.params.target)
          return reply.code(204).send(null)
        } catch (error) {
          return logtoFailure(reply, error, 'unlink')
        }
      }
    )

    // A READ, unlike its siblings, and the one the Profile card loads from.
    // It exists so the browser does not call Logto directly: from here the
    // upstream read is cached and made next to Logto, instead of once per page
    // load from wherever the user happens to be. Read-only metadata; nothing
    // may treat it as an authorization statement.
    r.get(
      '/me/social-identities',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Get your sign-in methods',
          description:
            'The social accounts linked to your profile, narrowed to what the console renders, plus whether Logto will require you to re-verify before they can change.',
          operationId: 'getMySocialIdentities',
          response: { 200: SocialAccountDto, 429: ErrorDto, 502: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        if (!identity) return reply.code(503).send(unavailable)
        try {
          return await identity.socialAccountFor(req.oidcSubject!)
        } catch (error) {
          return logtoFailure(reply, error, 'read')
        }
      }
    )

    r.get(
      '/me/social-identities/slack',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Get your Slack workspace identity',
          description:
            'The Slack workspace id and user id behind your account, as recorded by the sign-in provider. Returns `linked: false` when you have not connected Slack.',
          operationId: 'getMySlackIdentity',
          response: { 200: SlackIdentityDto, 429: ErrorDto, 502: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const identity = deps.logtoIdentity
        if (!identity) return reply.code(503).send(unavailable)
        try {
          const slack = await identity.slackIdentityFor(req.oidcSubject!)
          return slack ? { linked: true as const, ...slack } : { linked: false as const }
        } catch (error) {
          return logtoFailure(reply, error, 'read')
        }
      }
    )
  }
}
