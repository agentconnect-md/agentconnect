/**
 * `http/routes/gitea.ts` — the organization's Gitea connection and managed repositories
 * (gitea-integration.md §4, §6, §12), mounted inside the `/orgs/:orgId` subtree.
 *
 * Connect pastes the bot token (write-only: verified, sealed, never echoed), replace swaps it for
 * the same bot, disconnect walks every binding's removal path first, the picker lists the
 * repositories the bot administers, and the repository routes run the §6 saga. Without a Gitea
 * surface on the deps, none of these routes register — the whole surface 404s.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { OrgId } from '../../domain/ids.js'
import { Tag } from '../plugins/openapi.js'
import { GITEA_REQUIRED_TOKEN_SCOPES, GiteaConnectDenied } from '../../gitea/connection.service.js'
import {
  GiteaApiError,
  giteaListOrganizationRepositories,
  giteaListUserOrganizations,
  giteaListUserRepositories,
  giteaOrganizationName,
  giteaPageSize,
  giteaRepositoryById,
  type GiteaRepository
} from '../../gitea/api.js'
import { unionGiteaWebhookEvents } from '../../gitea/webhook-events.js'
import { GITEA_MINIMUM_VERSION_LABEL, parseGiteaVersion } from '../../gitea/version.js'
import { GiteaRepositoryClaimConflict } from '../../persistence/errors.js'
import {
  ConnectGiteaBody,
  CreateGiteaRepositoryBody,
  ErrorDto,
  GiteaConnectionDeleteDto,
  GiteaConnectionDto,
  GiteaConnectionListDto,
  GiteaRepositoryBindingDto,
  GiteaRepositoryBindingListDto,
  GiteaRepositoryListDto,
  GiteaWebhookRotationDto,
  IdParam,
  type GiteaConnectionDtoT,
  type GiteaRepositoryBindingDtoT
} from '../dto/index.js'
import type { GiteaConnectionRecord, GiteaRepositoryBindingRecord } from '../../persistence/ports.js'

/** A repair is an HTTP request: outwait a brief contention, then let the follow-up finish the job. */
const REPAIR_CONTENTION_ATTEMPTS = 6

const ERROR_NAMES = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway'
} as const

type GiteaWebhookState = GiteaRepositoryBindingDtoT['webhookState']

/** The managed webhook's state (§7); a repository no enabled trigger points at wants no ingress. */
function webhookStateOf(r: GiteaRepositoryBindingRecord, wanted: boolean): GiteaWebhookState {
  if (!wanted) return 'not_needed'
  if (r.webhookId !== null) return 'installed'
  return r.state === 'ready' || r.state === 'provisioning' ? 'repairing' : 'failed'
}

