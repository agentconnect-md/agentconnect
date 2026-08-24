/**
 * Unit test for the OpenAPI plane (`plugins/openapi.ts`). Builds the WHOLE HTTP
 * server via `buildHttpServer` with stub deps — the spec is generated purely
 * from the routes' zod schemas at registration time, so no repo is ever called
 * (the `/openapi.json` + `/docs` handlers don't touch `deps`). Hence: no Docker,
 * no Postgres — this lives in the fast `unit` project.
 */
import { describe, it, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildHttpServer } from '../server.js'
import type { HttpDeps } from '../deps.js'
import { buildCpPlatformRegistry } from '../../platforms/registry.js'
import { createTelegramCpProvider } from '../../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../../platforms/discord/provider.js'
import { createSlackCpProvider } from '../../platforms/slack/provider.js'
import { createFeishuCpProvider } from '../../platforms/feishu/provider.js'

/** Minimal stub deps: `config` plus the platform registry, which the create
 *  route folds into its documented request body at registration time. Repos
 *  stay untouched because the tests hit only the docs/spec routes (no DB-backed
 *  handler), so the providers' offline seams are never called. */
function stubDeps(): HttpDeps {
  return {
    repos: { user: { provisionOidcUser: async () => ({ userId: 'u' }) } },
    config: { NODE_ENV: 'test', DEFAULT_OWNER_ID: '00000000-0000-4000-8000-000000000000' },
    platforms: buildCpPlatformRegistry([
      createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
      createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
      createSlackCpProvider({}),
      createFeishuCpProvider({})
    ])
  } as unknown as HttpDeps
}

async function buildReady(): Promise<FastifyInstance> {
  const app = buildHttpServer(stubDeps())
  await app.ready()
  return app
}

