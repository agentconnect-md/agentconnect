/** Organization-owned single sign-on (organization-sso.md §6): the domains an organization has proved it controls. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { HttpDeps } from '../deps.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import { denyNonOwner } from '../rbac.js'
import {
  AddOrgSsoDomainBody,
  ErrorDto,
  IdParam,
  OrgSsoConnectionDto,
  OrgSsoDomainDto,
  OrgSsoStateDto,
  OrgSsoTestDto,
  OrgSsoTestResultBody,
  OrgSsoTestResultDto,
  PutOrgSsoConnectionBody,
  VerifiedOrgSsoDomainDto,
  type OrgSsoConnectionDtoT,
  type OrgSsoDomainDtoT
} from '../dto/index.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { MAX_DOMAINS_PER_ORG, type OrgDomainView } from '../../org-sso/domains.js'
import type { OrgSsoConnectionView } from '../../org-sso/connections.js'
import { OrgSsoIdpRejected } from '../../org-sso/idp.js'

// These routes decide how an organization's people authenticate.
const config = { interactiveOnly: true }

function toDto(view: OrgDomainView): OrgSsoDomainDtoT {
  return {
    id: view.id,
    domain: view.domain,
    status: view.status,
    record: { type: 'TXT', ...view.record },
    challengeExpiresAt: view.challengeExpiresAt?.toISOString() ?? null,
    verifiedAt: view.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: view.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: view.lastCheckOk
  }
}

function connectionDto(view: OrgSsoConnectionView): OrgSsoConnectionDtoT {
  return {
    id: view.id,
    protocol: view.protocol,
    name: view.name,
    status: view.status,
    tested: view.tested,
    testedAt: view.testedAt?.toISOString() ?? null,
    activatedAt: view.activatedAt?.toISOString() ?? null,
    configChangedAt: view.configChangedAt.toISOString(),
    serviceProvider: view.serviceProvider
  }
}

const conflict = (reply: FastifyReply, code: string, message: string) =>
  reply.code(409).send({ error: 'Conflict', statusCode: 409, message, code })
const connectionNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'no single sign-on connection' })
const needsConfiguration = (reply: FastifyReply) =>
  conflict(reply, 'SSO_CONNECTION_NEEDS_CONFIGURATION', 'the connection needs its configuration again')
const domainRequired = (reply: FastifyReply) => conflict(reply, 'SSO_DOMAIN_REQUIRED', 'verify a domain first')

/** The identity service's refusal goes to the owner as a 400; its being unreachable is a 503. */
async function withIdp<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof OrgSsoIdpRejected) {
      return reply.code(400).send({
        error: 'Bad Request',
        statusCode: 400,
        message: `the identity service rejected the settings: ${err.message}`,
        code: 'SSO_CONNECTION_REJECTED'
      })
    }
    if (err instanceof LogtoApiError) {
      return reply
        .code(503)
        .send({ error: 'Service Unavailable', statusCode: 503, message: 'the identity service is unavailable' })
    }
    throw err
  }
}

const domainTaken = (reply: FastifyReply) =>
  reply.code(409).send({
    error: 'Conflict',
    statusCode: 409,
    message: 'another organization has verified this domain',
    code: 'SSO_DOMAIN_TAKEN'
  })
const domainNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'domain not found' })

