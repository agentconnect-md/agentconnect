/**
 * `http/routes/agent-repos.ts` — explicit repo grants per agent
 * (issue #457, agent-multi-repo-authorization.md).
 *
 * Authorization is anchored on the AGENT (a grant is subordinate to it, like a
 * hook): reads gate on the owning agent's visibility, writes on
 * `denyViewerWrite` — the hook-route precedent for agent-subordinate resources.
 * The numeric repo id is resolved server-side through an org installation
 * (create-time attribution proof, same as github-hook creation); with the
 * identity-assertion gate configured, the CALLER must hold the corresponding
 * GitHub permission on the repo (read/comment ⇒ ≥read, write ⇒ ≥write).
 */
import { gitRepoLabel } from '@agentconnect.md/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { isSyntheticEmail, type AgentRecord, type AgentRepoAuthorizationRecord } from '../../persistence/ports.js'
import { AgentWorkspaceRepoConflict } from '../../persistence/errors.js'
import { GithubApiError } from '../../github/api.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView } from '../visibility.js'
import { Tag } from '../plugins/openapi.js'
import {
  AgentRepoAuthDto,
  AgentRepoAuthListDto,
  AgentRepoAuthParam,
  CreateAgentRepoAuthBody,
  ErrorDto,
  UpdateAgentRepoAuthBody,
  type AgentRepoAuthDtoT
} from '../dto/index.js'

function toDto(r: AgentRepoAuthorizationRecord): AgentRepoAuthDtoT {
  return {
    id: r.id,
    repoId: r.repoId.toString(),
    repoFullName: r.repoFullName,
    access: r.access,
    createdBy: r.createdBy && !isSyntheticEmail(r.createdBy.email) ? r.createdBy.userId : null,
    createdAt: r.createdAt.toISOString()
  }
}

