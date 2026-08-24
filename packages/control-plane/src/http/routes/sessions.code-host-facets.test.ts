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
import { CODE_HOST_PROVIDERS, HOOK_KINDS, isCodeHostHookKind } from '@agentconnect.md/protocol'
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

/** A hook session as the LIST projection reads it — the visibility trio the row DTO requires. */
function pageRow(hookId: string, id: string, hookKind: string | null = null) {
  return {
    ...hookSession(hookId, id),
    hookKind,
    visibility: 'org',
    externalProvider: null,
    externalResolution: null
  }
}

function fakeDeps(pageSessions: ReturnType<typeof pageRow>[] = []) {
  const listFacets = vi.fn(async () => facetIndex)
  const listPage = vi.fn<(q: SessionPageQuery) => Promise<SessionPageRecord>>(async () => ({
    sessions: pageSessions as unknown as SessionPageRecord['sessions'],
    total: pageSessions.length,
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

/** The filter query the route handed the repository, as these assertions read it. */
function filterQueryOf(listPage: { mock: { calls: unknown[][] } }) {
  return listPage.mock.calls[0]?.[0] as { integration?: string; codeHostHookIds: Record<string, string[]> }
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

  // The read path is what the facet projection promises: a host it can EMIT must also
  // be selectable. Walking the provider list pins both halves for every host at once —
  // the query vocabulary accepting the value, and the filter resolving that host's ids.
  it('accepts every code host as a filter value and hands each one its own hook ids', async () => {
    const hookByProvider = new Map(hookRows.map((hook) => [hook.kind, hook.id]))
    for (const provider of CODE_HOST_PROVIDERS) {
      const { deps, listPage } = fakeDeps()
      const res = await (await app(deps)).inject({ method: 'GET', url: `/sessions?view=flat&integration=${provider}` })

      expect(res.statusCode).toBe(200)
      const passed = filterQueryOf(listPage)
      expect(passed.integration).toBe(provider)
      // Exact, so another host's ids are never read for this filter.
      expect(passed.codeHostHookIds).toEqual({ [provider]: [hookByProvider.get(provider)] })
    }
  })

  it('gives the generic hook filter every host to exclude', async () => {
    const { deps, listPage } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat&integration=hook' })

    expect(res.statusCode).toBe(200)
    const passed = filterQueryOf(listPage)
    expect(passed.integration).toBe('hook')
    // A promoted host missing here would be counted twice: once as its own, once as a webhook.
    expect(Object.keys(passed.codeHostHookIds).sort()).toEqual([...CODE_HOST_PROVIDERS].sort())
    expect(passed.codeHostHookIds).toMatchObject({ github: [GITHUB_HOOK], gitlab: [GITLAB_HOOK] })
  })

  it('resolves no code-host definitions for a filter that needs none', async () => {
    const { deps, listIdsForOrgKind } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat&integration=slack' })

    expect(res.statusCode).toBe(200)
    expect(listIdsForOrgKind).not.toHaveBeenCalled()
  })

  // The taxonomy is derived from the shared hook-kind vocabulary, so this walks the
  // whole vocabulary rather than the two hosts that happen to exist today: every code
  // host must project a facet of its own, and only the generic kind may say 'hook'.
  it('gives every code-host kind a distinct, non-generic facet', async () => {
    const hookById = new Map(hookRows.map((hook) => [hook.kind, hook.id]))
    const { deps } = fakeDeps()
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions/facets' })
    const triggers = (res.json() as { triggers: Array<{ value: string; integration: string; hookKind: string }> })
      .triggers
    const facetOf = (kind: string) => triggers.find((t) => t.value === `hook:${hookById.get(kind)}`)

    const projected = HOOK_KINDS.map((kind) => [kind, facetOf(kind)?.integration] as const)
    for (const [kind, integration] of projected) {
      expect(facetOf(kind)?.hookKind).toBe(kind)
      expect(integration).toBe(isCodeHostHookKind(kind) ? kind : 'hook')
    }
    // Distinctness is the property that failed in live testing: GitLab shared the
    // generic bucket, so its sessions were unreachable from the integration filter.
    expect(new Set(projected.map(([, integration]) => integration)).size).toBe(HOOK_KINDS.length)
  })

  it('carries the hook kind on the session row so the console never has to guess', async () => {
    const { deps } = fakeDeps([pageRow(GITLAB_HOOK, 'sess-gitlab')])
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat' })

    expect(res.statusCode).toBe(200)
    const [session] = (res.json() as { sessions: Array<{ hookKind: string; triggeredByName: string }> }).sessions
    expect(session?.hookKind).toBe('gitlab')
    expect(session?.triggeredByName).toBe('acme/platform')
  })

  it('lets the row own snapshot outrank the hook definition it points at', async () => {
    // A hook can be deleted and recreated, so the definition a session points at is not
    // evidence about what fired it. The creation-time snapshot is, and it wins.
    const { deps } = fakeDeps([pageRow(WEBHOOK, 'sess-snapshot', 'gitlab')])
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat' })

    expect(res.statusCode).toBe(200)
    const [session] = (res.json() as { sessions: Array<{ hookKind: string }> }).sessions
    expect(session?.hookKind).toBe('gitlab')
  })

  it('falls back to the live hook only for a row with no snapshot', async () => {
    const { deps } = fakeDeps([pageRow(GITLAB_HOOK, 'sess-legacy', null)])
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat' })

    expect(res.statusCode).toBe(200)
    const [session] = (res.json() as { sessions: Array<{ hookKind: string }> }).sessions
    expect(session?.hookKind).toBe('gitlab')
  })

  it('names the source of an unnamed hook instead of calling every kind a webhook', async () => {
    // A hook reassigned to another agent keeps its kind but loses its name for these
    // historical rows, which is exactly when the generic label used to take over.
    const { deps } = fakeDeps([pageRow(GITLAB_HOOK, 'sess-gitlab')])
    deps.repos.hook.getMany = vi.fn(async () => [
      { id: GITLAB_HOOK, agentId: 'agent-2', kind: 'gitlab', name: 'acme/platform', repoId: 4210n }
    ]) as unknown as typeof deps.repos.hook.getMany
    const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat' })

    const [session] = (res.json() as { sessions: Array<{ hookKind: string; triggeredByName: string }> }).sessions
    expect(session?.triggeredByName).toBe('GitLab')
  })
})
