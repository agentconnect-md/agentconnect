/**
 * `http/routes/github.ts` — GitHub App installations for github-app workspaces
 * (docs/designs/github-app-git-credentials.md §HTTP Routes).
 *
 * TWO plugins:
 *  - `githubRoutes` mounts inside the `/orgs/:orgId` subtree (humanAuth +
 *    org-scope run as subtree hooks): app status + install link, installations
 *    list, sync, owner-only uninstall, and the repo/branch picker proxies.
 *    Installations are infrastructure-class in the visibility taxonomy (like
 *    bots) — org-visible, never restricted, NOT filtered by canView.
 *  - `githubCallbackRoutes` mounts at the API version root, UNAUTHENTICATED
 *    (GitHub redirects a browser here; the org being claimed rides the signed
 *    one-shot `state`). Hidden from the published OpenAPI spec.
 *
 * When the deployment has no GITHUB_APP_* config, `deps.github` is absent and
 * none of these routes register — the whole surface 404s.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { GithubInstallationRecord } from '../../persistence/ports.js'
import { OrgId } from '../../domain/ids.js'
import { GithubApiError } from '../../github/api.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { GithubInstallationClaimConflict } from '../../persistence/errors.js'
import { orgOf, denyViewerWrite, denyNonOwner } from '../rbac.js'
import {
  ErrorDto,
  GithubAppDto,
  GithubBranchListDto,
  GithubInstallationListDto,
  GithubOwnerRepoParam,
  GithubRepoAccessDto,
  GithubRepoDto,
  GithubRepoPageDto,
  GithubRepoPageQuery,
  IdParam
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { resolveWebAppUrl } from '../../config/env.js'

function installationSettingsUrl(i: GithubInstallationRecord): string {
  return i.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(i.accountLogin)}/settings/installations/${i.installationId}`
    : `https://github.com/settings/installations/${i.installationId}`
}

/** Derive the effect-authorizing Checks fact from the persisted installation
 * snapshot. This intentionally does not consult the coarse App-upgrade probe:
 * that status may cover unrelated permission changes. */
export function checksPermissionFromPersisted(
  permissions: GithubInstallationRecord['permissions']
): 'write' | 'missing' | 'unknown' {
  if (permissions?.checks === 'write') return 'write'
  if (Object.keys(permissions ?? {}).length === 0) return 'unknown'
  return 'missing'
}

export function pullRequestsPermissionFromPersisted(
  permissions: GithubInstallationRecord['permissions']
): 'read' | 'write' | 'missing' | 'unknown' {
  if (permissions?.pull_requests === 'write') return 'write'
  if (permissions?.pull_requests === 'read') return 'read'
  if (Object.keys(permissions ?? {}).length === 0) return 'unknown'
  return 'missing'
}

export function githubInstallationToDto(i: GithubInstallationRecord, outdated: ReadonlyMap<string, string> | null) {
  const installationId = i.installationId.toString()
  return {
    id: i.id,
    installationId: Number(i.installationId), // ~1e9 — well within 2^53
    accountLogin: i.accountLogin,
    accountType: i.accountType,
    repositorySelection: i.repositorySelection,
    suspended: i.suspendedAt !== null,
    permissionsStatus:
      outdated === null
        ? ('unknown' as const)
        : outdated.has(installationId)
          ? ('outdated' as const)
          : ('current' as const),
    pullRequestsPermission: pullRequestsPermissionFromPersisted(i.permissions),
    checksPermission: checksPermissionFromPersisted(i.permissions),
    settingsUrl: outdated?.get(installationId) || installationSettingsUrl(i),
    createdAt: i.createdAt.toISOString()
  }
}

function githubUpstreamFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof GithubApiError) {
    const status = e.code === 'RATE_LIMITED' ? 429 : 502
    return reply.code(status).send({
      error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
      statusCode: status,
      message: `github: ${e.message}`
    })
  }
  if (e instanceof LogtoApiError) {
    // The identity assertion leg failed — the gate fails CLOSED, but as a 502
    // (upstream trouble, retryable) rather than a denial.
    return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
  }
  throw e
}

