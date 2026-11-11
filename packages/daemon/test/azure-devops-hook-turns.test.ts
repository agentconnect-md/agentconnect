// Azure DevOps hook turns on the daemon (azure-devops-integration.md §11.4, §11.5, §11.8): the turn-start read and its classification, the reply target and poster, the like, admission, and the prompt.
import { describe, expect, it, vi } from 'vitest'
import type { AzureDevOpsHookMetadata, GitCredGrant, RdMsgHook } from '@agentconnect.md/protocol'
import { GitCredentialCache, GitCredUnavailableError, type GitCredentialCacheDeps } from '../src/cp/git-credential.js'
import {
  codeHostHostFence,
  codeHostIgnoredDelivery,
  codeHostReplyTarget,
  codeHostResolveDelivery,
  codeHostThreadWorktreeCleanup,
  turnFinalFor,
  type CodeHostTurnFinalHost
} from '../src/codehost/turn-final.js'
import { acknowledgeCodeHostTrigger } from '../src/codehost/ack.js'
import { hookAdmissionFor } from '../src/codehost/hook-admission.js'
import {
  buildHookMessage,
  buildHookTurnFacts,
  UNTRUSTED_CONTENT_BEGIN_AZURE_DEVOPS
} from '../src/messages/hook-message.js'
import { AZURE_DEVOPS_READ_FAILED, resolveAzureDevOpsDelivery } from '../src/azure-devops/turn-final.js'
import { AzureDevOpsFinalPoster } from '../src/azure-devops/poster.js'
import { HOOK_NOTICE_TEXT } from '../src/codehost/notice.js'
import type { PosterScheduler } from '../src/github/poster.js'
import type { HookDispatchContext } from '../src/github/hook-coords.js'

