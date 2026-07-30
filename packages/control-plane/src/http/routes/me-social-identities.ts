/**
 * The signed-in user's social sign-in methods. These routes deliberately use
 * `oidcAuth` (never devAuth or API keys) and proxy the narrow operation through
 * Logto's Management API, so its M2M credential stays server-side.
 *
 * The current OIDC session is the authorization boundary. Provider OAuth proves
 * the identity being linked; unlinking does not add a second email-code step.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { resolveWebAppUrl } from '../../config/env.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'

const ConnectorId = z.string().trim().min(1).max(128)
// Must stay in step with the console's SOCIAL_LOGIN_PROVIDERS: a target the UI
// offers but this rejects is a Connect button that 400s.
const SocialTarget = z.enum(['github', 'google', 'slack'])
const State = z.string().min(32).max(256)
const ConnectorData = z
  .record(z.string().max(64), z.string().max(4096))
  .refine((value) => Object.keys(value).length <= 32, 'too many connector response fields')

const AuthorizationBody = z.object({ target: SocialTarget, state: State }).strict()
const AuthorizationDto = z.object({ authorizationUri: z.url(), connectorId: ConnectorId })
const LinkBody = z.object({ connectorId: ConnectorId, connectorData: ConnectorData }).strict()
const LinkDto = z.object({ linked: z.literal(true) })
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

type Operation = 'authorize' | 'link' | 'unlink' | 'read'

function socialCallbackUrl(deps: HttpDeps): string | undefined {
  const webUrl = resolveWebAppUrl(deps.config)
  return webUrl ? new URL('/auth/social/callback', webUrl).toString() : undefined
}

function logtoFailure(reply: FastifyReply, error: unknown, operation: Operation) {
  if (!(error instanceof LogtoApiError)) throw error
  if (operation === 'unlink' && error.status === 409 && error.code === 'LAST_SOCIAL_IDENTITY') {
    return reply.code(409).send({
      error: 'Conflict',
      statusCode: 409,
      code: error.code,
      message: 'connect another sign-in method before removing this one'
    })
  }
  if (operation === 'link' && error.status === 422) {
    return reply.code(409).send({
      error: 'Conflict',
      statusCode: 409,
      code: 'SOCIAL_IDENTITY_IN_USE',
      message: 'this social account is already connected to another account'
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

    r.post(
      '/me/social-identities/authorization-uri',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Start linking a social sign-in method',
          description:
            'Resolve a statically supported provider target and build its authorization URI. The current OIDC session authorizes the operation; the provider flow proves the new identity.',
          operationId: 'createMySocialIdentityAuthorization',
          body: AuthorizationBody,
          response: {
            200: AuthorizationDto,
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
        const redirectUri = socialCallbackUrl(deps)
        if (!identity || !redirectUri) return reply.code(503).send(unavailable)
        try {
          const authorization = await identity.createSocialAuthorization(req.body.target, redirectUri, req.body.state)
          return {
            authorizationUri: authorization.redirectTo,
            connectorId: authorization.connectorId
          }
        } catch (error) {
          return logtoFailure(reply, error, 'authorize')
        }
      }
    )

    r.post(
      '/me/social-identities',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Link a social sign-in method',
          description:
            'Link the social identity authenticated by the provider to the signed-in user. Existing accounts are not merged.',
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
        try {
          await identity.linkSocialIdentity(req.oidcSubject!, req.body.connectorId, {
            ...req.body.connectorData,
            redirectUri
          })
          return { linked: true as const }
        } catch (error) {
          return logtoFailure(reply, error, 'link')
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

    // A READ, unlike its siblings: it reports the Slack workspace an account
    // signed in with — the one server-side path to that pair, since a Logto
    // access token carries the Logto subject and never the connector identity.
    // Read-only metadata; nothing may treat it as an authorization statement.
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