/** Policy denial from the per-user gate → 403 with a machine-readable code. */
function userAuthzDenied(reply: FastifyReply, e: UserAuthzDeniedError) {
  return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message, code: e.code })
}

/** Exact repository lookup accepts arbitrary names, so every non-visible
 * repository must have one indistinguishable response. */
function githubRepositoryNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'repository not found' })
}

export function githubRoutes(deps: HttpDeps) {
  return async function githubRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gh = deps.github
    if (!gh) return // feature off — no routes, the surface 404s
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/github/app',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'GitHub App status',
          description:
            'Whether github-app workspaces are enabled on this deployment, and a one-shot org-bound link to install the App on GitHub. Minting the link is a connection change — viewers get 403.',
          operationId: 'getGithubApp',
          response: { 200: GithubAppDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        // The install URL embeds a signed state claiming THIS org — that is a
        // write-intent (starts a connection change), so viewers don't get one.
        if (denyViewerWrite(req, reply)) return
        return { enabled: true, slug: gh.slug, installUrl: await gh.installUrl(orgOf(req)) }
      }
    )

    r.get(
      '/github/installations',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'List GitHub installations',
          description:
            "The org's live (non-revoked) installations of the deployment GitHub App — the repo picker's first level. Includes the persisted installation-effective Checks permission separately from GitHub's coarse current/outdated App-upgrade verdict; a transient verdict read reports `unknown` without hiding the durable roster. Org-level infrastructure: visible to every member, never restricted.",
          operationId: 'listGithubInstallations',
          response: { 200: GithubInstallationListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.githubInstallation.listForOrg(orgOf(req))
        let outdated: ReadonlyMap<string, string> | null = null
        try {
          outdated = await gh.outdatedInstallations()
        } catch (err) {
          // The installation roster is durable local metadata; a transient
          // GitHub read must not hide it. Surface an explicit unknown status.
          req.log.warn({ err }, 'github installations: permission status unavailable')
        }
        return rows.map((row) => githubInstallationToDto(row, outdated))
      }
    )

    r.post(
      '/github/installations/sync',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'Sync GitHub installations',
          description:
            "Refresh this organization's existing installation claims from GitHub, mark vanished ones revoked, and update the current/outdated permission verdict. Unknown installations are never claimed by Sync.",
          operationId: 'syncGithubInstallations',
          response: { 200: GithubInstallationListDto, 403: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        try {
          const orgId = orgOf(req)
          const rows = await gh.sync(orgId)
          let outdated: ReadonlyMap<string, string> | null = null
          try {
            // Explicit Sync is also the user's refresh button for permission
            // health, so bypass the short console-read cache.
            outdated = await gh.outdatedInstallations(true)
          } catch (err) {
            req.log.warn({ err }, 'github sync: permission status unavailable')
          }
          // The installation set may have changed — re-converge the org's
          // github hook rules (the relay pool bakes installationIds into each
          // rule). Fire-and-forget: Sync is one of the documented recovery
          // paths for a dropped doorbell, so it must ALSO recover the pool.
          void deps.hooks
            .rebroadcastGithubForOrg(OrgId(orgId))
            .catch((err) => req.log.warn({ err }, 'github sync: hook rebroadcast failed'))
          return rows.map((row) => githubInstallationToDto(row, outdated))
        } catch (e) {
          return githubUpstreamFailure(reply, e)
        }
      }
    )

    r.delete(
      '/github/installations/:id',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'Uninstall a GitHub App installation',
          description:
            'Uninstall the deployment GitHub App from this account (AgentConnect organization owners only), then mark its local provenance revoked and re-converge the organization’s GitHub hook rules. The provenance row is retained so a later reinstall can self-heal existing agents.',
          operationId: 'uninstallGithubInstallation',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        // This call uses the deployment App JWT and therefore bypasses GitHub's
        // human-admin UI gate. Keep that external destructive power owner-only.
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const ins = await deps.repos.githubInstallation.get(orgId, req.params.id)
        if (!ins) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        // DELETE is idempotent at our boundary too: a repeated request after the
        // local revoke does no second GitHub call.
        if (ins.revokedAt) return reply.code(204).send(null)

        try {
          // Remote first. If this fails the live local roster remains honest;
          // GitHub 404/410 are normalized to success by the service.
          await gh.uninstallInstallation(ins.installationId)
        } catch (e) {
          return githubUpstreamFailure(reply, e)
        }
        await deps.repos.githubInstallation.markRevokedByInstallationId(ins.installationId)
        // The remote deletion and local revoke have committed. A relay/DB blip
        // while recompiling must not turn that irreversible success into a 5xx;
        // the installation doorbell or Sync path will retry convergence.
        await deps.hooks
          .rebroadcastGithubForOrg(OrgId(orgId))
          .catch((err) => req.log.warn({ err }, 'github uninstall: hook rebroadcast failed'))
        return reply.code(204).send(null)
      }
    )

    r.get(
      '/github/installations/:id/repositories',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'List installation repositories',
          description:
            'Repositories the installation is granted (paged, max 100/page). With the per-user authorization gate configured, public repositories remain visible while private repositories are filtered to those the CALLER can read on GitHub. Without a linked GitHub identity, only the public subset is returned and `privateReposHidden` is true — no private repository names reach the console. GitHub offers NO server-side search on this listing — the console filters client-side.',
          operationId: 'listGithubInstallationRepositories',
          params: IdParam,
          querystring: GithubRepoPageQuery,
          response: { 200: GithubRepoPageDto, 403: ErrorDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        const ins = await deps.repos.githubInstallation.get(orgOf(req), req.params.id)
        if (!ins || ins.revokedAt) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        try {
          const { repos, totalCount } = await gh.listRepos(ins, req.query.page, req.query.perPage)
          // Per-user gate: drop what the caller can't read — the totalCount
          // stays GitHub's page-independent total (a pager hint, not a promise).
          const visible = deps.githubUserAuthz
            ? await deps.githubUserAuthz.filterReposForUser(
                req.principal!.userId,
                ins,
                repos.map((r) => ({ fullName: r.full_name, private: r.private, repo: r }))
              )
            : { repos: repos.map((r) => ({ repo: r })), privateReposHidden: false }
          return {
            repos: visible.repos.map(({ repo }) => ({
              repoId: String(repo.id),
              fullName: repo.full_name,
              private: repo.private,
              defaultBranch: repo.default_branch,
              description: repo.description,
              updatedAt: repo.pushed_at ?? repo.updated_at ?? null
            })),
            totalCount,
            privateReposHidden: visible.privateReposHidden
          }
        } catch (e) {
          if (e instanceof UserAuthzDeniedError) return userAuthzDenied(reply, e)
          return githubUpstreamFailure(reply, e)
        }
      }
    )

    r.get(
      '/github/installations/:id/repositories/:owner/:repo',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'Resolve an installation repository',
          description:
            'Resolve one owner/repository name through this GitHub App installation. This covers private repositories and repositories beyond the first page of the picker listing without exposing repositories outside the installation grant. The owner must be the installation account: an installation token reads any public repository, so a repository on another account is reported as absent rather than as App-backed.',
          operationId: 'getGithubInstallationRepository',
          params: GithubOwnerRepoParam,
          response: { 200: GithubRepoDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        const ins = await deps.repos.githubInstallation.get(orgOf(req), req.params.id)
        if (!ins || ins.revokedAt) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        // An installation token reads ANY public repository, so a bare
        // `/repos/{owner}/{repo}` would report a repo on an unrelated account as
        // App-backed — and the workspace routes then refuse it on the owner check.
        // Installations are per-account: only this account's repos can be granted.
        if (req.params.owner.toLowerCase() !== ins.accountLogin.toLowerCase()) {
          return githubRepositoryNotFound(reply)
        }
        try {
          // Resolve with this installation's token before returning anything: a
          // 404 includes both uninstalled and missing repos, so it leaks no
          // repository names outside this App grant.
          const repo = await gh.repoRefFor(ins, req.params.owner, req.params.repo)
          if (!repo) return githubRepositoryNotFound(reply)
          // The initial roster is filtered with this same gate. Keep exact
          // lookup equivalent so a typed private name cannot bypass it.
          if (deps.githubUserAuthz) {
            await deps.githubUserAuthz.assertAccess(
              req.principal!.userId,
              ins,
              req.params.owner,
              req.params.repo,
              'read'
            )
          }
          return {
            repoId: repo.repoId.toString(),
            fullName: repo.fullName,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            description: null,
            updatedAt: null
          }
        } catch (e) {
          // Unlike the selected-repository and branch endpoints, this accepts
          // arbitrary names. A 403 here would reveal that an otherwise hidden
          // private repository is covered by this installation, so normalize
          // per-user denials to the same response as a missing repository.
          if (e instanceof UserAuthzDeniedError) return githubRepositoryNotFound(reply)
          return githubUpstreamFailure(reply, e)
        }
      }
    )

    r.get(
      '/github/installations/:id/repositories/:owner/:repo/branches',
      {
        schema: {
          tags: [Tag.GitHub],
          summary: 'List repository branches',
          description:
            'Branch names for the picker (first 100). Uses a contents:read token scoped to the one repository.',
          operationId: 'listGithubRepositoryBranches',
          params: GithubOwnerRepoParam,
          response: { 200: GithubBranchListDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        const ins = await deps.repos.githubInstallation.get(orgOf(req), req.params.id)
        if (!ins || ins.revokedAt) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        try {
          // Per-user gate (when configured): branch listing is the picker's
          // "repo selected" moment — a user without read on the repo learns
          // that HERE, before create even runs.
          if (deps.githubUserAuthz) {
            await deps.githubUserAuthz.assertAccess(
              req.principal!.userId,
              ins,
              req.params.owner,
              req.params.repo,
              'read'
            )
          }
          const names = await gh.listBranches(ins, req.params.owner, req.params.repo)
          return names.map((name) => ({ name }))
        } catch (e) {
          if (e instanceof UserAuthzDeniedError) return userAuthzDenied(reply, e)
          return githubUpstreamFailure(reply, e)
        }
      }
    )

    // Registered only when the identity-assertion gate is configured — the
    // console probes it per picked repo and treats a 404 as "no per-user
    // gating on this deployment" (mirrors the /github/app enablement probe).
    const authz = deps.githubUserAuthz
    if (authz) {
      r.get(
        '/github/installations/:id/repositories/:owner/:repo/access',
        {
          schema: {
            tags: [Tag.GitHub],
            summary: 'My access to a repository',
            description:
              "The caller's own effective GitHub permission on the repository (identity assertion via the sign-in identity — no user OAuth). The console uses it to gate the Allow-push toggle and surface no-access repos before create.",
            operationId: 'getGithubRepositoryAccess',
            params: GithubOwnerRepoParam,
            response: { 200: GithubRepoAccessDto, 403: ErrorDto, 404: ErrorDto, 429: ErrorDto, 502: ErrorDto }
          }
        },
        async (req, reply) => {
          const ins = await deps.repos.githubInstallation.get(orgOf(req), req.params.id)
          if (!ins || ins.revokedAt) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
          }
          try {
            const access = await authz.accessFor(req.principal!.userId, ins, req.params.owner, req.params.repo)
            return {
              permission: access.permission,
              canRead: access.canRead,
              canWrite: access.canWrite,
              identityRequired: access.identityRequired
            }
          } catch (e) {
            if (e instanceof UserAuthzDeniedError) return userAuthzDenied(reply, e)
            return githubUpstreamFailure(reply, e)
          }
        }
      )
    }
  }
}

