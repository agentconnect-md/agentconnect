import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  AZURE_DEVOPS_HOOKS_V1_FEATURE,
  AZURE_DEVOPS_V1_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RD_HOOK_NOTICE_V1,
  type AzureDevOpsDeliveryKind,
  type RcCodeHostDelivery,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcRunReport,
  type RdAck,
  type RdMsg,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { HookTable } from '../hook-table.js'
import { HookRateLimiter } from '../rate-limit.js'
import { registerAzureDevOpsIngress } from './ingress.js'
import { mentionsAzureDevOpsIdentity } from './events.js'

// Every identifier below is synthetic (publication policy).
const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ORG = 'example-org'
const COLLECTION = '00000000-0000-4000-8000-0000000000a0'
const REPOSITORY = '00000000-0000-4000-8000-0000000000a1'
const PROJECT = '00000000-0000-4000-8000-0000000000a2'
const OTHER_REPOSITORY = '00000000-0000-4000-8000-0000000000a9'
const IDENTITY = '00000000-0000-4000-8000-0000000000b1'
const HUMAN = '00000000-0000-4000-8000-0000000000b2'
const EVENT = '00000000-0000-4000-8000-0000000000e1'
const REPO_ID = '42'
const REPO_PATH = `${ORG}/Example Project/Example Repo`
const HEAD_SHA = 'a'.repeat(40)
const KEY = randomBytes(32).toString('hex')
const NEXT_KEY = randomBytes(32).toString('hex')
const PREVIOUS_KEY = randomBytes(32).toString('hex')

const SUBSCRIPTIONS: Record<AzureDevOpsDeliveryKind, string> = {
  opened: '00000000-0000-4000-8000-0000000000c1',
  revision: '00000000-0000-4000-8000-0000000000c2',
  reviewers: '00000000-0000-4000-8000-0000000000c3',
  state: '00000000-0000-4000-8000-0000000000c4',
  merged: '00000000-0000-4000-8000-0000000000c5',
  comment: '00000000-0000-4000-8000-0000000000c6',
  push: '00000000-0000-4000-8000-0000000000c7'
}

const EVENT_TYPES: Record<AzureDevOpsDeliveryKind, string> = {
  opened: 'git.pullrequest.created',
  revision: 'git.pullrequest.updated',
  reviewers: 'git.pullrequest.updated',
  state: 'git.pullrequest.updated',
  merged: 'git.pullrequest.merged',
  comment: 'ms.vss-code.git-pullrequest-comment-event',
  push: 'git.push'
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function rule(
  overrides: Partial<RcHookAssign> = {},
  azure: Partial<NonNullable<RcHookAssign['azureDevOps']>> = {}
): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'azure-devops',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    sessionMode: 'perThread',
    azureDevOps: {
      repoId: REPO_ID,
      repoPath: REPO_PATH,
      sessionKeyPrefix: `azure-devops:${REPO_ID}`,
      organization: ORG,
      projectId: PROJECT,
      repositoryId: REPOSITORY,
      instanceId: COLLECTION,
      subscriptions: Object.entries(SUBSCRIPTIONS).map(([kind, subscriptionId]) => ({
        subscriptionId,
        kind: kind as AzureDevOpsDeliveryKind
      })),
      events: ['merge_request:opened', 'merge_request:synchronize', 'push:*'],
      commentFamilies: ['pull_request'],
      mentionOnly: false,
      agentName: 'reviewer',
      identityId: IDENTITY,
      signingKey: KEY,
      ...azure
    },
    ...overrides
  }
}

function identity(id = HUMAN, displayName = 'Alice Example'): Record<string, unknown> {
  return { id, displayName, uniqueName: 'alice@example.test', descriptor: 'aad.example' }
}

function pullUrl(n = 7, project = PROJECT, repository = REPOSITORY): string {
  return `https://dev.azure.com/${ORG}/${project}/_apis/git/repositories/${repository}/pullRequests/${n}`
}

function pullResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 7,
    status: 'active',
    isDraft: false,
    createdBy: identity(),
    repository: { id: REPOSITORY, name: 'Example Repo', project: { id: PROJECT } },
    sourceRefName: 'refs/heads/topic',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: HEAD_SHA },
    reviewers: [],
    title: 'Tighten retry',
    description: 'please review',
    url: pullUrl(),
    ...overrides
  }
}

function threadsHref(n = 7, thread = 12, repository = REPOSITORY): string {
  return `https://dev.azure.com/${ORG}/_apis/git/repositories/${repository}/pullRequests/${n}/threads/${thread}`
}

function commentResource(overrides: Record<string, unknown> = {}, links: Record<string, unknown> = {}) {
  return {
    id: 3,
    parentCommentId: 0,
    author: identity(),
    content: 'what is the rollout plan?',
    publishedDate: '2026-11-07T00:00:00.000Z',
    lastUpdatedDate: '2026-11-07T00:00:00.000Z',
    lastContentUpdatedDate: '2026-11-07T00:00:00.000Z',
    commentType: 'text',
    usersLiked: [],
    _links: {
      self: { href: `${threadsHref()}/comments/3` },
      repository: { href: `https://dev.azure.com/${ORG}/_apis/git/repositories/${REPOSITORY}` },
      threads: { href: threadsHref() },
      pullRequests: { href: `https://dev.azure.com/${ORG}/_apis/git/pullRequests/7` },
      ...links
    },
    ...overrides
  }
}

function pushResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pushId: 9,
    pushedBy: identity(),
    refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'b'.repeat(40), newObjectId: HEAD_SHA }],
    repository: { id: REPOSITORY, name: 'Example Repo', project: { id: PROJECT } },
    url: `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pushes/9`,
    date: '2026-11-07T00:00:00.000Z',
    ...overrides
  }
}

function envelope(
  kind: AzureDevOpsDeliveryKind,
  resource: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    subscriptionId: SUBSCRIPTIONS[kind],
    notificationId: 5,
    id: EVENT,
    eventType: EVENT_TYPES[kind],
    publisherId: 'tfs',
    message: null,
    detailedMessage: null,
    resource,
    resourceVersion: '1.0',
    resourceContainers: {
      collection: { id: COLLECTION, baseUrl: `https://dev.azure.com/${ORG}/` },
      account: { id: '00000000-0000-4000-8000-0000000000a3', baseUrl: `https://dev.azure.com/${ORG}/` },
      project: { id: PROJECT, baseUrl: `https://dev.azure.com/${ORG}/` }
    },
    createdDate: '2026-11-07T00:00:00.000Z',
    ...overrides
  }
}

function basic(password = KEY, user = 'agentconnect'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsgHook[]
  reports: RcRunReport[]
  observed: RcCodeHostDelivery[]
  authzRequests: RcCodeHostMembershipAuthz[]
  authzResult: boolean
  hooksSupported: boolean
  ack: RdAck
}

function makeHarness(): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> & Pick<Harness, 'sent' | 'reports' | 'observed' | 'authzRequests'> = {
    sent: [],
    reports: [],
    observed: [],
    authzRequests: [],
    authzResult: true,
    hooksSupported: true,
    ack: { msgId: 'x', accepted: true }
  }
  const app = Fastify()
  const table = new HookTable()
  registerAzureDevOpsIngress(app, {
    table,
    daemons: () => ({
      get: () =>
        ({
          supports: (feature: string) => {
            if (feature === AZURE_DEVOPS_HOOKS_V1_FEATURE) return h.hooksSupported === true
            return feature === AZURE_DEVOPS_V1_FEATURE || feature === RD_HOOK_NOTICE_V1
          },
          sendMsg: async (msg: RdMsg) => {
            if (msg.source === 'hook') h.sent.push(msg)
            return h.ack!
          }
        }) as never
    }),
    report: (r) => h.reports.push(r),
    observe: (observed) => h.observed.push(observed),
    authorizeMembership: async (request) => {
      h.authzRequests.push(request)
      return h.authzResult!
    },
    authzLimiter: new HookRateLimiter(clock, { capacity: 20, refillPerSec: 0 }),
    limiter: new HookRateLimiter(clock, { capacity: 5, refillPerSec: 0 }),
    clock,
    log
  })
  h.app = app
  h.table = table
  h.clock = clock
  return h as Harness
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

