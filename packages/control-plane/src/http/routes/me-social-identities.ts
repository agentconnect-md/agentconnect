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
import { LogtoApiError } from '../../github/logto-identity.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'

const ConnectorId = z.string().trim().min(1).max(128)
// Must stay in step with the console's SOCIAL_LOGIN_PROVIDERS: a target the UI
// offers but this rejects is a Connect button that 400s.
const SocialTarget = z.enum(['github', 'google', 'slack'])
const TargetParamStrict = z.object({ target: SocialTarget })
const ConnectorDto = z.object({ connectorId: ConnectorId })
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
type Operation = 'authorize' | 'unlink' | 'read'

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
  if (error.status === 400) {
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
    const unavailable = {
      error: 'Service Unavailable',
      statusCode: 503,
      message: 'social sign-in management is not configured'
    } as const

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
        identity.forgetUser(req.oidcSubject!)
        return reply.code(204).send(null)
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
