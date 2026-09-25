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
 *
 * Installation grants (decision 10) live here too: organization-owner writes, no per-repository attestation.
 */
import { gitRepoLabel, type CodeHostProvider } from '@agentconnect.md/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import {
  isSyntheticEmail,
  type AgentInstallationAuthorizationRecord,
  type AgentRecord,
  type AgentRepoAuthorizationRecord,
  type RepoAccess,
  type RepoMaterialization
} from '../../persistence/ports.js'
import {
  AgentRepoIntegrationConflict,
  AgentWorkspaceRepoConflict,
  GiteaBindingUnavailable
} from '../../persistence/errors.js'
import { GithubApiError } from '../../github/api.js'
import { GiteaApiError } from '../../gitea/api.js'
import { GiteaConnectDenied } from '../../gitea/connection.service.js'
import { gitlabAuthorizationAccessLevel } from '../../gitlab/api.js'
import { gitlabAccountUnavailableMessage } from '../../gitlab/account.service.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { orgOf, denyViewerWrite, denyNonOwner, ctxOf } from '../rbac.js'
import { canView } from '../../authorization/policy.js'
import { decisionMaterializeRefusal } from '../repository-selection.js'
import { accessBelow } from '../../domain/repo-access.js'
import { codeHostsOf } from '../../codehost/registry.js'
import { Tag } from '../plugins/openapi.js'
import { isCanonicalGithubAddress } from '../../domain/git-host.js'
import {
  AgentInstallationAuthDto,
  AgentInstallationAuthListDto,
  AgentInstallationAuthParam,
  AgentRepoAuthDto,
  AgentRepoAuthListDto,
  AgentRepoAuthParam,
  CreateAgentInstallationAuthBody,
  CreateAgentRepoAuthBody,
  ErrorDto,
  UpdateAgentInstallationAuthBody,
  UpdateAgentRepoAuthBody,
  type AgentInstallationAuthDtoT,
  type AgentRepoAuthDtoT
} from '../dto/index.js'

function installationGrantToDto(g: AgentInstallationAuthorizationRecord): AgentInstallationAuthDtoT {
  return {
    id: g.id,
    provider: g.provider,
    installationId: Number(g.installationId),
    accountLogin: g.accountLogin,
    access: g.access,
    materialize: g.materialize,
    createdBy: g.createdBy && !isSyntheticEmail(g.createdBy.email) ? g.createdBy.userId : null,
    createdAt: g.createdAt.toISOString()
  }
}

function toDto(r: AgentRepoAuthorizationRecord): AgentRepoAuthDtoT {
  return {
    id: r.id,
    provider: r.provider,
    repoId: r.repoId.toString(),
    repoFullName: r.repoFullName,
    access: r.access,
    materialize: r.materialize,
    createdBy: r.createdBy && !isSyntheticEmail(r.createdBy.email) ? r.createdBy.userId : null,
    createdAt: r.createdAt.toISOString()
  }
}

