// `PullRequestViewService` — TTL/keying/eviction of the cache, the GraphQL projection, and every
// degraded shape (webchat-side-panels.md §3.4, M5). GitHub is a scripted `fetchImpl`; no network.
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import {
  PullRequestViewService,
  PR_VIEW_TTL_MS,
  PR_VIEW_CACHE_MAX,
  type PullRequestIdentity
} from './pull-request-view.service.js'
import type { InstallationTokenService } from './installation-token.service.js'
import type { FetchLike } from './api.js'
import { OrgId } from '../domain/ids.js'

const IDENTITY: PullRequestIdentity = {
  orgId: OrgId('org_a'),
  installationId: 111n,
  repoId: 42n,
  repoFullName: 'acme/repo',
  pullNumber: 7
}

function fakeTokens(): { mint: ReturnType<typeof vi.fn>; tokens: InstallationTokenService } {
  const mint = vi.fn(async () => ({
    token: 'ghs_test',
    ttlSec: 3600,
    expiresAt: '2026-08-11T01:00:00Z',
    repoFullName: 'acme/repo',
    access: 'read' as const
  }))
  return { mint, tokens: { mintPullRequestRead: mint } as unknown as InstallationTokenService }
}

// A full GraphQL answer: 2 checks (one classic status), 2 reviews, 3 threads (one resolved, one outdated).
function fullAnswer(): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          title: 'Ship the panel',
          bodyText: 'Ship the panel body',
          state: 'OPEN',
          isDraft: false,
          merged: false,
          additions: 120,
          deletions: 8,
          url: 'https://github.com/acme/repo/pull/7',
          baseRefName: 'main',
          headRefName: 'feat/panel',
          headRefOid: 'sha_HEAD',
          reviewDecision: 'CHANGES_REQUESTED',
          latestReviews: {
            nodes: [
              { state: 'APPROVED', author: { login: 'dana', __typename: 'User' } },
              { state: 'CHANGES_REQUESTED', author: { login: 'review-bot', __typename: 'Bot' } },
              { state: 'COMMENTED', author: null }
            ]
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'unit',
                          conclusion: 'SUCCESS',
                          status: 'COMPLETED',
                          startedAt: '2026-08-11T00:00:00Z',
                          completedAt: '2026-08-11T00:05:00Z',
                          detailsUrl: 'https://ci.example/unit'
                        },
                        {
                          __typename: 'StatusContext',
                          context: 'legacy-ci',
                          state: 'FAILURE',
                          targetUrl: 'https://ci.example/legacy',
                          createdAt: '2026-08-11T00:01:00Z'
                        }
                      ]
                    }
                  }
                }
              }
            ]
          },
          reviewThreads: {
            totalCount: 3,
            nodes: [
              {
                isResolved: false,
                isOutdated: false,
                path: 'src/app.ts',
                line: 12,
                comments: { nodes: [{ body: 'rename this', author: { login: 'dana' } }] }
              },
              {
                isResolved: true,
                isOutdated: false,
                path: 'src/done.ts',
                line: 1,
                comments: { nodes: [{ body: 'fixed', author: { login: 'dana' } }] }
              },
              {
                isResolved: false,
                isOutdated: true,
                path: 'src/moved.ts',
                line: null,
                comments: { nodes: [{ body: 'outdated note', author: { login: 'review-bot' } }] }
              }
            ]
          }
        }
      }
    }
  }
}

// Scripted GitHub: each call shifts the next reply; `calls` records how many reads actually happened.
function scriptedFetch(replies: Array<() => Response | Promise<Response>>): {
  fetch: FetchLike
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const next = replies.shift()
    if (!next) throw new Error('unexpected extra GitHub call')
    return next()
  }
  return { fetch, calls }
}

const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function build(replies: Array<() => Response | Promise<Response>>) {
  const clock = new FakeClock(1_000_000)
  const { mint, tokens } = fakeTokens()
  const { fetch, calls } = scriptedFetch(replies)
  const service = new PullRequestViewService(tokens, clock, fetch)
  return { service, clock, mint, calls }
}

