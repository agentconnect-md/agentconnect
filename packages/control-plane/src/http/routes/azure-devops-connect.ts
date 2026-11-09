// Connect with Microsoft and Manage project access (azure-devops-integration.md §3.2, §8), mounted inside `/orgs/:orgId`; every route manages a credential and is interactive-only.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { AzureDevOpsApiError } from '../../azure-devops/api.js'
import { AzureDevOpsConnectDenied } from '../../azure-devops/connection.service.js'
import {
  AzureDevOpsConnectRefusal,
  type AzureDevOpsConnectFlowService,
  type AzureDevOpsFlowResult
} from '../../azure-devops/connect-flow.service.js'
import type { AzureDevOpsFlowTicket } from '../../azure-devops/connect.js'
import {
  ApplyAzureDevOpsProjectsBody,
  AzureDevOpsAuthorizeDto,
  AzureDevOpsConnectCallbackBody,
  AzureDevOpsConnectFlowDto,
  AzureDevOpsConnectResultDto,
  AzureDevOpsFlowHeaders,
  AzureDevOpsFlowParams,
  AzureDevOpsMemberOrganizationsDto,
  AzureDevOpsMembershipDto,
  AzureDevOpsProjectsDto,
  ChooseAzureDevOpsOrganizationBody,
  ErrorDto,
  StartAzureDevOpsConnectBody
} from '../dto/index.js'
import { connectionToDto } from './azure-devops.js'
import { z } from 'zod'

const ERROR_NAMES = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway'
} as const

/** A connect refusal with what comes next: an admin-consent link, a manual checklist, or a ticket to verify with. */
const AzureDevOpsConnectErrorDto = ErrorDto.extend({
  adminConsentUrl: z.string().optional(),
  checklist: z.array(z.string()).optional(),
  memberships: z.array(AzureDevOpsMembershipDto).optional(),
  inOrganization: z.boolean().optional(),
  ticket: z.string().optional(),
  authorizeUrl: z.string().optional()
})

const ERRORS = {
  400: AzureDevOpsConnectErrorDto,
  403: AzureDevOpsConnectErrorDto,
  404: AzureDevOpsConnectErrorDto,
  409: AzureDevOpsConnectErrorDto,
  429: AzureDevOpsConnectErrorDto,
  502: AzureDevOpsConnectErrorDto
}

const TICKET_HEADER = 'x-azure-devops-flow-ticket'