// Every identifier below is synthetic (publication policy).
const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ORG = 'example-org'
const PROJECT = '00000000-0000-4000-8000-0000000000a2'
const REPOSITORY = '00000000-0000-4000-8000-0000000000a1'
const IDENTITY = '00000000-0000-4000-8000-0000000000b1'
const HUMAN = '00000000-0000-4000-8000-0000000000b2'
const REPO_ID = '42'
const REPO_PATH = `${ORG}/Example Project/Example Repo`
const API = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPOSITORY}`
const V = '?api-version=7.1'
const OLD_SHA = 'a'.repeat(40)
const NEW_SHA = 'b'.repeat(40)

function azure(over: Partial<AzureDevOpsHookMetadata> = {}): AzureDevOpsHookMetadata {
  return {
    repoId: REPO_ID,
    repoPath: REPO_PATH,
    organization: ORG,
    projectId: PROJECT,
    repositoryId: REPOSITORY,
    deliveryKind: 'opened',
    target: { kind: 'pull', pullRequestId: 7, headSha: OLD_SHA, isDraft: false },
    ...over
  }
}

function fire(over: Partial<RdMsgHook> = {}, member: Partial<AzureDevOpsHookMetadata> = {}): RdMsgHook {
  const metadata = azure(member)
  const kind = metadata.deliveryKind
  const event =
    kind === 'comment'
      ? 'note:created'
      : kind === 'push'
        ? 'push'
        : `merge_request:${{ opened: 'opened', revision: 'synchronize', reviewers: 'review_requested', state: 'state_changed', merged: 'merged' }[kind]}`
  const colon = event.indexOf(':')
  return {
    source: 'hook',
    agentId: AGENT,
    sessionKey: `azure-devops:${REPO_ID}:pull:7`,
    msgId: `${HOOK}:event-1`,
    hookId: HOOK,
    deliveryKey: 'event-1',
    firedAt: '2026-11-07T00:00:00.000Z',
    event,
    azureDevOps: metadata,
    context: {
      source: 'azure-devops',
      event: colon === -1 ? event : event.slice(0, colon),
      ...(colon === -1 ? {} : { action: event.slice(colon + 1) }),
      repo: REPO_PATH,
      number: 7,
      truncated: false
    },
    ...over
  }
}

function comment(over: Partial<RdMsgHook> = {}): RdMsgHook {
  const msg = fire(
    {},
    { deliveryKind: 'comment', target: { kind: 'pull', pullRequestId: 7 }, threadId: '12', commentId: '3' }
  )
  return {
    ...msg,
    context: { ...msg.context!, senderLogin: 'Alice Example', bodyExcerpt: '@reviewer what is the rollout plan?' },
    ...over
  }
}

function host(opts: { tokens?: string[]; mint?: () => Promise<{ token: string; username: string }> } = {}) {
  const tokens = opts.tokens ?? ['hook-token']
  let minted = 0
  const getAzureDevOpsPostLease = vi.fn(
    opts.mint ?? (async () => ({ token: tokens[Math.min(minted++, tokens.length - 1)]!, username: IDENTITY }))
  )
  const invalidateAzureDevOpsPost = vi.fn()
  const warn = vi.fn()
  const turnFinalHost = {
    getAzureDevOpsPostLease,
    invalidateAzureDevOpsPost,
    gitlabHostFor: () => undefined,
    giteaHostFor: () => undefined,
    log: { warn }
  } as unknown as CodeHostTurnFinalHost
  return { turnFinalHost, getAzureDevOpsPostLease, invalidateAzureDevOpsPost, warn }
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

function pullBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 7,
    title: 'Tighten   retry\nbudget',
    status: 'active',
    isDraft: false,
    createdBy: { id: HUMAN, displayName: 'Alice Example' },
    sourceRefName: 'refs/heads/topic',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: OLD_SHA },
    description: 'Reworks the retry budget.',
    reviewers: [],
    ...over
  }
}

const ITERATIONS = {
  count: 2,
  value: [
    { id: 2, sourceRefCommit: { commitId: NEW_SHA } },
    { id: 1, sourceRefCommit: { commitId: OLD_SHA } }
  ]
}

const THREAD = {
  id: 12,
  status: 'active',
  threadContext: {
    filePath: '/src/retry.ts',
    rightFileStart: { line: 10, offset: 1 },
    rightFileEnd: { line: 14, offset: 1 }
  },
  comments: [
    { id: 1, author: { displayName: 'Bob Example' }, content: 'Is the cap right?', commentType: 'text' },
    { id: 2, author: { displayName: 'System' }, content: 'voted', commentType: 'system' },
    {
      id: 3,
      author: { displayName: 'Alice Example' },
      content: '@reviewer what is the rollout plan?',
      commentType: 'text'
    }
  ]
}

/** Answers by path: the pull request, its iterations, and the thread; `statuses` fails calls in order. */
function fakeAzure(opts: { pull?: Record<string, unknown>; statuses?: number[]; iterations?: unknown[] } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const index = calls.length
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
    })
    const status = opts.statuses?.[index]
    if (status !== undefined && status >= 400) return new Response('', { status })
    const path = String(url).slice(API.length).replace(V, '')
    if (path === '/pullRequests/7') return Response.json(opts.pull ?? pullBody())
    if (path === '/pullRequests/7/iterations')
      return Response.json(opts.iterations ? { value: opts.iterations } : ITERATIONS)
    if (path === '/pullRequests/7/threads/12') return Response.json(THREAD)
    return new Response('', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('reply target and lifecycle (§11.5)', () => {
  it('opens a thread on the pull request, or answers in the comment’s own thread, never on a push', () => {
    expect(codeHostReplyTarget(fire())).toEqual({
      hookId: HOOK,
      provider: 'azure-devops',
      host: API,
      subjectKind: 'merge_request',
      repo: REPO_ID,
      repoPath: REPO_PATH,
      number: 7
    })
    expect(codeHostReplyTarget(comment())).toMatchObject({
      reviewThreadRootCommentId: '12',
      triggerComment: { kind: 'note', id: '3' }
    })
    expect(
      codeHostReplyTarget(
        fire({ event: 'push' }, { deliveryKind: 'push', target: { kind: 'push', ref: 'refs/heads/main' } })
      )
    ).toBeUndefined()
  })

  it('fences no instance, and refuses a target whose API root is not a repository’s', () => {
    expect(codeHostHostFence(fire(), host().turnFinalHost)).toBeUndefined()
    const target = codeHostReplyTarget(fire())!
    const lease = turnFinalFor(target).effectLease(AGENT, target, host().turnFinalHost)
    expect(lease.apiBaseUrl()).toBe(API)
    for (const forged of ['https://example.test/x', `${API}/pullRequests/7`, API.replace('https:', 'http:')]) {
      const bad = turnFinalFor(target).effectLease(AGENT, { ...target, host: forged }, host().turnFinalHost)
      expect(() => bad.apiBaseUrl()).toThrow('names no repository')
    }
  })

  it('retires the checkout on a completed or abandoned pull request, and ignores what the read left unclassified', () => {
    const delivery = (event: string) => ({ event, azureDevOps: azure({ deliveryKind: 'state' }) })
    expect(codeHostThreadWorktreeCleanup(delivery('merge_request:merged'))).toBe('pull_request_merged')
    expect(codeHostThreadWorktreeCleanup(delivery('merge_request:closed'))).toBe('pull_request_closed')
    expect(codeHostThreadWorktreeCleanup(delivery('merge_request:reopened'))).toBeUndefined()
    expect(codeHostIgnoredDelivery(delivery('merge_request:state_changed'))).toBe('state_change_ignored')
    expect(codeHostIgnoredDelivery(delivery('merge_request:reviewers_updated'))).toBe('review_request_not_for_identity')
    expect(codeHostIgnoredDelivery(delivery('merge_request:review_requested'))).toBeUndefined()
  })
})

describe('the turn-start read (§11.4)', () => {
  it('reads under the hook lease with a bearer token, and fences the head on the newest iteration', async () => {
    const h = host()
    const { fetchImpl, calls } = fakeAzure()
    const resolved = await resolveAzureDevOpsDelivery(
      fire({}, { deliveryKind: 'revision', target: { kind: 'pull', pullRequestId: 7 } }),
      h.turnFinalHost,
      fetchImpl
    )
    expect(h.getAzureDevOpsPostLease).toHaveBeenCalledWith(AGENT, REPO_ID, HOOK)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${API}/pullRequests/7${V}`],
      ['GET', `${API}/pullRequests/7/iterations${V}`]
    ])
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer hook-token', 'x-tfs-fedauthredirect': 'Suppress' })
    if (!resolved || 'refused' in resolved) throw new Error('expected a delivery')
    expect(resolved.msg.event).toBe('merge_request:synchronize')
    expect(resolved.msg.azureDevOps?.target).toEqual({
      kind: 'pull',
      pullRequestId: 7,
      headSha: NEW_SHA,
      isDraft: false
    })
    // An update kind carries no title, so the read names it, flattened.
    expect(resolved.msg.context?.title).toBe('Tighten retry budget')
    expect(resolved.supplement?.azureDevOps).toMatchObject({
      kind: 'read',
      pull: { status: 'active', sourceBranch: 'topic', targetBranch: 'main', headSha: NEW_SHA, iteration: 2 }
    })
  })

  it.each([
    ['the identity with no vote', [{ id: IDENTITY.toUpperCase(), vote: 0 }], 'merge_request:review_requested'],
    ['the identity after it voted', [{ id: IDENTITY, vote: 10 }], 'merge_request:reviewers_updated'],
    ['the identity declined', [{ id: IDENTITY, vote: 0, hasDeclined: true }], 'merge_request:reviewers_updated'],
    ['someone else', [{ id: HUMAN, vote: 0 }], 'merge_request:reviewers_updated']
  ])('classifies a reviewer change naming %s', async (_name, reviewers, event) => {
    const { fetchImpl } = fakeAzure({ pull: pullBody({ reviewers }) })
    const msg = fire({}, { deliveryKind: 'reviewers', target: { kind: 'pull', pullRequestId: 7 } })
    const resolved = await resolveAzureDevOpsDelivery(msg, host().turnFinalHost, fetchImpl)
    if (!resolved || 'refused' in resolved) throw new Error('expected a delivery')
    expect(resolved.msg.event).toBe(event)
    expect(resolved.msg.context?.action).toBe(event.slice('merge_request:'.length))
  })

  it.each([
    ['active, admitting a reopening', 'active', true, 'merge_request:reopened'],
    ['active, admitting none', 'active', false, 'merge_request:state_changed'],
    ['abandoned', 'abandoned', true, 'merge_request:closed'],
    ['completed', 'completed', false, 'merge_request:merged']
  ])('classifies a status change found %s', async (_name, status, admitsReopened, event) => {
    const { fetchImpl } = fakeAzure({ pull: pullBody({ status }) })
    const msg = fire({}, { deliveryKind: 'state', target: { kind: 'pull', pullRequestId: 7, admitsReopened } })
    const resolved = await resolveAzureDevOpsDelivery(msg, host().turnFinalHost, fetchImpl)
    if (!resolved || 'refused' in resolved) throw new Error('expected a delivery')
    expect(resolved.msg.event).toBe(event)
  })

  it('reads a comment’s thread: its place in the diff and the comments before the one that fired', async () => {
    const { fetchImpl, calls } = fakeAzure()
    const resolved = await resolveAzureDevOpsDelivery(comment(), host().turnFinalHost, fetchImpl)
    expect(calls.map((c) => c.url)).toContain(`${API}/pullRequests/7/threads/12${V}`)
    if (!resolved || 'refused' in resolved) throw new Error('expected a delivery')
    expect(resolved.msg.event).toBe('note:created')
    expect(resolved.supplement?.azureDevOps).toMatchObject({
      kind: 'read',
      pull: {
        thread: {
          id: '12',
          filePath: '/src/retry.ts',
          right: { start: 10, end: 14 },
          comments: [{ id: '1', author: 'Bob Example', body: 'Is the cap right?' }]
        }
      }
    })
  })

  it('re-mints once after a rejected lease', async () => {
    const h = host({ tokens: ['stale', 'fresh'] })
    const { fetchImpl, calls } = fakeAzure({ statuses: [401] })
    const resolved = await resolveAzureDevOpsDelivery(fire(), h.turnFinalHost, fetchImpl)
    expect(h.invalidateAzureDevOpsPost).toHaveBeenCalledWith(AGENT, REPO_ID, 'stale')
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer fresh')
    expect(resolved && 'msg' in resolved).toBe(true)
  })

  it('refuses an update kind it could not read, and keeps any other delivery with the failure said', async () => {
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    const reviewers = fire({}, { deliveryKind: 'reviewers', target: { kind: 'pull', pullRequestId: 7 } })
    expect(await resolveAzureDevOpsDelivery(reviewers, host().turnFinalHost, failing)).toEqual({
      refused: AZURE_DEVOPS_READ_FAILED
    })
    const kept = await resolveAzureDevOpsDelivery(fire(), host().turnFinalHost, failing)
    expect(kept).toMatchObject({ msg: fire(), supplement: { azureDevOps: { kind: 'unavailable' } } })
    // A refused lease is the same failure.
    const refusedLease = host({ mint: async () => Promise.reject(new Error('hook is not enabled')) })
    expect(await resolveAzureDevOpsDelivery(reviewers, refusedLease.turnFinalHost, failing)).toEqual({
      refused: AZURE_DEVOPS_READ_FAILED
    })
  })

  it('refuses a revision whose read fails or finds no head, since supersession keys on that head', async () => {
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    const revision = fire(
      { event: 'merge_request:synchronize' },
      { deliveryKind: 'revision', target: { kind: 'pull', pullRequestId: 7 } }
    )
    expect(await resolveAzureDevOpsDelivery(revision, host().turnFinalHost, failing)).toEqual({
      refused: AZURE_DEVOPS_READ_FAILED
    })
    const noIterations = fakeAzure({ iterations: [], pull: pullBody({ lastMergeSourceCommit: undefined }) })
    expect(await resolveAzureDevOpsDelivery(revision, host().turnFinalHost, noIterations.fetchImpl)).toEqual({
      refused: AZURE_DEVOPS_READ_FAILED
    })
  })

  it('takes a "merge attempted" delivery as a merge only once the read finds the pull request completed', async () => {
    const merged = fire({ event: 'merge_request:merged' }, { deliveryKind: 'merged' })
    const active = await resolveAzureDevOpsDelivery(merged, host().turnFinalHost, fakeAzure().fetchImpl)
    expect(active && 'msg' in active && active.msg.event).toBe('merge_request:state_changed')
    const done = await resolveAzureDevOpsDelivery(
      merged,
      host().turnFinalHost,
      fakeAzure({ pull: pullBody({ status: 'completed' }) }).fetchImpl
    )
    expect(done && 'msg' in done && done.msg.event).toBe('merge_request:merged')
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    expect(await resolveAzureDevOpsDelivery(merged, host().turnFinalHost, failing)).toEqual({
      refused: AZURE_DEVOPS_READ_FAILED
    })
  })

  it('reads nothing for a push or a delivery of another host', async () => {
    const { fetchImpl, calls } = fakeAzure()
    const h = host()
    const push = fire({ event: 'push' }, { deliveryKind: 'push', target: { kind: 'push', ref: 'refs/heads/main' } })
    expect(await resolveAzureDevOpsDelivery(push, h.turnFinalHost, fetchImpl)).toBeUndefined()
    const { azureDevOps: _drop, ...webhook } = fire()
    expect(await codeHostResolveDelivery(webhook, h.turnFinalHost)).toEqual({ msg: webhook })
    expect(calls).toEqual([])
  })
})

