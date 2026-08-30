/**
 * Session routes × viewer identity — the wiring, not the policy: an OIDC
 * caller's linked Slack identity must reach BOTH visibility seams
 * (session-visibility.md §5) — the repo list projection's `viewer.identitySet`
 * and the in-app `canViewSession` point read — so a private Slack DM session
 * (`ownerIdentity: slack:T…:U…`) lights up for the console user behind it.
 * The policy truth table lives in authorization/policy.test.ts; this suite pins
 * the request-time plugin wiring.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../deps.js'
import type { SessionAccessViewer } from '../session-access-plugin.js'
import { installZod } from '../plugins/zod.js'
import { sessionRoutes } from './sessions.js'

const ORG_ID = 'org-1'
const SLACK_OWNER = 'slack:T024BE7LD:U0123ABCD'

const agent = {
  id: 'agent-1',
  name: 'hidden-agent',
  orgId: ORG_ID,
  visibility: 'restricted',
  sharedWith: []
}

function slackDmSession() {
  const at = new Date('2026-07-31T00:00:00Z')
  return {
    id: 'sess-1',
    parentSessionId: null,
    agentId: 'agent-1',
    launchId: null,
    platform: 'slack',
    channel: 'D0AAA0AAA',
    thread: '1722384000.000100',
    phase: 'start',
    link: null,
    summary: null,
    title: 'a DM session',
    status: null,
    lastActivityAt: at,
    triggeredBy: 'U0123ABCD',
    channelName: null,
    triggeredByName: null,
    threadUrl: null,
    runtime: null,
    model: null,
    effort: null,
    fastMode: null,
    permissionMode: null,
    outputMode: null,
    daemonId: null,
    workspaceIsolation: null,
    activityState: 'idle',
    orgId: ORG_ID,
    visibility: 'private',
    ownerIdentity: SLACK_OWNER,
    visibilitySource: 'default',
    visibilityRev: 0,
    visibilityAckedRev: 0,
    externalProvider: null,
    externalScopeId: null,
    externalResolution: null,
    classifiedPolicyRev: null,
    startedAt: at,
    endedAt: null
  }
}

function fakeDeps(overrides: {
  slackIdentityFor?: () => Promise<{ teamId: string; userId: string } | null>
  session?: ReturnType<typeof slackDmSession>
}) {
  const listPage = vi.fn(async () => ({ sessions: [], total: 0, hasMore: false }))
  const listConversationPage = vi.fn(async () => ({ conversations: [], total: 0, hasMore: false }))
  const deps = {
    repos: {
      agent: {
        list: vi.fn(async () => [agent]),
        get: vi.fn(async () => agent)
      },
      session: {
        // The repo read is org-fenced now (org-scoped-data-layer.md §3), so the
        // fake enforces the fence instead of the route's deleted comparison.
        get: vi.fn(async (orgId: string) => {
          const row = overrides.session ?? slackDmSession()
          return row.orgId === orgId ? row : null
        }),
        orgHasAny: vi.fn(async () => true),
        listExternalScopes: vi.fn(async () => []),
        getExternalScopes: vi.fn(async () => []),
        getExternalAccessPolicy: vi.fn(async () => null),
        listPage,
        listConversationPage,
        listChildren: vi.fn(async () => []),
        listFacets: vi.fn(async () => ({ agents: [], integrations: [], channels: [], triggers: [] }))
      },
      sessionUsage: { get: vi.fn(async () => null) },
      hook: { getMany: vi.fn(async () => []) },
      integrationChannel: { namesForOrg: vi.fn(async () => []) }
    },
    clock: { now: () => Date.now() },
    ...(overrides.slackIdentityFor
      ? {
          sessionAccessPlugins: [
            {
              provider: 'slack',
              available: true,
              addViewerIdentities: async ({ request, identitySet }: SessionAccessViewer) => {
                if (!request.oidcSubject) return
                const identity = await overrides.slackIdentityFor!()
                if (identity) identitySet.add(`slack:${identity.teamId}:${identity.userId}`)
              },
              resolve: async () => ({ allowedScopes: [], degraded: false })
            }
          ]
        }
      : {})
  } as unknown as HttpDeps
  return { deps, listPage, listConversationPage }
}

async function appAs(deps: HttpDeps, caller: { userId: string; oidcSubject?: string }): Promise<FastifyInstance> {
  const app = Fastify()
  installZod(app)
  // Stand-ins for humanAuth + the org-scope guard, which run before these
  // routes in the real server (http/server.ts).
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: caller.userId }
    req.orgCtx = { orgId: ORG_ID, role: 'collaborator', userId: caller.userId } as never
    if (caller.oidcSubject) req.oidcSubject = caller.oidcSubject
  })
  await app.register(sessionRoutes(deps))
  return app
}

describe('session routes × viewer identity', () => {
  it('feeds the linked Slack identity into the list projection viewer', async () => {
    const { deps, listPage, listConversationPage } = fakeDeps({
      slackIdentityFor: async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' })
    })
    const app = await appAs(deps, { userId: 'u-1', oidcSubject: 'logto-sub' })
    try {
      // Default (grouped) view and the flat escape hatch feed the SAME viewer.
      const res = await app.inject({ method: 'GET', url: '/sessions' })
      expect(res.statusCode).toBe(200)
      expect(listConversationPage).toHaveBeenCalledWith(
        expect.objectContaining({
          viewer: expect.objectContaining({
            role: 'collaborator',
            identitySet: expect.arrayContaining(['user:u-1', SLACK_OWNER])
          })
        })
      )
      const flat = await app.inject({ method: 'GET', url: '/sessions?view=flat' })
      expect(flat.statusCode).toBe(200)
      expect(listPage).toHaveBeenCalledWith(
        expect.objectContaining({
          viewer: expect.objectContaining({
            role: 'collaborator',
            identitySet: expect.arrayContaining(['user:u-1', SLACK_OWNER])
          })
        })
      )
    } finally {
      await app.close()
    }
  })

  it('serves the detail of a private Slack DM session to its linked owner even when the Agent is hidden', async () => {
    const { deps } = fakeDeps({
      slackIdentityFor: async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' })
    })
    const app = await appAs(deps, { userId: 'u-1', oidcSubject: 'logto-sub' })
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { agentName: string; visibility: string; canChangeVisibility: boolean }
      expect(body.agentName).toBe('hidden-agent')
      expect(body.visibility).toBe('private')
      // Identity match also grants §4.3 re-classification, exactly like a
      // `user:<id>`-owned row.
      expect(body.canChangeVisibility).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('still 404s that session for a caller whose Slack identity differs', async () => {
    const { deps } = fakeDeps({
      slackIdentityFor: async () => ({ teamId: 'T024BE7LD', userId: 'U9OTHER' })
    })
    const app = await appAs(deps, { userId: 'u-2', oidcSubject: 'logto-sub-2' })
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' })
      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('still 404s a matching Session audience from another organization', async () => {
    const session = slackDmSession()
    session.orgId = 'org-2'
    const { deps } = fakeDeps({
      session,
      slackIdentityFor: async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' })
    })
    const app = await appAs(deps, { userId: 'u-1', oidcSubject: 'logto-sub' })
    try {
      expect((await app.inject({ method: 'GET', url: '/sessions/sess-1' })).statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('404s for a non-OIDC caller even when a Slack identity exists upstream', async () => {
    // devAuth / API-key callers carry no verified subject — the provider is
    // never consulted, so the DM stays hidden (fail closed).
    const slackIdentityFor = vi.fn(async () => ({ teamId: 'T024BE7LD', userId: 'U0123ABCD' }))
    const { deps } = fakeDeps({ slackIdentityFor })
    const app = await appAs(deps, { userId: 'u-1' })
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/sess-1' })
      expect(res.statusCode).toBe(404)
      expect(slackIdentityFor).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
