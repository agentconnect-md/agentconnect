/**
 * The PINNED platform mount table (integration-plugin-architecture.md §9).
 *
 * `server.ts` no longer imports the five funnel-route factories: it asks every
 * registered provider for `installRoutes(scope)` and mounts what comes back, at
 * the org scope and — twice — at the public-callback scope. That refactor is
 * only safe if the URLs do not move: **the public callbacks are external
 * contracts**. They are baked into a Slack app's OAuth redirect list and into
 * the deployment gateway's routing, and this repo has already been bitten by a
 * public-prefix/internal-prefix mismatch turning a live callback into a 404.
 *
 * So this suite pins paths × scopes × plugin, and it does it by ENUMERATION,
 * never by re-stating the new code:
 *
 *  1. each plugin is mounted ALONE in a bare Fastify app to learn which routes
 *     it declares (the plugin is the authority for its own paths);
 *  2. the whole server is built and its complete route table captured through
 *     an `onRoute` hook (Fastify is the authority for where they landed);
 *  3. the table below — copied from the pre-refactor server's actual output —
 *     is the pin, so a plugin that silently stops declaring a route, or lands
 *     at one prefix instead of two, fails here.
 *
 * The funnels self-disable without their config, so the stub deps deliberately
 * ENABLE every one of them (`slackConfigApi`, `slackPlatformApp`,
 * `PUBLIC_CP_URL`) — otherwise the suite would happily pin an empty table. The
 * last test covers the other silent loss a registry-driven mount can cause: the
 * OpenAPI conventions on contributed routes.
 */
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import { buildHttpServer } from './server.js'
import { installZod } from './plugins/zod.js'
import type { HttpDeps } from './deps.js'
import type { CpPlatformRegistry, CpRouteScope } from '../platforms/provider.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createTelegramCpProvider } from '../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../platforms/discord/provider.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'
import { createLinearCpProvider } from '../platforms/linear/provider.js'
import { LinearApiClient } from '../platforms/linear/api.js'
import { LinearTokenService } from '../platforms/linear/token-service.js'
import { linearConnectRoutes, linearOauthCallbackRoutes } from '../platforms/linear/routes.js'
import { slackInstallRoutes, slackConfigRoutes, slackOauthCallbackRoutes } from './routes/slack-install.js'
import { slackPlatformInstallRoutes, slackPlatformCallbackRoutes } from './routes/slack-platform-install.js'
import { feishuRegistrationRoutes } from './routes/feishu-registration.js'
import { slackBotRefreshRoutes } from './routes/slack-bot-refresh.js'
import { telegramCheckRoutes } from './routes/telegram-check.js'
import type { FeishuRouteSeams, LinearRouteSeams, SlackRouteSeams, TelegramRouteSeams } from './platform-route-seams.js'

/**
 * TODAY'S TABLE — captured from the routing table the pre-refactor `server.ts`
 * produced with these same deps. Paths are relative to their scope's prefix;
 * `HEAD` (Fastify's automatic twin of every GET) is omitted.
 */
const EXPECTED_MOUNTS: Record<CpRouteScope, Record<string, string[]>> = {
  org: {
    slackInstallRoutesPlugin: [
      'POST /integrations/slack/app',
      'GET /integrations/slack/app/:id',
      'POST /integrations/slack/app/:id/finalize'
    ],
    slackPlatformInstallRoutesPlugin: [
      'POST /integrations/slack/platform-install',
      'GET /integrations/slack/platform-install/:id'
    ],
    // The §9 `providerToolingCredentials` surface (Slack's App Configuration
    // token): status, entry, removal.
    slackConfigRoutesPlugin: ['GET /slack/config', 'PUT /slack/config', 'DELETE /slack/config'],
    // Moved OUT of core `routes/bots.ts` / `routes/integrations.ts` and into the
    // owning provider — the paths are unchanged, which is the whole point of
    // pinning them here (both core route sets register into this same scope).
    slackBotRefreshRoutesPlugin: ['POST /bots/:id/slack/refresh'],
    telegramCheckRoutesPlugin: ['POST /integrations/telegram/check'],
    feishuRegistrationRoutesPlugin: ['POST /integrations/feishu/app', 'GET /integrations/feishu/app/:id'],
    linearConnectRoutesPlugin: [
      'POST /integrations/linear/connect',
      'GET /integrations/linear/connect/:id',
      'POST /bots/:id/linear/reconnect'
    ]
  },
  'public-callback': {
    slackOauthCallbackRoutesPlugin: ['GET /integrations/slack/oauth/callback'],
    slackPlatformCallbackRoutesPlugin: ['GET /integrations/slack/platform/callback'],
    linearOauthCallbackRoutesPlugin: ['GET /integrations/linear/oauth/callback']
  }
}

/** Where each scope is mounted. `public-callback` is mounted TWICE on purpose:
 *  the internal versioned root and the public `/v1` alias the edge rewrites to
 *  it, because a handed-out callback URL leaves the system in the public form. */