/** Owner-only routes mounted inside `/orgs/:orgId`, and only on a deployment that declares organization SSO. */
export function orgSsoRoutes(deps: HttpDeps) {
  return async function orgSsoRoutesPlugin(app: FastifyInstance): Promise<void> {
    const domains = deps.orgSsoDomains
    if (!domains) return
    const connections = deps.orgSsoConnections
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/sso',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Get the organization single sign-on setup',
          description:
            'Owner-only. Returns the domains the organization has claimed for single sign-on, each with the DNS TXT record that proves control of it, and the organization’s connection with the values to enter at the identity provider.',
          operationId: 'getOrganizationSso',
          response: { 200: OrgSsoStateDto, 401: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const connection = (await connections?.get(orgId)) ?? null
        return {
          domains: (await domains.list(orgId)).map(toDto),
          connection: connection ? connectionDto(connection) : null
        }
      }
    )

    r.post(
      '/sso/domains',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Add a single sign-on domain',
          description:
            'Owner-only. Starts a claim on an email domain and returns the DNS TXT record to publish. The claim lapses after seven days unless verified. Adding a domain the organization already has returns the existing entry.',
          operationId: 'addOrganizationSsoDomain',
          body: AddOrgSsoDomainBody,
          response: {
            200: OrgSsoDomainDto,
            201: OrgSsoDomainDto,
            400: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const result = await domains.add(req.orgCtx!.orgId, req.body.domain, req.principal!.userId)
        if (result === 'invalid') {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'not an email domain' })
        }
        if (result === 'taken') return domainTaken(reply)
        if (result === 'limit') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `an organization can hold at most ${MAX_DOMAINS_PER_ORG} domains`,
            code: 'SSO_DOMAIN_LIMIT'
          })
        }
        return reply.code(result.created ? 201 : 200).send(toDto(result.domain))
      }
    )

    r.post(
      '/sso/domains/:id/verify',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Verify a single sign-on domain',
          description:
            'Owner-only. Resolves the domain’s TXT record now and reports what it found. A pending domain becomes verified when the record carries the challenge; a verified domain is checked again and stays verified.',
          operationId: 'verifyOrganizationSsoDomain',
          params: IdParam,
          response: {
            200: VerifiedOrgSsoDomainDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        return withIdp(reply, async () => {
          const result = connections
            ? await connections.verifyDomain(orgId, req.params.id, userId)
            : await domains.verify(orgId, req.params.id, userId)
          if (result === null) return domainNotFound(reply)
          if (result === 'taken') return domainTaken(reply)
          return { domain: toDto(result.domain), check: result.check }
        })
      }
    )

    r.delete(
      '/sso/domains/:id',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Release a single sign-on domain',
          description:
            'Owner-only. Removes the domain from the organization; another organization may then verify it. A verified domain is kept while the organization has a connection: remove the connection first.',
          operationId: 'releaseOrganizationSsoDomain',
          params: IdParam,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        const released = connections
          ? await connections.releaseDomain(orgId, req.params.id, userId)
          : await domains.release(orgId, req.params.id, userId)
        if (released === 'in_use') {
          return conflict(
            reply,
            'SSO_DOMAIN_IN_USE',
            'remove the single sign-on connection before releasing this domain'
          )
        }
        if (!released) return domainNotFound(reply)
        return reply.code(204).send(null)
      }
    )

    if (!connections) return

    r.put(
      '/sso/connection',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Create or change the single sign-on connection',
          description:
            'Owner-only. Saves the identity provider settings for the organization’s one connection and returns the values to enter at the identity provider. The settings take effect at once, also on an active connection, and the connection reads as untested until a test sign-in succeeds again. An OIDC save always carries the client secret, which is forwarded to the identity service and not kept. A SAML save carries a metadata URL or a metadata document. Changing the protocol starts a new connection with new service-provider values.',
          operationId: 'putOrganizationSsoConnection',
          body: PutOrgSsoConnectionBody,
          response: { 200: OrgSsoConnectionDto, 400: ErrorDto, 401: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const body = req.body
        if (body.protocol === 'saml' && (body.metadataUrl === undefined) === (body.metadata === undefined)) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'give a metadata URL or a metadata document, not both'
          })
        }
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        return withIdp(reply, async () => connectionDto(await connections.save(orgId, body, userId)))
      }
    )

    r.post(
      '/sso/connection/test',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Start a test sign-in',
          description:
            'Owner-only. Opens a ten-minute test window and returns a one-time nonce and the connector to start a sign-in against. While the window is open the organization’s verified domains sign in only through the connection, as they do once it is active. Refused without a verified domain.',
          operationId: 'startOrganizationSsoTest',
          response: { 200: OrgSsoTestDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        return withIdp(reply, async () => {
          const result = await connections.startTest(orgId)
          if (result === 'none') return connectionNotFound(reply)
          if (result === 'no_domain') return domainRequired(reply)
          if (result === 'needs_configuration') return needsConfiguration(reply)
          return { nonce: result.nonce, connectorId: result.connectorId, expiresAt: result.expiresAt.toISOString() }
        })
      }
    )

    r.post(
      '/sso/connection/activate',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Activate the single sign-on connection',
          description:
            'Owner-only. From this moment addresses in the organization’s verified domains sign in only through the connection. Requires a successful test sign-in since the settings last changed, and resolves every verified domain’s DNS record again first; activation is refused when one no longer carries its challenge.',
          operationId: 'activateOrganizationSsoConnection',
          response: {
            200: OrgSsoConnectionDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        return withIdp(reply, async () => {
          const result = await connections.activate(orgId, userId)
          if (result === 'none') return connectionNotFound(reply)
          if (result === 'needs_configuration') return needsConfiguration(reply)
          if (result === 'no_domain') return domainRequired(reply)
          if (result === 'untested') {
            return conflict(reply, 'SSO_CONNECTION_UNTESTED', 'run a test sign-in after the last settings change first')
          }
          if ('failed' in result) {
            const names = result.failed.map((entry) => entry.domain).join(', ')
            return conflict(reply, 'SSO_DOMAIN_CHECK_FAILED', `the DNS record could not be confirmed for ${names}`)
          }
          return connectionDto(result)
        })
      }
    )

    r.post(
      '/sso/connection/deactivate',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Deactivate the single sign-on connection',
          description:
            'Owner-only. Lifts the restriction on the organization’s domains, so their addresses may sign in by other methods again. People who already signed in through the connection can still use it; removing the connection ends that.',
          operationId: 'deactivateOrganizationSsoConnection',
          response: { 200: OrgSsoConnectionDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        return withIdp(reply, async () => {
          const view = await connections.deactivate(orgId, userId)
          return view ? connectionDto(view) : connectionNotFound(reply)
        })
      }
    )

    r.delete(
      '/sso/connection',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Remove the single sign-on connection',
          description:
            'Owner-only. Deletes the connection and every sign-in identity it established, and lifts the restriction on the organization’s domains. Accounts stay; their owners sign in by another method.',
          operationId: 'removeOrganizationSsoConnection',
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const { orgId } = req.orgCtx!
        const userId = req.principal!.userId
        return withIdp(reply, async () =>
          (await connections.remove(orgId, userId)) ? reply.code(204).send(null) : connectionNotFound(reply)
        )
      }
    )
  }
}