describe('openapi plane', () => {
  it('serves an OpenAPI 3.1 document at /api/v1/openapi.json', async () => {
    const app = await buildReady()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
      expect(res.statusCode).toBe(200)
      const doc = res.json() as Record<string, any>
      expect(doc.openapi).toBe('3.1.0')
      // `info.version` is the API version ("1"), distinct from the spec version.
      expect(doc.info?.version).toBe('1')
      expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    } finally {
      await app.close()
    }
  })

  it('documents the org-scoped REST surface from the routes’ zod schemas', async () => {
    const app = await buildReady()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      const paths = Object.keys(doc.paths ?? {})
      expect(paths.length).toBeGreaterThan(0)
      // Every documented path lives under the versioned prefix.
      expect(paths.every((p) => p.startsWith('/api/v1/'))).toBe(true)

      // A representative operation carries its request body + typed responses,
      // proving the zod DTOs were transformed into JSON Schema (not just listed).
      const agentsPost = doc.paths?.['/api/v1/orgs/{orgId}/agents']?.post
      expect(agentsPost?.requestBody).toBeTruthy()
      expect(agentsPost?.responses?.['201']).toBeTruthy()

      // A discriminated-union response transforms too, and the operation carries
      // the naming a docs UI needs (without these it renders as a bare path).
      const slackIdentity = doc.paths?.['/api/v1/me/social-identities/slack']?.get
      expect(slackIdentity).toMatchObject({ operationId: 'getMySlackIdentity', tags: ['Profile'] })
      expect(slackIdentity?.summary).toBeTruthy()
      expect(slackIdentity?.responses?.['200']?.content?.['application/json']?.schema).toBeTruthy()
    } finally {
      await app.close()
    }
  })

  it('names the git review reads and keeps every operationId unique', async () => {
    const app = await buildReady()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      const base = '/api/v1/orgs/{orgId}/agents/{id}/workspace'
      const diff = doc.paths?.[`${base}/gitdiff`]?.get
      const log = doc.paths?.[`${base}/gitlog`]?.get
      for (const op of [diff, log]) {
        expect(op).toMatchObject({ tags: ['Agent workspace'] })
        expect(op?.summary).toBeTruthy()
        expect(op?.description).toBeTruthy()
      }
      expect(diff?.operationId).toBe('getAgentWorkspaceGitDiff')
      expect(log?.operationId).toBe('listAgentWorkspaceGitLog')
      // The diff scope is a closed vocabulary in the docs, not a free-form boolean.
      const scope = (diff?.parameters ?? []).find((p: any) => p.name === 'scope')
      expect(scope?.schema?.enum).toEqual(['unstaged', 'staged'])

      // A duplicated operationId makes a docs UI render one route and silently drop
      // the other, so uniqueness is asserted across the WHOLE spec, not just here.
      const ids = Object.values<Record<string, any>>(doc.paths ?? {}).flatMap((item) =>
        Object.values(item)
          .map((op: any) => op?.operationId)
          .filter((id: unknown): id is string => typeof id === 'string')
      )
      expect(ids.length).toBeGreaterThan(0)
      expect([...new Set(ids)].sort()).toEqual([...ids].sort())
    } finally {
      await app.close()
    }
  })

  it('names every git write route and documents its body and session scope', async () => {
    const app = await buildReady()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      const base = '/api/v1/orgs/{orgId}/agents/{id}/workspace'
      const expected: Record<string, string> = {
        gitstage: 'stageAgentWorkspacePaths',
        gitunstage: 'unstageAgentWorkspacePaths',
        gitcommit: 'commitAgentWorkspace',
        gitpush: 'pushAgentWorkspace',
        gitmessage: 'draftAgentWorkspaceCommitMessage'
      }
      for (const [path, operationId] of Object.entries(expected)) {
        const op = doc.paths?.[`${base}/${path}`]?.post
        expect(op, path).toMatchObject({ tags: ['Agent workspace'], operationId })
        expect(op?.summary, path).toBeTruthy()
        expect(op?.description, path).toBeTruthy()
        // Every write is addressable at a session worktree, and every write can be
        // refused by role (403), by staleness (409) or by an offline daemon (503).
        expect(
          (op?.parameters ?? []).map((p: any) => p.name),
          path
        ).toContain('sessionId')
        expect(Object.keys(op?.responses ?? {}), path).toEqual(
          expect.arrayContaining(['200', '400', '403', '404', '409', '503'])
        )
      }

      // The two body-bearing writes document their payload; the other three take none.
      const stageBody = doc.paths?.[`${base}/gitstage`]?.post?.requestBody
      expect(stageBody?.content?.['application/json']?.schema?.properties?.paths?.type).toBe('array')
      const commitBody = doc.paths?.[`${base}/gitcommit`]?.post?.requestBody
      expect(commitBody?.content?.['application/json']?.schema?.properties?.message?.type).toBe('string')
      expect(doc.paths?.[`${base}/gitpush`]?.post?.requestBody).toBeUndefined()
      expect(doc.paths?.[`${base}/gitmessage`]?.post?.requestBody).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('excludes non-public surfaces (/health) from the spec', async () => {
    const app = await buildReady()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      expect(Object.keys(doc.paths ?? {})).not.toContain('/health')
      // …but the probe itself is untouched — still served, unversioned.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('declares every templated path parameter — incl. the `/orgs/:orgId` prefix param', async () => {
    const app = await buildReady()
    try {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
      // Mirror the OpenAPI 3.1 rule a spec validator enforces: every `{token}` in
      // a path template must have a matching `in: path` parameter on the operation
      // (or the shared path-item). Leaf routes (`/agents/:id`) only put `id` in
      // their zod `schema.params`; `orgId` comes from the Fastify prefix and must
      // be backfilled — otherwise "missing path parameter(s) for `{orgId}`".
      const missing: string[] = []
      for (const [path, item] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
        const tokens = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
        if (tokens.length === 0) continue
        const shared = new Set((item.parameters ?? []).map((p: any) => p.name))
        for (const method of METHODS) {
          const op = item[method]
          if (!op) continue
          const names = new Set([
            ...shared,
            ...(op.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name)
          ])
          for (const t of tokens) if (!names.has(t)) missing.push(`${path} [${method}] → {${t}}`)
        }
      }
      expect(missing).toEqual([])

      // Spot-check the exact shape a formerly-broken leaf route now emits:
      // the prefix param leads, in path order.
      const agentGet = doc.paths?.['/api/v1/orgs/{orgId}/agents/{id}']?.get
      expect(agentGet.parameters.filter((p: any) => p.in === 'path').map((p: any) => p.name)).toEqual(['orgId', 'id'])
    } finally {
      await app.close()
    }
  })

  it('serves the interactive Swagger-UI at /docs with resolvable assets', async () => {
    const app = await buildReady()
    try {
      // The entry page renders (200 index or 302 to the trailing-slash index)…
      const entry = await app.inject({ method: 'GET', url: '/docs' })
      expect([200, 302]).toContain(entry.statusCode)

      // …and the assets it references actually resolve. The no-slash page emits
      // absolute `/docs/static/...` refs — probe one so a blank-UI regression
      // (assets 404ing) is caught here, not in a browser.
      const html = (await app.inject({ method: 'GET', url: '/docs' })).body
      const asset = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1]!)
        .find((ref) => ref.includes('swagger-ui-bundle.js'))
      expect(asset).toBeTruthy()
      const assetUrl = new URL(asset!, 'http://example.test/docs').pathname // resolve as a browser would
      expect((await app.inject({ method: 'GET', url: assetUrl })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