const SCOPE_PREFIXES: Record<CpRouteScope, string[]> = {
  org: ['/api/v1/orgs/:orgId'],
  'public-callback': ['/api/v1', '/v1']
}

/** Minimal deps with every funnel's feature flag ON. Handlers are never invoked
 *  (this suite only inspects the routing table and the generated spec), so the
 *  repos and API clients can stay hollow. */
function stubDeps(): { deps: HttpDeps; assignRegistry: (registry: CpPlatformRegistry) => void } {
  let registry: CpPlatformRegistry | undefined
  const deps = {
    repos: { user: { provisionOidcUser: async () => ({ userId: 'u' }) } },
    get platforms(): CpPlatformRegistry {
      if (!registry) throw new Error('platform registry read before composition')
      return registry
    },
    config: {
      NODE_ENV: 'test',
      DEFAULT_OWNER_ID: '00000000-0000-4000-8000-000000000000',
      PUBLIC_CP_URL: 'https://cp.example.test',
      PUBLIC_RELAY_URL: 'https://relay.example.test'
    }
  } as unknown as HttpDeps
  return { deps, assignRegistry: (r) => (registry = r) }
}

/** Route seams with every funnel's feature flag ON: presence of `configApi` /
 *  `platformApp` is what makes the two Slack funnels register at all. Handlers
 *  are never invoked here, so they can stay hollow. */
const SLACK_SEAMS = {
  configApi: {},
  platformApp: { appId: 'A1', clientId: 'c', clientSecret: 's', signingSecret: 'sig' }
} as unknown as SlackRouteSeams
const TELEGRAM_SEAMS = { verifyBot: async () => ({ status: 'unreachable' }) } as unknown as TelegramRouteSeams
const FEISHU_SEAMS = { configureHttpApp: async () => {}, registrations: {} } as unknown as FeishuRouteSeams
/** Linear's funnel registers only with the deployment app configured — that presence IS its flag. */
const LINEAR_API = new LinearApiClient()
const LINEAR_SEAMS: LinearRouteSeams = {
  app: { clientId: 'lin_client', clientSecret: 'lin_secret', signingSecret: 'lin_signing' },
  api: LINEAR_API,
  tokens: {} as unknown as LinearTokenService
}

/** The production provider set, with the route plugins pre-bound exactly as
 *  `buildContainer` pre-binds them. */
function productionPlatforms(deps: HttpDeps): CpPlatformRegistry {
  return buildCpPlatformRegistry([
    createTelegramCpProvider({
      verifyBot: async () => ({ status: 'unreachable' }),
      funnelRoutes: { org: [telegramCheckRoutes(deps, TELEGRAM_SEAMS)], publicCallback: [] }
    }),
    createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
    createSlackCpProvider({
      funnelRoutes: {
        org: [
          slackInstallRoutes(deps, SLACK_SEAMS),
          slackPlatformInstallRoutes(deps, SLACK_SEAMS),
          slackConfigRoutes(deps, SLACK_SEAMS),
          slackBotRefreshRoutes(deps, SLACK_SEAMS)
        ],
        publicCallback: [slackOauthCallbackRoutes(deps, SLACK_SEAMS), slackPlatformCallbackRoutes(deps, SLACK_SEAMS)]
      }
    }),
    createFeishuCpProvider({
      funnelRoutes: { org: [feishuRegistrationRoutes(deps, FEISHU_SEAMS)], publicCallback: [] }
    }),
    createLinearCpProvider({
      app: LINEAR_SEAMS.app!,
      funnelRoutes: {
        org: [linearConnectRoutes(deps, LINEAR_SEAMS)],
        publicCallback: [linearOauthCallbackRoutes(deps, LINEAR_SEAMS)]
      }
    })
  ])
}

/** Every `METHOD url` Fastify registered, captured from the instance itself. */
async function routeTableOf(app: FastifyInstance): Promise<string[]> {
  const seen: string[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) if (method !== 'HEAD') seen.push(`${method} ${route.url}`)
  })
  await app.ready()
  return [...new Set(seen)].sort()
}

/** What ONE plugin declares, learned by mounting it alone. */
async function routesDeclaredBy(plugin: FastifyPluginAsync): Promise<string[]> {
  const app = Fastify({ logger: false })
  installZod(app)
  void app.register(plugin)
  try {
    return await routeTableOf(app)
  } finally {
    await app.close()
  }
}

async function builtServer(): Promise<{ app: FastifyInstance; routes: string[]; platforms: CpPlatformRegistry }> {
  const { deps, assignRegistry } = stubDeps()
  const platforms = productionPlatforms(deps)
  assignRegistry(platforms)
  const app = buildHttpServer(deps)
  const routes = await routeTableOf(app)
  return { app, routes, platforms }
}