export function agentRepoRoutes(deps: HttpDeps) {
  return async function agentRepoRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Same no-oracle rule as `GET /agents/:agentId/hooks`: cross-org, unknown,
    // and not-viewable agents all read 404.
    const getViewableAgent = async (req: FastifyRequest, agentId: string): Promise<AgentRecord | null> => {
      const agent = await deps.repos.agent.get(AgentId(agentId))
      if (!agent || agent.orgId !== orgOf(req) || !canView(agent, ctxOf(req))) return null
      return agent
    }
    /** Lazily pin a legacy github workspace to its rename-proof numeric id.
     * PgAgentRepo performs the pin and redundant-grant cleanup atomically under
     * the shared (agent, repo) projection lock. */
    const ensureWorkspaceRepoId = async (agent: AgentRecord): Promise<bigint | undefined> => {
      if (agent.workspaceRepoId !== undefined) return agent.workspaceRepoId
      if (agent.workspace.mode !== 'github' || agent.workspace.installationId === undefined || !deps.github)
        return undefined
      const workspaceLabel = gitRepoLabel(agent.workspace.gitRepo)
      const [owner, repo] = workspaceLabel.split('/')
      if (!owner || !repo) return undefined
      const installation = await deps.repos.githubInstallation.liveByOrgAndAccount(agent.orgId, owner)
      if (!installation || installation.suspendedAt) return undefined
      const ref = await deps.github.repoRefFor(installation, owner, repo)
      if (!ref) return undefined
      if (await deps.repos.agent.setWorkspaceRepoId(agent.id, ref.repoId)) return ref.repoId
      return (await deps.repos.agent.get(agent.id))?.workspaceRepoId
    }
    const agentNotFound = (reply: FastifyReply) =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })

    r.get(
      '/agents/:agentId/repos',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s repository authorizations',
          description:
            'Explicit GitHub repository grants for this agent. An App-backed workspace repo is implicit and not listed; scratch workspaces may grant any covered repository, while a manual GitHub workspace may explicitly grant only its own repo for review/check effects. Gated by the agent’s visibility.',
          operationId: 'listAgentRepoAuthorizations',
          params: z.object({ agentId: z.string() }),
          response: { 200: AgentRepoAuthListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getViewableAgent(req, req.params.agentId)
        if (!agent) return agentNotFound(reply)
        const rows = await deps.repos.agentRepoAuth.listForAgent(agent.id)
        return rows.map(toDto)
      }
    )

    r.post(
      '/agents/:agentId/repos',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Authorize a repository for an agent',
          description:
            'Grant the agent access to a GitHub repository. App-backed workspaces may add repositories beyond their implicit workspace grant, scratch workspaces may add any covered repository, and a manual GitHub workspace may explicitly authorize only its own repository for control-plane review/check effects. The repository must be covered by one of the organization’s GitHub App installations; with the per-user gate configured, the caller must hold the matching GitHub permission (`read`/`comment` tiers need read, `write` needs write).',
          operationId: 'createAgentRepoAuthorization',
          params: z.object({ agentId: z.string() }),
          body: CreateAgentRepoAuthBody,
          response: {
            200: AgentRepoAuthDto,
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
        const agent = await getViewableAgent(req, req.params.agentId)
        if (!agent) return agentNotFound(reply)
        if (!deps.github) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'GitHub App is not configured on this deployment (GITHUB_APP_*)'
          })
        }
        // Scratch has no implicit repository, so every GitHub repo is an
        // explicit grant. A manual GitHub workspace stays the narrow exception:
        // it may grant only its own repo for CP-owned review/check effects.
        const manualWorkspace = agent.workspace.mode === 'github' && agent.workspace.installationId === undefined
        if (
          manualWorkspace &&
          agent.workspace.mode === 'github' &&
          gitRepoLabel(agent.workspace.gitRepo).toLowerCase() !== req.body.repoFullName.toLowerCase()
        ) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'a manual GitHub workspace can authorize only its workspace repository'
          })
        }
        const [owner, repo] = req.body.repoFullName.split('/')
        if (!owner || !repo) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'expected "owner/repo"' })
        }
        const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(OrgId(orgOf(req)), owner)
        if (!ins || ins.suspendedAt) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: "repository is not covered by one of this organization's GitHub App installations"
          })
        }
        try {
          // Resolution through the installation's own metadata token IS the
          // attribution proof (out-of-grant reads 404 ⇒ null) — and pins the
          // rename-immune numeric id the mint gate matches on.
          const ref = await deps.github.repoRefFor(ins, owner, repo)
          if (!ref) {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: "repository is not covered by one of this organization's GitHub App installations"
            })
          }
          const workspaceRepoId =
            agent.workspace.mode === 'github' && !manualWorkspace ? await ensureWorkspaceRepoId(agent) : undefined
          if (workspaceRepoId === ref.repoId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'this is already the agent’s workspace repository'
            })
          }
          if ((await deps.repos.agentRepoAuth.listForAgent(agent.id)).some((row) => row.repoId === ref.repoId)) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: `${ref.fullName} is already authorized for this agent — upgrade that grant or remove it to lower the tier`
            })
          }
          // Identity assertion (open question #7 gate, when configured): the AUTHORIZER
          // must hold the permission the tier implies. `comment` maps to read —
          // commenting is a read-level social action on GitHub; the App-widened
          // issues:write delta is the design's documented, accepted semantics.
          if (deps.githubUserAuthz) {
            await deps.githubUserAuthz.assertAccess(
              req.principal!.userId,
              ins,
              owner,
              repo,
              req.body.access === 'write' ? 'write' : 'read'
            )
          }
          const row = await deps.repos.agentRepoAuth.create({
            agentId: agent.id,
            repoId: ref.repoId,
            repoFullName: ref.fullName,
            access: req.body.access,
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          void deps.repos.audit
            .append({
              kind: 'agent_repo_change',
              orgId: orgOf(req),
              agentId: agent.id,
              ...(req.principal ? { actorUserId: req.principal.userId } : {}),
              frameType: 'gitcred/grant',
              message: `repo ${row.repoFullName} authorized (${row.access})`,
              details: { repoAuthId: row.id, repoFullName: row.repoFullName, access: row.access }
            })
            .catch(() => {})
          return toDto(row)
        } catch (e) {
          if (e instanceof UserAuthzDeniedError) {
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message, code: e.code })
          }
          if (e instanceof GithubApiError) {
            const status = e.code === 'RATE_LIMITED' ? 429 : 502
            return reply.code(status).send({
              error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
              statusCode: status,
              message: `github: ${e.message}`
            })
          }
          if (e instanceof LogtoApiError) {
            // Identity leg down ⇒ fail closed, surfaced as retryable upstream trouble.
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
          }
          if (e instanceof AgentWorkspaceRepoConflict) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'this is already the agent’s workspace repository'
            })
          }
          throw e
        }
      }
    )

    r.patch(
      '/agents/:agentId/repos/:repoAuthId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Upgrade a repository authorization',
          description:
            'Raise an existing repository grant to a stronger access tier after re-checking the caller’s matching GitHub permission. Downgrades still require revoke and reauthorize so review-check cleanup remains explicit.',
          operationId: 'updateAgentRepoAuthorization',
          params: AgentRepoAuthParam,
          body: UpdateAgentRepoAuthBody,
          response: {
            200: AgentRepoAuthDto,
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
        const agent = await getViewableAgent(req, req.params.agentId)
        if (!agent) return agentNotFound(reply)
        const row = await deps.repos.agentRepoAuth.get(req.params.repoAuthId)
        if (!row || row.agentId !== agent.id) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        }
        const rank = { read: 0, comment: 1, write: 2 } as const
        if (rank[req.body.access] < rank[row.access]) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'revoke and reauthorize this repository to lower its access tier'
          })
        }
        if (req.body.access === row.access) return toDto(row)

        const [owner, repo] = row.repoFullName.split('/')
        const installation = owner
          ? await deps.repos.githubInstallation.liveByOrgAndAccount(OrgId(orgOf(req)), owner)
          : null
        if (!owner || !repo || !installation || installation.suspendedAt) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'repository is not covered by a live GitHub App installation'
          })
        }
        try {
          if (deps.githubUserAuthz) {
            await deps.githubUserAuthz.assertAccess(
              req.principal!.userId,
              installation,
              owner,
              repo,
              req.body.access === 'write' ? 'write' : 'read'
            )
          }
          const updated = await deps.repos.agentRepoAuth.updateAccess(row.id, req.body.access)
          if (!updated) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
          }
          void deps.repos.audit
            .append({
              kind: 'agent_repo_change',
              orgId: orgOf(req),
              agentId: agent.id,
              ...(req.principal ? { actorUserId: req.principal.userId } : {}),
              frameType: 'gitcred/grant',
              message: `repo ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
              details: {
                repoAuthId: updated.id,
                repoFullName: updated.repoFullName,
                previousAccess: row.access,
                access: updated.access
              }
            })
            .catch(() => {})
          return toDto(updated)
        } catch (e) {
          if (e instanceof UserAuthzDeniedError) {
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message, code: e.code })
          }
          if (e instanceof GithubApiError) {
            const status = e.code === 'RATE_LIMITED' ? 429 : 502
            return reply.code(status).send({
              error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
              statusCode: status,
              message: `github: ${e.message}`
            })
          }
          if (e instanceof LogtoApiError) {
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
          }
          throw e
        }
      }
    )

    r.delete(
      '/agents/:agentId/repos/:repoAuthId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Revoke a repository authorization',
          description:
            'Atomically retire existing informational Checks to a non-passing cleanup state and remove the grant. A legacy grant that resolves to the still-authorized workspace repository is removed without retiring its Checks. Already-minted tokens live out their ≤1h expiry (the documented revocation window); the next credential request for a genuinely additional repo is denied.',
          operationId: 'deleteAgentRepoAuthorization',
          params: AgentRepoAuthParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await getViewableAgent(req, req.params.agentId)
        if (!agent) return agentNotFound(reply)
        const row = await deps.repos.agentRepoAuth.get(req.params.repoAuthId)
        if (!row || row.agentId !== agent.id) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        }
        let workspaceRepoId: bigint | undefined
        try {
          workspaceRepoId = await ensureWorkspaceRepoId(agent)
        } catch (e) {
          if (e instanceof GithubApiError) {
            const status = e.code === 'RATE_LIMITED' ? 429 : 502
            return reply.code(status).send({
              error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
              statusCode: status,
              message: `github: ${e.message}`
            })
          }
          throw e
        }
        const redundantWorkspaceGrant = workspaceRepoId === row.repoId
        const now = new Date()
        // Persist one-way cleanup authority and drop the grant atomically under
        // the projection lifecycle lock. Deleting first could leave a passing
        // Check that the normal reporter is no longer authorized to clean up.
        await deps.repos.agentRepoAuth.removeWithReviewProjectionCleanup(row.id, agent.id, row.repoId, now, 'failure')
        void deps.repos.audit
          .append({
            kind: 'agent_repo_change',
            orgId: orgOf(req),
            agentId: agent.id,
            ...(req.principal ? { actorUserId: req.principal.userId } : {}),
            frameType: 'gitcred/grant',
            message: redundantWorkspaceGrant
              ? `redundant workspace repo ${row.repoFullName} authorization removed`
              : `repo ${row.repoFullName} authorization revoked`,
            details: { repoAuthId: row.id, repoFullName: row.repoFullName, redundantWorkspaceGrant }
          })
          .catch(() => {})
        return reply.code(204).send(null)
      }
    )
  }
}