export function agentRepoRoutes(deps: HttpDeps) {
  return async function agentRepoRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const codeHosts = codeHostsOf(deps)

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
      if (agent.workspace.mode !== 'git' || agent.workspace.credential?.provider !== 'github' || !deps.github)
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
    // Marking a row or grant `decision` needs the agent's selector and daemons that run it (multi-repository-workspaces.md decision 18).
    const refuseDecisionMaterialize = async (
      reply: FastifyReply,
      agent: AgentRecord,
      materialize: RepoMaterialization | undefined,
      current?: RepoMaterialization
    ): Promise<boolean> => {
      if (materialize !== 'decision' || current === 'decision') return false
      const refusal = await decisionMaterializeRefusal(deps, agent)
      if (!refusal) return false
      void reply.code(409).send({ error: 'Conflict', statusCode: 409, message: refusal.message, code: refusal.code })
      return true
    }

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

    // Authorization changed who consumes the repository, so whatever the host binds
    // per consumer must reconverge — the same kick a workspace or hook write does
    // (a no-op where the host binds nothing). Fire-and-forget: a host's own saga
    // outwaits a peer's lease.
    const convergeManagedRepository = (provider: CodeHostProvider, orgId: string, repoId: bigint): void => {
      codeHosts[provider].hooks.convergeManagedRepository(deps, OrgId(orgId), repoId, (err) =>
        app.log.warn({ err, projectId: repoId.toString() }, `${provider} authorization converge failed`)
      )
    }

    /** The gitlab arm of `POST /agents/:agentId/repos` (§8.3). */
    const authorizeGitlabProject = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord,
      body: { projectId: string; access: RepoAccess; materialize: RepoMaterialization }
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
      if (
        agent.workspace.mode === 'git' &&
        agent.workspace.credential?.provider === 'gitlab' &&
        agent.workspaceRepoId === projectId
      ) {
        return conflict('this is already the agent’s workspace project')
      }
      const held = await deps.repos.agentRepoAuth.listForAgent(agent.id)
      if (held.some((row) => row.provider === 'gitlab' && row.repoId === projectId)) {
        return conflict(
          `${binding.projectPath} is already authorized for this agent — change that grant’s tier instead`
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
          materialize: body.materialize,
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
        convergeManagedRepository('gitlab', orgId, projectId)
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
          message: `gitlab project ${row.repoFullName} authorized (${row.access}, ${row.materialize})`,
          details: {
            repoAuthId: row.id,
            provider: 'gitlab',
            repoFullName: row.repoFullName,
            access: row.access,
            materialize: row.materialize
          }
        })
        .catch(() => {})
      await replicateUpsert(agent)
      return toDto(row)
    }

    const ERROR_NAMES = {
      400: 'Bad Request',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      429: 'Too Many Requests',
      502: 'Bad Gateway'
    } as const

    /** The gitea arm of `POST /agents/:agentId/repos` (gitea-integration.md §5, §6): the binding vouches — bound on first use — and the tier is a local clamp. */
    const authorizeGiteaRepository = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord,
      body: { repoId: string; access: RepoAccess; materialize: RepoMaterialization }
    ): Promise<AgentRepoAuthDtoT | undefined> => {
      const refused = (status: 400 | 403 | 404 | 409 | 429 | 502, message: string): undefined => {
        void reply.code(status).send({ error: ERROR_NAMES[status], statusCode: status, message })
      }
      const conflict = (message: string): undefined => refused(409, message)
      if (!deps.gitea) return conflict('Gitea is not configured on this deployment')
      const orgId = orgOf(req)
      const repoId = BigInt(body.repoId)
      if (
        agent.workspace.mode === 'git' &&
        agent.workspace.credential?.provider === 'gitea' &&
        agent.workspaceRepoId === repoId
      ) {
        return conflict('this is already the agent’s workspace repository')
      }
      let binding
      try {
        // The grant is the consumer that binds the repository when nothing else has (§6).
        binding = (await deps.gitea.bindings.ensureBound(orgId, repoId)).binding
      } catch (e) {
        if (e instanceof GiteaConnectDenied) return refused(e.status, e.message)
        if (e instanceof GiteaApiError) return refused(e.code === 'RATE_LIMITED' ? 429 : 502, `gitea: ${e.message}`)
        throw e
      }
      const held = await deps.repos.agentRepoAuth.listForAgent(agent.id)
      if (held.some((row) => row.provider === 'gitea' && row.repoId === repoId)) {
        return conflict(`${binding.repoPath} is already authorized for this agent — change that grant’s tier instead`)
      }
      let row: AgentRepoAuthorizationRecord
      try {
        row = await deps.repos.agentRepoAuth.create({
          agentId: agent.id,
          provider: 'gitea',
          repoId,
          repoFullName: binding.repoPath,
          access: body.access,
          materialize: body.materialize,
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
      } catch (e) {
        // The binding fence (§6): the repository was removed while this grant was in flight.
        if (e instanceof GiteaBindingUnavailable) return conflict(e.message)
        throw e
      }
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId,
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message: `gitea repository ${row.repoFullName} authorized (${row.access}, ${row.materialize})`,
          details: {
            repoAuthId: row.id,
            provider: 'gitea',
            repoFullName: row.repoFullName,
            access: row.access,
            materialize: row.materialize
          }
        })
        .catch(() => {})
      // The grant is a consumer: the spec carries the host from here on (gitea-integration.md §11).
      convergeManagedRepository('gitea', orgId, repoId)
      await replicateUpsert(agent)
      return toDto(row)
    }

    // Lowering asks no host permission; the repository refuses it while an enabled GitHub review or Checks hook needs the tier.
    const lowerRepoAuthorization = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agent: AgentRecord,
      row: AgentRepoAuthorizationRecord,
      access: RepoAccess
    ): Promise<AgentRepoAuthDtoT | undefined> => {
      let updated: AgentRepoAuthorizationRecord | null
      try {
        updated = await deps.repos.agentRepoAuth.updateAccess(row.id, access)
      } catch (e) {
        if (!(e instanceof AgentRepoIntegrationConflict)) throw e
        void reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message, code: e.code })
        return undefined
      }
      if (!updated) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        return undefined
      }
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId: orgOf(req),
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message: `repo ${updated.repoFullName} authorization lowered (${row.access} → ${updated.access})`,
          details: {
            repoAuthId: updated.id,
            provider: updated.provider,
            repoFullName: updated.repoFullName,
            previousAccess: row.access,
            access: updated.access
          }
        })
        .catch(() => {})
      // A host that binds a per-consumer role (GitLab) re-derives it from the lowered tier, as on revoke.
      convergeManagedRepository(row.provider, orgOf(req), row.repoId)
      return toDto(updated)
    }

    r.get(
      '/agents/:agentId/repos',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s repository authorizations',
          description:
            'Explicit code-host repository grants for this agent, each with its access tier and `materialize` choice (`always` clones it as a secondary workspace root, `on-demand` grants credentials only). An App-backed workspace repo is implicit and not listed; scratch workspaces may grant any covered repository, while a manual GitHub workspace may explicitly grant only its own repo for review/check effects. Gated by the agent’s visibility.',
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
            'Grant the agent access to one code-host repository. With `provider: github` (the default) the repository is named `owner/repo` and must be covered by one of the organization’s GitHub App installations; App-backed workspaces may add repositories beyond their implicit workspace grant, scratch workspaces may add any covered repository, and a manual GitHub workspace may explicitly authorize only its own repository for control-plane review/check effects. With the per-user gate configured, the caller must hold the matching GitHub permission (`read`/`comment` tiers need read, `write` needs write). With `provider: gitlab` the project is named by its numeric id and must already be a managed GitLab project in this organization; authorizing it provisions the agent’s own GitLab bot account and project membership before the grant lands. With `provider: gitea` the repository is named by its numeric id and must already be a managed Gitea repository in this organization; the organization’s bot token serves every tier, so the tier is a clamp on what the agent may do, never a provider role. `materialize` chooses how sessions stand in the repository: `always` (the default) clones it as a secondary workspace root on every session, `on-demand` grants credentials only and the agent clones during the turn, and `decision` makes it a candidate the per-session repository selector may check out. `decision` needs the agent’s `repositorySelector` (409 `REPOSITORY_SELECTOR_MISSING` otherwise) and daemons serving the agent that advertise `repo-selector-v1` (409 `DAEMON_FEATURE_MISSING` otherwise).',
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
        if (await refuseDecisionMaterialize(reply, agent, req.body.materialize)) return
        if (req.body.provider === 'gitlab') return authorizeGitlabProject(req, reply, agent, req.body)
        if (req.body.provider === 'gitea') return authorizeGiteaRepository(req, reply, agent, req.body)
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
        // A manual workspace is an anonymous GITHUB checkout: the own-repo exception
        // exists for CP-owned review/check effects, which only github.com carries.
        // Anonymous checkouts on other hosts behave like scratch — explicit grants only.
        const manualWorkspace =
          agent.workspace.mode === 'git' &&
          agent.workspace.credential === undefined &&
          isCanonicalGithubAddress(agent.workspace.gitRepo)
        if (
          manualWorkspace &&
          agent.workspace.mode === 'git' &&
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
          // Only a github-vouched workspace's numeric id may collide with a GitHub
          // repo id — the hosts number theirs independently (§8.1).
          const workspaceRepoId =
            agent.workspace.mode === 'git' && agent.workspace.credential?.provider === 'github'
              ? await ensureWorkspaceRepoId(agent)
              : undefined
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
              message: `${ref.fullName} is already authorized for this agent — change that grant’s tier instead`
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
            materialize: req.body.materialize,
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          void deps.repos.audit
            .append({
              kind: 'agent_repo_change',
              orgId: orgOf(req),
              agentId: agent.id,
              ...(req.principal ? { actorUserId: req.principal.userId } : {}),
              frameType: 'gitcred/grant',
              message: `repo ${row.repoFullName} authorized (${row.access}, ${row.materialize})`,
              details: {
                repoAuthId: row.id,
                repoFullName: row.repoFullName,
                access: row.access,
                materialize: row.materialize
              }
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
          summary: 'Update a repository authorization',
          description:
            'Change an existing repository grant’s access tier, how the repository is materialized (`materialize`: `always`, `decision` or `on-demand`; `decision` needs the agent’s `repositorySelector` and daemons serving the agent that advertise `repo-selector-v1`, else 409 with `REPOSITORY_SELECTOR_MISSING` or `DAEMON_FEATURE_MISSING`), or both. At least one field is required. Raising the tier re-checks the caller’s matching GitHub permission. Lowering it needs no permission and is refused with 409 `AGENT_REPO_INTEGRATION_CONFLICT` while an enabled GitHub integration on the repository still needs the tier for pull request reviews or Checks; the next credential request is served at the lower tier, and already-minted tokens live out their expiry of at most one hour, as on revoke. `materialize` moves freely and re-projects the agent’s spec.',
          operationId: 'updateAgentRepoAuthorization',
          params: AgentRepoAuthParam,
          body: UpdateAgentRepoAuthBody,
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
        const row = await deps.repos.agentRepoAuth.get(req.params.repoAuthId)
        if (!row || row.agentId !== agent.id) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        }
        if (await refuseDecisionMaterialize(reply, agent, req.body.materialize, row.materialize)) return
        let dto = toDto(row)
        // Access first, so a denied tier leaves the row untouched; what raising means is the host's.
        if (req.body.access !== undefined && req.body.access !== row.access) {
          const changed = accessBelow(req.body.access, row.access)
            ? await lowerRepoAuthorization(req, reply, agent, row, req.body.access)
            : await codeHosts[row.provider].upgradeRepoAuthorization({
                deps,
                req,
                reply,
                orgId: orgOf(req),
                agent,
                row,
                access: req.body.access,
                toDto
              })
          if (!changed) return
          dto = changed
        }
        // Materialization is projected onto the spec, so the repo bumps the revision and the agent is re-pushed.
        if (req.body.materialize !== undefined && req.body.materialize !== row.materialize) {
          const updated = await deps.repos.agentRepoAuth.updateMaterialize(row.id, req.body.materialize)
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
              message: `repo ${updated.repoFullName} materialization changed (${row.materialize} → ${updated.materialize})`,
              details: {
                repoAuthId: updated.id,
                provider: updated.provider,
                repoFullName: updated.repoFullName,
                previousMaterialize: row.materialize,
                materialize: updated.materialize
              }
            })
            .catch(() => {})
          await replicateUpsert(agent)
          dto = toDto(updated)
        }
        return dto
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
        const redundantWorkspaceGrant =
          workspaceRepoId === row.repoId &&
          agent.workspace.mode === 'git' &&
          agent.workspace.credential?.provider === row.provider
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
        if (!redundantWorkspaceGrant) convergeManagedRepository(row.provider, orgOf(req), row.repoId)
        await replicateUpsert(agent)
        return reply.code(204).send(null)
      }
    )

    // ── installation grants (agent-multi-repo-authorization.md decision 10) ──

    // Writes need an editor of the agent who is an organization owner; a hidden agent still reads 404 first (no oracle).
    const installationGrantEditor = async (
      req: FastifyRequest,
      reply: FastifyReply,
      agentId: string
    ): Promise<AgentRecord | null> => {
      if (denyViewerWrite(req, reply)) return null
      const agent = await getViewableAgent(req, agentId)
      if (!agent) {
        void agentNotFound(reply)
        return null
      }
      return denyNonOwner(req, reply) ? null : agent
    }
    const ownGrant = async (agent: AgentRecord, id: string): Promise<AgentInstallationAuthorizationRecord | null> => {
      const grant = await deps.repos.agentInstallationAuth.get(id)
      return grant && grant.agentId === agent.id ? grant : null
    }
    const grantNotFound = (reply: FastifyReply) =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation grant not found' })
    const auditGrant = (
      req: FastifyRequest,
      agent: AgentRecord,
      message: string,
      grant: AgentInstallationAuthorizationRecord,
      extra: Record<string, unknown> = {}
    ): void => {
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId: orgOf(req),
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message,
          details: {
            installationAuthId: grant.id,
            provider: grant.provider,
            installationId: grant.installationId.toString(),
            accountLogin: grant.accountLogin,
            access: grant.access,
            materialize: grant.materialize,
            ...extra
          }
        })
        .catch(() => {})
    }

    r.get(
      '/agents/:agentId/installations',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s installation grants',
          description:
            'Installation grants on this agent: each authorizes every repository one of the organization’s GitHub App installations covers, including repositories created later, at one access tier. A grant is never expanded into repository authorizations; `materialize` is `on-demand` (credentials only) or `decision`. Gated by the agent’s visibility.',
          operationId: 'listAgentInstallationAuthorizations',
          params: z.object({ agentId: z.string() }),
          response: { 200: AgentInstallationAuthListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await getViewableAgent(req, req.params.agentId)
        if (!agent) return agentNotFound(reply)
        return (await deps.repos.agentInstallationAuth.listForAgent(agent.id)).map(installationGrantToDto)
      }
    )

    r.post(
      '/agents/:agentId/installations',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Authorize an installation for an agent',
          description:
            'Grant the agent every repository a live, unsuspended GitHub App installation claimed by this organization covers, at one tier (`read` by default); an explicit repository authorization on a covered repository keeps its own tier. Only an organization owner may do this, and no per-repository permission check runs. `materialize` defaults to `on-demand`; `decision` feeds the installation’s repositories to the per-session repository selector and needs the agent’s `repositorySelector` and daemons serving the agent that advertise `repo-selector-v1` (409 `REPOSITORY_SELECTOR_MISSING` or `DAEMON_FEATURE_MISSING` otherwise), and `always` is never accepted. An agent holds at most one grant per installation.',
          operationId: 'createAgentInstallationAuthorization',
          params: z.object({ agentId: z.string() }),
          body: CreateAgentInstallationAuthBody,
          response: { 200: AgentInstallationAuthDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await installationGrantEditor(req, reply, req.params.agentId)
        if (!agent) return
        if (await refuseDecisionMaterialize(reply, agent, req.body.materialize)) return
        if (!deps.github) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'GitHub App is not configured on this deployment (GITHUB_APP_*)'
          })
        }
        const installationId = BigInt(req.body.installationId)
        // The org-fenced live list: an unknown id, another organization's claim and a revoked one all read as absent.
        const installation = (await deps.repos.githubInstallation.listForOrg(orgOf(req))).find(
          (row) => row.installationId === installationId
        )
        if (!installation) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: "not one of this organization's GitHub App installations"
          })
        }
        if (installation.suspendedAt) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `the ${installation.accountLogin} installation is suspended on GitHub`
          })
        }
        const held = await deps.repos.agentInstallationAuth.listForAgent(agent.id)
        if (held.some((grant) => grant.installationId === installationId)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `the ${installation.accountLogin} installation is already authorized for this agent — change that grant’s tier instead`
          })
        }
        const grant = await deps.repos.agentInstallationAuth.create({
          agentId: agent.id,
          installationId,
          accountLogin: installation.accountLogin,
          access: req.body.access,
          materialize: req.body.materialize,
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
        auditGrant(
          req,
          agent,
          `installation ${grant.accountLogin} authorized (${grant.access}, ${grant.materialize})`,
          grant
        )
        await replicateUpsert(agent)
        return installationGrantToDto(grant)
      }
    )

    r.patch(
      '/agents/:agentId/installations/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Update an installation grant',
          description:
            'Change an installation grant’s access tier, how its repositories are materialized (`on-demand` or `decision`; `decision` has the same preconditions as on create, 409 otherwise), or both. At least one field is required. Lowering the tier is refused with 409 `AGENT_REPO_INTEGRATION_CONFLICT` while an enabled GitHub integration still needs it for pull request reviews on a repository the grant covers without an authorization of its own; already-minted tokens live out their expiry of at most one hour. Organization owners only; the change re-projects the agent’s spec.',
          operationId: 'updateAgentInstallationAuthorization',
          params: AgentInstallationAuthParam,
          body: UpdateAgentInstallationAuthBody,
          response: { 200: AgentInstallationAuthDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await installationGrantEditor(req, reply, req.params.agentId)
        if (!agent) return
        const grant = await ownGrant(agent, req.params.id)
        if (!grant) return grantNotFound(reply)
        if (await refuseDecisionMaterialize(reply, agent, req.body.materialize, grant.materialize)) return
        let updated: AgentInstallationAuthorizationRecord | null
        try {
          // A lowered tier is refused while an enabled GitHub review or Checks hook on a repository only the grant covers needs it.
          updated = await deps.repos.agentInstallationAuth.update(grant.id, {
            ...(req.body.access !== undefined ? { access: req.body.access } : {}),
            ...(req.body.materialize !== undefined ? { materialize: req.body.materialize } : {})
          })
        } catch (e) {
          if (!(e instanceof AgentRepoIntegrationConflict)) throw e
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message, code: e.code })
        }
        if (!updated) return grantNotFound(reply)
        if (updated.access !== grant.access || updated.materialize !== grant.materialize) {
          auditGrant(
            req,
            agent,
            `installation ${updated.accountLogin} authorization changed (${grant.access}, ${grant.materialize} → ${updated.access}, ${updated.materialize})`,
            updated,
            { previousAccess: grant.access, previousMaterialize: grant.materialize }
          )
          await replicateUpsert(agent)
        }
        return installationGrantToDto(updated)
      }
    )

    r.delete(
      '/agents/:agentId/installations/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Revoke an installation grant',
          description:
            'Remove the grant. Repositories it alone covered are denied on their next credential request; already-minted tokens live out their expiry of at most one hour. Organization owners only.',
          operationId: 'deleteAgentInstallationAuthorization',
          params: AgentInstallationAuthParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await installationGrantEditor(req, reply, req.params.agentId)
        if (!agent) return
        const grant = await ownGrant(agent, req.params.id)
        if (!grant) return grantNotFound(reply)
        if (!(await deps.repos.agentInstallationAuth.remove(grant.id))) return grantNotFound(reply)
        auditGrant(req, agent, `installation ${grant.accountLogin} authorization revoked`, grant)
        await replicateUpsert(agent)
        return reply.code(204).send(null)
      }
    )
  }
}
