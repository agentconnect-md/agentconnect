/**
 * Gitea's turn-final members (gitea-integration.md §8, §10.1, §11): the comment target on a numbered
 * subject, the host fence against the spec-carried instance, the maintenance pairing that retires a
 * thread's checkout, the per-instance effect lease behind the poster, and the review-delivery
 * correlation fetched under that lease before the prompt is built.
 */
import { describe, expect, it, vi } from 'vitest'
import { GITEA_DEFAULT_BASE_URL, type RdMsgHook } from '@agentconnect.md/protocol'
import {
  codeHostHostFence,
  codeHostPromptSupplement,
  codeHostReplyTarget,
  codeHostThreadWorktreeCleanup,
  turnFinalFor,
  type CodeHostTurnFinalHost
} from '../src/codehost/turn-final.js'
import { GITEA_HOST_MISMATCH_REASON } from '../src/gitea/host-fence.js'
import { GiteaFinalPoster } from '../src/gitea/poster.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const REPO = '556677'
const PATH = 'example-org/example-repo'
const INSTANCE = 'https://gitea.example.test:8443/gitea'

function fire(overrides: Partial<RdMsgHook> = {}): RdMsgHook {
  return {
    source: 'hook',
    agentId: AGENT,
    sessionKey: `gitea:${REPO}:pull:12`,
    msgId: `${HOOK}:msg_delivery_1`,
    hookId: HOOK,
    deliveryKey: 'msg_delivery_1',
    firedAt: '2026-09-12T00:00:00.000Z',
    event: 'merge_request:opened',
    gitea: { repoId: REPO, repoPath: PATH, target: { kind: 'pull', index: 12, headSha: 'a'.repeat(40) } },
    context: {
      source: 'gitea',
      event: 'merge_request',
      action: 'opened',
      number: 12,
      senderLogin: 'alice',
      truncated: false
    },
    ...overrides
  }
}

function host(overrides: { giteaHost?: string; token?: () => Promise<{ token: string }> } = {}) {
  const warn = vi.fn()
  const getGiteaPostToken = vi.fn(overrides.token ?? (async () => ({ token: 'gitea-token' })))
  const invalidateGiteaPost = vi.fn()
  const turnFinalHost = {
    getPostToken: vi.fn(),
    invalidatePost: vi.fn(),
    getGitlabPostToken: vi.fn(),
    invalidateGitlabPost: vi.fn(),
    gitlabHostFor: () => undefined,
    getGiteaPostToken,
    invalidateGiteaPost,
    giteaHostFor: () => overrides.giteaHost,
    log: { warn }
  } as unknown as CodeHostTurnFinalHost
  return { turnFinalHost, warn, getGiteaPostToken, invalidateGiteaPost }
}

describe('reply target (§10.1)', () => {
  it('names the numeric repository as the lease scope, the current path for the REST call, and the triggering comment', () => {
    expect(codeHostReplyTarget(fire())).toEqual({
      hookId: HOOK,
      provider: 'gitea',
      subjectKind: 'merge_request',
      repo: REPO,
      repoPath: PATH,
      number: 12
    })
    const comment = fire({
      gitea: { repoId: REPO, repoPath: PATH, target: { kind: 'issue', index: 42 }, commentId: '9001' },
      context: { source: 'gitea', event: 'issue_comment', action: 'created', number: 42, truncated: false }
    })
    expect(codeHostReplyTarget(comment)).toMatchObject({
      subjectKind: 'issue',
      number: 42,
      triggerComment: { kind: 'issue_comment', id: '9001' }
    })
    // A push has no thread and stays silent.
    expect(
      codeHostReplyTarget(
        fire({
          gitea: { repoId: REPO, repoPath: PATH, target: { kind: 'push', ref: 'refs/heads/main' } },
          context: { source: 'gitea', event: 'push', truncated: false }
        })
      )
    ).toBeUndefined()
  })
})

describe('host fence (§11)', () => {
  it('admits a delivery on the instance the spec names, defaulting both sides to gitea.com', () => {
    expect(codeHostHostFence(fire(), host().turnFinalHost)).toBeUndefined()
    expect(
      codeHostHostFence(fire({ gitea: { ...fire().gitea!, host: GITEA_DEFAULT_BASE_URL } }), host().turnFinalHost)
    ).toBeUndefined()
    expect(
      codeHostHostFence(
        fire({ gitea: { ...fire().gitea!, host: INSTANCE } }),
        host({ giteaHost: INSTANCE }).turnFinalHost
      )
    ).toBeUndefined()
  })

  it('refuses a delivery naming another instance, never re-targeting it', () => {
    const bound = host({ giteaHost: INSTANCE })
    expect(codeHostHostFence(fire(), bound.turnFinalHost)).toBe(GITEA_HOST_MISMATCH_REASON)
    expect(bound.warn).toHaveBeenCalledWith(
      expect.stringContaining(`names gitea instance ${GITEA_DEFAULT_BASE_URL} but its spec is bound to ${INSTANCE}`)
    )
    const unbound = host()
    expect(codeHostHostFence(fire({ gitea: { ...fire().gitea!, host: INSTANCE } }), unbound.turnFinalHost)).toBe(
      'gitea_host_mismatch'
    )
    // A delivery without a Gitea member is not this fence's to judge.
    expect(codeHostHostFence(fire({ gitea: undefined }), bound.turnFinalHost)).toBeUndefined()
  })
})