const AdminOrgParams = z.object({ orgId: z.string().min(1).max(64) })

/** Outside the organization subtree: the test landing for any signed-in caller, and a deployment administrator's recovery paths (§4.1, §8). */
export function orgSsoRootRoutes(deps: HttpDeps) {
  return async function orgSsoRootRoutesPlugin(app: FastifyInstance): Promise<void> {
    const connections = deps.orgSsoConnections
    if (!connections) return
    const r = app.withTypeProvider<ZodTypeProvider>()
    const isDeploymentAdmin = (req: FastifyRequest): boolean =>
      !deps.config.OIDC_ISSUER || req.principal?.isAdmin === true
    const adminOnly = (reply: FastifyReply) =>
      reply.code(403).send({
        error: 'Forbidden',
        statusCode: 403,
        message: 'only a deployment administrator can do this'
      })

    r.post(
      '/sso/test-result',
      {
        preHandler: app.humanAuth,
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Report a test sign-in',
          description:
            'Called by the page a test sign-in lands on, by whichever account landed. The connection is marked tested when the nonce belongs to an open test window and the caller holds a sign-in identity on that connection. `tested: false` leaves the window open for another try.',
          operationId: 'reportOrganizationSsoTest',
          body: OrgSsoTestResultBody,
          response: { 200: OrgSsoTestResultDto, 401: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const { userId } = req.principal!
        const subject = await deps.repos.user.getOidcSubject(userId)
        if (!subject) return { tested: false }
        return withIdp(reply, async () => ({ tested: await connections.completeTest(req.body.nonce, subject, userId) }))
      }
    )

    r.post(
      '/admin/orgs/:orgId/sso/connection/deactivate',
      {
        preHandler: app.humanAuth,
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Deactivate an organization’s single sign-on connection (admin)',
          description:
            'A deployment administrator’s recovery path when an identity provider breaks after activation: lifts the restriction on the organization’s domains without being a member. 403 for anyone else; 404 when the organization has no connection.',
          operationId: 'adminDeactivateOrganizationSsoConnection',
          params: AdminOrgParams,
          response: { 200: OrgSsoConnectionDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!isDeploymentAdmin(req)) return adminOnly(reply)
        const userId = req.principal!.userId
        return withIdp(reply, async () => {
          const view = await connections.deactivate(req.params.orgId, userId)
          return view ? connectionDto(view) : connectionNotFound(reply)
        })
      }
    )

    r.delete(
      '/admin/sso/domains/:id',
      {
        preHandler: app.humanAuth,
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Release any single sign-on domain (admin)',
          description:
            'A deployment administrator’s release of a domain its organization no longer controls. A verified domain takes the organization’s connection with it, so the identities established on that domain’s word end too. 403 for anyone else.',
          operationId: 'adminReleaseOrganizationSsoDomain',
          params: IdParam,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!isDeploymentAdmin(req)) return adminOnly(reply)
        const userId = req.principal!.userId
        return withIdp(reply, async () =>
          (await connections.adminReleaseDomain(req.params.id, userId))
            ? reply.code(204).send(null)
            : domainNotFound(reply)
        )
      }
    )
  }
}