function scheduler(): PosterScheduler {
  return { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} }
}

function posterFetch(statuses: number[] = [], body = '{"id":5,"comments":[{"id":1}]}') {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const status = statuses[calls.length]
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body))
    })
    if (status !== undefined && status >= 400) return new Response('', { status })
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('the final poster (§11.5)', () => {
  const deps = (fetchImpl: typeof fetch, invalidateToken?: (token: string) => void) => ({
    token: async () => 'hook-token',
    ...(invalidateToken ? { invalidateToken } : {}),
    apiBaseUrl: () => API,
    log: { warn: vi.fn() },
    fetchImpl,
    scheduler: scheduler()
  })

  it('opens one active thread with a text comment for a trigger that is not a comment, exactly once', async () => {
    const { fetchImpl, calls } = posterFetch()
    const poster = new AzureDevOpsFinalPoster(deps(fetchImpl), { repoId: REPO_ID, pullRequestId: 7 })
    const published = await poster.publish('looks good')
    expect(await poster.publish('again')).toBe(published)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/pullRequests/7/threads${V}`,
      headers: { authorization: 'Bearer hook-token', 'content-type': 'application/json' },
      body: { comments: [{ parentCommentId: 0, content: 'looks good', commentType: 1 }], status: 1 }
    })
    expect(published).toEqual({ provider: 'azure-devops', kind: 'thread', externalId: '5' })
  })

  it('replies in the comment’s thread to the comment that fired it, reporting the thread', async () => {
    const { fetchImpl, calls } = posterFetch([], '{"id":4,"parentCommentId":3}')
    const poster = new AzureDevOpsFinalPoster(deps(fetchImpl), {
      repoId: REPO_ID,
      pullRequestId: 7,
      threadId: '12',
      parentCommentId: '3'
    })
    expect(await poster.publish('the rollout is staged')).toEqual({
      provider: 'azure-devops',
      kind: 'thread',
      externalId: '12'
    })
    expect(calls[0]).toMatchObject({
      url: `${API}/pullRequests/7/threads/12/comments${V}`,
      body: { parentCommentId: 3, content: 'the rollout is staged', commentType: 1 }
    })
  })

  it('retries once after a rejected token, and names the failure when nothing posted', async () => {
    const invalidate = vi.fn()
    const retried = posterFetch([401])
    expect(
      await new AzureDevOpsFinalPoster(deps(retried.fetchImpl, invalidate), {
        repoId: REPO_ID,
        pullRequestId: 7
      }).publish('x')
    ).toBeDefined()
    expect(invalidate).toHaveBeenCalledWith('hook-token')
    expect(retried.calls).toHaveLength(2)
    const failed = posterFetch([500])
    const poster = new AzureDevOpsFinalPoster(deps(failed.fetchImpl), { repoId: REPO_ID, pullRequestId: 7 })
    expect(await poster.publish('x')).toBeUndefined()
    expect(poster.failure).toBe('post_failed')
  })

  it('posts the refusal notice through the same member, in the thread of the refused comment', async () => {
    const { fetchImpl, calls } = posterFetch([], '{"id":4}')
    const target = codeHostReplyTarget(comment())!
    const turnFinal = turnFinalFor(target)
    const poster = turnFinal.finalPoster(target, {
      ...turnFinal.effectLease(AGENT, target, host().turnFinalHost),
      log: { warn: vi.fn() }
    })
    // The member's lease is the host's; the wire is checked through a poster on the same place.
    expect(poster).toBeInstanceOf(AzureDevOpsFinalPoster)
    const direct = new AzureDevOpsFinalPoster(deps(fetchImpl), {
      repoId: REPO_ID,
      pullRequestId: 7,
      threadId: '12',
      parentCommentId: '3'
    })
    await direct.publish(HOOK_NOTICE_TEXT.actor_not_trusted)
    expect(calls[0]!.body).toMatchObject({ parentCommentId: 3, content: HOOK_NOTICE_TEXT.actor_not_trusted })
  })
})

describe('the acknowledgement (§11.5)', () => {
  function ackFetch(status = 200) {
    const calls: Call[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>
      })
      return new Response(null, { status })
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  it('likes the comment that fired the turn, with no body', async () => {
    const { fetchImpl, calls } = ackFetch()
    const warn = vi.fn()
    await acknowledgeCodeHostTrigger(codeHostReplyTarget(comment())!, {
      token: async () => 'hook-token',
      apiBaseUrl: () => API,
      log: { warn },
      fetchImpl
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${API}/pullRequests/7/threads/12/comments/3/likes${V}`,
        headers: expect.objectContaining({ authorization: 'Bearer hook-token' })
      }
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reacts to nothing else, and a failed like only warns', async () => {
    const quiet = ackFetch()
    const token = vi.fn(async () => 'hook-token')
    await acknowledgeCodeHostTrigger(codeHostReplyTarget(fire())!, {
      token,
      apiBaseUrl: () => API,
      log: { warn: vi.fn() },
      fetchImpl: quiet.fetchImpl
    })
    expect(quiet.calls).toEqual([])
    expect(token).not.toHaveBeenCalled()
    const failing = ackFetch(500)
    const warn = vi.fn()
    await expect(
      acknowledgeCodeHostTrigger(codeHostReplyTarget(comment())!, {
        token: async () => 'hook-token',
        apiBaseUrl: () => API,
        log: { warn },
        fetchImpl: failing.fetchImpl
      })
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('azure-devops ack: reaction rejected (HTTP 500)')
  })
})