describe('maintenance pairing (§8)', () => {
  it('maps a merged pull request and a closed issue to the shared worktree-cleanup family, fenced on metadata', () => {
    const gitea = { repoId: REPO, repoPath: PATH, target: { kind: 'pull' as const, index: 12 } }
    expect(codeHostThreadWorktreeCleanup({ event: 'merge_request:merged', gitea })).toBe('pull_request_merged')
    expect(
      codeHostThreadWorktreeCleanup({
        event: 'issues:closed',
        gitea: { ...gitea, target: { kind: 'issue', index: 42 } }
      })
    ).toBe('issue_closed')
    // The event alone never authorizes maintenance, and a closed-unmerged pull request keeps its checkout.
    expect(codeHostThreadWorktreeCleanup({ event: 'merge_request:merged' })).toBeUndefined()
    expect(codeHostThreadWorktreeCleanup({ event: 'issues:closed', gitea })).toBeUndefined()
    expect(codeHostThreadWorktreeCleanup({ event: 'merge_request:closed', gitea })).toBeUndefined()
  })
})

describe('effect lease and poster (§10.1)', () => {
  it('mints the hook-reply lease for the numeric repository and addresses the spec instance', async () => {
    const h = host({ giteaHost: INSTANCE })
    const target = codeHostReplyTarget(fire())!
    const turnFinal = turnFinalFor(target)
    expect(turnFinal.provider).toBe('gitea')
    expect(turnFinal.reportsAbsentOutput).toBe(true)
    const lease = turnFinal.effectLease(AGENT, target, h.turnFinalHost)
    expect(await lease.token()).toBe('gitea-token')
    expect(h.getGiteaPostToken).toHaveBeenCalledWith(AGENT, REPO, HOOK)
    lease.invalidateToken('gitea-token')
    expect(h.invalidateGiteaPost).toHaveBeenCalledWith(AGENT, REPO, 'gitea-token')
    expect(lease.apiBaseUrl()).toBe(`${INSTANCE}/api/v1`)
    expect(turnFinalFor(target).effectLease(AGENT, target, host().turnFinalHost).apiBaseUrl()).toBe(
      'https://gitea.com/api/v1'
    )
  })

  it('builds the Gitea poster on the issue-comments path of the current repository path', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response('{"id":77}', { status: 201, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const target = codeHostReplyTarget(fire())!
    const poster = turnFinalFor(target).finalPoster(target, {
      token: async () => 'gitea-token',
      invalidateToken: () => undefined,
      apiBaseUrl: () => `${INSTANCE}/api/v1`,
      log: { warn: () => undefined }
    })
    expect(poster).toBeInstanceOf(GiteaFinalPoster)
    vi.stubGlobal('fetch', fetchImpl)
    try {
      expect(await poster.publish('answer')).toEqual({ provider: 'gitea', kind: 'comment', externalId: '77' })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls).toEqual([`${INSTANCE}/api/v1/repos/${PATH}/issues/12/comments`])
  })
})

describe('prompt supplement (§8)', () => {
  const reviewFire = (extra: Partial<RdMsgHook> = {}) =>
    fire({
      event: 'review:approved',
      context: {
        source: 'gitea',
        event: 'review',
        action: 'approved',
        number: 12,
        senderLogin: 'alice',
        bodyExcerpt: 'ship it',
        truncated: false
      },
      ...extra
    })

  it('correlates a review delivery under the turn’s own lease, on the spec instance', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url)
      expect((init.headers as Record<string, string>).authorization).toBe('token gitea-token')
      const body = url.includes('/comments')
        ? [{ id: 5, path: 'src/a.ts', position: 3, body: 'nit' }]
        : [{ id: 987, user: { login: 'alice' }, state: 'APPROVED', body: 'ship it', commit_id: '' }]
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const h = host({ giteaHost: INSTANCE })
    const target = codeHostReplyTarget(reviewFire())!
    const lease = turnFinalFor(target).effectLease(AGENT, target, h.turnFinalHost)
    const supplement = await turnFinalFor(target).promptSupplement!(reviewFire(), {
      token: lease.token,
      apiBaseUrl: lease.apiBaseUrl,
      log: h.turnFinalHost.log,
      fetchImpl
    })
    expect(supplement).toEqual({
      giteaReview: {
        kind: 'matched',
        reviews: [{ id: '987', comments: [{ id: '5', path: 'src/a.ts', line: 3, side: 'new', body: 'nit' }] }]
      }
    })
    expect(urls[0]).toBe(`${INSTANCE}/api/v1/repos/${PATH}/pulls/12/reviews?page=1&limit=50`)
  })

  it('fetches nothing for a delivery that is not a review submission, and degrades when the lease is refused', async () => {
    const h = host({
      token: async () => {
        throw new Error('LEASE_DENIED')
      }
    })
    expect(await codeHostPromptSupplement(fire(), h.turnFinalHost)).toBeUndefined()
    expect(h.getGiteaPostToken).not.toHaveBeenCalled()
    expect(await codeHostPromptSupplement(reviewFire(), h.turnFinalHost)).toEqual({
      giteaReview: { kind: 'unavailable', reason: 'LEASE_DENIED' }
    })
    expect(
      await codeHostPromptSupplement(
        reviewFire({ context: { ...reviewFire().context!, senderLogin: undefined } }),
        host().turnFinalHost
      )
    ).toEqual({
      giteaReview: { kind: 'unavailable', reason: 'the delivery names no sender' }
    })
  })
})
