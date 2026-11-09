// The organization's Azure DevOps connections and bound repositories (azure-devops-integration.md §3.2, §5, §8), mounted inside `/orgs/:orgId`; without the surface on the deps nothing registers.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { OrgId } from '../../domain/ids.js'
import { Tag } from '../plugins/openapi.js'
import { AzureDevOpsApiError } from '../../azure-devops/api.js'
import { AzureDevOpsConnectDenied } from '../../azure-devops/connection.service.js'
import { describeGiteaReferences, type GiteaBindingReference } from '../../gitea/references.js'
import {
  AzureDevOpsConnectionDto,
  AzureDevOpsConnectionListDto,
  AzureDevOpsRepositoryBindingListDto,
  AzureDevOpsRepositoryListDto,
  ConnectAzureDevOpsBody,
  ErrorDto,
  IdParam,
  ReplaceAzureDevOpsSecretBody,
  AzureDevOpsHookKeyRotationDto,
  type AzureDevOpsConnectionDtoT,
  type AzureDevOpsRepositoryBindingDtoT
} from '../dto/index.js'
import type {
  AzureDevOpsConnectionRecord,
  AzureDevOpsHookSubscriptionRecord,
  AzureDevOpsRepositoryBindingRecord
} from '../../persistence/ports.js'

const ERROR_NAMES = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway'
} as const

/** The machine-readable code a removal refused for a remaining reference answers with. */
const REPOSITORY_IN_USE = 'repository_in_use'