describe('admission (§11.4)', () => {
  const coords = { agentId: AGENT, platform: 'hook', channel: HOOK }
  const hook = (event: string, member: Partial<AzureDevOpsHookMetadata> = {}): HookDispatchContext => ({
    hookId: HOOK,
    agentId: AGENT,
    deliveryKey: 'event-1',
    firedAt: '2026-11-07T00:00:00.000Z',
    event,
    azureDevOps: azure(member)
  })

  it('contests one pull request’s lane on the head the read fenced; a review request pins it', () => {
    const admission = hookAdmissionFor(hook('merge_request:opened'))!
    expect(admission.provider).toBe('azure-devops')
    const opened = admission.revisionStream(hook('merge_request:opened'), coords)
    expect(opened).toMatchObject({ revision: OLD_SHA, pinned: false })
    expect(admission.revisionStream(hook('merge_request:review_requested'), coords)).toMatchObject({
      lane: opened!.lane,
      pinned: true
    })
    expect(
      admission.revisionStream(
        hook('merge_request:synchronize', { target: { kind: 'pull', pullRequestId: 7 } }),
        coords
      )
    ).toBeUndefined()
    expect(admission.revisionStream(hook('merge_request:reopened'), coords)).toBeUndefined()
    expect(admission.rerunsCurrentRevision(hook('merge_request:review_requested'))).toBe(true)
  })

  it('batches comments per thread, since the one reply goes into the leader’s thread', () => {
    const admission = hookAdmissionFor(hook('note:created'))!
    const inThread = (threadId: string) => hook('note:created', { deliveryKind: 'comment', threadId, commentId: '3' })
    const first = admission.reviewBatchStream(inThread('12'), coords)
    expect(first).toBeDefined()
    expect(admission.reviewBatchStream(inThread('12'), coords)).toBe(first)
    expect(admission.reviewBatchStream(inThread('13'), coords)).not.toBe(first)
    expect(admission.reviewBatchStream(hook('merge_request:opened'), coords)).toBeUndefined()
    const batch = admission.openReviewBatch(inThread('12'), coords, 'short', 0, 'the prompt')
    expect(batch).toMatchObject({ reviewId: `${REPO_ID}#7:12`, items: [{ text: 'the prompt' }] })
    expect(
      admission.renderBatchPrompt({
        ...batch!,
        items: [...batch!.items, { ...batch!.items[0]!, deliveryKey: 'event-2' }]
      })
    ).toContain('posts it back into that comment thread automatically as one reply')
    expect(admission.batchPublishesItems).toBe(false)
  })
})