export function azureDevOpsConnectRoutes(deps: HttpDeps) {
  return async function azureDevOpsConnectRoutesPlugin(app: FastifyInstance): Promise<void> {
    const azure = deps.azureDevOps
    if (!azure) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    const refuse = (reply: FastifyReply, e: AzureDevOpsConnectDenied) =>
      reply.code(e.status).send({
        error: ERROR_NAMES[e.status],
        statusCode: e.status,
        message: e.message,
        code: e.code,
        ...(e instanceof AzureDevOpsConnectRefusal ? e.details : {})
      })
    const failed = (reply: FastifyReply, e: unknown) => {
      if (e instanceof AzureDevOpsConnectDenied) return refuse(reply, e)
      if (e instanceof AzureDevOpsApiError) {
        const status = e.code === 'RATE_LIMITED' ? 429 : 502
        return refuse(
          reply,
          new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, status, 'azure_devops_unavailable')
        )
      }
      throw e
    }
    /** The flow service and the caller, or a refusal already sent. */
    const ready = (
      req: FastifyRequest,
      reply: FastifyReply
    ): { flow: AzureDevOpsConnectFlowService; userId: string } | undefined => {
      if (denyViewerWrite(req, reply)) return undefined
      if (!azure.connect) {
        void refuse(
          reply,
          new AzureDevOpsConnectDenied(
            'this deployment has no Microsoft application — use your own application instead',
            409,
            'deployment_application_missing'
          )
        )
        return undefined
      }
      if (!req.principal) {
        void refuse(reply, new AzureDevOpsConnectDenied('sign in to connect Azure DevOps', 403, 'sign_in_required'))
        return undefined
      }
      return { flow: azure.connect, userId: req.principal.userId }
    }
    const result = async (orgId: string, outcome: AzureDevOpsFlowResult) => ({
      connection: connectionToDto(
        outcome.connection,
        (await deps.repos.azureDevOpsRepositoryBinding.listForConnection(orgId, outcome.connection.id)).length
      ),
      memberships: outcome.memberships,
      triggers: outcome.triggers,
      ...(outcome.checklist ? { checklist: outcome.checklist } : {})
    })
    /** Runs one step of an open flow: the ticket must be this flow's, for this organization and caller. */
    const step = async <T>(
      req: FastifyRequest,
      reply: FastifyReply,
      flowId: string,
      run: (flow: AzureDevOpsConnectFlowService, ticket: AzureDevOpsFlowTicket) => Promise<T>
    ): Promise<T | FastifyReply | undefined> => {
      const live = ready(req, reply)
      if (!live) return undefined
      try {
        const header = req.headers[TICKET_HEADER]
        const ticket = live.flow.open(orgOf(req), live.userId, flowId, typeof header === 'string' ? header : undefined)
        return await run(live.flow, ticket)
      } catch (e) {
        return failed(reply, e)
      }
    }

    r.post(
      '/azure-devops/connect',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Start connecting Azure DevOps with Microsoft',
          description:
            'Answers Microsoft’s sign-in URL for the deployment’s Microsoft application at the `organizations` authority, asking for `openid`, `User.Read` and the delegated Azure DevOps scope, with a PKCE challenge only the Control Plane can complete and the Console’s `/azure-devops/connect` page as the redirect URI. The state is signed for this organization and caller and expires in ten minutes. A `connectionId` starts Manage project access for that connection, at its tenant’s authority. Refused when the deployment has no Microsoft application, or when the organization already has a connection and none is named.',
          operationId: 'startAzureDevOpsConnect',
          body: StartAzureDevOpsConnectBody,
          response: { 200: AzureDevOpsAuthorizeDto, ...ERRORS }
        }
      },
      async (req, reply) => {
        const live = ready(req, reply)
        if (!live) return
        try {
          return await live.flow.start(orgOf(req), live.userId, req.body.connectionId)
        } catch (e) {
          return failed(reply, e)
        }
      }
    )

    r.post(
      '/azure-devops/connect/callback',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Finish the Microsoft sign-in for Azure DevOps',
          description:
            'Verifies the state, redeems the code with the deployment secret, and takes the tenant from the ID token. A personal Microsoft account is refused; missing consent is refused with `consent_required` and, when the tenant is known, an admin-consent URL. The administrator’s delegated token is sealed into an encrypted ticket that expires within thirty minutes and is never stored.',
          operationId: 'finishAzureDevOpsSignIn',
          body: AzureDevOpsConnectCallbackBody,
          response: { 200: AzureDevOpsConnectFlowDto, ...ERRORS }
        }
      },
      async (req, reply) => {
        const live = ready(req, reply)
        if (!live) return
        try {
          const started = await live.flow.callback(orgOf(req), live.userId, {
            state: req.body.state,
            ...(req.body.code !== undefined ? { code: req.body.code } : {}),
            ...(req.body.error !== undefined ? { error: req.body.error } : {}),
            ...(req.body.error_description !== undefined ? { errorDescription: req.body.error_description } : {})
          })
          return { ...started, expiresAt: new Date(started.expiresAt).toISOString() }
        } catch (e) {
          return failed(reply, e)
        }
      }
    )

    r.get(
      '/azure-devops/connect/:flow/organizations',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'List the signed-in administrator’s Azure DevOps organizations',
          description:
            'With the flow’s delegated token, reads the administrator’s profile and the organizations they are a member of in the signed-in tenant.',
          operationId: 'listAzureDevOpsConnectOrganizations',
          params: AzureDevOpsFlowParams,
          headers: AzureDevOpsFlowHeaders,
          response: { 200: AzureDevOpsMemberOrganizationsDto, ...ERRORS }
        }
      },
      async (req, reply) =>
        step(req, reply, req.params.flow, async (flow, ticket) => ({ organizations: await flow.organizations(ticket) }))
    )

    r.post(
      '/azure-devops/connect/:flow/organization',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Choose the Azure DevOps organization to connect',
          description:
            'Records the organization in a new ticket and answers its projects, read with the delegated token. An organization another AgentConnect organization on this deployment holds is refused (AZURE_DEVOPS_ORGANIZATION_TAKEN). For Manage project access the organization is the connection’s.',
          operationId: 'chooseAzureDevOpsConnectOrganization',
          params: AzureDevOpsFlowParams,
          headers: AzureDevOpsFlowHeaders,
          body: ChooseAzureDevOpsOrganizationBody,
          response: { 200: AzureDevOpsProjectsDto, ...ERRORS }
        }
      },
      async (req, reply) =>
        step(req, reply, req.params.flow, (flow, ticket) => flow.chooseOrganization(ticket, req.body.organization))
    )

    r.post(
      '/azure-devops/connect/:flow/projects',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Give the application access to projects and connect',
          description:
            'Adds the application’s service principal to the organization with the Basic access level, or raises a member below Basic to Basic, adds it to each project’s Readers or Contributors group, then verifies as the application and records the connection (or, for Manage project access, re-verifies the existing one). For each project with Allow triggers (on by default with Contributors) it then gives the application View and Edit subscriptions there; a refusal is reported in `triggers` with a `checklist` entry and does not fail the step. Below Project Collection Administrator the entitlement is refused with a manual checklist naming the application’s client ID, the memberships the caller could make, and a ticket to verify with once the checklist is done.',
          operationId: 'applyAzureDevOpsConnectProjects',
          params: AzureDevOpsFlowParams,
          headers: AzureDevOpsFlowHeaders,
          body: ApplyAzureDevOpsProjectsBody,
          response: { 200: AzureDevOpsConnectResultDto, ...ERRORS }
        }
      },
      async (req, reply) =>
        step(req, reply, req.params.flow, async (flow, ticket) =>
          result(orgOf(req), await flow.applyProjects(ticket, req.body.projects, req.body.allProjects))
        )
    )

    r.post(
      '/azure-devops/connect/:flow/verify',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Verify Azure DevOps access after a manual step',
          description:
            'Resumes a flow whose projects were chosen: checks that the service principal is in the organization, raises it to Basic when below, makes the group memberships the caller may, then verifies as the application and records the connection (or re-verifies the existing one). Refused with `not_in_organization` and the checklist while the service principal is not a member.',
          operationId: 'verifyAzureDevOpsConnect',
          params: AzureDevOpsFlowParams,
          headers: AzureDevOpsFlowHeaders,
          response: { 200: AzureDevOpsConnectResultDto, ...ERRORS }
        }
      },
      async (req, reply) =>
        step(req, reply, req.params.flow, async (flow, ticket) => result(orgOf(req), await flow.verify(ticket)))
    )
  }
}
