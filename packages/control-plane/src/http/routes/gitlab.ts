/**
 * `http/routes/gitlab.ts` — GitLab.com OAuth connections
 * (gitlab-com-integration.md §9, §18.2).
 *
 * TWO plugins, mirroring `github.ts`:
 *  - `gitlabRoutes` mounts inside the `/orgs/:orgId` subtree: oauth start,
 *    connection list, disconnect and removal. Connections are infrastructure-class
 *    (org-visible, never canView-filtered), like GitHub installations.
 *  - `gitlabOauthRoutes` mounts at the API version root, UNAUTHENTICATED
 *    (GitLab redirects a browser): the begin hop that stamps the
 *    browser-binding cookie, and the callback that consumes the one-shot
 *    state. Hidden from the published OpenAPI spec.
 *
 * Without GITLAB_CLIENT_ID/SECRET, `deps.gitlab` is absent and none of these
 * routes register — the whole surface 404s.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { GitlabOauthDenied, OAUTH_BROWSER_COOKIE } from '../../gitlab/oauth.service.js'
import {
  GITLAB_ACCESS_MAINTAINER,
  GitlabApiError,
  gitlabEffectiveMembership,
  gitlabListProjects,
  gitlabProject,
  membershipSatisfies
} from '../../gitlab/api.js'
import { GitlabProjectClaimConflict } from '../../persistence/errors.js'
import {
  CreateGitlabProjectBody,
  ErrorDto,
  GitlabConnectionDeleteDto,
  GitlabConnectionListDto,
  GitlabOauthStartDto,
  GitlabProjectBindingDto,
  GitlabProjectBindingListDto,
  GitlabProjectPageDto,
  IdParam
} from '../dto/index.js'
import type {
  GitlabAgentAccountRecord,
  GitlabConnectionRecord,
  GitlabProjectBindingRecord
} from '../../persistence/ports.js'

function toDto(r: GitlabConnectionRecord, assignedProjects: number, callerUserId: string) {
  return {
    id: r.id,
    gitlabUserId: r.gitlabUserId.toString(),
    gitlabUsername: r.gitlabUsername,
    state: r.state,
    scopes: r.scopes,
    connectedBy: r.userId,
    mine: r.userId !== null && r.userId === callerUserId,
    accessExpiresAt: r.accessExpiresAt ? r.accessExpiresAt.toISOString() : null,
    assignedProjects,
    createdAt: r.createdAt.toISOString()
  }
}

/** One binding with its member accounts (§7.2) — the project's bot identities. */
function bindingToDto(r: GitlabProjectBindingRecord, accounts: GitlabAgentAccountRecord[]) {
  return {
    id: r.id,
    projectId: r.projectId.toString(),
    projectPath: r.projectPath,
    defaultBranch: r.defaultBranch,
    state: r.state,
    stateReason: r.stateReason,
    installerConnectionId: r.installerConnectionId,
    accounts: accounts.map((account) => ({
      agentId: account.agentId,
      username: account.username,
      displayName: account.displayName,
      userId: account.serviceAccountUserId?.toString() ?? null,
      state: account.state,
      stateReason: account.stateReason
    })),
    webhookInstalled: r.webhookId !== null,
    credentialEpoch: r.credentialEpoch.toString(),
    createdAt: r.createdAt.toISOString()
  }
}

/** Upstream trouble is upstream trouble, not policy: 429 stays 429, the rest 502. */
function gitlabUpstream(e: GitlabApiError): { status: 429 | 502; message: string } {
  return { status: e.status === 429 ? 429 : 502, message: `gitlab: ${e.message}` }
}

function browserCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === OAUTH_BROWSER_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function gitlabRoutes(deps: HttpDeps) {
  return async function gitlabRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gitlab = deps.gitlab
    if (!gitlab) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/gitlab/oauth/start',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Start a GitLab.com OAuth connection',
          description:
            'Mints a one-shot authorization state bound to this organization and the calling user, and returns the URL the browser must visit to continue on GitLab.com.',
          operationId: 'startGitlabOauth',
          body: z.object({ returnPath: z.string().max(512).optional() }).optional(),
          response: { 200: GitlabOauthStartDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        try {
          return await gitlab.oauth.start(orgOf(req), req.principal!.userId, req.body?.returnPath)
        } catch (e) {
          if (e instanceof GitlabOauthDenied) {
            return reply.code(e.status).send({ error: 'Bad Request', statusCode: e.status, message: e.message })
          }
          throw e
        }
      }
    )

    r.get(
      '/gitlab/connections',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'List GitLab.com connections',
          description:
            'The organization-owned GitLab.com OAuth connections: administration identities only, no token material.',
          operationId: 'listGitlabConnections',
          response: { 200: GitlabConnectionListDto }
        }
      },
      async (req) => {
        const orgId = orgOf(req)
        const rows = await deps.repos.gitlabConnection.listForOrg(orgId)
        const assigned = await deps.repos.gitlabProjectBinding.countByInstaller(orgId)
        return { connections: rows.map((row) => toDto(row, assigned[row.id] ?? 0, req.principal!.userId)) }
      }
    )

    r.get(
      '/gitlab/connections/:id/projects',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Search accessible GitLab.com projects',
          description:
            "Server-side paginated search of the connection's accessible projects (§10.1). Metadata only; installability is enforced at project selection.",
          operationId: 'listGitlabConnectionProjects',
          params: IdParam,
          querystring: z.object({
            search: z.string().max(256).optional(),
            page: z.coerce.number().int().positive().optional()
          }),
          response: {
            200: GitlabProjectPageDto,
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        try {
          const token = await gitlab.oauth.withAccessToken(orgOf(req), req.params.id)
          const { projects, nextPage } = await gitlabListProjects(
            token,
            {
              ...(req.query.search ? { search: req.query.search } : {}),
              ...(req.query.page ? { page: req.query.page } : {})
            },
            gitlab.fetchImpl
          )
          return {
            projects: projects.map((project) => ({
              projectId: String(project.id),
              path: project.path_with_namespace,
              defaultBranch: project.default_branch ?? null,
              lastActivityAt: project.last_activity_at ?? null
            })),
            nextPage
          }
        } catch (e) {
          if (e instanceof GitlabOauthDenied) {
            return reply.code(e.status).send({ error: 'Conflict', statusCode: e.status, message: e.message })
          }
          if (e instanceof GitlabApiError) {
            const up = gitlabUpstream(e)
            return reply.code(up.status).send({ error: 'Bad Gateway', statusCode: up.status, message: up.message })
          }
          throw e
        }
      }
    )

    r.get(
      '/gitlab/projects',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'List managed GitLab projects',
          description: 'The organization-owned project bindings with their §8.2 lifecycle states.',
          operationId: 'listGitlabProjects',
          response: { 200: GitlabProjectBindingListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.gitlabProjectBinding.listForOrg(orgOf(req))
        return {
          bindings: await Promise.all(
            rows.map(async (row) => bindingToDto(row, await deps.repos.gitlabAgentAccount.listForBinding(row.id)))
          )
        }
      }
    )

    r.post(
      '/gitlab/projects',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Bind a GitLab.com project',
          description:
            'Re-fetches the selected project, requires current Maintainer-or-Owner effective membership, acquires the deployment-global project claim, and creates the binding in the provisioning state (§10.1–§10.2).',
          operationId: 'createGitlabProject',
          body: CreateGitlabProjectBody,
          response: {
            200: GitlabProjectBindingDto,
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
        const projectId = BigInt(req.body.projectId)
        const err = (status: 400 | 403 | 404 | 409, message: string) =>
          reply.code(status).send({ error: 'Conflict', statusCode: status, message })
        const connection = await deps.repos.gitlabConnection.get(orgId, req.body.connectionId)
        if (!connection) return err(404, 'gitlab connection not found')
        if (await deps.repos.gitlabProjectBinding.byProject(orgId, projectId)) {
          return err(409, 'project is already bound in this organization')
        }
        try {
          const token = await gitlab.oauth.withAccessToken(orgId, connection.id)
          // The server re-fetches; the client-supplied id is never trusted for facts (§10.1).
          const project = await gitlabProject(token, projectId, gitlab.fetchImpl)
          if (!project) return err(400, 'project is not accessible through this connection')
          const membership = await gitlabEffectiveMembership(
            token,
            projectId,
            connection.gitlabUserId,
            gitlab.fetchImpl
          )
          if (!membershipSatisfies(membership, GITLAB_ACCESS_MAINTAINER, Date.now())) {
            return err(403, 'Maintainer or Owner access to the project is required for managed installation')
          }
          const binding = await deps.repos.gitlabProjectBinding.createWithClaim({
            orgId,
            projectId,
            projectPath: project.path_with_namespace,
            ...(project.default_branch ? { defaultBranch: project.default_branch } : {}),
            ...(project.http_url_to_repo ? { cloneUrl: project.http_url_to_repo } : {}),
            installerConnectionId: connection.id
          })
          // The §10.2 saga converges the external resources; the binding records
          // the outcome state either way and repair re-runs it.
          await gitlab.provisioner.provision(orgId, binding.id)
          const converged = await deps.repos.gitlabProjectBinding.get(orgId, binding.id)
          return bindingToDto(converged ?? binding, await deps.repos.gitlabAgentAccount.listForBinding(binding.id))
        } catch (e) {
          if (e instanceof GitlabProjectClaimConflict) {
            // The deployment-global claim (§7.2): one managing organization per
            // project; never disclose WHICH organization holds it.
            return err(409, 'project is already claimed by another organization')
          }
          if (e instanceof GitlabOauthDenied) {
            return reply.code(e.status).send({ error: 'Conflict', statusCode: e.status, message: e.message })
          }
          if (e instanceof GitlabApiError) {
            const up = gitlabUpstream(e)
            return reply.code(up.status).send({ error: 'Bad Gateway', statusCode: up.status, message: up.message })
          }
          throw e
        }
      }
    )

    r.post(
      '/gitlab/projects/:id/repair',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Repair a managed GitLab project',
          description:
            'Re-runs the §10.2 provisioning convergence: refresh identity, service account, credentials, and the managed webhook.',
          operationId: 'repairGitlabProject',
          params: IdParam,
          response: { 200: GitlabProjectBindingDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        if (!(await deps.repos.gitlabProjectBinding.get(orgId, req.params.id))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab project not found' })
        }
        await gitlab.provisioner.provision(orgId, req.params.id)
        const binding = await deps.repos.gitlabProjectBinding.get(orgId, req.params.id)
        if (!binding) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab project not found' })
        }
        return bindingToDto(binding, await deps.repos.gitlabAgentAccount.listForBinding(binding.id))
      }
    )

    r.post(
      '/gitlab/projects/:id/transfer',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Take over administration of a GitLab project',
          description:
            "Moves administration of a project whose administering account can no longer act to the caller's own connected GitLab account (§9.4). The Control Plane re-verifies the caller's CURRENT Maintainer-or-Owner membership live, through the caller's own connection, then re-runs the §10.2 convergence under the new account. Eligible in any binding state — including a `cleanup_pending` one, whose interrupted removal can then finish under the new account (§19.4); that state is only reassigned, never re-provisioned. A project whose administering account is still connected and is not degraded is refused. Every refusal carries a machine-readable `code`.",
          operationId: 'transferGitlabProject',
          params: IdParam,
          response: {
            200: GitlabProjectBindingDto,
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
        const notFound = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab project not found' })
        const conflict = (code: string, message: string) =>
          reply.code(409).send({ error: 'Conflict', statusCode: 409, message, code })
        const binding = await deps.repos.gitlabProjectBinding.get(orgId, req.params.id)
        if (!binding) return notFound()
        // Takeover authority is the CALLER's own connection, never the org's (§7.1).
        const own = (await deps.repos.gitlabConnection.listForOrg(orgId)).filter(
          (candidate) => candidate.userId === req.principal!.userId
        )
        if (own.length === 0) {
          return conflict('GITLAB_NO_OWN_CONNECTION', 'connect your own GitLab account before taking over a project')
        }
        // Newest wins when one user connected two GitLab identities to this organization.
        const mine = own.filter((candidate) => candidate.state === 'connected').at(-1)
        if (!mine) {
          return conflict('GITLAB_CONNECTION_NOT_CONNECTED', 'reconnect your own GitLab account first')
        }
        const installer = binding.installerConnectionId
          ? await deps.repos.gitlabConnection.get(orgId, binding.installerConnectionId)
          : null
        // §9.4 offers takeover for administration that is actually stuck: a released
        // or removed installer, or a binding degraded under the current one. A binding
        // awaiting cleanup qualifies whatever its installer row reports — the takeover
        // only reassigns it, and that is what unblocks the interrupted removal (§19.4).
        const stuck = installer?.state !== 'connected'
        if (!stuck && binding.state !== 'admin_degraded' && binding.state !== 'cleanup_pending') {
          return conflict('GITLAB_INSTALLER_CONNECTED', 'a connected GitLab account already administers this project')
        }
        try {
          const outcome = await gitlab.provisioner.transfer(orgId, binding.id, {
            id: mine.id,
            gitlabUserId: mine.gitlabUserId
          })
          if (outcome.outcome === 'binding_missing') return notFound()
          if (outcome.outcome === 'busy') {
            return conflict('GITLAB_BINDING_BUSY', 'project setup or removal is already running — try again shortly')
          }
          if (outcome.outcome === 'not_maintainer') {
            return reply.code(403).send({
              error: 'Forbidden',
              statusCode: 403,
              message: 'Maintainer or Owner access to the project is required to take it over',
              code: 'GITLAB_NOT_MAINTAINER'
            })
          }
          const converged = await deps.repos.gitlabProjectBinding.get(orgId, binding.id)
          if (!converged) return notFound()
          return bindingToDto(converged, await deps.repos.gitlabAgentAccount.listForBinding(binding.id))
        } catch (e) {
          if (e instanceof GitlabOauthDenied) {
            return reply.code(e.status).send({ error: 'Conflict', statusCode: e.status, message: e.message })
          }
          if (e instanceof GitlabApiError) {
            const up = gitlabUpstream(e)
            return reply.code(up.status).send({ error: 'Bad Gateway', statusCode: up.status, message: up.message })
          }
          throw e
        }
      }
    )

    r.delete(
      '/gitlab/projects/:id',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Disconnect a managed GitLab project',
          description:
            'Disables local authority, then removes the managed webhook, revokes the managed tokens, and deletes the Project Service Account (§19.4). Incomplete external cleanup leaves the binding cleanup_pending and keeps the deployment-global claim.',
          operationId: 'deleteGitlabProject',
          params: IdParam,
          response: {
            200: z.object({
              removed: z.boolean(),
              state: GitlabProjectBindingDto.shape.state.optional(),
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
        if (!(await deps.repos.gitlabProjectBinding.get(orgId, req.params.id))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab project not found' })
        }
        const outcome = await gitlab.provisioner.disconnect(orgId, req.params.id)
        if (outcome.removed) return { removed: true }
        const binding = await deps.repos.gitlabProjectBinding.get(orgId, req.params.id)
        return { removed: false, state: binding?.state, stateReason: binding?.stateReason ?? outcome.reason ?? null }
      }
    )

    r.delete(
      '/gitlab/connections/:id',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Disconnect or remove a GitLab.com connection',
          description:
            'On a live connection: revokes the OAuth grant when possible, removes the stored token pair, and keeps the row so its projects can still be listed — project bindings are never deleted implicitly (§9.4). On an already-disconnected connection that administers no projects: removes the row, under a lock that makes a racing project create meet the refusal rather than be detached. Removal is refused with 409 while any project is still assigned to it.',
          operationId: 'disconnectGitlabConnection',
          params: IdParam,
          response: { 200: GitlabConnectionDeleteDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const notFound = () =>
          reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab connection not found' })
        const conflict = (message: string) => reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
        const existing = await deps.repos.gitlabConnection.get(orgId, req.params.id)
        if (!existing) return notFound()
        // Second delete on a released row finishes the job the first one started.
        // The repository re-checks state and count under its own lock; this read
        // only decides which of the two meanings the request has.
        if (existing.state === 'disconnected') {
          const removal = await deps.repos.gitlabConnection.remove(orgId, existing.id)
          if (removal.outcome === 'removed') return { removed: true, connection: null }
          if (removal.outcome === 'missing') return notFound()
          if (removal.outcome === 'blocked') {
            const n = removal.assignedProjects
            return conflict(`connection still administers ${n} managed project${n === 1 ? '' : 's'}`)
          }
          return conflict('gitlab connection is connected again — reload and try once more')
        }
        if (!(await gitlab.oauth.disconnect(orgId, existing.id))) return notFound()
        const record = await deps.repos.gitlabConnection.get(orgId, existing.id)
        if (!record) return notFound()
        const assigned = (await deps.repos.gitlabProjectBinding.countByInstaller(orgId))[existing.id] ?? 0
        return { removed: false, connection: toDto(record, assigned, req.principal!.userId) }
      }
    )
  }
}