describe('platform route mounts', () => {
  it('mounts every provider plugin at its pinned paths, and the callbacks at BOTH public prefixes', async () => {
    const { app, routes, platforms } = await builtServer()
    try {
      for (const scope of ['org', 'public-callback'] as const) {
        const plugins = platforms.all().flatMap((provider) => provider.installRoutes(scope))
        const expected = EXPECTED_MOUNTS[scope]
        // The registry contributes exactly the pinned plugins at this scope.
        expect(plugins.map((plugin) => plugin.name).sort()).toEqual(Object.keys(expected).sort())

        for (const plugin of plugins) {
          // …and each one still DECLARES the pinned routes (asked of the plugin,
          // not restated from the mount code).
          const declared = await routesDeclaredBy(plugin)
          expect(declared).toEqual([...expected[plugin.name]!].sort())

          // …which land under every prefix this scope is mounted at.
          for (const prefix of SCOPE_PREFIXES[scope]) {
            for (const route of declared) {
              const [method, path] = route.split(' ') as [string, string]
              expect(routes).toContain(`${method} ${prefix}${path}`)
            }
          }
        }
      }
    } finally {
      await app.close()
    }
  })

  it('leaks no platform route to a prefix it was not mounted at', async () => {
    const { app, routes, platforms } = await builtServer()
    try {
      const orgPaths = (
        await Promise.all(
          platforms.all().flatMap((provider) => provider.installRoutes('org').map((plugin) => routesDeclaredBy(plugin)))
        )
      ).flat()
      const callbackPaths = (
        await Promise.all(
          platforms
            .all()
            .flatMap((provider) => provider.installRoutes('public-callback').map((plugin) => routesDeclaredBy(plugin)))
        )
      ).flat()

      // The org funnels are behind humanAuth + the org guard, never at a public
      // root: no `/v1/orgs/...` alias, no unprefixed twin.
      for (const route of orgPaths) {
        const [method, path] = route.split(' ') as [string, string]
        expect(routes).not.toContain(`${method} /v1/orgs/:orgId${path}`)
        expect(routes).not.toContain(`${method} ${path}`)
      }
      // The callbacks live at the two version roots and nowhere else — in
      // particular NOT inside the org subtree (they are unauthenticated: the org
      // rides the OAuth state).
      for (const route of callbackPaths) {
        const [method, path] = route.split(' ') as [string, string]
        expect(routes).not.toContain(`${method} /api/v1/orgs/:orgId${path}`)
        const mounted = routes.filter((route) => route.startsWith(`${method} `) && route.endsWith(path))
        expect(mounted).toEqual([`${method} /api/v1${path}`, `${method} /v1${path}`])
      }
    } finally {
      await app.close()
    }
  })

  it('a platform composed without route plugins contributes nothing at either scope', async () => {
    const telegram = createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) })
    const discord = createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' })
    for (const provider of [telegram, discord]) {
      expect(provider.installRoutes('org')).toEqual([])
      expect(provider.installRoutes('public-callback')).toEqual([])
    }
  })

  it('serves the two relocated routes at their original core paths, and only there', async () => {
    // §9 moved `POST /bots/:id/slack/refresh` out of `routes/bots.ts` and
    // `POST /integrations/telegram/check` out of `routes/integrations.ts` into
    // their owning providers. Both core route sets and the registry's org plugins
    // register into the SAME `/api/v1/orgs/:orgId` scope, so the public paths are
    // byte-identical — that is the deploy-surface claim, asserted against
    // Fastify's own table rather than restated from the mount code.
    const { app, routes } = await builtServer()
    try {
      for (const path of [
        '/api/v1/orgs/:orgId/bots/:id/slack/refresh',
        '/api/v1/orgs/:orgId/integrations/telegram/check'
      ]) {
        expect(routes.filter((route) => route.endsWith(` ${path}`))).toEqual([`POST ${path}`])
      }
      // Contributed exactly once — a double registration would 500 at boot, but
      // pin the count so a stray second mount is caught here instead.
      expect(routes.filter((route) => route.includes('/slack/refresh'))).toHaveLength(1)
      expect(routes.filter((route) => route.includes('/integrations/telegram/check'))).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('keeps the repo OpenAPI conventions on every contributed org route', async () => {
    const { app } = await builtServer()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as {
        paths: Record<
          string,
          Record<string, { tags?: string[]; summary?: string; description?: string; operationId?: string }>
        >
      }
      const documented = Object.values(EXPECTED_MOUNTS.org)
        .flat()
        .map((route) => {
          const [method, path] = route.split(' ') as [string, string]
          return { method: method.toLowerCase(), url: `/api/v1/orgs/{orgId}${path.replace(/:(\w+)/g, '{$1}')}` }
        })

      const operationIds: string[] = []
      for (const { method, url } of documented) {
        const op = doc.paths[url]?.[method]
        expect(op, `${method.toUpperCase()} ${url} is missing from the OpenAPI document`).toBeTruthy()
        expect(op!.tags?.length, `${url} has no tags`).toBeTruthy()
        expect(op!.summary, `${url} has no summary`).toBeTruthy()
        expect(op!.description, `${url} has no description`).toBeTruthy()
        expect(op!.operationId, `${url} has no operationId`).toBeTruthy()
        operationIds.push(op!.operationId!)
      }
      expect(new Set(operationIds).size).toBe(operationIds.length)
    } finally {
      await app.close()
    }
  })
})