function bindingToDto(r: GiteaRepositoryBindingRecord, webhookWanted: boolean): GiteaRepositoryBindingDtoT {
  return {
    id: r.id,
    connectionId: r.connectionId,
    repoId: r.repoId.toString(),
    repoPath: r.repoPath,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch,
    state: r.state,
    stateReason: r.stateReason,
    webhookState: webhookStateOf(r, webhookWanted),
    lastVerifiedDeliveryAt: r.lastVerifiedDeliveryAt ? r.lastVerifiedDeliveryAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

function connectionToDto(
  r: GiteaConnectionRecord,
  boundRepositories: number,
  instanceUrl: string
): GiteaConnectionDtoT {
  return {
    id: r.id,
    botUserId: r.botUserId.toString(),
    botUsername: r.botUsername,
    botDisplayName: r.botDisplayName,
    state: r.state,
    connectedBy: r.createdByUserId,
    credentialEpoch: r.credentialEpoch.toString(),
    boundRepositories,
    instanceUrl,
    instanceVersion: r.instanceVersion,
    instanceVersionSupported: r.instanceVersion !== null ? parseGiteaVersion(r.instanceVersion).supported : null,
    instanceVersionFloor: GITEA_MINIMUM_VERSION_LABEL,
    requiredScopes: [...GITEA_REQUIRED_TOKEN_SCOPES],
    lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

/** One picker row per repository the bot ADMINISTERS (§4.4, §6), keyed by numeric id. */
function pickerRow(repo: GiteaRepository) {
  return {
    repoId: String(repo.id),
    path: repo.full_name,
    cloneUrl: repo.clone_url ?? null,
    defaultBranch: repo.default_branch ?? null,
    private: repo.private === true
  }
}

export function giteaRoutes(deps: HttpDeps) {
  return async function giteaRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gitea = deps.gitea
    if (!gitea) return
    const r = app.withTypeProvider<ZodTypeProvider>()
    const instanceUrl = gitea.api.baseUrl

    const denied = (reply: FastifyReply, e: GiteaConnectDenied) =>
      reply
        .code(e.status)
        .send({ error: ERROR_NAMES[e.status], statusCode: e.status, message: e.message, code: e.code })
    /** Upstream trouble is upstream trouble: 429 stays 429, the rest 502; a token rejection is the connection's verdict. */
    const upstream = async (reply: FastifyReply, e: GiteaApiError, orgId: string, connectionId: string) => {
      if (e.code === 'AUTH_REJECTED') {
        await gitea.connections.onAuthRejected(orgId, connectionId)
        return reply.code(409).send({
          error: ERROR_NAMES[409],
          statusCode: 409,
          message: 'the Gitea token was rejected — replace it',
          code: 'token_rejected'
        })
      }
      const status = e.code === 'RATE_LIMITED' ? 429 : 502
      return reply.code(status).send({ error: ERROR_NAMES[status], statusCode: status, message: `gitea: ${e.message}` })
    }
    const notFound = (reply: FastifyReply, what: string) =>
      reply.code(404).send({ error: ERROR_NAMES[404], statusCode: 404, message: `${what} not found` })

    // Whether a repository wants ingress, from the same authority the provisioner converges against.
    const webhookWanted = async (orgId: string): Promise<(repoId: bigint) => boolean> => {
      const hooks = await deps.repos.hook.listForOrgKind(OrgId(orgId), 'gitea')
      return (repoId) => unionGiteaWebhookEvents(hooks, repoId) !== null
    }
    const connectionDto = async (orgId: string, record: GiteaConnectionRecord): Promise<GiteaConnectionDtoT> =>
      connectionToDto(
        record,
        (await deps.repos.giteaRepositoryBinding.listForConnection(orgId, record.id)).length,
        instanceUrl
      )

    r.post(
      '/gitea/connections',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Connect Gitea with a bot token',
          description:
            'Verifies a bot user’s personal access token against the instance (§4.1): reads the user, applies the 1.23 floor, probes the required scopes (read:user, write:repository, write:issue, read:organization), refuses a bot already serving another connection on this deployment and a second connection in this organization, then seals the token. The token is write-only and never returned.',
          operationId: 'connectGitea',
          body: ConnectGiteaBody,
          response: { 200: GiteaConnectionDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        try {
          const record = await gitea.connections.connect(orgId, req.body.token, req.principal?.userId)
          return await connectionDto(orgId, record)
        } catch (e) {
          if (e instanceof GiteaConnectDenied) return denied(reply, e)
          throw e
        }
      }
    )

    r.get(
      '/gitea/connections',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'List Gitea connections',
          description:
            'The organization’s Gitea bot connection (at most one): identity facts, instance facts and the required scopes — no token material.',
          operationId: 'listGiteaConnections',
          response: { 200: GiteaConnectionListDto }
        }
      },
      async (req) => {
        const orgId = orgOf(req)
        const rows = await deps.repos.giteaConnection.listForOrg(orgId)
        return { connections: await Promise.all(rows.map((row) => connectionDto(orgId, row))) }
      }
    )

    r.post(
      '/gitea/connections/:id/token',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Replace the Gitea bot token',
          description:
            'Runs the connect checks against the new token, requires the same numeric bot user, then switches the sealed value atomically and advances the credential epoch so daemon caches purge the old value (§4.3). Bindings degraded by a rejected token are re-converged; the old token is revoked by a human in Gitea.',
          operationId: 'replaceGiteaToken',
          params: IdParam,
          body: ConnectGiteaBody,
          response: {
            200: GiteaConnectionDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        try {
          const record = await gitea.connections.replaceToken(orgId, req.params.id, req.body.token)
          // Whatever the rejected token left behind heals under the new one: a parked cleanup finishes, the rest re-converges.
          for (const binding of await deps.repos.giteaRepositoryBinding.listForConnection(orgId, record.id)) {
            const run =
              binding.state === 'cleanup_pending'
                ? gitea.provisioner.disconnect(orgId, binding.id)
                : gitea.provisioner.convergeRepository(orgId, binding.repoId)
            void run.catch((err) =>
              app.log.warn({ err, bindingId: binding.id }, 'gitea re-converge after token replacement failed')
            )
          }
          return await connectionDto(orgId, record)
        } catch (e) {
          if (e instanceof GiteaConnectDenied) return denied(reply, e)
          throw e
        }
      }
    )

    r.delete(
      '/gitea/connections/:id',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Disconnect Gitea',
          description:
            'Walks every managed repository’s removal path first (§6): each managed webhook is deleted by its recorded id and its claim released. A binding whose cleanup cannot complete — a rejected token, or a bot that lost admin — parks in cleanup_pending and keeps the connection row until a replacement token or a manual webhook removal clears it; only then is the row and its sealed token removed.',
          operationId: 'disconnectGitea',
          params: IdParam,
          response: { 200: GiteaConnectionDeleteDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const record = await gitea.connections.beginDisconnect(orgId, req.params.id)
        if (!record) return notFound(reply, 'gitea connection')
        for (const binding of await deps.repos.giteaRepositoryBinding.listForConnection(orgId, record.id)) {
          await gitea.provisioner.disconnect(orgId, binding.id)
        }
        const removal = await gitea.connections.removeIfEmpty(orgId, record.id)
        if (removal === 'missing') return notFound(reply, 'gitea connection')
        if (removal === 'removed') return { removed: true, pendingRepositories: 0, connection: null }
        const pending = await deps.repos.giteaRepositoryBinding.listForConnection(orgId, record.id)
        const current = await deps.repos.giteaConnection.get(orgId, record.id)
        return {
          removed: false,
          pendingRepositories: pending.length,
          connection: current ? await connectionDto(orgId, current) : null
        }
      }
    )

    r.get(
      '/gitea/connections/:id/repositories',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'List the repositories the Gitea bot administers',
          description:
            'The picker (§6): every repository the bot can reach through its own listing and each organization it belongs to, kept only where the bot holds admin, keyed by numeric id. Metadata only.',
          operationId: 'listGiteaConnectionRepositories',
          params: IdParam,
          response: { 200: GiteaRepositoryListDto, 404: ErrorDto, 409: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        const orgId = orgOf(req)
        const connection = await deps.repos.giteaConnection.get(orgId, req.params.id)
        if (!connection) return notFound(reply, 'gitea connection')
        try {
          const token = await gitea.connections.withToken(orgId, connection.id)
          const pageSize = await giteaPageSize(gitea.api)
          const byId = new Map<number, GiteaRepository>()
          for (const repo of await giteaListUserRepositories(token, gitea.api, pageSize)) byId.set(repo.id, repo)
          for (const org of await giteaListUserOrganizations(token, gitea.api, pageSize)) {
            const name = giteaOrganizationName(org)
            if (!name) continue
            for (const repo of await giteaListOrganizationRepositories(token, name, gitea.api, pageSize)) {
              byId.set(repo.id, repo)
            }
          }
          const repositories = [...byId.values()]
            .filter((repo) => repo.permissions?.admin === true && typeof repo.full_name === 'string')
            .sort((a, b) => (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0))
            .map(pickerRow)
          return { repositories }
        } catch (e) {
          if (e instanceof GiteaConnectDenied) return denied(reply, e)
          if (e instanceof GiteaApiError) return upstream(reply, e, orgId, connection.id)
          throw e
        }
      }
    )

    r.get(
      '/gitea/repositories',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'List managed Gitea repositories',
          description:
            'The organization-owned repository bindings with their §5 lifecycle states and the managed webhook’s state.',
          operationId: 'listGiteaRepositories',
          response: { 200: GiteaRepositoryBindingListDto }
        }
      },
      async (req) => {
        const orgId = orgOf(req)
        const rows = await deps.repos.giteaRepositoryBinding.listForOrg(orgId)
        const wanted = await webhookWanted(orgId)
        return { bindings: rows.map((row) => bindingToDto(row, wanted(row.repoId))) }
      }
    )

    r.post(
      '/gitea/repositories',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Bind a Gitea repository',
          description:
            'Re-fetches the selected repository by numeric id through the organization’s connection, requires the bot to hold admin on it (§4.4), acquires the deployment-global repository claim, creates the binding in the provisioning state and runs the §6 saga: the managed webhook is installed when an enabled trigger wants ingress, tested, and the binding is ready — with the webhook_unverified warning when the relay never observed the test delivery.',
          operationId: 'createGiteaRepository',
          body: CreateGiteaRepositoryBody,
          response: {
            200: GiteaRepositoryBindingDto,
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
        const repoId = BigInt(req.body.repoId)
        const err = (status: 400 | 403 | 404 | 409, message: string) =>
          reply.code(status).send({ error: ERROR_NAMES[status], statusCode: status, message })
        const connection = await deps.repos.giteaConnection.forOrg(orgId)
        if (!connection) return err(404, 'this organization has no Gitea connection')
        if (connection.state !== 'connected') {
          return err(
            409,
            connection.state === 'token_rejected'
              ? 'the Gitea token was rejected — replace it first'
              : 'the Gitea connection is being removed'
          )
        }
        if (await deps.repos.giteaRepositoryBinding.byRepo(orgId, repoId)) {
          return err(409, 'repository is already bound in this organization')
        }
        try {
          const token = await gitea.connections.withToken(orgId, connection.id)
          // The server re-fetches; the client-supplied id is never trusted for facts (§6).
          const repo = await giteaRepositoryById(token, repoId, gitea.api)
          if (!repo) return err(400, 'repository is not accessible through this connection')
          if (repo.permissions?.admin !== true) {
            return err(
              403,
              `the bot ${connection.botUsername} must hold admin on ${repo.full_name} — grant it as a collaborator or through a team first`
            )
          }
          const binding = await deps.repos.giteaRepositoryBinding.createWithClaim({
            orgId,
            connectionId: connection.id,
            repoId,
            repoPath: repo.full_name,
            ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
            ...(repo.clone_url ? { cloneUrl: repo.clone_url } : {}),
            axisBaseUrl: gitea.api.baseUrl
          })
          await gitea.provisioner.provision(orgId, binding.id)
          const converged = await deps.repos.giteaRepositoryBinding.get(orgId, binding.id)
          const wanted = await webhookWanted(orgId)
          return bindingToDto(converged ?? binding, wanted(binding.repoId))
        } catch (e) {
          // The deployment-global claim: one managing organization per repository; never disclose WHICH.
          if (e instanceof GiteaRepositoryClaimConflict)
            return err(409, 'repository is already claimed by another organization')
          if (e instanceof GiteaConnectDenied) return denied(reply, e)
          if (e instanceof GiteaApiError) return upstream(reply, e, orgId, connection.id)
          throw e
        }
      }
    )

    r.post(
      '/gitea/repositories/:id/repair',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Repair a managed Gitea repository',
          description:
            'Re-runs the §6 convergence: refresh the repository facts, re-check the bot’s admin, and install or reconcile the managed webhook.',
          operationId: 'repairGiteaRepository',
          params: IdParam,
          response: { 200: GiteaRepositoryBindingDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const target = await deps.repos.giteaRepositoryBinding.get(orgId, req.params.id)
        if (!target) return notFound(reply, 'gitea repository')
        // Concurrent repairs JOIN one run instead of racing it for the same lease.
        await gitea.provisioner.convergeRepository(orgId, target.repoId, { attempts: REPAIR_CONTENTION_ATTEMPTS })
        const binding = await deps.repos.giteaRepositoryBinding.get(orgId, req.params.id)
        if (!binding) return notFound(reply, 'gitea repository')
        const wanted = await webhookWanted(orgId)
        return bindingToDto(binding, wanted(binding.repoId))
      }
    )

    r.post(
      '/gitea/repositories/:id/rotate-webhook-secret',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Rotate a managed Gitea webhook’s signing secret',
          description:
            'A webhook’s secret is set at creation only, so the key is rotated by replacing the webhook (§7): a successor is created under a sealed successor key with the full subscription, both keys reach the relays, the old webhook is deactivated and a test delivery is fired at the successor. The old webhook is deleted and the key promoted once the relay verifies one delivery under the successor — `promoted` reports whether that already happened.',
          operationId: 'rotateGiteaWebhookSecret',
          params: IdParam,
          response: { 200: GiteaWebhookRotationDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        if (!(await deps.repos.giteaRepositoryBinding.get(orgId, req.params.id)))
          return notFound(reply, 'gitea repository')
        const outcome = await gitea.provisioner.rotateWebhookSecret(orgId, req.params.id)
        return { rotated: outcome.rotated, promoted: outcome.promoted ?? false, reason: outcome.reason ?? null }
      }
    )

    r.delete(
      '/gitea/repositories/:id',
      {
        schema: {
          tags: [Tag.Gitea],
          summary: 'Unbind a managed Gitea repository',
          description:
            'Disables local authority, deletes the managed webhook by its recorded id and releases the deployment-global claim (§6). A rejected token parks the binding in cleanup_pending until a replacement token or a manual webhook removal clears it.',
          operationId: 'deleteGiteaRepository',
          params: IdParam,
          response: {
            200: z.object({
              removed: z.boolean(),
              state: GiteaRepositoryBindingDto.shape.state.optional(),
              stateReason: z.string().nullable().optional()
            }),
            403: ErrorDto,
            404: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        if (!(await deps.repos.giteaRepositoryBinding.get(orgId, req.params.id)))
          return notFound(reply, 'gitea repository')
        const outcome = await gitea.provisioner.disconnect(orgId, req.params.id)
        if (outcome.removed) return { removed: true }
        const binding = await deps.repos.giteaRepositoryBinding.get(orgId, req.params.id)
        return { removed: false, state: binding?.state, stateReason: binding?.stateReason ?? outcome.reason ?? null }
      }
    )
  }
}