export function connectionToDto(r: AzureDevOpsConnectionRecord, boundRepositories: number): AzureDevOpsConnectionDtoT {
  return {
    id: r.id,
    organization: r.organization,
    organizationInstanceId: r.organizationInstanceId,
    tenantId: r.tenantId,
    identityId: r.identityId,
    identityName: r.identityName,
    credentialSource: r.credentialSource,
    clientId: r.clientId,
    state: r.state,
    stateReason: r.stateReason,
    credentialEpoch: r.credentialEpoch.toString(),
    boundRepositories,
    connectedBy: r.createdByUserId,
    lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

function bindingToDto(
  r: AzureDevOpsRepositoryBindingRecord,
  subscriptions: ReadonlyArray<Pick<AzureDevOpsHookSubscriptionRecord, 'kind' | 'status'>>
): AzureDevOpsRepositoryBindingDtoT {
  return {
    id: r.id,
    connectionId: r.connectionId,
    repoId: r.repoId.toString(),
    repositoryId: r.repositoryId,
    projectId: r.projectId,
    repoPath: r.repoPath,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch,
    state: r.state,
    stateReason: r.stateReason,
    hookReason: r.hookReason,
    lastVerifiedDeliveryAt: r.lastVerifiedDeliveryAt ? r.lastVerifiedDeliveryAt.toISOString() : null,
    subscriptions: subscriptions.map(({ kind, status }) => ({ kind, status })),
    createdAt: r.createdAt.toISOString()
  }
}

export function azureDevOpsRoutes(deps: HttpDeps) {
  return async function azureDevOpsRoutesPlugin(app: FastifyInstance): Promise<void> {
    const azure = deps.azureDevOps
    if (!azure) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    const denied = (reply: FastifyReply, e: AzureDevOpsConnectDenied) =>
      reply
        .code(e.status)
        .send({ error: ERROR_NAMES[e.status], statusCode: e.status, message: e.message, code: e.code })
    /** A connection-level verdict is a 409 the card acts on; throttling stays 429 and the rest 502. */
    const upstream = (reply: FastifyReply, e: AzureDevOpsApiError) => {
      if (e.code === 'SECRET_REJECTED' || e.code === 'ACCESS_REVOKED') {
        const code = e.code === 'SECRET_REJECTED' ? 'secret_rejected' : 'access_revoked'
        return reply
          .code(409)
          .send({ error: ERROR_NAMES[409], statusCode: 409, message: `azure devops: ${e.message}`, code })
      }
      const status = e.code === 'RATE_LIMITED' ? 429 : 502
      if (e.retryAfterMs !== undefined) void reply.header('retry-after', Math.ceil(e.retryAfterMs / 1000))
      return reply
        .code(status)
        .send({ error: ERROR_NAMES[status], statusCode: status, message: `azure devops: ${e.message}` })
    }
    const failed = (reply: FastifyReply, e: unknown) => {
      if (e instanceof AzureDevOpsConnectDenied) return denied(reply, e)
      if (e instanceof AzureDevOpsApiError) return upstream(reply, e)
      throw e
    }
    const notFound = (reply: FastifyReply, what: string) =>
      reply.code(404).send({ error: ERROR_NAMES[404], statusCode: 404, message: `${what} not found` })
    const connectionDto = async (orgId: string, record: AzureDevOpsConnectionRecord) =>
      connectionToDto(
        record,
        (await deps.repos.azureDevOpsRepositoryBinding.listForConnection(orgId, record.id)).length
      )

    /** The workspaces and grants that name any of these bindings, for a refusal that says what to remove first. */
    const referencesTo = async (
      orgId: string,
      bindings: readonly AzureDevOpsRepositoryBindingRecord[]
    ): Promise<GiteaBindingReference[]> => {
      const agents = await deps.repos.agent.list(OrgId(orgId))
      const nameOf = new Map<string, string>(agents.map((agent): [string, string] => [agent.id, agent.name]))
      const references: GiteaBindingReference[] = []
      for (const binding of bindings) {
        for (const agent of agents) {
          const credential = agent.workspace.mode === 'git' ? agent.workspace.credential : undefined
          if (
            credential?.provider === 'azure-devops' &&
            credential.connectionId === binding.connectionId &&
            agent.workspaceRepoId === binding.repoId
          ) {
            references.push({ kind: 'workspace', agentName: agent.name })
          }
        }
        const grants = await deps.repos.agentRepoAuth.listForRepository(OrgId(orgId), 'azure-devops', binding.repoId)
        for (const grant of grants.filter((row) => row.connectionId === binding.connectionId)) {
          references.push({ kind: 'additional_repository', agentName: nameOf.get(grant.agentId) ?? grant.agentId })
        }
      }
      return references
    }

    r.post(
      '/azure-devops/connections',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Connect Azure DevOps with your own application',
          description:
            'Connects an Azure DevOps organization through an Entra application registered in your tenant (“Use your own application instead”). The Control Plane takes a client credentials token at the tenant, reads connectionData for the identity and the organization’s instance, and lists the repositories, which proves an access level that includes Azure Repos. The deployment’s own Microsoft application is refused here, as is an organization another AgentConnect organization already connected (AZURE_DEVOPS_ORGANIZATION_TAKEN). One connection per organization. The client secret is write-only, sealed and never returned.',
          operationId: 'connectAzureDevOps',
          body: ConnectAzureDevOpsBody,
          response: {
            200: AzureDevOpsConnectionDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        // The first version offers one connection per organization; nothing below this route assumes it (§3.2).
        if ((await deps.repos.azureDevOpsConnection.listForOrg(orgId)).length > 0) {
          return reply.code(409).send({
            error: ERROR_NAMES[409],
            statusCode: 409,
            message: 'this organization already has an Azure DevOps connection — disconnect it first',
            code: 'connection_exists'
          })
        }
        try {
          const record = await azure.connections.connectOwnApplication(orgId, req.body, req.principal?.userId)
          return await connectionDto(orgId, record)
        } catch (e) {
          return failed(reply, e)
        }
      }
    )

    r.get(
      '/azure-devops/connections',
      {
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'List Azure DevOps connections',
          description:
            'The organization’s Azure DevOps connections with their identity, credential source, state and bound repository count — no secret material — and whether the deployment’s Microsoft application can connect.',
          operationId: 'listAzureDevOpsConnections',
          response: { 200: AzureDevOpsConnectionListDto }
        }
      },
      async (req) => {
        const orgId = orgOf(req)
        const rows = await deps.repos.azureDevOpsConnection.listForOrg(orgId)
        return {
          connections: await Promise.all(rows.map((row) => connectionDto(orgId, row))),
          deploymentApplication: azure.connections.deploymentClientId !== undefined
        }
      }
    )

    r.post(
      '/azure-devops/connections/:id/secret',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Replace an own application’s client secret',
          description:
            'For a connection made with your own application only: verifies the new secret as the connect step does, requires the same tenant, client ID and Azure DevOps identity, then swaps the sealed value and advances the credential epoch so daemon caches purge the old token. Bindings degraded by a rejected secret recover. The deployment application’s secret is rotated in Setup instead.',
          operationId: 'replaceAzureDevOpsSecret',
          params: IdParam,
          body: ReplaceAzureDevOpsSecretBody,
          response: {
            200: AzureDevOpsConnectionDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        try {
          const record = await azure.connections.replaceOwnSecret(orgId, req.params.id, req.body.clientSecret)
          return await connectionDto(orgId, record)
        } catch (e) {
          return failed(reply, e)
        }
      }
    )

    r.delete(
      '/azure-devops/connections/:id',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Disconnect Azure DevOps',
          description:
            'Removes the connection, its sealed secret and its bound repositories at once, then deletes the service hook subscriptions it made. Refused with 409 while an agent workspace or an additional-repository grant still uses one of its repositories, naming them. The service principal stays in the Azure DevOps organization until an administrator removes it there.',
          operationId: 'disconnectAzureDevOps',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const record = await deps.repos.azureDevOpsConnection.get(orgId, req.params.id)
        if (!record) return notFound(reply, 'azure devops connection')
        const outcome = azure.hooks
          ? await azure.hooks.disconnect(orgId, record.id, () => azure.connections.disconnect(orgId, record.id))
          : await azure.connections.disconnect(orgId, record.id)
        if (outcome === 'missing') return notFound(reply, 'azure devops connection')
        if (outcome === 'referenced') {
          const bindings = await deps.repos.azureDevOpsRepositoryBinding.listForConnection(orgId, record.id)
          return reply.code(409).send({
            error: ERROR_NAMES[409],
            statusCode: 409,
            message: describeGiteaReferences(record.organization, await referencesTo(orgId, bindings)),
            code: REPOSITORY_IN_USE
          })
        }
        return reply.code(204).send(null)
      }
    )

    r.get(
      '/azure-devops/connections/:id/repositories',
      {
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'List Azure DevOps repositories available to the caller',
          description:
            'Repositories readable by both the connection and the caller’s linked Microsoft account, without disabled repositories or those in maintenance. A previously bound row carries its binding; any other row is bound when a workspace or grant first names it. Metadata only.',
          operationId: 'listAzureDevOpsConnectionRepositories',
          params: IdParam,
          response: {
            200: AzureDevOpsRepositoryListDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const orgId = orgOf(req)
        const connection = await deps.repos.azureDevOpsConnection.get(orgId, req.params.id)
        if (!connection) return notFound(reply, 'azure devops connection')
        try {
          const repositories = await azure.userAuthz.filterRepositories(
            req.principal?.userId,
            connection,
            await azure.bindings.visibleRepositories(connection)
          )
          const bindings = await deps.repos.azureDevOpsRepositoryBinding.listForConnection(orgId, connection.id)
          const boundBy = new Map(bindings.map((binding) => [binding.repositoryId, binding]))
          const ids = await deps.repos.azureDevOpsRepositoryBinding.identitiesOf(repositories.map((repo) => repo.id))
          return {
            repositories: repositories.map((repo) => ({
              repositoryId: repo.id,
              projectId: repo.projectId,
              path: `${connection.organization}/${repo.projectName}/${repo.name}`,
              cloneUrl: repo.cloneUrl,
              defaultBranch: repo.defaultBranch,
              repoId: ids.get(repo.id)?.toString() ?? null,
              bindingId: boundBy.get(repo.id)?.id ?? null
            }))
          }
        } catch (e) {
          return failed(reply, e)
        }
      }
    )

    r.get(
      '/azure-devops/repositories',
      {
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'List bound Azure DevOps repositories',
          description:
            'The organization’s bound repositories with their state: `ready`, or `runtime_degraded` with `secret_rejected`, `access_revoked` or `repository_unavailable`. A repository with Azure DevOps triggers also carries its service hook subscriptions, one per delivery kind, and `hookReason` while they are not known to deliver: `webhook_unverified` until a delivery verifies, `triggers_not_allowed` when the application lacks View and Edit subscriptions on the project, `relay_url_unconfigured`, or `subscriptions_failed`.',
          operationId: 'listAzureDevOpsRepositories',
          response: { 200: AzureDevOpsRepositoryBindingListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.azureDevOpsRepositoryBinding.listForOrg(orgOf(req))
        const hooks = azure.hooks
        return {
          bindings: await Promise.all(
            rows.map(async (row) => bindingToDto(row, hooks ? await hooks.subscriptionsOf(row.id) : []))
          )
        }
      }
    )

    r.post(
      '/azure-devops/repositories/:id/rotate-hook-key',
      {
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Rotate an Azure DevOps repository’s service hook key',
          description:
            'Seals a next key, sends it to the relays beside the current one, then replaces each recorded service hook subscription with the next key, recording each acknowledgement so a rotation cut short resumes without re-keying any subscription twice. The key is promoted once every subscription has switched and a delivery verifies under it; the old key is then accepted for 36 hours of Azure DevOps retries. Answers how many subscriptions have switched so far.',
          operationId: 'rotateAzureDevOpsHookKey',
          params: IdParam,
          response: { 200: AzureDevOpsHookKeyRotationDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        if (!azure.hooks) {
          return reply.code(409).send({
            error: ERROR_NAMES[409],
            statusCode: 409,
            message: 'Azure DevOps triggers are not available on this deployment'
          })
        }
        const target = await deps.repos.azureDevOpsRepositoryBinding.get(orgId, req.params.id)
        if (!target) return notFound(reply, 'azure devops repository')
        return azure.hooks.rotate(orgId, target.id)
      }
    )

    r.delete(
      '/azure-devops/repositories/:id',
      {
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Remove a bound Azure DevOps repository',
          description:
            'Removes the binding at once, releasing the deployment-global repository claim when no other connection of the organization binds it, then deletes its service hook subscriptions; its triggers stop firing. Refused with 409 while an agent workspace or an additional-repository grant still uses the repository, naming them.',
          operationId: 'deleteAzureDevOpsRepository',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const target = await deps.repos.azureDevOpsRepositoryBinding.get(orgId, req.params.id)
        if (!target) return notFound(reply, 'azure devops repository')
        // Its subscriptions are deleted once the binding is gone; an orphan Azure DevOps keeps is refused by the relay and retires on its own.
        const outcome = azure.hooks
          ? await azure.hooks.removeBinding(orgId, target.id)
          : await deps.repos.azureDevOpsRepositoryBinding.remove(orgId, target.id)
        if (outcome === 'missing') return notFound(reply, 'azure devops repository')
        if (outcome === 'referenced') {
          return reply.code(409).send({
            error: ERROR_NAMES[409],
            statusCode: 409,
            message: describeGiteaReferences(target.repoPath, await referencesTo(orgId, [target])),
            code: REPOSITORY_IN_USE
          })
        }
        return reply.code(204).send(null)
      }
    )
  }
}