describe('projection mapping', () => {
  it('projects one full GraphQL answer onto the panel view', async () => {
    const { service, calls } = build([ok(fullAnswer())])

    const view = await service.view(IDENTITY)

    expect(view).toEqual({
      repoFullName: 'acme/repo',
      pullNumber: 7,
      title: 'Ship the panel',
      body: 'Ship the panel body',
      headOid: 'sha_HEAD',
      state: 'open',
      isDraft: false,
      url: 'https://github.com/acme/repo/pull/7',
      headRef: 'feat/panel',
      baseRef: 'main',
      additions: 120,
      deletions: 8,
      reviewDecision: 'changes_requested',
      checks: [
        {
          name: 'unit',
          state: 'success',
          detail: 'SUCCESS',
          startedAt: '2026-08-11T00:00:00Z',
          completedAt: '2026-08-11T00:05:00Z',
          url: 'https://ci.example/unit'
        },
        {
          name: 'legacy-ci',
          state: 'failure',
          detail: 'FAILURE',
          startedAt: '2026-08-11T00:01:00Z',
          completedAt: null,
          url: 'https://ci.example/legacy'
        }
      ],
      checksTruncated: false,
      reviews: [
        { author: 'dana', state: 'approved', isBot: false },
        { author: 'review-bot', state: 'changes_requested', isBot: true }
      ],
      threads: [
        { location: 'src/app.ts:12', body: 'rename this', author: 'dana', isOutdated: false },
        { location: 'src/moved.ts', body: 'outdated note', author: 'review-bot', isOutdated: true }
      ],
      unresolvedCount: 2,
      threadsTruncated: false,
      degraded: false,
      degradedReason: null,
      agentReview: null
    })
    // One GraphQL POST, carrying the PR coordinates — not one call per fact.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/graphql')
    expect((calls[0]!.body as { variables: Record<string, unknown> }).variables).toMatchObject({
      owner: 'acme',
      name: 'repo',
      number: 7
    })
  })

  it('marks a merged PR merged and reads truncation from the connection itself', async () => {
    const answer = fullAnswer()
    const pr = (answer as { data: { repository: { pullRequest: Record<string, unknown> } } }).data.repository
      .pullRequest
    pr['state'] = 'MERGED'
    pr['merged'] = true
    ;(
      pr['commits'] as {
        nodes: Array<{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean } } } } }>
      }
    ).nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true
    ;(pr['reviewThreads'] as { totalCount: number }).totalCount = 31
    const { service } = build([ok(answer)])

    const view = await service.view(IDENTITY)

    expect(view.state).toBe('merged')
    expect(view.checksTruncated).toBe(true) // pageInfo.hasNextPage, not a page-size heuristic
    expect(view.threadsTruncated).toBe(true) // totalCount past the 30-thread page
  })

  it('tolerates field-level GraphQL errors when data is present, instead of degrading the read', async () => {
    const answer = fullAnswer() as Record<string, unknown>
    answer['errors'] = [{ type: 'FORBIDDEN', message: 'statuses denied on StatusContext.state' }]
    const { service } = build([ok(answer)])

    const view = await service.view(IDENTITY)

    expect(view.degraded).toBe(false)
    expect(view.title).toBe('Ship the panel')
  })
})