describe('the hook-reply lease (§11.5)', () => {
  function grant(): GitCredGrant {
    return {
      username: IDENTITY,
      token: 'hook-token',
      ttlSec: 3600,
      expiresAt: '2026-11-07T01:00:00.000Z',
      repoFullName: REPO_PATH,
      access: 'comment',
      provider: 'azure-devops',
      externalRepoId: REPO_ID
    }
  }

  it('asks for the hook’s purpose as the daemon, re-mints past the cache after a rejection, and never caches a refusal', async () => {
    const request = vi.fn(async (_payload: Parameters<GitCredentialCacheDeps['request']>[0]) => grant())
    const cache = new GitCredentialCache({ request, log: { warn: () => undefined }, providerV2Supported: () => true })
    const lease = await cache.getAzureDevOpsPostLease(AGENT, REPO_ID, HOOK)
    expect(lease).toMatchObject({ username: IDENTITY, token: 'hook-token', access: 'comment' })
    expect(request.mock.calls[0]?.[0]).toEqual({
      agentId: AGENT,
      reason: 'helper',
      provider: 'azure-devops',
      externalRepoId: REPO_ID,
      purpose: 'azure_devops_hook_reply',
      hookId: HOOK,
      consumer: 'daemon'
    })
    expect(await cache.getAzureDevOpsPostLease(AGENT, REPO_ID, HOOK)).toBe(lease)
    cache.invalidateAzureDevOpsPost(AGENT, REPO_ID, 'hook-token')
    await cache.getAzureDevOpsPostLease(AGENT, REPO_ID, HOOK)
    expect(request.mock.calls[1]?.[0]).toMatchObject({ forceRefresh: true })
    const refused = new GitCredentialCache({
      request: vi.fn(async () => {
        throw Object.assign(new Error('hook disabled'), { code: 'SCOPE_DENIED' })
      }),
      log: { warn: () => undefined },
      providerV2Supported: () => true
    })
    await expect(refused.getAzureDevOpsPostLease(AGENT, REPO_ID, HOOK)).rejects.toMatchObject({ terminal: false })
    const old = new GitCredentialCache({ request, log: { warn: () => undefined } })
    await expect(old.getAzureDevOpsPostLease(AGENT, REPO_ID, HOOK)).rejects.toBeInstanceOf(GitCredUnavailableError)
  })
})