function post(h: Harness, payload: unknown, authorization: string | null = basic()) {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (authorization !== null) headers.authorization = authorization
  return h.app.inject({
    method: 'POST',
    url: '/webhooks/azure-devops',
    headers,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
  })
}

describe('azure devops ingress', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
    log.info.mockClear()
    log.warn.mockClear()
  })
  afterEach(async () => {
    await h.app.close()
  })

  it('opened: verified → membership authz on the identity id → dispatch under the §11.4 key', async () => {
    h.table.upsert(rule())
    const res = await post(h, envelope('opened', pullResource()))
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ deliveryKey: EVENT })
    await flush()
    expect(h.observed).toEqual([
      {
        provider: 'azure-devops',
        repoExternalId: REPO_ID,
        deliveryKey: EVENT,
        receivedAt: expect.any(String),
        verifiedWith: 'current'
      }
    ])
    expect(h.authzRequests).toEqual([
      {
        hookId: HOOK,
        provider: 'azure-devops',
        repoExternalId: REPO_ID,
        actorIdentityId: HUMAN,
        configRevision: '3',
        dispatchRevision: '5'
      }
    ])
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0]!
    expect(msg.sessionKey).toBe(`azure-devops:${REPO_ID}:pull:7`)
    expect(msg.msgId).toBe(`${HOOK}:${EVENT}`)
    expect(msg.event).toBe('merge_request:opened')
    expect(msg.azureDevOps).toEqual({
      repoId: REPO_ID,
      repoPath: REPO_PATH,
      organization: ORG,
      projectId: PROJECT,
      repositoryId: REPOSITORY,
      deliveryKind: 'opened',
      target: { kind: 'pull', pullRequestId: 7, headSha: HEAD_SHA, isDraft: false }
    })
    expect(msg.context).toMatchObject({
      source: 'azure-devops',
      event: 'merge_request',
      action: 'opened',
      number: 7,
      title: 'Tighten retry',
      senderLogin: 'Alice Example',
      bodyExcerpt: 'please review'
    })
    expect(h.reports.map((r) => r.status)).toEqual(['accepted'])
  })

  it('answers the same 404 for an unknown subscription and every failed verification, observing none', async () => {
    h.table.upsert(rule())
    const body = envelope('opened', pullResource())
    const responses = await Promise.all([
      post(h, { ...body, subscriptionId: '00000000-0000-4000-8000-0000000000cf' }),
      post(h, { ...body, subscriptionId: 'not-a-guid' }),
      post(h, body, basic(NEXT_KEY)),
      post(h, body, basic(KEY, 'someone-else')),
      post(h, body, `Bearer ${KEY}`),
      post(h, body, null),
      post(h, '{"subscriptionId":'),
      post(h, '[]')
    ])
    for (const res of responses) {
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Not Found', statusCode: 404 })
    }
    await flush()
    expect(h.observed).toEqual([])
    expect(h.sent).toEqual([])
    expect(h.authzRequests).toEqual([])
  })

  it('accepts both keys during a rotation and the previous key only until its expiry', async () => {
    const expiresAt = new Date(h.clock.now() + 36 * 3600_000).toISOString()
    h.table.upsert(
      rule({}, { nextSigningKey: NEXT_KEY, previousSigningKey: PREVIOUS_KEY, previousSigningKeyExpiresAt: expiresAt })
    )
    const body = envelope('revision', { url: pullUrl(), pullRequestId: 7 })
    expect((await post(h, body, basic(KEY))).statusCode).toBe(202)
    expect((await post(h, body, basic(NEXT_KEY))).statusCode).toBe(202)
    expect((await post(h, body, basic(PREVIOUS_KEY))).statusCode).toBe(202)
    expect(h.observed.map((o) => o.verifiedWith)).toEqual(['current', 'next', 'previous'])
    h.clock.advance(36 * 3600_000)
    expect((await post(h, body, basic(PREVIOUS_KEY))).statusCode).toBe(404)
    expect(h.observed).toHaveLength(3)
  })

  it.each([
    ['another event type', envelope('opened', pullResource(), { eventType: 'git.pullrequest.updated' })],
    ['another publisher', envelope('opened', pullResource(), { publisherId: 'rm' })],
    [
      'another collection',
      envelope('opened', pullResource(), {
        resourceContainers: { collection: { id: OTHER_REPOSITORY }, project: { id: PROJECT } }
      })
    ],
    [
      'another project',
      envelope('opened', pullResource(), {
        resourceContainers: { collection: { id: COLLECTION }, project: { id: OTHER_REPOSITORY } }
      })
    ],
    [
      'another repository in the resource',
      envelope('opened', pullResource({ repository: { id: OTHER_REPOSITORY, project: { id: PROJECT } } }))
    ],
    [
      'a minimal url naming another repository',
      envelope('revision', { url: pullUrl(7, PROJECT, OTHER_REPOSITORY), pullRequestId: 7 })
    ],
    [
      'a minimal url naming another project',
      envelope('revision', { url: pullUrl(7, OTHER_REPOSITORY), pullRequestId: 7 })
    ],
    ['a minimal url naming another pull request', envelope('revision', { url: pullUrl(8), pullRequestId: 7 })],
    ['a minimal resource naming no repository', envelope('state', { pullRequestId: 7 })],
    ['no resource', envelope('merged', null)],
    ['a push to another repository', envelope('push', pushResource({ repository: { id: OTHER_REPOSITORY } }))],
    ['an event that is not a string', envelope('push', pushResource(), { id: 7 })]
  ])('refuses a body that disagrees with its rule: %s', async (_name, body) => {
    h.table.upsert(rule())
    const res = await post(h, body)
    expect(res.statusCode).toBe(404)
    await flush()
    expect(h.observed).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('reads a comment by its thread link, matching the repository GUID in any case', async () => {
    h.table.upsert(rule())
    const upper = threadsHref(7, 12, REPOSITORY.toUpperCase())
    const res = await post(h, envelope('comment', commentResource({}, { threads: { href: upper } })))
    expect(res.statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toEqual([expect.objectContaining({ actorIdentityId: HUMAN })])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.event).toBe('note:created')
    expect(h.sent[0]!.sessionKey).toBe(`azure-devops:${REPO_ID}:pull:7`)
    expect(h.sent[0]!.azureDevOps).toMatchObject({
      deliveryKind: 'comment',
      target: { kind: 'pull', pullRequestId: 7 },
      threadId: '12',
      commentId: '3'
    })
  })

  it.each([
    [
      'a thread link with a project segment',
      {
        threads: {
          href: `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullRequests/7/threads/12`
        }
      }
    ],
    ['a thread link on another repository', { threads: { href: threadsHref(7, 12, OTHER_REPOSITORY) } }],
    ['a thread link on another host', { threads: { href: threadsHref().replace('dev.azure.com', 'example.test') } }],
    ['a thread link over plain http', { threads: { href: threadsHref().replace('https:', 'http:') } }],
    ['a thread link with a query', { threads: { href: `${threadsHref()}?x=1` } }],
    ['a thread link naming no thread', { threads: { href: threadsHref().replace('/threads/12', '/threads/0') } }],
    ['no thread link', { threads: undefined }],
    [
      'a pull-request link naming another pull request',
      { pullRequests: { href: `https://dev.azure.com/${ORG}/_apis/git/pullRequests/8` } }
    ]
  ])('refuses a comment with %s', async (_name, links) => {
    h.table.upsert(rule())
    const res = await post(h, envelope('comment', commentResource({}, links)))
    expect(res.statusCode).toBe(404)
    await flush()
    expect(h.sent).toEqual([])
  })

  it.each([
    ['a system comment', { commentType: 'system' }],
    ['an edited comment', { lastContentUpdatedDate: '2026-11-07T00:05:00.000Z' }],
    ['a comment without a content date', { lastContentUpdatedDate: undefined }],
    ['a deleted comment', { isDeleted: true }],
    ["the identity's own comment", { author: identity(IDENTITY, 'AgentConnect') }]
  ])('answers %s with 2xx and fires nothing', async (_name, change) => {
    h.table.upsert(rule())
    const res = await post(h, envelope('comment', commentResource(change)))
    expect(res.statusCode).toBe(202)
    await flush()
    expect(h.observed).toHaveLength(1)
    expect(h.authzRequests).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('narrows to an agent summoned by name, and the identity mention broadcasts', async () => {
    h.table.upsert(rule())
    h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { agentName: 'planner' }))
    await post(h, envelope('comment', commentResource({ content: 'hey @planner take a look' })))
    await flush()
    expect(h.sent.map((m) => m.hookId)).toEqual([HOOK_B])
    h.sent.length = 0
    await post(h, envelope('comment', commentResource({ content: `@<${IDENTITY.toUpperCase()}> everyone` })))
    await flush()
    expect(h.sent.map((m) => m.hookId).sort()).toEqual([HOOK, HOOK_B])
  })

  it('a mention-only rule fires only when summoned', async () => {
    h.table.upsert(rule({}, { mentionOnly: true }))
    await post(h, envelope('comment', commentResource()))
    await flush()
    expect(h.sent).toEqual([])
    await post(h, envelope('comment', commentResource({ content: '@reviewer please' })))
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('a refused summons gets one body-free notice; an unsummoned refusal stays silent', async () => {
    h.table.upsert(rule())
    h.authzResult = false
    await post(h, envelope('comment', commentResource()))
    await flush()
    expect(h.sent).toEqual([])
    await post(h, envelope('comment', commentResource({ content: '@reviewer please' })))
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.notice).toBe('actor_not_trusted')
    expect(h.sent[0]!.context?.bodyExcerpt).toBeUndefined()
  })

  it('a refused opened pull request leaves the review-request row', async () => {
    h.table.upsert(rule())
    h.authzResult = false
    await post(h, envelope('opened', pullResource()))
    await flush()
    expect(h.sent).toEqual([])
    expect(h.reports).toEqual([
      expect.objectContaining({
        hookId: HOOK,
        deliveryKey: EVENT,
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
        azureDevOps: expect.objectContaining({ deliveryKind: 'opened' })
      })
    ])
  })

  it("vetoes the identity's own fork pull request and push, but its same-repository pull request enters without the gate", async () => {
    h.table.upsert(rule())
    await post(h, envelope('opened', pullResource({ createdBy: identity(IDENTITY), forkSource: { repository: {} } })))
    await post(h, envelope('push', pushResource({ pushedBy: identity(IDENTITY) })))
    await flush()
    expect(h.sent).toEqual([])
    await post(h, envelope('opened', pullResource({ createdBy: identity(IDENTITY.toUpperCase()) })))
    await flush()
    expect(h.authzRequests).toEqual([])
    expect(h.sent.map((m) => m.event)).toEqual(['merge_request:opened'])
  })

  it('a revision forwards only the pull request id, trusted', async () => {
    h.table.upsert(rule())
    await post(h, envelope('revision', { url: pullUrl(), pullRequestId: 7 }))
    await flush()
    expect(h.authzRequests).toEqual([])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.event).toBe('merge_request:synchronize')
    expect(h.sent[0]!.azureDevOps?.target).toEqual({ kind: 'pull', pullRequestId: 7 })
    expect(h.sent[0]!.azureDevOps?.deliveryKind).toBe('revision')
  })

  it("a reviewer change is gated on the pull request's author and forwarded unclassified for the daemon to confirm", async () => {
    h.table.upsert(rule({}, { events: ['push:*'], commentFamilies: [] }))
    h.table.upsert(
      rule({ hookId: HOOK_B, agentId: AGENT_B }, { events: ['merge_request:opened'], commentFamilies: [] })
    )
    // Whoever added the reviewer, the review reads code the author wrote (§11.4).
    await post(h, envelope('reviewers', pullResource({ reviewers: [{ id: IDENTITY, vote: 0 }] })))
    await flush()
    expect(h.authzRequests).toEqual([
      expect.objectContaining({ hookId: HOOK_B, actorIdentityId: HUMAN, configRevision: '3', dispatchRevision: '5' })
    ])
    expect(h.sent.map((m) => [m.hookId, m.event, m.azureDevOps?.deliveryKind])).toEqual([
      [HOOK_B, 'merge_request:review_requested', 'reviewers']
    ])
    // The relay names no reviewer and no classification: the daemon reads them.
    expect(h.sent[0]!.azureDevOps?.target).toEqual({ kind: 'pull', pullRequestId: 7 })
    expect(h.sent[0]!.context?.senderLogin).toBeUndefined()
  })

  it('a reviewer change on an untrusted author, or one naming no author, starts nothing and leaves no row', async () => {
    h.table.upsert(rule())
    h.authzResult = false
    await post(h, envelope('reviewers', pullResource()))
    await flush()
    expect(h.authzRequests).toHaveLength(1)
    h.authzResult = true
    await post(h, envelope('reviewers', { url: pullUrl(), pullRequestId: 7 }))
    await flush()
    expect(h.authzRequests).toHaveLength(1)
    expect(h.sent).toEqual([])
    expect(h.reports).toEqual([])
  })

  it("the identity's own same-repository pull request is not gated, its fork is", async () => {
    h.table.upsert(rule())
    await post(h, envelope('reviewers', pullResource({ createdBy: identity(IDENTITY) })))
    await flush()
    expect(h.authzRequests).toEqual([])
    expect(h.sent).toHaveLength(1)
    const fork = pullResource({ createdBy: identity(IDENTITY), forkSource: { repository: {} } })
    await post(h, envelope('reviewers', fork, { id: '00000000-0000-4000-8000-0000000000e2' }))
    await flush()
    expect(h.authzRequests).toEqual([expect.objectContaining({ actorIdentityId: IDENTITY })])
  })

  it("state and merged reach every pull-request rule; only a rule that admits reopened, on a trusted author's pull request, may start a turn", async () => {
    h.table.upsert(rule({}, { events: ['merge_request:reopened'] }))
    h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { events: ['merge_request:opened'] }))
    await post(h, envelope('state', pullResource()))
    await flush()
    expect(h.authzRequests).toEqual([expect.objectContaining({ hookId: HOOK, actorIdentityId: HUMAN })])
    const byHook = () => Object.fromEntries(h.sent.map((m) => [m.hookId, [m.event, m.azureDevOps?.target]]))
    expect(byHook()).toEqual({
      [HOOK]: ['merge_request:state_changed', { kind: 'pull', pullRequestId: 7, admitsReopened: true }],
      [HOOK_B]: ['merge_request:state_changed', { kind: 'pull', pullRequestId: 7, admitsReopened: false }]
    })
    // A refused author still gets the cleanup: the delivery goes out, it just cannot reopen into a turn.
    h.sent.length = 0
    h.authzResult = false
    await post(h, envelope('state', pullResource(), { id: '00000000-0000-4000-8000-0000000000e2' }))
    await flush()
    expect(byHook()).toEqual({
      [HOOK]: ['merge_request:state_changed', { kind: 'pull', pullRequestId: 7, admitsReopened: false }],
      [HOOK_B]: ['merge_request:state_changed', { kind: 'pull', pullRequestId: 7, admitsReopened: false }]
    })
    h.sent.length = 0
    await post(h, envelope('merged', { url: pullUrl(), pullRequestId: 7 }))
    await flush()
    expect(h.sent.map((m) => [m.hookId, m.event, m.azureDevOps?.deliveryKind])).toEqual([
      [HOOK, 'merge_request:merged', 'merged'],
      [HOOK_B, 'merge_request:merged', 'merged']
    ])
  })

  it('a push fires once per moved ref and skips a deletion', async () => {
    h.table.upsert(rule())
    await post(
      h,
      envelope(
        'push',
        pushResource({
          refUpdates: [
            { name: 'refs/heads/main', newObjectId: HEAD_SHA },
            { name: 'refs/tags/v1', newObjectId: HEAD_SHA },
            { name: 'refs/heads/gone', newObjectId: '0'.repeat(40) }
          ]
        })
      )
    )
    await flush()
    expect(h.sent.map((m) => [m.sessionKey, m.deliveryKey, m.event])).toEqual([
      [`azure-devops:${REPO_ID}:push:refs/heads/main`, `${EVENT}:refs/heads/main`, 'push'],
      [`azure-devops:${REPO_ID}:push:refs/tags/v1`, `${EVENT}:refs/tags/v1`, 'push']
    ])
    h.sent.length = 0
    await post(h, envelope('push', pushResource()))
    await flush()
    expect(h.sent.map((m) => m.deliveryKey)).toEqual([EVENT])
  })

  it('never dispatches to a daemon without azure-devops-hooks-v1, and still answers 2xx', async () => {
    h.table.upsert(rule())
    h.hooksSupported = false
    const res = await post(h, envelope('revision', { url: pullUrl(), pullRequestId: 7 }))
    expect(res.statusCode).toBe(202)
    await flush()
    expect(h.sent).toEqual([])
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])
  })

  it('a verified delivery no rule matches is still 2xx and observed', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:opened'], commentFamilies: [] }))
    const res = await post(h, envelope('push', pushResource()))
    expect(res.statusCode).toBe(202)
    await flush()
    expect(h.observed).toHaveLength(1)
    expect(h.sent).toEqual([])
  })

  it('skips a routed rule rather than fire around its Decision', async () => {
    const routing = {
      routingId: '66666666-6666-4666-8666-666666666666',
      decisionId: '44444444-4444-4444-8444-444444444444',
      evaluationAgentId: AGENT,
      evaluationDaemonId: DAEMON
    }
    h.table.upsert(rule({ routing }))
    await post(h, envelope('revision', { url: pullUrl(), pullRequestId: 7 }))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('never logs the credentials or the payload', async () => {
    h.table.upsert(rule())
    h.authzResult = false
    await post(h, envelope('comment', commentResource({ content: 'secret-plan @reviewer' })), basic(KEY))
    await post(h, envelope('opened', pullResource()), basic(NEXT_KEY))
    await flush()
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain(KEY)
    expect(logged).not.toContain(NEXT_KEY)
    expect(logged).not.toContain('secret-plan')
    expect(logged).not.toContain(HUMAN)
  })

  it('drops a rule from the subscription index when it is removed or loses the subscription', async () => {
    h.table.upsert(rule())
    expect(h.table.getByAzureDevOpsSubscription(SUBSCRIPTIONS.opened.toUpperCase())).toHaveLength(1)
    h.table.upsert(rule({}, { subscriptions: [{ subscriptionId: SUBSCRIPTIONS.push, kind: 'push' }] }))
    expect(h.table.getByAzureDevOpsSubscription(SUBSCRIPTIONS.opened)).toEqual([])
    h.table.remove(HOOK)
    expect(h.table.getByAzureDevOpsSubscription(SUBSCRIPTIONS.push)).toEqual([])
    expect((await post(h, envelope('push', pushResource()))).statusCode).toBe(404)
  })
})

describe('the identity mention form', () => {
  it('matches `@<{identity id}>` in any case and nothing looser', () => {
    expect(mentionsAzureDevOpsIdentity(`ping @<${IDENTITY.toUpperCase()}>`, IDENTITY)).toBe(true)
    expect(mentionsAzureDevOpsIdentity(`ping @${IDENTITY}`, IDENTITY)).toBe(false)
    expect(mentionsAzureDevOpsIdentity(`ping @<${HUMAN}>`, IDENTITY)).toBe(false)
    expect(mentionsAzureDevOpsIdentity(undefined, IDENTITY)).toBe(false)
  })
})