describe('degraded shapes', () => {
  const hinted: PullRequestIdentity = { ...IDENTITY, knownIsOpen: false, knownIsDraft: true }

  it('maps a GraphQL RATE_LIMITED error to rate_limited, with identity from Postgres', async () => {
    const { service } = build([ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit' }] })])

    const view = await service.view(hinted)

    expect(view).toMatchObject({
      degraded: true,
      degradedReason: 'rate_limited',
      repoFullName: 'acme/repo',
      pullNumber: 7,
      url: 'https://github.com/acme/repo/pull/7',
      // Postgres facts, not fabrication: the subject said closed, the run said draft, counts unknown.
      state: 'closed',
      isDraft: true,
      additions: null,
      deletions: null,
      checks: [],
      reviews: [],
      threads: []
    })
  })

  it('leaves state and isDraft null when degraded with no Postgres facts to fall back on', async () => {
    const { service } = build([ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })])

    const view = await service.view(IDENTITY)

    expect(view.degraded).toBe(true)
    expect(view.state).toBeNull()
    expect(view.isDraft).toBeNull()
  })

  it('carries the run recorded review ONLY when degraded — GitHub list is authoritative when it answered', async () => {
    // The precedence the plan (§10) requires, living in the service: a degraded answer falls back to
    // the one review state the deployment knows without GitHub — its own agent's, off the owning run —
    // while an answered read carries null, because GitHub's list already contains that review and a
    // second copy would invite the panel to double-draw it.
    const withReview: PullRequestIdentity = { ...IDENTITY, knownAgentReview: 'changes_requested' }

    const degraded = build([ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })])
    expect(await degraded.service.view(withReview)).toMatchObject({
      degraded: true,
      agentReview: 'changes_requested'
    })

    const answered = build([ok(fullAnswer())])
    expect(await answered.service.view(withReview)).toMatchObject({ degraded: false, agentReview: null })

    // And a degraded read with nothing recorded carries null rather than a guess.
    const bare = build([ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })])
    expect((await bare.service.view(IDENTITY)).agentReview).toBeNull()
  })

  it('never hands one run degraded fallback to another session on the same PR', async () => {
    // The cache key is the PR; knownIsOpen/knownIsDraft/knownAgentReview belong to the caller's RUN.
    // One shared cached answer, two different overlays — session B must not see A's recorded review.
    const { service } = build([ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })])
    const runA: PullRequestIdentity = { ...IDENTITY, knownIsOpen: false, knownAgentReview: 'changes_requested' }
    const runB: PullRequestIdentity = { ...IDENTITY, knownIsOpen: true, knownAgentReview: 'approved' }

    const a = await service.view(runA)
    const b = await service.view(runB) // cache hit — ONE GraphQL call for both
    expect(a).toMatchObject({ degraded: true, state: 'closed', agentReview: 'changes_requested' })
    expect(b).toMatchObject({ degraded: true, state: 'open', agentReview: 'approved' })

    // And a caller with NO recorded review gets none, not the cached caller's.
    const bare = await service.view(IDENTITY)
    expect(bare.agentReview).toBeNull()
    expect(bare.state).toBeNull()
  })

  it('overlays each caller of a SHARED in-flight read separately', async () => {
    // Single-flight merges the request, not the answer: two runs awaiting one read still get their
    // own facts, or the race would reintroduce exactly the leak the overlay removes.
    let release: ((value: Response) => void) | undefined
    const { service } = build([() => new Promise<Response>((resolve) => (release = resolve))])
    const runA: PullRequestIdentity = { ...IDENTITY, knownAgentReview: 'changes_requested' }
    const runB: PullRequestIdentity = { ...IDENTITY, knownAgentReview: 'approved' }

    const pendingA = service.view(runA)
    const pendingB = service.view(runB)
    // The read awaits the token mint before it fetches, so the held fetch is not in hand yet.
    while (!release) await new Promise((tick) => setTimeout(tick, 0))
    release(ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })())
    const [a, b] = await Promise.all([pendingA, pendingB])

    expect(a.agentReview).toBe('changes_requested')
    expect(b.agentReview).toBe('approved')
  })

  it('keys the cache by repoFullName too — runs across a repository rename never share a projection', async () => {
    // Historical runs keep pre-rename names, and the name drives the GraphQL query and the cached URL:
    // sharing on numeric identity alone would serve one name's denied/stale answer to the other.
    const { service, calls } = build([ok(fullAnswer()), ok(fullAnswer())])
    const oldName: PullRequestIdentity = { ...IDENTITY, repoFullName: 'acme/repo-old' }

    await service.view(IDENTITY)
    await service.view(oldName)

    expect(calls).toHaveLength(2)
    expect((calls[1]?.body as { variables: { owner: string; name: string } }).variables.name).toBe('repo-old')
  })

  it('maps a GitHub 5xx to unreachable, not to denied', async () => {
    // 'denied' points the operator at a nonexistent installation problem for the length of an outage;
    // a server error is GitHub being down, which is the 'unreachable' story.
    const { service } = build([() => new Response('Server Error', { status: 502 })])

    const view = await service.view(IDENTITY)

    expect(view).toMatchObject({ degraded: true, degradedReason: 'unreachable' })
  })

  it('maps a REST-level rate limit (403 + x-ratelimit-remaining: 0) to rate_limited', async () => {
    const { service } = build([
      () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' }
        })
    ])

    const view = await service.view(IDENTITY)

    expect(view).toMatchObject({ degraded: true, degradedReason: 'rate_limited' })
  })

  it('maps a FORBIDDEN GraphQL denial and a vanished PR both to denied', async () => {
    const { service } = build([
      ok({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }),
      ok({ data: { repository: { pullRequest: null } } })
    ])
    const other: PullRequestIdentity = { ...IDENTITY, pullNumber: 8 }

    expect(await service.view(IDENTITY)).toMatchObject({ degraded: true, degradedReason: 'denied' })
    expect(await service.view(other)).toMatchObject({ degraded: true, degradedReason: 'denied' })
  })

  it('maps a network failure to unreachable', async () => {
    const { service } = build([
      () => {
        throw new TypeError('fetch failed')
      }
    ])

    const view = await service.view(IDENTITY)

    expect(view).toMatchObject({ degraded: true, degradedReason: 'unreachable' })
  })
})