export function gitlabOauthRoutes(deps: HttpDeps) {
  return async function gitlabOauthRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gitlab = deps.gitlab
    if (!gitlab) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/gitlab/oauth/begin',
      { schema: { hide: true, querystring: z.object({ state: z.string().min(1).max(128) }) } },
      async (req, reply) => {
        const begun = await gitlab.oauth.begin(req.query.state)
        if (!begun) {
          // Unknown, expired, or already-begun state: uniform failure, restart from the console.
          return reply.redirect(gitlab.oauth.redirectTarget('/', 'state_invalid'))
        }
        const secure = deps.config.PUBLIC_CP_URL?.startsWith('https://') === true
        reply.header(
          'set-cookie',
          `${OAUTH_BROWSER_COOKIE}=${begun.browserNonce}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
        )
        return reply.redirect(begun.redirectUrl)
      }
    )

    r.get(
      '/gitlab/oauth/callback',
      {
        schema: {
          hide: true,
          querystring: z.object({
            code: z.string().max(4096).optional(),
            state: z.string().max(128).optional(),
            error: z.string().max(128).optional()
          })
        }
      },
      async (req, reply) => {
        const { redirectPath, result } = await gitlab.oauth.callback(
          req.query.state,
          req.query.error ? undefined : req.query.code,
          browserCookie(req)
        )
        // The one-shot cookie has served its purpose either way.
        reply.header('set-cookie', `${OAUTH_BROWSER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`)
        return reply.redirect(gitlab.oauth.redirectTarget(redirectPath, result))
      }
    )
  }
}