/**
 * The unauthenticated setup callback — GitHub redirects the installer's browser
 * here after install/update. The Setup URL is configured statically on github.com
 * and must use the PUBLIC prefix: `<PUBLIC_CP_URL>/v1/github/setup/callback` (the
 * edge rewrites `/v1` → the internal `/api/v1`; the bare-`/api/v1` form 404s at
 * the edge). Mounted TWICE by `server.ts` (a sibling of orgRoutes/meRoutes),
 * outside the org subtree: at the internal version root and at the public `/v1`
 * alias for direct-hit deploys. There is no bearer and no :orgId — the claimed
 * org rides the signed one-shot state. `hide: true` keeps a state-bearing
 * endpoint out of the published API docs.
 */
export function githubCallbackRoutes(deps: HttpDeps) {
  return async function githubCallbackRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gh = deps.github
    if (!gh) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/github/setup/callback',
      {
        schema: {
          hide: true,
          querystring: z.object({
            installation_id: z.coerce.number().int().optional(),
            setup_action: z.string().optional(),
            state: z.string().optional()
          })
        }
      },
      async (req, reply) => {
        // 302 target is PINNED to the configured console origin — never a
        // request-supplied URL (open-redirect). Unset ⇒ plain-text fallback.
        const consoleUrl = resolveWebAppUrl(deps.config)
        const back = (note: string) => {
          if (!consoleUrl) {
            return reply.type('text/plain').send(`GitHub App: ${note}. You can close this tab and open the console.`)
          }
          // A verified install is also a clear request to use GitHub. Continue
          // through Profile so an unlinked user can authorize their OWN
          // identity via Logto's state-bound flow; never infer it from the
          // installation account (which may be an organization).
          const path = note === 'installed' ? '/profile' : '/'
          return reply.redirect(`${consoleUrl}${path}?github=${encodeURIComponent(note)}`)
        }

        // Admin-approval flow: a non-admin requested the install — no usable
        // installation yet. After approval the user must restart the org-bound
        // install so a signed callback, rather than an App-wide scan, claims it.
        if (req.query.setup_action === 'request') return back('pending-approval')

        // State passthrough is UNDOCUMENTED GitHub behavior that has regressed
        // before (#61291). Without it there is no tenant-binding proof, so never
        // guess from the App-wide installation roster; ask the user to restart.
        if (!req.query.state || req.query.installation_id === undefined) return back('retry-install')
        try {
          const claimed = await gh.claimFromCallback(req.query.state, req.query.installation_id)
          if (claimed) {
            // A fresh claim can revive github hooks whose previous installation
            // was uninstalled (the `installation:created` doorbell fired before
            // this claim existed and was rightly ignored) — re-converge now.
            void deps.hooks
              .rebroadcastGithubForOrg(claimed.orgId)
              .catch((err) => req.log.warn({ err }, 'github setup callback: hook rebroadcast failed'))
          }
          return back(claimed ? 'installed' : 'retry-install')
        } catch (e) {
          if (e instanceof GithubApiError) {
            // Ownership verify failed (someone else's installation id, GitHub
            // hiccup) — nothing was claimed; restart the signed install flow.
            req.log.warn({ status: e.status }, 'github setup callback verify failed')
            return back('retry-install')
          }
          if (e instanceof GithubInstallationClaimConflict) {
            // Preserve the immutable tenant claim without exposing which other
            // organization owns it through this unauthenticated callback.
            req.log.warn(
              { installationId: e.installationId.toString(), code: e.code },
              'github setup callback: installation already claimed'
            )
            return back('retry-install')
          }
          throw e
        }
      }
    )
  }
}