describe('TTL cache', () => {
  it('serves a fresh hit without a second GitHub call, then refetches after the TTL', async () => {
    const { service, clock, calls, mint } = build([ok(fullAnswer()), ok(fullAnswer())])

    await service.view(IDENTITY)
    clock.advance(PR_VIEW_TTL_MS - 1)
    await service.view(IDENTITY)
    expect(calls).toHaveLength(1)
    expect(mint).toHaveBeenCalledTimes(1)

    clock.advance(1) // now exactly TTL past the store
    await service.view(IDENTITY)
    expect(calls).toHaveLength(2)
  })

  it('caches a degraded answer too, so a rate-limited installation is not hammered per mount', async () => {
    const { service, clock, calls } = build([
      ok({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }),
      ok(fullAnswer())
    ])

    expect((await service.view(IDENTITY)).degradedReason).toBe('rate_limited')
    clock.advance(PR_VIEW_TTL_MS - 1)
    expect((await service.view(IDENTITY)).degradedReason).toBe('rate_limited')
    expect(calls).toHaveLength(1)

    clock.advance(PR_VIEW_TTL_MS)
    expect((await service.view(IDENTITY)).degraded).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('coalesces concurrent reads into one GitHub call — force included', async () => {
    let release!: (r: Response) => void
    const gate = new Promise<Response>((resolve) => (release = resolve))
    const { service, calls } = build([() => gate])

    const first = service.view(IDENTITY)
    const second = service.view(IDENTITY)
    const forced = service.view(IDENTITY, true)
    release(ok(fullAnswer())())

    const views = await Promise.all([first, second, forced])
    expect(calls).toHaveLength(1)
    expect(views[0]).toBe(views[1])
    expect(views[0]).toBe(views[2])
  })

  it('force bypasses a still-fresh cache entry', async () => {
    const { service, calls } = build([ok(fullAnswer()), ok(fullAnswer())])

    await service.view(IDENTITY)
    await service.view(IDENTITY, true)

    expect(calls).toHaveLength(2)
  })
})

describe('cache keying and eviction', () => {
  it('never serves one org’s cached view to another org on the same repo/PR', async () => {
    const { service, calls, mint } = build([ok(fullAnswer()), ok(fullAnswer())])
    const orgB: PullRequestIdentity = { ...IDENTITY, orgId: OrgId('org_b'), installationId: 222n }

    await service.view(IDENTITY)
    await service.view(orgB)

    // Two reads, two token mints — org B validates its OWN installation instead of riding org A's.
    expect(calls).toHaveLength(2)
    expect(mint).toHaveBeenCalledTimes(2)
    expect(mint).toHaveBeenNthCalledWith(1, 111n, 'acme/repo', 42n)
    expect(mint).toHaveBeenNthCalledWith(2, 222n, 'acme/repo', 42n)
  })

  it('drops an installation’s cached views when its facts change', async () => {
    const { service, calls } = build([ok(fullAnswer()), ok(fullAnswer())])

    await service.view(IDENTITY)
    service.invalidateInstallation(IDENTITY.installationId)
    await service.view(IDENTITY)

    expect(calls).toHaveLength(2)
  })

  it('drops one PR on invalidate() and keeps its neighbours cached', async () => {
    const { service, calls } = build([ok(fullAnswer()), ok(fullAnswer()), ok(fullAnswer())])
    const other: PullRequestIdentity = { ...IDENTITY, pullNumber: 8 }

    await service.view(IDENTITY)
    await service.view(other)
    service.invalidate(IDENTITY.repoId, IDENTITY.pullNumber)
    await service.view(other) // still cached
    await service.view(IDENTITY) // refetched

    expect(calls).toHaveLength(3)
  })

  it('holds at most PR_VIEW_CACHE_MAX entries, evicting the oldest', async () => {
    const replies = Array.from({ length: PR_VIEW_CACHE_MAX + 2 }, () => ok(fullAnswer()))
    const { service, calls } = build(replies)

    for (let i = 0; i < PR_VIEW_CACHE_MAX + 1; i++) {
      await service.view({ ...IDENTITY, pullNumber: 100 + i })
    }
    expect(calls).toHaveLength(PR_VIEW_CACHE_MAX + 1)

    // The first-viewed PR was evicted (cap), so re-reading it costs a call; the cache never exceeds the cap.
    await service.view({ ...IDENTITY, pullNumber: 100 })
    expect(calls).toHaveLength(PR_VIEW_CACHE_MAX + 2)
  })
})

describe('merge (M6)', () => {
  const TARGET = { repoId: IDENTITY.repoId, repoFullName: IDENTITY.repoFullName, pullNumber: IDENTITY.pullNumber }
  const mergeNode = (merged: boolean) =>
    ok({
      data: { repository: { pullRequest: { id: 'PR_node1', state: merged ? 'MERGED' : 'OPEN', merged } } }
    })

  it('merges with the CALLER-minted token, mutates by node id, and drops the cached view', async () => {
    const { service, calls, mint } = build([
      ok(fullAnswer()), // seed the cache via view()
      mergeNode(false),
      ok({ data: { mergePullRequest: { clientMutationId: null } } }),
      ok(fullAnswer()) // the re-read after invalidation
    ])
    await service.view(IDENTITY)

    const result = await service.merge(TARGET, 'ghs_write', 'sha_HEAD')

    expect(result).toEqual({ merged: true })
    // The write rides the passed token, never this service's read-floor mint facility.
    expect(mint).toHaveBeenCalledTimes(1)
    const mutation = calls[2]!.body as { query: string; variables: Record<string, unknown> }
    expect(mutation.query).toContain('mergePullRequest')
    expect(mutation.query).toContain('mergeMethod:SQUASH')
    expect(mutation.query).toContain('expectedHeadOid')
    expect(mutation.variables).toEqual({ id: 'PR_node1', expectedHeadOid: 'sha_HEAD' })
    // The cached view is gone: the next read asks GitHub again rather than serving the pre-write state.
    await service.view(IDENTITY)
    expect(calls).toHaveLength(4)
  })

  it('is idempotent: an already-merged PR mutates nothing', async () => {
    const { service, calls } = build([mergeNode(true)])

    expect(await service.merge(TARGET, 'ghs_write', 'sha_HEAD')).toEqual({ merged: true })
    expect(calls).toHaveLength(1) // the node read only — no mutation call scripted, none made
  })

  it('throws denied when the installation cannot see the PR', async () => {
    const { service } = build([ok({ data: { repository: { pullRequest: null } } })])

    await expect(service.merge(TARGET, 'ghs_write', 'sha_HEAD')).rejects.toMatchObject({ code: 'LEASE_DENIED' })
  })

  it('treats a refused merge as FAILURE even when GitHub wraps it in truthy partial data', async () => {
    const { service } = build([
      mergeNode(false),
      ok({
        data: { mergePullRequest: null },
        errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is not mergeable' }]
      })
    ])

    await expect(service.merge(TARGET, 'ghs_write', 'sha_HEAD')).rejects.toMatchObject({
      message: expect.stringContaining('not mergeable')
    })
  })
})

describe('write-side correctness (M6 review findings)', () => {
  const TARGET = { repoId: IDENTITY.repoId, repoFullName: IDENTITY.repoFullName, pullNumber: IDENTITY.pullNumber }

  it('treats a refused mutation as FAILURE even when GitHub wraps it in truthy partial data', async () => {
    // GitHub rejects a mutation as `{ data: { mergePullRequest: null }, errors: [...] }` — reporting
    // `{ merged: true }` off the truthy half would claim a write that never happened.
    const { service } = build([
      ok({ data: { repository: { pullRequest: { id: 'PR_node1', state: 'OPEN', merged: false } } } }),
      ok({
        data: { mergePullRequest: null },
        errors: [{ type: 'UNPROCESSABLE', message: 'Head branch was modified' }]
      })
    ])

    await expect(service.merge(TARGET, 'ghs_write', 'sha_HEAD')).rejects.toMatchObject({
      message: expect.stringContaining('Head branch was modified')
    })
  })

  it('fences a read that started BEFORE invalidate() out of the cache — and out of later joins', async () => {
    let release: ((value: Response) => void) | undefined
    const { service, calls } = build([() => new Promise<Response>((resolve) => (release = resolve)), ok(fullAnswer())])

    const before = service.view(IDENTITY)
    while (!release) await new Promise((tick) => setTimeout(tick, 0))
    // The write lands mid-read: everything this PR cached, joined or later stored is now pre-write state.
    service.invalidate(IDENTITY.repoId, IDENTITY.pullNumber)
    release(ok(fullAnswer())())
    await before // its own awaiter still gets the answer it asked for…

    // …but the next view must ask GitHub again: no cache hit off the fenced store, no join on the old read.
    await service.view(IDENTITY)
    expect(calls).toHaveLength(2)
  })
})
