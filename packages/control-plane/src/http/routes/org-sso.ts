/** Organization-owned single sign-on (organization-sso.md §6): the domains an organization has proved it controls. */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { HttpDeps } from '../deps.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import { denyNonOwner } from '../rbac.js'
import {
  AddOrgSsoDomainBody,
  ErrorDto,
  IdParam,
  OrgSsoDomainDto,
  OrgSsoStateDto,
  VerifiedOrgSsoDomainDto,
  type OrgSsoDomainDtoT
} from '../dto/index.js'
import { MAX_DOMAINS_PER_ORG, type OrgDomainView } from '../../org-sso/domains.js'

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
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/sso',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Get the organization single sign-on setup',
          description:
            'Owner-only. Returns the domains the organization has claimed for single sign-on, each with the DNS TXT record that proves control of it.',
          operationId: 'getOrganizationSso',
          response: { 200: OrgSsoStateDto, 401: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        return { domains: (await domains.list(req.orgCtx!.orgId)).map(toDto) }
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
        const result = await domains.verify(req.orgCtx!.orgId, req.params.id, req.principal!.userId)
        if (result === null) return domainNotFound(reply)
        if (result === 'taken') return domainTaken(reply)
        return { domain: toDto(result.domain), check: result.check }
      }
    )

    r.delete(
      '/sso/domains/:id',
      {
        config,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Release a single sign-on domain',
          description: 'Owner-only. Removes the domain from the organization; another organization may then verify it.',
          operationId: 'releaseOrganizationSsoDomain',
          params: IdParam,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const found = await domains.release(req.orgCtx!.orgId, req.params.id, req.principal!.userId)
        if (!found) return domainNotFound(reply)
        return reply.code(204).send(null)
      }
    )
  }
}
