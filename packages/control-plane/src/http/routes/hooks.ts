/**
 * `http/routes/hooks.ts` — CRUD for inbound-webhook triggers
 * (webhook-triggers-and-github-events.md). A hook fires ONE agent; the relay
 * pool is the public ingress, so creation is gated on "a live relay exists and
 * `PUBLIC_RELAY_URL` is configured" (409 otherwise — same shape as the shared-bot
 * install chain). Every write re-converges the relay pool through the
 * {@link HookService} (fire-and-forget; a fresh relay replays on register).
 *
 * Secret discipline: `urlToken` is a capability URL — surfaced (as the full
 * ingress URL) only to callers with edit rights; the HMAC signing secret is
 * echoed EXACTLY ONCE in the create response and never retrievable after.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { gitRepoLabel, type CodeHostProvider } from '@agentconnect.md/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import {
  isSyntheticEmail,
  type AgentRecord,
  type GitlabBindingState,
  type HookRecord,
  type UpsertHookInput
} from '../../persistence/ports.js'
import { GithubApiError } from '../../github/api.js'
import { GITLAB_ACCESS_DEVELOPER } from '../../gitlab/api.js'
import { gitlabAccountUnavailableMessage } from '../../gitlab/account.service.js'
import { GitCredDeniedError, type ResolvedAgentRepoAuthorization } from '../../github/service.js'
import { AgentId, HookId, IntegrationId, OrgId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView } from '../../authorization/policy.js'
import { toDbPlatform, type DbPlatform } from '../../persistence/platform.js'
import { AgentWorkspaceIntegrationConflict } from '../../persistence/errors.js'
import { Tag } from '../plugins/openapi.js'
import {
  CreateHookBody,
  UpdateHookBody,
  HookDto,
  HookListDto,
  CreatedHookDto,
  HookRunListDto,
  HookRerunBody,
  HookRerunDto,
  ErrorDto,
  IdParam,
  type HookDtoT
} from '../dto/index.js'

/** Reason phrases for the rerun route's refusal statuses. */
const RERUN_STATUS_TEXT = {
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
} as const

/** The full ingress URL for a hook's urlToken (pool-level origin + fixed path). */
export function hookIngressUrl(publicRelayUrl: string, urlToken: string): string {
  const relayHttpUrl = publicRelayUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/+$/, '')
  return `${relayHttpUrl}/webhooks/in/${urlToken}`
}

// A hook has no visibility of its own — it is subordinate to its agent (like an
// Integration). The `url` capability is surfaced whenever the caller reached this
// hook at all, which already means they can VIEW (and thus edit) the owning agent.
function toDto(h: HookRecord, publicRelayUrl?: string): HookDtoT {
  return {
    id: h.id,
    orgId: h.orgId,
    agentId: h.agentId,
    kind: h.kind,
    name: h.name,
    sessionMode: h.sessionMode,
    enabled: h.enabled,
    url: h.urlToken && publicRelayUrl ? hookIngressUrl(publicRelayUrl, h.urlToken) : null,
    hmacConfigured: h.hmacConfigured,
    repoId: h.repoId?.toString() ?? null,
    repoFullName: h.repoFullName,
    events: h.events,
    commentFamilies: h.commentFamilies,
    labelFilter: h.labelFilter,
    mentionOnly: h.mentionOnly,
    configRevision: h.configRevision.toString(),
    reviewPolicy: h.reviewPolicy,
    reportingMode: h.reportingMode,
    gateMode: h.gateMode,
    targetPlatform: toDbPlatform(h.targetPlatform),
    targetChannel: h.targetChannel,
    targetIntegrationId: h.targetIntegrationId,
    lastFiredAt: h.lastFiredAt ? h.lastFiredAt.toISOString() : null,
    createdBy: h.createdBy && !isSyntheticEmail(h.createdBy.email) ? h.createdBy.userId : null,
    createdAt: h.createdAt.toISOString(),
    lastModifiedBy: h.lastModifiedBy && !isSyntheticEmail(h.lastModifiedBy.email) ? h.lastModifiedBy.userId : null,
    lastModifiedAt: h.lastModifiedAt.toISOString()
  }
}

