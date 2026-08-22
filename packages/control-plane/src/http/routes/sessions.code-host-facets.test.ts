/**
 * Session integration facets across the two code hosts.
 *
 * A hook session's `platform` is the literal 'hook' for every kind, so the facet
 * has to be PROMOTED from the hook definition's kind. GitHub was promoted and
 * GitLab was not, which left GitLab activity indistinguishable from generic
 * webhook activity in both the facet list and the filter that reads it. These
 * tests pin the promotion, the filter vocabulary, and the per-host hook-id
 * resolution the repository predicate is given.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../deps.js'
import type { SessionPageQuery, SessionPageRecord } from '../../persistence/ports.js'
import { installZod } from '../plugins/zod.js'
import { sessionRoutes } from './sessions.js'

const ORG_ID = 'org-1'
const AGENT_ID = 'agent-1'
const GITHUB_HOOK = '11111111-1111-4111-8111-111111111111'
const GITLAB_HOOK = '22222222-2222-4222-8222-222222222222'
const WEBHOOK = '33333333-3333-4333-8333-333333333333'

const at = new Date('2026-08-22T00:00:00Z')

function hookSession(hookId: string, id: string) {
  return {
    id,
    agentId: AGENT_ID,
    platform: 'hook',
    channel: hookId,
    thread: null,
    triggeredBy: `hook:${hookId}`,
    channelName: null,
    triggeredByName: null,
    lastActivityAt: at,
    startedAt: at
  }
}

const facetIndex = {
  agents: [AGENT_ID],
  integrations: [
    hookSession(GITHUB_HOOK, 'sess-github'),
    hookSession(GITLAB_HOOK, 'sess-gitlab'),
    hookSession(WEBHOOK, 'sess-webhook')
  ],
  channels: [],
  triggers: [
    hookSession(GITHUB_HOOK, 'sess-github'),
    hookSession(GITLAB_HOOK, 'sess-gitlab'),
    hookSession(WEBHOOK, 'sess-webhook')
  ]
}

const hookRows = [
  { id: GITHUB_HOOK, agentId: AGENT_ID, kind: 'github', name: 'owner/repo', repoId: 123n },
  { id: GITLAB_HOOK, agentId: AGENT_ID, kind: 'gitlab', name: 'acme/platform', repoId: 4210n },
  { id: WEBHOOK, agentId: AGENT_ID, kind: 'webhook', name: 'acme/build', repoId: null }
]

function fakeDeps() {
  const listFacets = vi.fn(async () => facetIndex)
  const listPage = vi.fn<(q: SessionPageQuery) => Promise<SessionPageRecord>>(async () => ({
    sessions: [],
    total: 0,
    hasMore: false
  }))
  const listIdsForOrgKind = vi.fn(async (_orgId: string, kind: string) =>
    hookRows.filter((hook) => hook.kind === kind).map((hook) => hook.id)
  )
  const deps = {
    repos: {
      agent: { list: vi.fn(async () => [{ id: AGENT_ID, name: 'build-agent', orgId: ORG_ID }]) },
      session: {
        listFacets,
        listPage,
        listConversationPage: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
        orgHasAny: vi.fn(async () => true),
        listExternalScopes: vi.fn(async () => []),
        getExternalScopes: vi.fn(async () => []),
        getExternalAccessPolicy: vi.fn(async () => null)
      },
      hook: {
        getMany: vi.fn(async (_orgId: string, ids: string[]) => hookRows.filter((hook) => ids.includes(hook.id))),
        listIdsForOrgKind,
        listForOrgKind: vi.fn(async (_orgId: string, kind: string) => hookRows.filter((hook) => hook.kind === kind))
      }
    },
    clock: { now: () => Date.now() }
  } as unknown as HttpDeps
  return { deps, listFacets, listPage, listIdsForOrgKind }
}

async function app(deps: HttpDeps): Promise<FastifyInstance> {
  const instance = Fastify()
  installZod(instance)
  instance.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user-1' }
    req.orgCtx = { orgId: ORG_ID, role: 'collaborator', userId: 'user-1' } as never
  })
  await instance.register(sessionRoutes(deps))
  return instance
}

describe('session integration facets across code hosts', () => {
  it('promotes each code host out of the generic hook bucket', async () => {
    const { deps } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions/facets' })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      integrations: string[]
      triggers: Array<{ value: string; integration: string; hookKind: string | null; githubRepoId: string | null }>
    }
    expect([...body.integrations].sort()).toEqual(['github', 'gitlab', 'hook'])
    expect(body.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: `hook:${GITLAB_HOOK}`, integration: 'gitlab', hookKind: 'gitlab' }),
        expect.objectContaining({ value: `hook:${GITHUB_HOOK}`, integration: 'github', hookKind: 'github' }),
        expect.objectContaining({ value: `hook:${WEBHOOK}`, integration: 'hook', hookKind: 'webhook' })
      ])
    )
    // The numeric repository id is GitHub's own filter key; GitLab carries none.
    expect(body.triggers.find((t) => t.hookKind === 'gitlab')?.githubRepoId).toBeNull()
  })

  it('accepts gitlab as a filter value and hands the repository its own hook ids', async () => {
    const { deps, listPage } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat&integration=gitlab' })

    expect(res.statusCode).toBe(200)
    expect(listPage.mock.calls[0]?.[0]).toMatchObject({ integration: 'gitlab', gitlabHookIds: [GITLAB_HOOK] })
    // GitHub's ids are irrelevant to a gitlab filter, so they are never read.
    expect(listPage.mock.calls[0]?.[0]).not.toHaveProperty('githubHookIds')
  })

  it('gives the generic hook filter both hosts to exclude', async () => {
    const { deps, listPage } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat&integration=hook' })

    expect(res.statusCode).toBe(200)
    expect(listPage.mock.calls[0]?.[0]).toMatchObject({
      integration: 'hook',
      githubHookIds: [GITHUB_HOOK],
      gitlabHookIds: [GITLAB_HOOK]
    })
  })

  it('resolves no code-host definitions for a filter that needs none', async () => {
    const { deps, listIdsForOrgKind } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat&integration=slack' })

    expect(res.statusCode).toBe(200)
    expect(listIdsForOrgKind).not.toHaveBeenCalled()
  })
})
