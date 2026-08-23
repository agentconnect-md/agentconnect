/**
 * `http/routes/agent-repos.ts` — explicit repository grants per agent
 * (issue #457, agent-multi-repo-authorization.md; gitlab-com-integration.md §8.3).
 *
 * Authorization is anchored on the AGENT (a grant is subordinate to it, like a
 * hook): reads gate on the owning agent's visibility, writes on
 * `denyViewerWrite` — the hook-route precedent for agent-subordinate resources.
 * The numeric repository id is resolved server-side, never client-supplied: github
 * resolves it through an org installation (create-time attribution proof, same as
 * github-hook creation) and gitlab through the org's own managed project binding.
 * With the identity-assertion gate configured, a github CALLER must hold the
 * corresponding permission on the repo (read/comment ⇒ ≥read, write ⇒ ≥write); the
 * gitlab arm's proof is the binding, whose creation already required the installing
 * user's Maintainer-or-Owner membership (§10.1).
 *
 * Authorizing a gitlab project makes the agent a CONSUMER of it (§7.2), so the arm
 * runs the same inline account/membership ensure the workspace and hook arms run,
 * and revoking converges the membership away.
 */
import { gitRepoLabel } from '@agentconnect.md/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import {
  isSyntheticEmail,
  type AgentRecord,
  type AgentRepoAuthorizationRecord,
  type RepoAccess
} from '../../persistence/ports.js'
import { AgentWorkspaceRepoConflict } from '../../persistence/errors.js'
import { GithubApiError } from '../../github/api.js'
import { gitlabAuthorizationAccessLevel } from '../../gitlab/api.js'
import { gitlabAccountUnavailableMessage } from '../../gitlab/account.service.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView } from '../../authorization/policy.js'
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
    provider: r.provider,
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
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(agentId))
      if (!agent || !canView(agent, ctxOf(req))) return null
      return agent
    }
    // Readers-first catalog convergence (gitlab-com-integration.md §8.1).
    const catalogGithubRepo = (
      orgId: string,
      ref: { repoId: bigint; fullName: string; defaultBranch: string }
    ): Promise<unknown> =>
      deps.repos.codeHostRepository.upsert({
        orgId,
        provider: 'github',
        externalId: ref.repoId,
        displayPath: ref.fullName,
        cloneUrl: `https://github.com/${ref.fullName}`,
        defaultBranch: ref.defaultBranch
      })
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
      await catalogGithubRepo(agent.orgId, ref)
      if (await deps.repos.agent.setWorkspaceRepoId(agent.id, ref.repoId)) return ref.repoId
      return (await deps.repos.agent.get(agent.orgId, agent.id))?.workspaceRepoId
    }
    const agentNotFound = (reply: FastifyReply) =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })

    // A grant rides `AgentSpec.workspace.additionalRepos`, so authorizing or revoking
    // one is a spec edit. Re-read the agent (the repo advanced its configRevision in
    // the same transaction) and push, exactly as the agents route's replicateUpsert.
    // Best-effort: the register/ok reconcile roster is the backstop.
    const replicateUpsert = async (agent: AgentRecord): Promise<void> => {
      const fresh = await deps.repos.agent.get(agent.orgId, agent.id)
      if (!fresh) return
      await deps.agentDelivery.upsert(fresh, (err, daemonId) => {
        if (err instanceof NoConnection) {
          app.log.debug({ agentId: agent.id, daemonId }, 'agent/upsert skipped: daemon offline')
        } else {
          app.log.warn(
            { err, agentId: agent.id, daemonId },
            'agent/upsert live reconcile failed (backstop: reconnect roster)'
          )
        }
      })
    }

    // Authorization changed who consumes the project, so the §7.2 accounts and
    // memberships must reconverge — the same kick a gitlab workspace or hook write
    // does. Fire-and-forget: the saga outwaits a peer's lease on its own.
    const convergeGitlabProject = (orgId: string, projectId: bigint): void => {
      const gitlab = deps.gitlab
      if (!gitlab) return
      void gitlab.provisioner
        .convergeProject(OrgId(orgId), projectId)
        .catch((err) => app.log.warn({ err, projectId: projectId.toString() }, 'gitlab authorization converge failed'))
    }

    /** The gitlab arm of `POST /agents/:agentId/repos` (§8.3). */
    const authorizeGitlabProject = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord,
      body: { projectId: string; access: RepoAccess }
    ): Promise<AgentRepoAuthDtoT | undefined> => {
      const conflict = (message: string): undefined => {
        void reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
      }
      const gitlab = deps.gitlab
      if (!gitlab) return conflict('GitLab is not configured on this deployment')
      const orgId = orgOf(req)
      const projectId = BigInt(body.projectId)
      // A grant never creates a binding, exactly as a hook never does (§8.3): the
      // numeric id is validated against the organization's own row, never trusted.
      const binding = await deps.repos.gitlabProjectBinding.byProject(orgId, projectId)
      if (!binding || binding.state === 'cleanup_pending') {
        return conflict('the project is not a managed GitLab project in this organization')
      }
      if (agent.workspace.mode === 'gitlab' && agent.workspaceRepoId === projectId) {
        return conflict('this is already the agent’s workspace project')
      }
      const held = await deps.repos.agentRepoAuth.listForAgent(agent.id)
      if (held.some((row) => row.provider === 'gitlab' && row.repoId === projectId)) {
        return conflict(
          `${binding.projectPath} is already authorized for this agent — upgrade that grant or remove it to lower the tier`
        )
      }
      // The path comes from the provider's answer INSIDE the lease, never from the
      // binding read above: a rename between the two would otherwise persist and
      // replicate the losing side, leaving the daemon unable to map the checkout.
      const create = (live: { projectPath: string }): Promise<AgentRepoAuthorizationRecord> =>
        deps.repos.agentRepoAuth.create({
          agentId: agent.id,
          provider: 'gitlab',
          repoId: projectId,
          repoFullName: live.projectPath,
          access: body.access,
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
      // §7.2 identity bracket, exactly as the workspace and hook arms take it: the
      // agent's own account and membership are provisioned FIRST and the grant row
      // commits while the binding lease is still HELD, so convergence never sees a
      // membership without the authorization that justifies it.
      let applied
      try {
        applied = await gitlab.provisioner.provisionAgentAccount(
          orgId,
          projectId,
          { agentId: agent.id, accessLevel: gitlabAuthorizationAccessLevel(body.access) },
          create
        )
      } catch (err) {
        // The grant rolled back, so the membership just bound belongs to an agent
        // that does not consume the project: converge it away.
        convergeGitlabProject(orgId, projectId)
        throw err
      }
      if (!applied.ok) return conflict(gitlabAccountUnavailableMessage(applied.reason))
      const row = applied.result
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId,
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message: `gitlab project ${row.repoFullName} authorized (${row.access})`,
          details: { repoAuthId: row.id, provider: 'gitlab', repoFullName: row.repoFullName, access: row.access }
        })
        .catch(() => {})
      await replicateUpsert(agent)
      return toDto(row)
    }

    /** The gitlab arm of `PATCH /agents/:agentId/repos/:repoAuthId`: raising the tier
     *  raises the account's project role, so it re-runs the same ensure the grant took. */
    const upgradeGitlabAuthorization = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord,
      row: AgentRepoAuthorizationRecord,
      access: RepoAccess
    ): Promise<AgentRepoAuthDtoT | undefined> => {
      const conflict = (message: string): undefined => {
        void reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
      }
      const gitlab = deps.gitlab
      if (!gitlab) return conflict('GitLab is not configured on this deployment')
      const orgId = orgOf(req)
      const binding = await deps.repos.gitlabProjectBinding.byProject(orgId, row.repoId)
      if (!binding || binding.state === 'cleanup_pending') {
        return conflict('the project is not a managed GitLab project in this organization')
      }
      const applied = await gitlab.provisioner.provisionAgentAccount(
        orgId,
        row.repoId,
        { agentId: agent.id, accessLevel: gitlabAuthorizationAccessLevel(access) },
        // Access-only: the row's path is converged by the same lease's fact sync.
        () => deps.repos.agentRepoAuth.updateAccess(row.id, access)
      )
      if (!applied.ok) return conflict(gitlabAccountUnavailableMessage(applied.reason))
      const updated = applied.result
      if (!updated) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        return undefined
      }
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId,
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message: `gitlab project ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
          details: {
            repoAuthId: updated.id,
            provider: 'gitlab',
            repoFullName: updated.repoFullName,
            previousAccess: row.access,
            access: updated.access
          }
        })
        .catch(() => {})
      return toDto(updated)
    }

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
            'Grant the agent access to one code-host repository. With `provider: github` (the default) the repository is named `owner/repo` and must be covered by one of the organization’s GitHub App installations; App-backed workspaces may add repositories beyond their implicit workspace grant, scratch workspaces may add any covered repository, and a manual GitHub workspace may explicitly authorize only its own repository for control-plane review/check effects. With the per-user gate configured, the caller must hold the matching GitHub permission (`read`/`comment` tiers need read, `write` needs write). With `provider: gitlab` the project is named by its numeric id and must already be a managed GitLab project in this organization; authorizing it provisions the agent’s own GitLab bot account and project membership before the grant lands.',
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
        if (req.body.provider === 'gitlab') return authorizeGitlabProject(req, reply, agent, req.body)
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
          await catalogGithubRepo(agent.orgId, ref)
          const workspaceRepoId =
            agent.workspace.mode === 'github' && !manualWorkspace ? await ensureWorkspaceRepoId(agent) : undefined
          if (workspaceRepoId === ref.repoId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'this is already the agent’s workspace repository'
            })
          }
          // Provider-qualified: a GitLab project numbered the same is a different
          // repository, and the unique key permits both (§8.1).
          if (
            (await deps.repos.agentRepoAuth.listForAgent(agent.id)).some(
              (row) => row.provider === 'github' && row.repoId === ref.repoId
            )
          ) {
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
            provider: 'github',
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
          await replicateUpsert(agent)
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
        if (row.provider === 'gitlab') return upgradeGitlabAuthorization(req, reply, agent, row, req.body.access)

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
        // The workspace is redundant with this grant only when it is the SAME host's
        // repository: the two number theirs independently (§8.1).
        const redundantWorkspaceGrant = workspaceRepoId === row.repoId && agent.workspace.mode === row.provider
        const now = new Date()
        // Persist one-way cleanup authority and drop the grant atomically under
        // the projection lifecycle lock. Deleting first could leave a passing
        // Check that the normal reporter is no longer authorized to clean up.
        await deps.repos.agentRepoAuth.removeWithReviewProjectionCleanup(
          row.id,
          agent.id,
          row.provider,
          row.repoId,
          now,
          'failure'
        )
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
            details: {
              repoAuthId: row.id,
              provider: row.provider,
              repoFullName: row.repoFullName,
              redundantWorkspaceGrant
            }
          })
          .catch(() => {})
        // Revoked authorization ⇒ the agent is no longer a consumer, so the §7.2
        // membership must go — and with nothing left in its root, the account retires.
        if (row.provider === 'gitlab' && !redundantWorkspaceGrant) convergeGitlabProject(orgOf(req), row.repoId)
        await replicateUpsert(agent)
        return reply.code(204).send(null)
      }
    )
  }
}