export function hookRoutes(deps: HttpDeps) {
  return async function hookRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // A hook is reachable iff its OWNING AGENT is viewable (no per-hook visibility;
    // the agent is the access boundary, like an Integration). Cross-org ids, an
    // agent the caller can't see, and any legacy orphaned hook all read as absent
    // (404, no existence oracle).
    const getOrgHook = async (req: FastifyRequest, id: string): Promise<HookRecord | null> => {
      const hook = await deps.repos.hook.get(orgOf(req), HookId(id))
      if (!hook || !hook.agentId) return null
      const agent = await deps.repos.agent.get(orgOf(req), hook.agentId)
      if (!agent || !canView(agent, ctxOf(req))) return null
      return hook
    }

    // The ingress lives on the relay pool: without a configured public origin
    // AND at least one live relay, a hook could never fire — refuse creation
    // up front (mirrors the shared-bot "no live relay" 409).
    const ingressUnavailable = async (): Promise<string | null> => {
      if (!deps.config.PUBLIC_RELAY_URL) return 'PUBLIC_RELAY_URL is not configured on this deployment'
      const staleMs = deps.config.RELAY_STALE_MS ?? 45_000
      const alive = await deps.repos.relay.listAlive(new Date(Date.now() - staleMs))
      return alive.length === 0 ? 'no relay is registered — deploy the relay to accept webhooks' : null
    }

    // Re-converge the relay pool after a write. Fire-and-forget: a push failure
    // never fails the CRUD (a relay converges via its register replay).
    const converge = (hook: HookRecord): void => {
      void deps.hooks.broadcast(hook).catch((err) => app.log.warn({ hookId: hook.id, err }, 'hook broadcast failed'))
    }

    // §7.2 identity bracket for a gitlab hook write: the hook agent's own account
    // is provisioned FIRST — the compiled rule names it and its poster mints
    // credentials from it — and the write commits while the binding lease is
    // still held, so convergence never sees the membership without the hook row
    // that authorizes it. A hook that will not be enabled needs no identity: it
    // can never fire, and provisioning one would churn an account the next
    // convergence retires, and would block disabling during an account outage.
    const withGitlabHookIdentity = async <T>(
      orgId: OrgId,
      projectId: bigint,
      agentId: string,
      enabled: boolean,
      commit: () => Promise<T>
    ): Promise<{ ok: true; result: T } | { ok: false; status: 409; message: string }> => {
      const gitlab = deps.gitlab
      if (!gitlab || !enabled) return { ok: true, result: await commit() }
      const done = await gitlab.provisioner.provisionAgentAccount(
        orgId,
        projectId,
        // A hook consumer posts notes and may run the configured review policy.
        { agentId, accessLevel: GITLAB_ACCESS_DEVELOPER },
        commit
      )
      if (!done.ok) return { ok: false, status: 409, message: gitlabAccountUnavailableMessage(done.reason) }
      return { ok: true, result: done.result }
    }

    // gitlab-kind writes also (re)converge the project (§11.1): the saga
    // recomputes the desired event union, gives the hook's agent its own §7.2
    // account and membership, and its onConverged rebroadcasts the compiled
    // rules. Fire-and-forget; the saga itself outwaits a peer's lease.
    const convergeGitlabWebhook = (orgId: OrgId, projectId: bigint | null): void => {
      const gitlab = deps.gitlab
      if (!gitlab || projectId === null) return
      void gitlab.provisioner
        .convergeProject(orgId, projectId)
        .catch((err) => app.log.warn({ projectId: projectId.toString(), err }, 'gitlab webhook converge failed'))
    }

    // The repository repeats the workspace-access invariant under its shared
    // transaction fence. Surface a concurrent loser as the same 409 as the
    // route's fast preflight instead of leaking it as a generic 500.
    const persistHook = async (input: UpsertHookInput): Promise<HookRecord | AgentWorkspaceIntegrationConflict> => {
      try {
        return await deps.repos.hook.upsert(input)
      } catch (err) {
        if (err instanceof AgentWorkspaceIntegrationConflict) return err
        throw err
      }
    }

    // github kind: resolve "owner/repo" to the NUMERIC repo id through the org's
    // covering installation. The resolution IS the attribution proof (the repo is
    // reachable through an installation this org owns — an installation only ever
    // grants repos under its own account); the canonical casing comes back from
    // GitHub. repoId is never client-supplied.
    type RepoResolution =
      { ok: true; repoId: bigint; repoFullName: string } | { ok: false; status: 400 | 409 | 429 | 502; message: string }
    const notCovered = {
      ok: false,
      status: 400,
      message: "repository is not covered by one of this organization's GitHub App installations"
    } as const
    // GitHub being unreachable is upstream trouble, not a policy verdict —
    // same mapping as routes/github.ts githubUpstreamFailure (429 rate-limit,
    // 502 for the rest); never let it surface as an unhandled 500.
    const githubUpstream = (e: GithubApiError): { status: 429 | 502; message: string } => ({
      status: e.code === 'RATE_LIMITED' ? 429 : 502,
      message: `github: ${e.message}`
    })
    const resolveGithubRepo = async (orgId: string, repoFullName: string): Promise<RepoResolution> => {
      if (!deps.github) {
        return {
          ok: false,
          status: 409,
          message: 'GitHub App is not configured on this deployment (GITHUB_APP_*)'
        }
      }
      const [owner, repo] = repoFullName.split('/')
      if (!owner || !repo) return notCovered
      const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(OrgId(orgId), owner)
      if (!ins || ins.suspendedAt) return notCovered
      try {
        const ref = await deps.github.repoRefFor(ins, owner, repo)
        if (!ref) return notCovered
        // Readers-first catalog convergence (gitlab-com-integration.md §8.1).
        await deps.repos.codeHostRepository.upsert({
          orgId,
          provider: 'github',
          externalId: ref.repoId,
          displayPath: ref.fullName,
          cloneUrl: `https://github.com/${ref.fullName}`,
          defaultBranch: ref.defaultBranch
        })
        return { ok: true, repoId: ref.repoId, repoFullName: ref.fullName }
      } catch (e) {
        if (e instanceof GithubApiError) return { ok: false, ...githubUpstream(e) }
        throw e
      }
    }
    const ERROR_NAMES = {
      400: 'Bad Request',
      409: 'Conflict',
      429: 'Too Many Requests',
      502: 'Bad Gateway'
    } as const

    // The trigger plane must not outrun the credential plane (issue #457,
    // multi-repo design decision 6; gitlab-com-integration.md §8.3): a code-host
    // hook may only watch the agent's workspace repository or an explicitly
    // authorized one — otherwise the agent's write-back on the watched repository
    // is credential-less by construction, which is exactly the "could not review"
    // note both agents post. Enforced on create and on a binding-CHANGING edit;
    // pre-existing rows are grandfathered (the console badges them instead).
    type WatchRepoAuthz = { ok: true } | { ok: false; status: 409 | 429 | 502; message: string }
    const watchRepoAuthorized = async (
      agent: AgentRecord,
      provider: CodeHostProvider,
      repoId: bigint,
      repoFullName: string
    ): Promise<WatchRepoAuthz> => {
      const subject = provider === 'gitlab' ? 'project' : 'repository'
      const denied = {
        ok: false,
        status: 409,
        message: `${repoFullName} is not authorized for this agent — authorize the ${subject} for it, or make it the agent's workspace ${subject}, then create the trigger`
      } as const
      const explicitlyGranted = async () =>
        (await deps.repos.agentRepoAuth.listForAgent(agent.id)).some(
          (row) => row.provider === provider && row.repoId === repoId
        )
      // The workspace is this repository only when it is the SAME host's: the two
      // number theirs independently, so `workspaceMode` qualifies the id (§8.1).
      if (agent.workspaceRepoId === repoId && agent.workspace.mode === provider) return { ok: true }
      // Legacy workspace rows acquire their rename-proof id lazily. The stored
      // name is only an endpoint hint: after a GitHub rename the requested
      // canonical name differs, so always resolve and compare numeric identity.
      if (provider === 'github' && agent.workspace.mode === 'github' && deps.github) {
        const workspaceLabel = gitRepoLabel(agent.workspace.gitRepo)
        const [owner, repo] = workspaceLabel.split('/')
        const ins = owner ? await deps.repos.githubInstallation.liveByOrgAndAccount(agent.orgId, owner) : null
        if (ins && repo) {
          try {
            const ref = await deps.github.repoRefFor(ins, owner!, repo)
            if (ref?.repoId === repoId) {
              if (await deps.repos.agent.setWorkspaceRepoId(agent.id, repoId)) return { ok: true }
              return (await deps.repos.agent.get(agent.orgId, agent.id))?.workspaceRepoId === repoId
                ? { ok: true }
                : denied
            }
          } catch (e) {
            if (!(e instanceof GithubApiError)) throw e
            // GitHub down mid-check: an explicit grant still authorizes; short
            // of one, report the upstream failure — not a misleading denial.
            return (await explicitlyGranted()) ? { ok: true } : { ok: false, ...githubUpstream(e) }
          }
        }
      }
      return (await explicitlyGranted()) ? { ok: true } : denied
    }

    // The two effect axes both code hosts carry; github adds its own gate axis on top.
    type CodeHostEffectConfig = {
      reviewPolicy: HookRecord['reviewPolicy']
      reportingMode: HookRecord['reportingMode']
    }

    type GithubEffectConfig = CodeHostEffectConfig & { gateMode: HookRecord['gateMode'] }

    type CodeHostEffectDenial = { status: 409 | 429 | 502; message: string }

    /** R1/R2a action-time rules are also enforced at configuration time so the
     * editor cannot save a mode that is guaranteed to fail. Runtime still
     * re-resolves the same numeric authorization on every effect. */
    const validateGithubEffects = async (
      agent: AgentRecord,
      repoId: bigint,
      repoFullName: string,
      cfg: GithubEffectConfig
    ): Promise<CodeHostEffectDenial | null> => {
      const misconfigured = (message: string): CodeHostEffectDenial => ({ status: 409, message })
      if (cfg.gateMode === 'required') return misconfigured('required review gates are not available until R2b')
      if (cfg.reportingMode === 'status') return misconfigured('commit status reporting is not available until R3')
      if (cfg.reviewPolicy === 'off' && cfg.reportingMode === 'off') return null
      if (!deps.github) return misconfigured('GitHub App is not configured on this deployment (GITHUB_APP_*)')

      let resolved: ResolvedAgentRepoAuthorization
      try {
        resolved = await deps.github.resolveAgentRepoAuthorization(agent, repoId, repoFullName)
      } catch (err) {
        if (err instanceof GitCredDeniedError) return misconfigured(err.message)
        // GitHub unreachable is not a configuration verdict — report it as
        // retryable upstream trouble instead of a 409 policy denial.
        if (err instanceof GithubApiError) return githubUpstream(err)
        throw err
      }

      if (cfg.reviewPolicy !== 'off') {
        const commentOnlyAdditional =
          resolved.kind === 'additional' && resolved.access === 'comment' && cfg.reviewPolicy === 'comment'
        if (resolved.access !== 'write' && !commentOnlyAdditional) {
          return misconfigured(
            cfg.reviewPolicy === 'comment'
              ? 'formal review comments require workspace write or additional-repository comment access'
              : 'request-changes and approve reviews require write repository access'
          )
        }
        if (resolved.installation.permissions?.pull_requests !== 'write') {
          return misconfigured('this GitHub App installation has not accepted the Pull requests write permission')
        }
      }
      if (cfg.reportingMode === 'check') {
        if (resolved.access !== 'write') return misconfigured('informational Checks require write repository access')
        if (resolved.installation.permissions?.checks !== 'write') {
          return misconfigured('this GitHub App installation has not accepted the Checks write permission')
        }
        const pullRequests = resolved.installation.permissions?.pull_requests
        if (pullRequests !== 'read' && pullRequests !== 'write') {
          return misconfigured('this GitHub App installation has not accepted the Pull requests read permission')
        }
      }
      return null
    }

    // The GitLab counterpart. No repository-access clamp: the writer for BOTH effects is the
    // hook agent's own service account under its provisioned role (§7.2), not the agent's git
    // grant. That account is created by the convergence this very write kicks, so the only
    // configuration-time fact to check is that the binding itself has converged once.
    const validateGitlabEffects = (
      binding: { state: GitlabBindingState; projectPath: string },
      cfg: CodeHostEffectConfig
    ): CodeHostEffectDenial | null => {
      // §16.2: GitLab commit statuses are external CI jobs, deliberately not this transport.
      if (cfg.reportingMode === 'status') {
        return { status: 409, message: 'commit status reporting is not available for GitLab projects' }
      }
      if (cfg.reviewPolicy === 'off' && cfg.reportingMode === 'off') return null
      if (binding.state === 'provisioning') {
        return {
          status: 409,
          message: `${binding.projectPath} is still being set up — reviews and run reporting need its bot accounts`
        }
      }
      return null
    }

    // Validate the optional anchoring target against the hook's agent (the
    // anchor posts through one of THAT agent's integrations — cron semantics).
    const resolveTarget = async (
      orgId: OrgId,
      agentId: string,
      // `DbPlatform` is the served set the anchor may target — the same registry
      // declaration `Platform` (the request body's own enum) and `toDbPlatform`
      // (the value returned below) read, instead of a third inline spelling.
      body: {
        targetPlatform: DbPlatform
        targetChannel?: string
        targetIntegrationId?: string
      }
    ): Promise<{ ok: true; targetPlatform: DbPlatform; targetIntegrationId?: IntegrationId } | { ok: false }> => {
      if (!(body.targetIntegrationId && body.targetChannel)) return { ok: true, targetPlatform: body.targetPlatform }
      const integ = await deps.repos.integration.get(orgId, IntegrationId(body.targetIntegrationId))
      if (!integ || integ.agentId !== agentId) return { ok: false }
      return { ok: true, targetPlatform: toDbPlatform(integ.platform), targetIntegrationId: integ.id }
    }

    r.post(
      '/hooks',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Create a hook',
          description:
            'Create a trigger for one agent. `kind:"webhook"` mints an ingress URL (the response carries it plus — when requested — the one-time HMAC signing secret, never retrievable again). `kind:"github"` subscribes a repository covered by one of the organization’s GitHub App installations to issue/PR events.',
          operationId: 'createHook',
          body: CreateHookBody,
          response: { 200: CreatedHookDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const unavailable = await ingressUnavailable()
        if (unavailable) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: unavailable })
        }
        // The hook's agent must exist IN THIS ORG and be VISIBLE to the caller —
        // same no-oracle rule as cron create (no binding a restricted agent).
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'unknown agentId' })
        }
        const target = await resolveTarget(orgId, agent.id, req.body)
        if (!target.ok) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'targetIntegrationId is not an integration of this agent'
          })
        }
        // Server-minted identifiers: the row id and (webhook kind) the ≥128-bit
        // capability token. Prefixes follow the Stripe-style shapes (whk_ / whsec_).
        const hookId = HookId(randomUUID())
        const kindFields =
          req.body.kind === 'webhook'
            ? {
                sessionMode: req.body.sessionMode,
                urlToken: `whk_${randomBytes(16).toString('hex')}`,
                hmacSecret: req.body.hmac ? `whsec_${randomBytes(32).toString('hex')}` : null
              }
            : req.body.kind === 'gitlab'
              ? await (async () => {
                  // The project must already be a managed binding (§8.3): a hook
                  // never creates a grant or a binding, and the numeric id is
                  // validated against the org's own row — never trusted for facts.
                  const projectId = BigInt((req.body as { projectId: string }).projectId)
                  const binding = deps.gitlab ? await deps.repos.gitlabProjectBinding.byProject(orgId, projectId) : null
                  if (!binding || binding.state === 'cleanup_pending') {
                    return {
                      ok: false as const,
                      status: 409 as const,
                      message: 'the project is not a managed GitLab binding in this organization'
                    }
                  }
                  const dup = (await deps.repos.hook.listForAgent(agent.id)).some(
                    (h) => h.kind === 'gitlab' && h.repoId === projectId
                  )
                  if (dup) {
                    return {
                      ok: false as const,
                      status: 409 as const,
                      message: `this agent already watches ${binding.projectPath}`
                    }
                  }
                  // §8.3: creating a hook never creates a grant, so the project must
                  // ALREADY be the workspace or an explicit additional authorization.
                  const authz = await watchRepoAuthorized(agent, 'gitlab', projectId, binding.projectPath)
                  if (!authz.ok) return authz
                  const effectError = validateGitlabEffects(binding, {
                    reviewPolicy: req.body.kind === 'gitlab' ? req.body.reviewPolicy : 'off',
                    reportingMode: req.body.kind === 'gitlab' ? req.body.reportingMode : 'off'
                  })
                  if (effectError) return { ok: false as const, ...effectError }
                  return {
                    // gitlab is perThread by definition, like github (§12.3).
                    sessionMode: 'perThread' as const,
                    repoId: projectId,
                    repoFullName: binding.projectPath,
                    githubSessionKey: `gitlab:${projectId}`,
                    hmacSecret: null
                  }
                })()
              : await (async () => {
                  const repo = await resolveGithubRepo(orgId, (req.body as { repoFullName: string }).repoFullName)
                  if (!repo.ok) return repo
                  // One subscription per (agent, repo): edit the existing hook's
                  // events instead of stacking duplicates that would double-fire.
                  const dup = (await deps.repos.hook.listForAgent(agent.id)).some(
                    (h) => h.kind === 'github' && h.repoId === repo.repoId
                  )
                  if (dup) {
                    return {
                      ok: false as const,
                      status: 409 as const,
                      message: `this agent already watches ${repo.repoFullName}`
                    }
                  }
                  const authz = await watchRepoAuthorized(agent, 'github', repo.repoId, repo.repoFullName)
                  if (!authz.ok) return authz
                  const configError = await validateGithubEffects(agent, repo.repoId, repo.repoFullName, {
                    reviewPolicy: req.body.kind === 'github' ? req.body.reviewPolicy : 'off',
                    reportingMode: req.body.kind === 'github' ? req.body.reportingMode : 'off',
                    gateMode: req.body.kind === 'github' ? req.body.gateMode : 'informational'
                  })
                  if (configError) {
                    return { ok: false as const, ...configError }
                  }
                  return {
                    // github is perThread by definition — the same issue/PR
                    // continues one session (design decision 7).
                    sessionMode: 'perThread' as const,
                    repoId: repo.repoId,
                    repoFullName: repo.repoFullName,
                    hmacSecret: null
                  }
                })()
        if ('status' in kindFields) {
          const { status, message } = kindFields
          return reply.code(status).send({ error: ERROR_NAMES[status], statusCode: status, message })
        }
        const { hmacSecret, ...upsertFields } = kindFields
        const writeHook = (): Promise<HookRecord | AgentWorkspaceIntegrationConflict> =>
          persistHook({
            hookId,
            orgId,
            agentId: agent.id,
            kind: req.body.kind,
            name: req.body.name,
            enabled: req.body.enabled,
            ...upsertFields,
            ...(req.body.kind === 'github'
              ? {
                  events: req.body.events,
                  commentFamilies: req.body.commentFamilies,
                  labelFilter: req.body.labelFilter,
                  mentionOnly: req.body.mentionOnly,
                  reviewPolicy: req.body.reviewPolicy,
                  reportingMode: req.body.reportingMode,
                  gateMode: req.body.gateMode
                }
              : {}),
            ...(req.body.kind === 'gitlab'
              ? {
                  events: req.body.events,
                  commentFamilies: req.body.commentFamilies,
                  mentionOnly: req.body.mentionOnly,
                  reviewPolicy: req.body.reviewPolicy,
                  reportingMode: req.body.reportingMode
                  // No gateMode: GitLab has no required-gate surface, so the row stays informational.
                }
              : {}),
            targetPlatform: target.targetPlatform,
            ...(req.body.targetChannel ? { targetChannel: req.body.targetChannel } : {}),
            ...(target.targetIntegrationId ? { targetIntegrationId: target.targetIntegrationId } : {}),
            ...(req.principal
              ? { createdByUserId: req.principal.userId, lastModifiedByUserId: req.principal.userId }
              : {})
          })
        const written =
          req.body.kind === 'gitlab'
            ? await withGitlabHookIdentity(orgId, BigInt(req.body.projectId), agent.id, req.body.enabled, writeHook)
            : { ok: true as const, result: await writeHook() }
        if (!written.ok) {
          return reply
            .code(written.status)
            .send({ error: ERROR_NAMES[written.status], statusCode: written.status, message: written.message })
        }
        const hook = written.result
        if (hook instanceof AgentWorkspaceIntegrationConflict) {
          return reply.code(409).send({ error: ERROR_NAMES[409], statusCode: 409, message: hook.message })
        }
        if (hmacSecret) await deps.repos.hookSecret.put(orgOf(req), hookId, hmacSecret)
        void deps.repos.audit
          .append({
            kind: 'hook_change',
            orgId,
            agentId: agent.id,
            ...(req.principal ? { actorUserId: req.principal.userId } : {}),
            frameType: 'rc/hook-assign',
            message: `hook ${hook.id} created`,
            details: {
              hookId: hook.id,
              kind: hook.kind,
              enabled: hook.enabled,
              ...(hook.repoFullName ? { repoFullName: hook.repoFullName } : {})
            }
          })
          .catch(() => {})
        // Re-read so hmacConfigured reflects the secret written above.
        const fresh = (await deps.repos.hook.get(orgId, hookId)) ?? hook
        converge(fresh)
        if (fresh.kind === 'gitlab') convergeGitlabWebhook(orgId, fresh.repoId)
        return { ...toDto(fresh, deps.config.PUBLIC_RELAY_URL), hmacSecret }
      }
    )

    // A hook is subordinate to its agent (like an Integration), so there is no
    // org-wide hook list — you list an AGENT's hooks, gated by that agent's
    // visibility. An agent you can't see (or that isn't in the org) reads 404.
    r.get(
      '/agents/:agentId/hooks',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'List an agent’s hooks',
          description: 'Every hook firing this agent. Gated by the agent’s visibility.',
          operationId: 'listAgentHooks',
          params: z.object({ agentId: z.string() }),
          response: { 200: HookListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        const rows = await deps.repos.hook.listForAgent(agent.id)
        return rows.map((h) => toDto(h, deps.config.PUBLIC_RELAY_URL))
      }
    )

    r.get(
      '/hooks/:id',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Get a hook',
          description: 'A single hook definition by id, scoped to the caller’s active organization.',
          operationId: 'getHook',
          params: IdParam,
          response: { 200: HookDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const hook = await getOrgHook(req, req.params.id)
        if (!hook) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'hook not found' })
        }
        return toDto(hook, deps.config.PUBLIC_RELAY_URL)
      }
    )

    r.put(
      '/hooks/:id',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Update a hook',
          description:
            'Update a hook definition. `kind` is immutable (it discriminates the body); a webhook hook’s ingress URL and signing secret are immutable too — rotating either is a delete + re-create. A github hook’s repository may be re-targeted (re-validated against the organization’s installations).',
          operationId: 'updateHook',
          params: IdParam,
          body: UpdateHookBody,
          response: {
            200: HookDto,
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
        // getOrgHook already gated on the owning agent's visibility, and
        // denyViewerWrite blocked viewer-role callers — that IS edit authorization
        // for an agent-subordinate resource (no separate per-hook canEdit).
        const existing = await getOrgHook(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'hook not found' })
        }
        if (req.body.kind !== existing.kind) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'kind is immutable — delete and re-create to change it'
          })
        }
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'unknown agentId' })
        }
        const target = await resolveTarget(orgId, agent.id, req.body)
        if (!target.ok) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'targetIntegrationId is not an integration of this agent'
          })
        }
        // github kind: re-resolve the repo on every update (re-target allowed —
        // repoId is recomputed; a stale/foreign repo fails the same as on create).
        let kindFields: { sessionMode: HookRecord['sessionMode'] } & Partial<{
          repoId: bigint
          repoFullName: string
          events: string[]
          commentFamilies: HookRecord['commentFamilies']
          labelFilter: string[]
          mentionOnly: boolean
          reviewPolicy: HookRecord['reviewPolicy']
          reportingMode: HookRecord['reportingMode']
          gateMode: HookRecord['gateMode']
        }>
        if (req.body.kind === 'github') {
          const nextEnabled = req.body.enabled ?? existing.enabled
          const effectConfig = {
            reviewPolicy: req.body.reviewPolicy ?? existing.reviewPolicy,
            reportingMode: req.body.reportingMode ?? existing.reportingMode,
            gateMode: req.body.gateMode ?? existing.gateMode
          }
          // Future modes remain fail-closed even on a disabled definition; a
          // later re-enable must never activate a value R2a cannot execute.
          if (effectConfig.gateMode === 'required' || effectConfig.reportingMode === 'status') {
            const message =
              effectConfig.gateMode === 'required'
                ? 'required review gates are not available until R2b'
                : 'commit status reporting is not available until R3'
            return reply.code(409).send({ error: ERROR_NAMES[409], statusCode: 409, message })
          }
          const policyRank = { off: 0, comment: 1, request_changes: 2, full: 3 } as const
          const persistedBindingRequested =
            existing.repoId !== null &&
            existing.repoFullName !== null &&
            agent.id === existing.agentId &&
            req.body.repoFullName.toLowerCase() === existing.repoFullName.toLowerCase()
          const safeLifecycleNarrowing =
            persistedBindingRequested &&
            (!nextEnabled ||
              (existing.reportingMode === 'check' &&
                effectConfig.reportingMode === 'off' &&
                policyRank[effectConfig.reviewPolicy] <= policyRank[existing.reviewPolicy]))
          // A pure disable/check-off mutation is authorized to reduce effects
          // even after the grant/installation disappeared or GitHub is down.
          // It reuses the persisted numeric binding; any retarget, agent change,
          // or policy widening still goes through live resolution below.
          const repo = safeLifecycleNarrowing
            ? { ok: true as const, repoId: existing.repoId!, repoFullName: existing.repoFullName! }
            : await resolveGithubRepo(orgId, req.body.repoFullName)
          if (!repo.ok) {
            const { status, message } = repo
            return reply.code(status).send({ error: ERROR_NAMES[status], statusCode: status, message })
          }
          // Same one-subscription-per-(agent, repo) rule as create — a re-target
          // onto a repo another hook of this agent already watches would double-fire.
          const dup = (await deps.repos.hook.listForAgent(agent.id)).some(
            (h) => h.id !== existing.id && h.kind === 'github' && h.repoId === repo.repoId
          )
          if (dup) {
            return reply.code(409).send({
              error: ERROR_NAMES[409],
              statusCode: 409,
              message: `this agent already watches ${repo.repoFullName}`
            })
          }
          // Binding-CHANGING edits go through the authorization gate — a new
          // repo, or the same repo moved onto a different agent. An edit that
          // keeps the (grandfathered) pair — events/labels/target tweaks — must
          // not brick an existing hook.
          const bindingChanged = repo.repoId !== existing.repoId || agent.id !== existing.agentId
          if (bindingChanged) {
            const authz = await watchRepoAuthorized(agent, 'github', repo.repoId, repo.repoFullName)
            if (!authz.ok) {
              return reply.code(authz.status).send({
                error: ERROR_NAMES[authz.status],
                statusCode: authz.status,
                message: authz.message
              })
            }
          }
          const configError = safeLifecycleNarrowing
            ? null
            : await validateGithubEffects(agent, repo.repoId, repo.repoFullName, effectConfig)
          if (configError) {
            return reply.code(configError.status).send({
              error: ERROR_NAMES[configError.status],
              statusCode: configError.status,
              message: configError.message
            })
          }
          kindFields = {
            sessionMode: 'perThread',
            repoId: repo.repoId,
            repoFullName: repo.repoFullName,
            events: req.body.events,
            // Optional on UPDATE so old clients preserve the stored scope.
            commentFamilies: req.body.commentFamilies ?? existing.commentFamilies,
            labelFilter: req.body.labelFilter,
            mentionOnly: req.body.mentionOnly ?? existing.mentionOnly,
            ...effectConfig
          }
        } else if (req.body.kind === 'gitlab') {
          const projectId = BigInt(req.body.projectId)
          const binding = deps.gitlab ? await deps.repos.gitlabProjectBinding.byProject(orgId, projectId) : null
          if (!binding || binding.state === 'cleanup_pending') {
            return reply.code(409).send({
              error: ERROR_NAMES[409],
              statusCode: 409,
              message: 'the project is not a managed GitLab binding in this organization'
            })
          }
          const dup = (await deps.repos.hook.listForAgent(agent.id)).some(
            (h) => h.id !== existing.id && h.kind === 'gitlab' && h.repoId === projectId
          )
          if (dup) {
            return reply.code(409).send({
              error: ERROR_NAMES[409],
              statusCode: 409,
              message: `this agent already watches ${binding.projectPath}`
            })
          }
          // Binding-CHANGING edits go through the §8.3 gate — a new project, or the
          // same project moved onto a different agent. An edit that keeps the
          // (grandfathered) pair must not brick an existing hook, exactly as github.
          if (projectId !== existing.repoId || agent.id !== existing.agentId) {
            const authz = await watchRepoAuthorized(agent, 'gitlab', projectId, binding.projectPath)
            if (!authz.ok) {
              return reply.code(authz.status).send({
                error: ERROR_NAMES[authz.status],
                statusCode: authz.status,
                message: authz.message
              })
            }
          }
          const effectConfig = {
            reviewPolicy: req.body.reviewPolicy ?? existing.reviewPolicy,
            reportingMode: req.body.reportingMode ?? existing.reportingMode
          }
          const effectError = validateGitlabEffects(binding, effectConfig)
          if (effectError) {
            return reply.code(effectError.status).send({
              error: ERROR_NAMES[effectError.status],
              statusCode: effectError.status,
              message: effectError.message
            })
          }
          kindFields = {
            sessionMode: 'perThread',
            repoId: projectId,
            repoFullName: binding.projectPath,
            events: req.body.events,
            commentFamilies: req.body.commentFamilies ?? existing.commentFamilies,
            mentionOnly: req.body.mentionOnly ?? existing.mentionOnly,
            ...effectConfig
          }
        } else {
          kindFields = { sessionMode: req.body.sessionMode }
        }
        // PgHookRepo owns the hook-level lifecycle transaction: binding/mode/
        // enablement changes tombstone the old projection epoch before this
        // definition advances to its new epoch.
        const nowEnabled = req.body.enabled ?? existing.enabled
        const writeHook = (): Promise<HookRecord | AgentWorkspaceIntegrationConflict> =>
          persistHook({
            hookId: existing.id,
            expectedAgentId: existing.agentId!,
            orgId,
            agentId: agent.id,
            kind: existing.kind,
            name: req.body.name,
            enabled: nowEnabled,
            ...kindFields,
            targetPlatform: target.targetPlatform,
            ...(req.body.targetChannel ? { targetChannel: req.body.targetChannel } : {}),
            ...(target.targetIntegrationId ? { targetIntegrationId: target.targetIntegrationId } : {}),
            ...(req.principal ? { lastModifiedByUserId: req.principal.userId } : {})
          })
        const written =
          req.body.kind === 'gitlab'
            ? await withGitlabHookIdentity(orgId, BigInt(req.body.projectId), agent.id, nowEnabled, writeHook)
            : { ok: true as const, result: await writeHook() }
        if (!written.ok) {
          return reply
            .code(written.status)
            .send({ error: ERROR_NAMES[written.status], statusCode: written.status, message: written.message })
        }
        const hook = written.result
        if (hook instanceof AgentWorkspaceIntegrationConflict) {
          return reply.code(409).send({ error: ERROR_NAMES[409], statusCode: 409, message: hook.message })
        }
        void deps.repos.audit
          .append({
            kind: 'hook_change',
            orgId,
            agentId: agent.id,
            ...(req.principal ? { actorUserId: req.principal.userId } : {}),
            frameType: 'rc/hook-assign',
            message: `hook ${hook.id} updated`,
            details: { hookId: hook.id, kind: hook.kind, enabled: hook.enabled }
          })
          .catch(() => {})
        converge(hook)
        if (hook.kind === 'gitlab') {
          convergeGitlabWebhook(orgOf(req), hook.repoId)
          // A retarget moved this hook off `existing.repoId`: the source
          // binding's union shrank too, so converge BOTH distinct projects.
          if (existing.repoId !== null && existing.repoId !== hook.repoId) {
            convergeGitlabWebhook(orgOf(req), existing.repoId)
          }
        }
        return toDto(hook, deps.config.PUBLIC_RELAY_URL)
      }
    )

    r.delete(
      '/hooks/:id',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Delete a hook',
          description: 'Remove a hook definition and drop its rule from the relay pool.',
          operationId: 'deleteHook',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgHook(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'hook not found' })
        }
        // remove() atomically tombstones the current projection epoch under the
        // same hook lifecycle lock before deleting the definition.
        await deps.repos.hook.remove(orgOf(req), existing.id, existing.agentId!)
        void deps.repos.audit
          .append({
            kind: 'hook_change',
            orgId: orgOf(req),
            ...(existing.agentId ? { agentId: existing.agentId } : {}),
            ...(req.principal ? { actorUserId: req.principal.userId } : {}),
            frameType: 'rc/hook-remove',
            message: `hook ${existing.id} removed`,
            details: { hookId: existing.id }
          })
          .catch(() => {})
        deps.hooks.remove(existing.id)
        if (existing.kind === 'gitlab') convergeGitlabWebhook(orgOf(req), existing.repoId)
        return reply.code(204).send(null)
      }
    )

    // Run history (two-stage: relay rc/run-report opens, daemon hook/report
    // closes), newest first — the console detail page's Runs card.
    r.get(
      '/hooks/:id/runs',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'List hook runs',
          description: 'Delivery/run history for a hook, newest first (metadata only — payloads never reach the CP).',
          operationId: 'listHookRuns',
          params: IdParam,
          response: { 200: HookRunListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const hook = await getOrgHook(req, req.params.id)
        if (!hook) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'hook not found' })
        }
        const runs = await deps.repos.hook.listRuns(orgOf(req), hook.id)
        return runs.map((run) => ({
          id: run.id,
          deliveryKey: run.deliveryKey,
          event: run.event,
          startedAt: run.startedAt.toISOString(),
          status: run.status,
          durationMs: run.durationMs,
          sessionId: run.sessionId,
          reason: run.reason,
          redeliveryAttempts: run.redeliveryAttempts,
          redeliveryLastRequestedAt: run.redeliveryLastRequestedAt?.toISOString() ?? null
        }))
      }
    )

    // The Console "Run again" action (gitlab-com-integration.md §16.1, §18.2).
    // GitLab has no native Check button, so this is the replacement start path:
    // the service revalidates every fence live and reads the subject's CURRENT
    // head from GitLab, then the relay re-dispatches through the ordinary hook
    // turn path. Registered unconditionally so the published spec describes it;
    // a deployment without the GitLab app refuses every call.
    r.post(
      '/hooks/:id/rerun',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Run a GitLab trigger again',
          description:
            'Re-dispatches one GitLab trigger turn for a merge request or issue thread. GitLab offers no native re-run control, so this is the console entry point. The enabled trigger, its agent, the managed project binding, and the subject are all revalidated live, and a merge-request rerun targets the head SHA GitLab reports right now — never a stored one. Refusals carry a machine-readable `code`.',
          operationId: 'rerunHook',
          params: IdParam,
          body: HookRerunBody,
          response: {
            200: HookRerunDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        // Cross-org and invisible-agent ids read as absent, like every other hook route.
        const hook = await getOrgHook(req, req.params.id)
        if (!hook) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'hook not found' })
        }
        if (!deps.gitlab) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this deployment has no GitLab application configured',
            code: 'GITLAB_NOT_CONFIGURED'
          })
        }
        const outcome = await deps.gitlab.hookRerun.rerun(hook, req.body.subject)
        if (!outcome.ok) {
          return reply.code(outcome.status).send({
            error: RERUN_STATUS_TEXT[outcome.status],
            statusCode: outcome.status,
            message: outcome.message,
            code: outcome.code
          })
        }
        return {
          accepted: true as const,
          deliveryKey: outcome.deliveryKey,
          event: outcome.event,
          headSha: outcome.headSha
        }
      }
    )

    // No /hooks/:id/sharing: a hook has no visibility of its own — it inherits the
    // owning agent's (share the agent instead). See CreateHookBody / the schema.
  }
}