describe('the prompt (§11.5, §11.8)', () => {
  it('keys the session on the surrogate id and links the pull request’s page', () => {
    const msg = buildHookMessage(fire(), 'trace')
    expect(msg.channel).toBe(HOOK)
    expect(msg.thread).toBe(`azure-devops:${REPO_ID}:pull:7`)
    expect(msg.transportScope).toBe(`azure-devops:${REPO_ID}`)
    expect(msg.threadUrl).toBe(`https://dev.azure.com/${ORG}/Example%20Project/_git/Example%20Repo/pullrequest/7`)
    expect(msg.initialSessionTitle).toBe(`PR ${REPO_PATH}!7`)
  })

  it('keeps the source repository linked when the session anchors into Slack', () => {
    expect(buildHookMessage(fire({ target: { platform: 'slack', channel: 'C1' } }), 'trace')).toMatchObject({
      sourceRepository: {
        label: REPO_PATH,
        url: `https://dev.azure.com/${ORG}/Example%20Project/_git/Example%20Repo`
      }
    })
  })

  it('stands on a `# Azure DevOps` block naming the tools before the CLI', () => {
    const standing = buildHookMessage(fire(), 'trace').standingContext!
    expect(standing.startsWith('# Azure DevOps')).toBe(true)
    const tools = standing.indexOf('`azureDevOpsComment`')
    expect(tools).toBeGreaterThan(-1)
    expect(standing.indexOf('`readAzureDevOpsPullRequest`')).toBeGreaterThan(tools)
    expect(standing.indexOf('Azure CLI')).toBeGreaterThan(tools)
    // A push answers nothing, so it takes no rules.
    const push = fire({ event: 'push' }, { deliveryKind: 'push', target: { kind: 'push', ref: 'refs/heads/main' } })
    expect(buildHookMessage(push, 'trace').standingContext).toBeUndefined()
  })

  it('renders the read: the header outside the fence, every authored string inside it, and where the reply goes', async () => {
    const { fetchImpl } = fakeAzure()
    const resolved = await resolveAzureDevOpsDelivery(comment(), host().turnFinalHost, fetchImpl)
    if (!resolved || 'refused' in resolved) throw new Error('expected a delivery')
    const text = buildHookMessage(resolved.msg, 'trace', resolved.supplement).turnBody!.prompt!
    expect(text).toContain(`Azure DevOps note:created — ${REPO_PATH}!7 "Tighten retry budget"`)
    expect(text).toContain(`Head SHA: ${NEW_SHA}`)
    expect(text).toContain('Branches: topic → main')
    expect(text).toContain('The comment is in thread 12 on /src/retry.ts, source lines 10–14 of the diff.')
    const fenced = text.slice(text.indexOf(UNTRUSTED_CONTENT_BEGIN_AZURE_DEVOPS))
    expect(fenced).toContain('@reviewer what is the rollout plan?')
    expect(fenced).toContain('[comment 1] Bob Example\nIs the cap right?')
    expect(text).not.toContain('voted')
    expect(
      text.endsWith(
        'into that comment thread automatically as one reply. The daemon owns the reply; post nothing yourself.'
      )
    ).toBe(true)
    // An update kind shows the description, fenced; a trigger that is not a comment opens a thread.
    const reopened = await resolveAzureDevOpsDelivery(
      fire({}, { deliveryKind: 'state', target: { kind: 'pull', pullRequestId: 7, admitsReopened: true } }),
      host().turnFinalHost,
      fakeAzure().fetchImpl
    )
    if (!reopened || 'refused' in reopened) throw new Error('expected a delivery')
    const reopenedText = buildHookMessage(reopened.msg, 'trace', reopened.supplement).turnBody!.prompt!
    expect(reopenedText).toContain('Azure DevOps merge_request:reopened')
    expect(reopenedText).toContain(`${UNTRUSTED_CONTENT_BEGIN_AZURE_DEVOPS}\nReworks the retry budget.`)
    expect(reopenedText).toContain('as one comment in a new thread')
  })

  it('names submitCodeReview and the shared vote when a delivery opens a review generation (§11.6)', () => {
    const standing = buildHookMessage(fire(), 'trace').standingContext!
    expect(standing).toContain('`submitCodeReview`')
    expect(standing).toContain('connection identity every agent shares')
    const reviewed = buildHookMessage(fire({ reviewPolicy: 'full' }), 'trace').turnBody!.prompt!
    expect(reviewed).toContain('This delivery opens a review generation for the current pull-request revision')
    expect(reviewed).toContain('use APPROVE + pass when it passes, or REQUEST_CHANGES + fail')
    // A comment, or a hook whose review policy is off, keeps the ordinary reply.
    expect(buildHookMessage(fire({ reviewPolicy: 'off' }), 'trace').turnBody!.prompt!).not.toContain('submitCodeReview')
    expect(buildHookMessage(comment({ reviewPolicy: 'full' }), 'trace').turnBody!.prompt!).not.toContain(
      'submitCodeReview'
    )
  })

  it('says when the pull request could not be read', () => {
    const text = buildHookMessage(fire(), 'trace', {
      azureDevOps: { kind: 'unavailable', reason: 'Azure DevOps GET failed' }
    }).turnBody!.prompt!
    expect(text).toContain('The pull request could not be read (Azure DevOps GET failed)')
  })
})

describe('the turn facts (§11.8)', () => {
  it('names the pull request with its head, draft state and thread link, and a push by its ref', () => {
    const facts = buildHookTurnFacts(fire({ reviewPolicy: 'full' }))
    expect(facts).toMatchObject({
      provider: 'azure-devops',
      event: 'merge_request:opened',
      subject: {
        kind: 'pull_request',
        repo: REPO_PATH,
        number: 7,
        url: `https://dev.azure.com/${ORG}/Example%20Project/_git/Example%20Repo/pullrequest/7`
      },
      revision: { head: OLD_SHA },
      draft: false,
      review: 'generation'
    })
    const push = buildHookTurnFacts(
      fire({ event: 'push' }, { deliveryKind: 'push', target: { kind: 'push', ref: 'refs/heads/main' } })
    )
    expect(push).toMatchObject({
      provider: 'azure-devops',
      subject: { kind: 'push', repo: REPO_PATH },
      ref: 'refs/heads/main'
    })
    expect(push).not.toHaveProperty('review')
  })
})
