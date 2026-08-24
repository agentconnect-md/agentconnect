/**
 * `http/server.ts` (design §2.1) — `buildHttpServer(deps)`: the C2 BFF Fastify
 * instance. Installs the zod type provider (validator + bigint-safe serializer),
 * registers the `humanAuth` plane (devAuth stub or OIDC by config), mounts every
 * route plugin, and installs the error mapper that turns zod validation /
 * serialization failures and thrown errors into stable JSON problem responses.
 *
 * Shared by production (`container.ts`) and tests (`build-http.ts`): the same
 * graph, with the repos/registry/auth/events seams injected either real (Prisma)
 * or faked. No `@prisma/client` import here — only ports.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions
} from 'fastify'
import cors from '@fastify/cors'
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod'
import type { HttpDeps } from './deps.js'
import { createIdentityWarmTrigger } from './identity-warm.js'
import { installZod } from './plugins/zod.js'
import { installOpenapi } from './plugins/openapi.js'
import { humanAuthPlugin } from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { runtimeConfigRoutes } from './routes/runtime-config.js'
import { daemonRoutes } from './routes/daemons.js'
import { memberSetRoutes } from './routes/member-sets.js'
import { keyRoutes } from './routes/keys.js'
import { agentRoutes } from './routes/agents.js'
import { agentRepoRoutes } from './routes/agent-repos.js'
import { webchatTokenRoutes } from './routes/webchat-token.js'
import { webchatMcpOperationRoutes } from './routes/webchat-mcp-operations.js'
import { integrationRoutes } from './routes/integrations.js'
import { botRoutes } from './routes/bots.js'
import { mcpProviderRoutes } from './routes/mcp-providers.js'
import { skillSourceRoutes } from './routes/skill-sources.js'
import { organizationKnowledgeRoutes } from './routes/organization-knowledge.js'
import { organizationEnvironmentRoutes } from './routes/organization-environment.js'
import { connectorRoutes } from './routes/connectors.js'
import { memoryConnectionRoutes } from './routes/memory-connections.js'
import { githubRoutes, githubCallbackRoutes } from './routes/github.js'
import { gitlabRoutes, gitlabOauthRoutes } from './routes/gitlab.js'
import { agentIconRoutes } from './routes/agent-icon.js'
import { orgIconRoutes } from './routes/org-icon.js'
import { iconUploadRoutes } from './routes/icon-upload.js'
import { memberRoutes } from './routes/members.js'
import { orgInviteAcceptRoutes, orgInviteLinkRoutes } from './routes/org-invite-links.js'
import { meRoutes } from './routes/me.js'
import { meSocialIdentityRoutes } from './routes/me-social-identities.js'
import { waitlistRoutes } from './routes/waitlist.js'
import { meKeyRoutes } from './routes/me-keys.js'
import { orgRoutes, orgScopedRoutes } from './routes/orgs.js'
import { makeOrgScope } from './org-scope.js'
import { cronRoutes } from './routes/crons.js'
import { hookRoutes } from './routes/hooks.js'
import { sessionRoutes } from './routes/sessions.js'
import { usageRoutes } from './routes/usage.js'
import { usageServiceAuth, unlessUsageService } from './usage-service-auth.js'
import { internalUsageRoutes } from './routes/internal-usage.js'
import { streamRoutes } from './routes/stream.js'
import { mcpRoutes } from './mcp/routes.js'
import { oauthConsentRoutes } from './oauth/consent.js'
import { oauthMetadataRoutes } from './oauth/metadata.js'
import { oauthRoutes } from './oauth/routes.js'
import { API_V1_PREFIX } from './version.js'
import type { CpRouteScope } from '../platforms/provider.js'
import { controlPlaneOtelFastifyPlugin } from '../observability.js'

export function buildHttpServer(deps: HttpDeps, opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, ...opts })

  /**
   * Every registered platform's route plugins for one mount scope
   * (integration-plugin-architecture.md §9 `installRoutes`). Core mounts what
   * the registry hands back and names no platform: the Slack quick-install and
   * platform-app funnels, the Slack config-token surface and the Feishu
   * one-click registration used to be five hand-listed imports here.
   *
   * Two scopes, and the PATHS ARE UNCHANGED BY CONSTRUCTION — a plugin declares
   * its own routes, so mounting it from the registry instead of from an import
   * moves nothing (`src/http/platform-route-mounts.test.ts` pins the table).
   * The registration ORDER follows the registry rather than the old literal
   * list; Fastify's radix router is order-independent for distinct paths.
   *
   * A plugin may still self-disable when its config is absent (the platform-app
   * funnel returns early without SLACK_PLATFORM_* + PUBLIC_CP_URL) — "the routes
   * 404" stays the feature flag.
   */
  const platformRoutes = (scope: CpRouteScope): FastifyPluginAsync[] =>
    deps.platforms.all().flatMap((provider) => provider.installRoutes(scope))

  const otelPlugin = controlPlaneOtelFastifyPlugin()
  if (otelPlugin) void app.register(otelPlugin)

  // zod validator + (bigint-safe) serializer — must precede route registration.
  installZod(app)

  // OpenAPI 3.1 generation + interactive docs: the raw spec at
  // `/api/v1/openapi.json` (versioned, machine-readable) and Swagger-UI at
  // `/docs` (root, unversioned — human tooling). Registered here — before the
  // route plugins below — so `@fastify/swagger`'s `onRoute` hook captures them
  // and builds the spec straight from the zod DTO schemas each route declares.
  installOpenapi(app, { ...(deps.config.PUBLIC_CP_URL ? { publicUrl: deps.config.PUBLIC_CP_URL } : {}) })

  // Browser CORS for the Web UI (C2). Explicit CORS_ORIGIN wins; otherwise reflect
  // any origin in development and stay disabled in production. Bearer-token auth
  // (not cookies) so credentials are off and `*`/reflection are safe.
  const corsOrigin =
    deps.config.CORS_ORIGIN !== undefined
      ? deps.config.CORS_ORIGIN === '*'
        ? true
        : deps.config.CORS_ORIGIN.split(',').map((o) => o.trim())
      : deps.config.NODE_ENV !== 'production'
  // @fastify/cors v11 defaults `methods` to GET,HEAD,POST — without this the
  // PUT/PATCH/DELETE routes (cron upsert; rename/delete daemon, delete agent/key/cron)
  // fail the browser preflight ("Failed to fetch") even though the route exists.
  if (corsOrigin)
    void app.register(cors, { origin: corsOrigin, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] })

  // C2 human-auth plane (devAuth stub unless OIDC_ISSUER is set). Non-encapsulated
  // (fastify-plugin) so `app.humanAuth` is visible to every route plugin. The user
  // repo is injected as the JIT resolver so a verified OIDC `sub` maps to a local
  // user/org (only consulted on the OIDC path; the devAuth stub ignores it). The
  // API-key verifier lets a dot-free `Authorization: Bearer <key>` authenticate as a
  // personal key in front of the JWT/dev path (daemon-api-key-auth.md §8).
  void app.register(humanAuthPlugin, {
    ...deps.config,
    resolveUser: (input) => deps.repos.user.provisionOidcUser(input),
    verifyApiKey: (token) => deps.apiKeys.authenticateUser(token),
    internalInvocationAuth: deps.internalInvocationAuth,
    // Identity warm-at-touch (session-access-cold-visit.md §3): every authenticated
    // request pre-warms the caller's Logto projection so a cold `/sessions` finds it
    // fresh instead of blocking on the serial identity lookup.
    ...(deps.logtoIdentity
      ? {
          ensureIdentityFresh: createIdentityWarmTrigger({
            identity: deps.logtoIdentity,
            users: deps.repos.user,
            clock: deps.clock,
            log: { debug: (o, m) => app.log.debug(o, m) }
          })
        }
      : {}),
    // Lets the plane notice an account deleted underneath a live session (→ 401
    // ACCOUNT_GONE, which drives the console to sign out) instead of serving
    // requests for an identity that is no longer there.
    principalExists: (userId) => deps.repos.user.exists(userId),
    // …and makes that observation outlive this process, so a restart cannot hand a
    // still-live pre-deletion bearer a brand-new account.
    deletedIdentities: {
      read: (oidcSubject, now) => deps.repos.user.deletedIdentityCutoff(oidcSubject, now),
      record: (oidcSubject, cutoffAt, expiresAt) =>
        deps.repos.user.recordDeletedIdentity(oidcSubject, cutoffAt, expiresAt)
    }
  })

  // Map zod validation/serialization failures + Prisma "record not found" to
  // stable problem responses (design §2.1 "error mapper").
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'Bad Request',
        statusCode: 400,
        message: 'request does not match schema',
        details: { issues: err.validation, method: req.method, url: req.url }
      })
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response serialization error')
      return reply.code(500).send({
        error: 'Internal Server Error',
        statusCode: 500,
        message: 'response does not match schema'
      })
    }
    // Prisma "record to delete/update does not exist", a membership-dependent
    // mutation whose required membership disappeared while it was queued, or an
    // org-fenced mutation whose row vanished (or never belonged to the caller's
    // org) between the route's pre-read and the write — the fence deliberately
    // makes those indistinguishable (org-scoped-data-layer.md §3). Every
    // `<Resource>Missing` code the data layer can raise belongs in this list.
    if (
      (err as { code?: string }).code === 'P2025' ||
      (err as { code?: string }).code === 'ORG_MEMBERSHIP_MISSING' ||
      (err as { code?: string }).code === 'AGENT_MISSING' ||
      (err as { code?: string }).code === 'BOT_MISSING' ||
      (err as { code?: string }).code === 'CRON_MISSING' ||
      (err as { code?: string }).code === 'HOOK_MISSING'
    ) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'resource not found' })
    }
    // Prisma unique-constraint violation (e.g. duplicate agent slug in an org).
    if ((err as { code?: string }).code === 'P2002') {
      return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'resource already exists' })
    }
    // Workspace-claim admission fence (ingress-tenant-fence.md §5). The message
    // deliberately never names the organization holding the workspace.
    if ((err as { code?: string }).code === 'BOT_WORKSPACE_CLAIMED') {
      return reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message:
          err instanceof Error && err.message
            ? err.message
            : 'this workspace is already connected to another organization'
      })
    }
    if ((err as { code?: string }).code === 'ORG_OWNER_REQUIRED') {
      return reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message: 'an organization needs at least one owner'
      })
    }
    if ((err as { code?: string }).code === 'RESOURCE_AUDIENCE_EMPTY') {
      return reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message: 'Selected access requires at least one current organization member'
      })
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500
    if (status >= 500) req.log.error({ err }, 'unhandled error')
    return reply.code(status).send({
      error: status >= 500 ? 'Internal Server Error' : err.name,
      statusCode: status,
      message: status >= 500 ? 'internal server error' : err.message
    })
  })

  // Routes (each a Fastify plugin; closures capture `deps`).
  //
  // `GET /health` stays at the ROOT, unversioned — an infra liveness probe the
  // deployment hits at a stable path (versioning a probe is an anti-pattern).
  //
  // Everything else is the versioned public REST surface, mounted under
  // `/api/v1` (see `version.ts`) so the API is externally versioned from day one.
  // Within it: the caller's org list/create + profile at the version root, and
  // every resource org-scoped under `/api/v1/orgs/:orgId` behind humanAuth + the
  // org-scope guard (membership check → `req.orgCtx`), so every resource URL
  // names its tenant and cross-org access reads as 404.
  void app.register(healthRoutes(deps))
  // Embedded OAuth AS (agent-assistant.md §7) — discovery + protocol endpoints at the ROOT
  // (unauthenticated auth-bootstrap surface): the .well-known metadata + /oauth/{register,
  // authorize,token}. Hand-rolled Fastify over `OAuthService` (the MCP SDK dropped its
  // embedded-AS helpers in v2; the spec keeps AS internals out of scope). /authorize
  // redirects to the web console consent page — the CP holds no browser session.
  void app.register(oauthMetadataRoutes(deps))
  void app.register(oauthRoutes(deps))
  void app.register(
    async (api) => {
      await api.register(runtimeConfigRoutes(deps.runtimeConfig))
      await api.register(orgRoutes(deps))
      await api.register(meRoutes(deps))
      await api.register(meSocialIdentityRoutes(deps))
      await api.register(meKeyRoutes(deps))
      await api.register(waitlistRoutes(deps))
      // Service-authenticated usage ingress — version root, OUTSIDE the org subtree
      // and outside `humanAuth`: it carries its own deployment secret and its org
      // comes from each report's agent, not the URL. Self-disables when unconfigured.
      await api.register(internalUsageRoutes(deps))
      await api.register(orgInviteAcceptRoutes(deps))
      // OAuth consent BACKEND (agent-assistant.md §7.3) — version root, guarded
      // inside its plugin by interactive human auth for the console session.
      await api.register(oauthConsentRoutes(deps))
      // Unauthenticated GitHub setup callback (browser redirect; org rides the
      // signed state) — version root, deliberately OUTSIDE the org subtree.
      await api.register(githubCallbackRoutes(deps))
      // Unauthenticated GitLab OAuth begin/callback hops (browser redirects; the
      // one-shot state row carries the org) — version root, outside the org subtree.
      await api.register(gitlabOauthRoutes(deps))
      // Unauthenticated PLATFORM callbacks from the registry (§9
      // `installRoutes('public-callback')`) — browser redirects whose state
      // rides the OAuth exchange: today the Slack quick-install callback and its
      // platform-app sibling (preset-agents.md §5.3). Same version-root
      // placement as the GitHub one, and mounted AGAIN at the public `/v1`
      // alias below, because a handed-out callback URL leaves the system in the
      // public form.
      for (const plugin of platformRoutes('public-callback')) await api.register(plugin)
      // Unauthenticated agent avatar PNG (Slack fetches it as the per-message
      // icon_url; no bearer, no org — only the agent UUID). Handed-out URL uses
      // the public `/v1` form, aliased below.
      await api.register(agentIconRoutes(deps))
      // Unauthenticated org avatar PNG (console `<img src>`; no bearer). Same
      // version-root placement + `/v1` alias as the agent icon endpoint.
      await api.register(orgIconRoutes(deps))
      // AgentConnect MCP — version root, OUTSIDE the org subtree: the org is
      // resolved from the personal API key's binding, not the URL
      // (docs/designs/agent-assistant.md §6.1). Mounted again at the public
      // `/v1` alias below; the handed-out URL is `<PUBLIC_CP_URL>/v1/mcp`.
      await api.register(mcpRoutes(deps))
      await api.register(
        async (scope) => {
          // preValidation, not preHandler: zod validation strips params a route's
          // schema doesn't declare (the prefix's `orgId`), and it runs BEFORE
          // preHandler — the guard must read the raw params first.
          scope.addHook('preValidation', scope.humanAuth)
          scope.addHook('preValidation', makeOrgScope(deps.repos.org))
          await scope.register(orgScopedRoutes(deps))
          await scope.register(daemonRoutes(deps))
          await scope.register(memberSetRoutes(deps))
          await scope.register(keyRoutes(deps))
          await scope.register(agentRoutes(deps))
          await scope.register(agentRepoRoutes(deps))
          await scope.register(webchatTokenRoutes(deps))
          await scope.register(webchatMcpOperationRoutes(deps))
          await scope.register(integrationRoutes(deps))
          // Org-scoped platform routes from the registry (§9 `installRoutes('org')`):
          // the install funnels' wizard endpoints and the per-user provider tooling
          // credential surface (Slack's App Configuration token).
          for (const plugin of platformRoutes('org')) await scope.register(plugin)
          await scope.register(botRoutes(deps))
          await scope.register(mcpProviderRoutes(deps))
          await scope.register(skillSourceRoutes(deps))
          await scope.register(organizationKnowledgeRoutes(deps))
          await scope.register(organizationEnvironmentRoutes(deps))
          await scope.register(connectorRoutes(deps))
          await scope.register(memoryConnectionRoutes(deps))
          await scope.register(memberRoutes(deps))
          await scope.register(orgInviteLinkRoutes(deps))
          await scope.register(cronRoutes(deps))
          await scope.register(hookRoutes(deps))
          await scope.register(sessionRoutes(deps))
          await scope.register(streamRoutes(deps))
          await scope.register(githubRoutes(deps))
          await scope.register(gitlabRoutes(deps))
          // Uploaded-icon write surface — mounted ONLY when the object store is
          // configured; absent ⇒ the routes don't exist and the console hides Upload.
          if (deps.iconStore) await scope.register(iconUploadRoutes(deps))
        },
        { prefix: '/orgs/:orgId' }
      )
      // The usage aggregate takes EITHER credential, so it gets its own scope rather
      // than the shared human one: a settlement job authenticates as a workload and has
      // no membership row, and widening the hooks every org route sits behind — to
      // admit a service principal for the sake of one read — is how an auth change
      // reaches routes nobody meant to open. Same path, same prefix, narrower blast
      // radius. `humanAuth` and the org scope stand down only once the workload is
      // verified; every other request reaches them exactly as before.
      await api.register(
        async (scope) => {
          scope.addHook('preValidation', usageServiceAuth(deps))
          scope.addHook('preValidation', unlessUsageService(scope.humanAuth))
          scope.addHook('preValidation', unlessUsageService(makeOrgScope(deps.repos.org)))
          await scope.register(usageRoutes(deps))
        },
        { prefix: '/orgs/:orgId' }
      )
    },
    { prefix: API_V1_PREFIX }
  )

  // PUBLIC-prefix alias for the routes whose URLs are handed OUT of the system.
  // Externally the versioned API lives under `/v1` (the edge rewrites it to the
  // internal `/api/v1`), and these URLs leave in that public form: the OAuth
  // callbacks (SLACK_OAUTH_CALLBACK_PATH; the GitHub App's Setup URL) and the
  // AgentConnect MCP endpoint (MCP_PUBLIC_PATH — the canonical resource URL users
  // paste into claude.ai / Claude Code; RFC 9728 clients validate it byte-for-byte).
  // A direct-hit deploy (local dev, no rewriting edge) has nothing mapping `/v1`
  // back to `/api/v1` — mount the same plugins at `/v1` so the public form routes
  // in both shapes.
  void app.register(
    async (pub) => {
      await pub.register(githubCallbackRoutes(deps))
      await pub.register(gitlabOauthRoutes(deps))
      // The SAME platform callback plugins as the `/api/v1` mount above — the
      // deliberate double mount (§9: "core mounts this scope twice"), so a
      // callback URL handed out in the public form routes in both shapes.
      for (const plugin of platformRoutes('public-callback')) await pub.register(plugin)
      await pub.register(agentIconRoutes(deps))
      await pub.register(orgIconRoutes(deps))
      await pub.register(mcpRoutes(deps))
    },
    { prefix: '/v1' }
  )

  return app
}
