import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac, randomBytes } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  GITEA_V1_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
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
import { registerGiteaIngress } from './ingress.js'
import { giteaRuleVerdict, normalizeGiteaEvent, type GiteaPayload } from './events.js'

// Every identifier below is synthetic. The probe captures that shaped these fixtures carried real
// repository, user, and delivery identities; none of them appear here (publication policy).
const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REPO = 7701234
const FORK_REPO = 7709999
const BOT_USER = 424242
const BOT_LOGIN = 'example-bot'
const HUMAN = 515151
const OUTSIDER = 606060
const REPO_PATH = 'example-org/example-repo'
const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const KEY = randomBytes(32).toString('hex')
const NEXT_KEY = randomBytes(32).toString('hex')
const DELIVERY = '11111111-2222-4333-8444-555555555555'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function rule(
  overrides: Partial<RcHookAssign> = {},
  gitea: Partial<NonNullable<RcHookAssign['gitea']>> = {}
): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'gitea',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    sessionMode: 'perThread',
    gitea: {
      repoId: String(REPO),
      repoPath: REPO_PATH,
      sessionKeyPrefix: `gitea:${REPO}`,
      events: ['issues:opened'],
      mentionOnly: false,
      botUserId: String(BOT_USER),
      botUsername: BOT_LOGIN,
      signingKey: KEY,
      ...gitea
    },
    ...overrides
  }
}

function sender(id = HUMAN, login = 'alice'): Record<string, unknown> {
  return { id, login, username: login, avatar_url: `https://gitea.example.test/avatars/${id}` }
}

function repository(): Record<string, unknown> {
  return { id: REPO, full_name: REPO_PATH }
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    repository: repository(),
    sender: sender(),
    issue: {
      id: 900001,
      number: 42,
      title: 'db down',
      body: 'the primary is unreachable',
      html_url: `https://gitea.example.test/${REPO_PATH}/issues/42`,
      user: sender(),
      labels: [{ name: 'bug' }],
      ...((overrides.issue as Record<string, unknown> | undefined) ?? {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'issue'))
  }
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900002,
    number: 77,
    title: 'tighten retry',
    body: 'please review',
    html_url: `https://gitea.example.test/${REPO_PATH}/pulls/77`,
    user: sender(),
    labels: [],
    draft: false,
    merged: false,
    head: { ref: 'topic', sha: HEAD_SHA, repo_id: REPO },
    base: { ref: 'main', sha: BASE_SHA, repo_id: REPO },
    ...overrides
  }
}

function pullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    number: 77,
    commit_id: '',
    repository: repository(),
    sender: sender(),
    requested_reviewer: null,
    review: null,
    pull_request: pullRequest((overrides.pull_request as Record<string, unknown> | undefined) ?? {}),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'pull_request'))
  }
}

/** An issue-timeline comment: Gitea sends `is_pull: false` under event type `issue_comment`. */
function issueCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    is_pull: false,
    repository: repository(),
    sender: sender(),
    issue: { ...(issuePayload().issue as Record<string, unknown>), user: sender(OUTSIDER, 'mallory') },
    comment: {
      id: 1692903,
      body: 'what is the rollout plan?',
      html_url: `https://gitea.example.test/${REPO_PATH}/issues/42#issuecomment-1692903`
    },
    ...overrides
  }
}

/** A pull-request TIMELINE comment: event type `pull_request_comment`, `is_pull: true`. */
function pullCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    is_pull: true,
    repository: repository(),
    sender: sender(),
    issue: { number: 77, title: 'tighten retry', user: sender() },
    pull_request: pullRequest(),
    comment: {
      id: 1692904,
      body: 'plain timeline comment',
      html_url: `https://gitea.example.test/${REPO_PATH}/pulls/77#issuecomment-1692904`
    },
    ...overrides
  }
}

/** A review submission: one delivery, `action: reviewed`, only the summary in `review.content`,
 *  and a top-level `commit_id` Gitea never assigns on review events (§16). */
function reviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'reviewed',
    number: 77,
    commit_id: '',
    repository: repository(),
    sender: sender(),
    // On a review delivery this names the review's AUTHOR, not a requested reviewer (§8).
    requested_reviewer: sender(),
    review: { type: 'pull_request_review_comment', content: 'review body' },
    pull_request: pullRequest(),
    ...overrides
  }
}

function reviewRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'review_requested',
    number: 77,
    commit_id: '',
    repository: repository(),
    sender: sender(),
    requested_reviewer: sender(BOT_USER, BOT_LOGIN),
    review: null,
    pull_request: pullRequest({ user: sender(OUTSIDER, 'mallory') }),
    ...overrides
  }
}

function pushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after: HEAD_SHA,
    repository: repository(),
    sender: sender(),
    pusher: sender(),
    commits: [{ message: 'fix: retry\n' }],
    ...overrides
  }
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsg[]
  reports: RcRunReport[]
  /** Every `rc/codehost-delivery` the ingress emitted — one per verified delivery, matched or not. */
  observed: RcCodeHostDelivery[]
  authzRequests: RcCodeHostMembershipAuthz[]
  authzResult: boolean | ((request: RcCodeHostMembershipAuthz) => boolean | Promise<boolean>)
  ack: RdAck
  offline: boolean
  giteaSupported: boolean
}

function makeHarness(): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> & Pick<Harness, 'sent' | 'reports' | 'observed' | 'authzRequests'> = {
    sent: [],
    reports: [],
    observed: [],
    authzRequests: [],
    authzResult: true,
    ack: { msgId: 'x', accepted: true },
    offline: false,
    giteaSupported: true
  }
  const app = Fastify()
  const table = new HookTable()
  const deps = {
    table,
    daemons: () => ({
      get: () => {
        if (h.offline) return undefined
        return {
          supports: (capability: string) => {
            if (capability === GITEA_V1_FEATURE) return h.giteaSupported === true
            return true
          },
          sendMsg: async (msg: RdMsg) => {
            h.sent.push(msg)
            return h.ack!
          }
        } as never
      }
    }),
    report: (r: RcRunReport) => h.reports.push(r),
    observe: (observed: RcCodeHostDelivery) => h.observed.push(observed),
    authorizeMembership: async (request: RcCodeHostMembershipAuthz) => {
      h.authzRequests.push(request)
      return typeof h.authzResult === 'function' ? h.authzResult(request) : h.authzResult!
    },
    authzLimiter: new HookRateLimiter(clock, { capacity: 20, refillPerSec: 0 }),
    limiter: new HookRateLimiter(clock, { capacity: 5, refillPerSec: 0 }),
    clock,
    log
  }
  registerGiteaIngress(app, deps)
  h.app = app
  h.table = table
  h.clock = clock
  return h as Harness
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

interface PostOptions {
  /** `X-Gitea-Event-Type` — the only header any decision keys on. */
  eventType: string
  /** `X-Gitea-Event` — the lossy legacy header, deliberately set to a COLLIDING value by default. */
  event?: string
  delivery?: string | null
  signature?: string | null
  signingKey?: string
}

function post(h: Harness, payload: Record<string, unknown>, opts: PostOptions) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.event !== undefined) headers['x-gitea-event'] = opts.event
  headers['x-gitea-event-type'] = opts.eventType
  const delivery = opts.delivery === undefined ? DELIVERY : opts.delivery
  if (delivery !== null) headers['x-gitea-delivery'] = delivery
  const signature =
    opts.signature === undefined
      ? createHmac('sha256', opts.signingKey ?? KEY)
          .update(body)
          .digest('hex')
      : opts.signature
  if (signature !== null) headers['x-gitea-signature'] = signature
  return h.app.inject({ method: 'POST', url: '/webhooks/gitea', headers, payload: body })
}

describe('gitea ingress', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  it('verified issue open → membership authz (id AND login) → dispatch with the §8 key', async () => {
    h.table.upsert(rule())
    const res = await post(h, issuePayload(), { eventType: 'issues', event: 'issues' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ deliveryKey: DELIVERY })
    await flush()
    // Gitea's permission lookup is by username, so the login travels beside the numeric id.
    expect(h.authzRequests).toEqual([
      expect.objectContaining({
        provider: 'gitea',
        repoExternalId: String(REPO),
        actorExternalId: String(HUMAN),
        actorUsername: 'alice',
        configRevision: '3',
        dispatchRevision: '5'
      })
    ])
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0] as RdMsgHook
    expect(msg.sessionKey).toBe(`gitea:${REPO}:issue:42`)
    expect(msg.msgId).toBe(`${HOOK}:${DELIVERY}`)
    expect(msg.deliveryKey).toBe(DELIVERY)
    expect(msg.event).toBe('issues:opened')
    expect(msg.gitea).toEqual({ repoId: String(REPO), repoPath: REPO_PATH, target: { kind: 'issue', index: 42 } })
    expect(msg.context?.source).toBe('gitea')
    expect(msg.context?.bodyExcerpt).toBe('the primary is unreachable')
    expect(msg.context?.labels).toEqual(['bug'])
    expect(h.reports.map((r) => r.status)).toEqual(['accepted'])
  })

  it('uniform 404: wrong key, tampered body, unknown repository, malformed body, missing headers', async () => {
    h.table.upsert(rule())
    const wrongKey = await post(h, issuePayload(), { eventType: 'issues', signingKey: NEXT_KEY })
    expect(wrongKey.statusCode).toBe(404)
    // The digest covers the EXACT raw bytes: a body edited in flight cannot keep its signature.
    const body = JSON.stringify(issuePayload())
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/webhooks/gitea',
      headers: {
        'content-type': 'application/json',
        'x-gitea-event-type': 'issues',
        'x-gitea-delivery': DELIVERY,
        'x-gitea-signature': createHmac('sha256', KEY).update(body).digest('hex')
      },
      payload: body.replace('"number":42', '"number":43')
    })
    expect(tampered.statusCode).toBe(404)
    const unknownRepo = await post(h, issuePayload({ repository: { id: 9, full_name: 'other/repo' } }), {
      eventType: 'issues'
    })
    expect(unknownRepo.statusCode).toBe(404)
    const malformed = await h.app.inject({
      method: 'POST',
      url: '/webhooks/gitea',
      headers: { 'content-type': 'application/json', 'x-gitea-event-type': 'issues' },
      payload: 'not-json'
    })
    expect(malformed.statusCode).toBe(404)
    expect((await post(h, issuePayload(), { eventType: 'issues', delivery: null })).statusCode).toBe(404)
    expect((await post(h, issuePayload(), { eventType: 'issues', signature: null })).statusCode).toBe(404)
    // A non-hex signature of the right shape decodes short and fails the length check.
    expect((await post(h, issuePayload(), { eventType: 'issues', signature: 'z'.repeat(64) })).statusCode).toBe(404)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('accepts the NEXT signing key while a rotation leaves the table mixed (§7)', async () => {
    // Rotation distributes both keys; one repository's rules may carry either until promotion.
    h.table.upsert(rule())
    h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { signingKey: NEXT_KEY }))
    expect((await post(h, issuePayload(), { eventType: 'issues', signingKey: NEXT_KEY })).statusCode).toBe(202)
    await flush()
    // Either key verifies the delivery for EVERY rule on the repository, so nothing is dropped.
    expect(h.sent.map((m) => (m as RdMsgHook).hookId).sort()).toEqual([HOOK, HOOK_B].sort())
  })

  it('verifies under a rule’s successor key and reports every verified delivery, matched or not (§6, §7)', async () => {
    h.table.upsert(rule({}, { nextSigningKey: NEXT_KEY }))
    // The managed webhook's test delivery is a push no rule matches: verified, reported, not dispatched.
    expect((await post(h, pushPayload(), { eventType: 'push' })).statusCode).toBe(202)
    expect(h.observed).toEqual([
      {
        provider: 'gitea',
        repoExternalId: String(REPO),
        deliveryKey: DELIVERY,
        receivedAt: expect.any(String),
        verifiedWith: 'current'
      }
    ])
    // A delivery signed under the successor verifies too, and says which key the CP may promote.
    expect(
      (await post(h, issuePayload(), { eventType: 'issues', signingKey: NEXT_KEY, delivery: 'delivery-next' }))
        .statusCode
    ).toBe(202)
    expect(h.observed.at(-1)).toMatchObject({ deliveryKey: 'delivery-next', verifiedWith: 'next' })
    await flush()
    expect(h.sent).toHaveLength(1)
    // Nothing unverified is ever reported.
    expect((await post(h, issuePayload(), { eventType: 'issues', signingKey: 'c'.repeat(64) })).statusCode).toBe(404)
    expect(h.observed).toHaveLength(2)
  })

  it('keys on X-Gitea-Event-Type, never the lossy X-Gitea-Event', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:*'], commentFamilies: ['pull_request'] }))
    // A pull-request TIMELINE comment: the legacy header says `issue_comment`.
    expect(
      (await post(h, pullCommentPayload(), { eventType: 'pull_request_comment', event: 'issue_comment' })).statusCode
    ).toBe(202)
    // A REVIEW submission: the legacy header says `pull_request_comment` — the exact value the
    // timeline comment's own event type uses, which is why it can never be the match key.
    expect(
      (
        await post(h, reviewPayload(), {
          eventType: 'pull_request_review_comment',
          event: 'pull_request_comment',
          delivery: 'delivery-review'
        })
      ).statusCode
    ).toBe(202)
    // And a revision: the legacy header collapses `pull_request_sync` into `pull_request`.
    expect(
      (
        await post(h, pullPayload({ action: 'synchronized', before: BASE_SHA, after: HEAD_SHA }), {
          eventType: 'pull_request_sync',
          event: 'pull_request',
          delivery: 'delivery-sync'
        })
      ).statusCode
    ).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).event)).toEqual([
      'note:created',
      'review:commented',
      'merge_request:synchronize'
    ])
  })

  it('maps every event-type row and vetoes the rest', () => {
    const row = (eventType: string, payload: Record<string, unknown>): string | undefined =>
      normalizeGiteaEvent(eventType, payload as GiteaPayload)?.eventAction
    expect(row('issues', issuePayload())).toBe('issues:opened')
    expect(row('issue_comment', issueCommentPayload())).toBe('note:created')
    expect(row('pull_request_comment', pullCommentPayload())).toBe('note:created')
    expect(row('pull_request', pullPayload())).toBe('merge_request:opened')
    expect(row('pull_request_sync', pullPayload({ action: 'synchronized' }))).toBe('merge_request:synchronize')
    expect(row('pull_request_review_request', reviewRequestPayload())).toBe('merge_request:review_requested')
    expect(row('pull_request_review_comment', reviewPayload())).toBe('review:commented')
    expect(row('pull_request_review_approved', reviewPayload({ review: { type: 'x', content: 'ok' } }))).toBe(
      'review:approved'
    )
    expect(row('pull_request_review_rejected', reviewPayload())).toBe('review:changes_requested')
    expect(row('push', pushPayload())).toBe('push')

    // Lifecycle noise: edits, reopens, unmerged closes, and the draft toggle that rides `edited`.
    expect(row('issues', issuePayload({ action: 'edited' }))).toBeUndefined()
    expect(row('issues', issuePayload({ action: 'reopened' }))).toBeUndefined()
    expect(row('pull_request', pullPayload({ action: 'reopened' }))).toBeUndefined()
    expect(row('pull_request', pullPayload({ action: 'edited' }))).toBeUndefined()
    expect(row('pull_request', pullPayload({ action: 'closed' }))).toBeUndefined()
    // Comment edits and deletions re-fire the same type with a fresh delivery id — never a turn.
    expect(row('issue_comment', issueCommentPayload({ action: 'edited' }))).toBeUndefined()
    expect(row('pull_request_comment', pullCommentPayload({ action: 'deleted' }))).toBeUndefined()
    // Label, assignment, and milestone churn arrive under event types the table never names.
    expect(row('issue_label', issuePayload({ action: 'label_updated' }))).toBeUndefined()
    expect(row('issue_assign', issuePayload({ action: 'assigned' }))).toBeUndefined()
    expect(row('pull_request_label', pullPayload({ action: 'label_updated' }))).toBeUndefined()
    expect(row('pull_request_assign', pullPayload({ action: 'assigned' }))).toBeUndefined()
    expect(
      row('pull_request_review_request', reviewRequestPayload({ action: 'review_request_removed' }))
    ).toBeUndefined()
    expect(row('release', { repository: repository(), action: 'published' })).toBeUndefined()
    // The subject discriminator is required: a comment whose payload disagrees with its event
    // type, and a subject without a positive index, are both rejected before any session key.
    expect(row('pull_request_comment', pullCommentPayload({ is_pull: false }))).toBeUndefined()
    expect(row('issue_comment', issueCommentPayload({ is_pull: true }))).toBeUndefined()
    expect(row('issues', issuePayload({ issue: { number: 0 } }))).toBeUndefined()
    expect(row('push', pushPayload({ ref: undefined }))).toBeUndefined()
  })

  it('a pull-request comment carries the comment id and the head fence; a review carries neither', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:*'], commentFamilies: ['pull_request'] }))
    expect((await post(h, pullCommentPayload(), { eventType: 'pull_request_comment' })).statusCode).toBe(202)
    await flush()
    const comment = h.sent[0] as RdMsgHook
    expect(comment.sessionKey).toBe(`gitea:${REPO}:pull:77`)
    expect(comment.gitea).toMatchObject({
      commentId: '1692904',
      target: { kind: 'pull', index: 77, headSha: HEAD_SHA, baseSha: BASE_SHA, sourceRepoId: String(REPO) }
    })

    h.sent.length = 0
    expect(
      (await post(h, reviewPayload(), { eventType: 'pull_request_review_approved', delivery: 'delivery-2' })).statusCode
    ).toBe(202)
    await flush()
    const review = h.sent[0] as RdMsgHook
    expect(review.event).toBe('review:approved')
    // §16: the delivery carries the summary and no comment, path, line, or review id at all.
    expect(review.gitea?.commentId).toBeUndefined()
    expect(review.context?.bodyExcerpt).toBe('review body')
    expect(review.gitea?.target).toMatchObject({ kind: 'pull', index: 77, headSha: HEAD_SHA })
  })

  it('§8 loop prevention: the bot is vetoed, except its own same-repository revision', async () => {
    h.table.upsert(rule({}, { events: ['issues:opened', 'merge_request:*'], commentFamilies: ['pull_request'] }))
    const botIssue = issuePayload({ sender: sender(BOT_USER, BOT_LOGIN), issue: { user: sender(BOT_USER, BOT_LOGIN) } })
    expect((await post(h, botIssue, { eventType: 'issues' })).statusCode).toBe(202)
    const botComment = pullCommentPayload({ sender: sender(BOT_USER, BOT_LOGIN) })
    expect((await post(h, botComment, { eventType: 'pull_request_comment', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.authzRequests).toHaveLength(0)

    // The internal lane: a same-repository revision the bot authored is TRUSTED — no membership
    // call, straight to dispatch, so the bot's own pull requests stay reviewable.
    const ownRevision = pullPayload({
      action: 'synchronized',
      sender: sender(BOT_USER, BOT_LOGIN),
      pull_request: { user: sender(BOT_USER, BOT_LOGIN) }
    })
    expect((await post(h, ownRevision, { eventType: 'pull_request_sync', delivery: 'd3' })).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:synchronize')

    // A bot revision from a FORK is not the internal lane and stays vetoed.
    h.sent.length = 0
    const forkedBotRevision = pullPayload({
      action: 'synchronized',
      sender: sender(BOT_USER, BOT_LOGIN),
      pull_request: { user: sender(BOT_USER, BOT_LOGIN), head: { ref: 'topic', sha: HEAD_SHA, repo_id: FORK_REPO } }
    })
    expect((await post(h, forkedBotRevision, { eventType: 'pull_request_sync', delivery: 'd4' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('an external pull request never starts automatically (§8)', async () => {
    h.authzResult = false
    h.table.upsert(rule({}, { events: ['merge_request:*'] }))
    const external = pullPayload({
      sender: sender(OUTSIDER, 'mallory'),
      pull_request: { user: sender(OUTSIDER, 'mallory'), head: { ref: 'topic', sha: HEAD_SHA, repo_id: FORK_REPO } }
    })
    expect((await post(h, external, { eventType: 'pull_request' })).statusCode).toBe(202)
    await flush()
    // The gate resolves the PULL REQUEST'S AUTHOR, not the delivery's sender claim.
    expect(h.authzRequests).toEqual([
      expect.objectContaining({ actorExternalId: String(OUTSIDER), actorUsername: 'mallory' })
    ])
    expect(h.sent).toHaveLength(0)
    // A denied revision leaves the durable, actionable row instead of silence.
    expect(h.reports).toEqual([
      expect.objectContaining({ status: 'failed', reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED })
    ])
  })

  it('requesting the bot as reviewer is the explicit start path, and only on its own event type', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:opened'] }))
    expect((await post(h, reviewRequestPayload(), { eventType: 'pull_request_review_request' })).statusCode).toBe(202)
    await flush()
    // The REQUESTING actor is authorized — never the (untrusted) external pull-request author.
    expect(h.authzRequests).toHaveLength(1)
    expect(h.authzRequests[0]?.actorExternalId).toBe(String(HUMAN))
    expect(h.authzRequests[0]?.subjectAuthorExternalId).toBeUndefined()
    const msg = h.sent[0] as RdMsgHook
    expect(msg.event).toBe('merge_request:review_requested')
    expect(msg.gitea?.target).toMatchObject({ kind: 'pull', index: 77, explicitReviewRequest: true })

    // Requesting SOMEONE ELSE is inert.
    h.sent.length = 0
    h.authzRequests.length = 0
    const other = reviewRequestPayload({ requested_reviewer: sender(OUTSIDER, 'mallory') })
    expect((await post(h, other, { eventType: 'pull_request_review_request', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)

    // And `requested_reviewer` on a REVIEW delivery names the review's author (§8), so a review
    // the bot submitted must never read as a request for the bot to review.
    const botReview = reviewPayload({ sender: sender(HUMAN, 'alice'), requested_reviewer: sender(BOT_USER, BOT_LOGIN) })
    expect((await post(h, botReview, { eventType: 'pull_request_review_comment', delivery: 'd3' })).statusCode).toBe(
      202
    )
    await flush()
    // The rule selects no comment family, so the review matched nothing at all.
    expect(h.sent).toHaveLength(0)
  })

  it('push is relay-trusted, matches only push:*, and keys the session by ref', async () => {
    h.table.upsert(rule({}, { events: ['push:*'] }))
    h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { events: ['issues:opened'] }))
    expect((await post(h, pushPayload(), { eventType: 'push' })).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0] as RdMsgHook
    expect(msg.hookId).toBe(HOOK)
    expect(msg.sessionKey).toBe(`gitea:${REPO}:push:refs/heads/main`)
    expect(msg.gitea?.target).toEqual({ kind: 'push', ref: 'refs/heads/main' })
  })

  it('merged pull requests and closed issues fan out as maintenance cleanup, bypassing the gate', async () => {
    h.authzResult = false // the gate would deny — cleanup must not care
    h.table.upsert(rule({}, { events: ['merge_request:*'] }))
    const merged = pullPayload({ action: 'closed', pull_request: { merged: true } })
    expect((await post(h, merged, { eventType: 'pull_request' })).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:merged')
    expect((h.sent[0] as RdMsgHook).sessionKey).toBe(`gitea:${REPO}:pull:77`)

    h.sent.length = 0
    const closed = issuePayload({ action: 'closed' })
    expect((await post(h, closed, { eventType: 'issues', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).event).toBe('issues:closed')
    expect((h.sent[0] as RdMsgHook).sessionKey).toBe(`gitea:${REPO}:issue:42`)

    // An UNMERGED close may still reopen, so it is neither cleanup nor a turn.
    h.sent.length = 0
    expect(
      (await post(h, pullPayload({ action: 'closed' }), { eventType: 'pull_request', delivery: 'd3' })).statusCode
    ).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('comment families scope comments and reviews; a summon narrows the fan-out', async () => {
    h.table.upsert(rule({}, { commentFamilies: ['issues'], agentName: 'oncall' }))
    h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { agentName: 'deploy' }))
    // HOOK matches via its selected family; HOOK_B selects none and is not summoned.
    expect((await post(h, issueCommentPayload(), { eventType: 'issue_comment' })).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK])
    // An unmentioned continuation fences the thread author as well as the commenter (§8).
    expect(h.authzRequests).toEqual([
      expect.objectContaining({
        actorExternalId: String(HUMAN),
        actorUsername: 'alice',
        subjectAuthorExternalId: String(OUTSIDER),
        subjectAuthorUsername: 'mallory'
      })
    ])

    h.sent.length = 0
    h.authzRequests.length = 0
    const mention = issueCommentPayload({ comment: { id: 2, body: '@oncall please look' } })
    expect((await post(h, mention, { eventType: 'issue_comment', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK])
    // A summoning comment authorizes only its author.
    expect(h.authzRequests[0]?.subjectAuthorExternalId).toBeUndefined()
  })

  it('mention-only rules stay silent without a summon, on comments and on reviews alike', async () => {
    h.table.upsert(rule({}, { mentionOnly: true, commentFamilies: ['issues', 'pull_request'], agentName: 'oncall' }))
    expect((await post(h, issueCommentPayload(), { eventType: 'issue_comment' })).statusCode).toBe(202)
    expect(
      (await post(h, reviewPayload(), { eventType: 'pull_request_review_comment', delivery: 'd2' })).statusCode
    ).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    // The bot handle is the repository-wide broadcast form; the agent handle targets one rule.
    const summoned = reviewPayload({ review: { type: 'x', content: `@${BOT_LOGIN} what about the retry?` } })
    expect((await post(h, summoned, { eventType: 'pull_request_review_comment', delivery: 'd3' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('review:commented')
  })

  it('copies the rule host onto the trusted metadata as opaque data (§3)', async () => {
    const SELF_HOSTED = 'https://gitea.example.test/gitea'
    h.table.upsert(rule({}, { host: SELF_HOSTED }))
    expect((await post(h, issuePayload(), { eventType: 'issues' })).statusCode).toBe(202)
    await flush()
    // Copied from the RULE, never read off the payload, and never parsed here: the relay does not
    // dial Gitea, and the daemon fences the turn on this value.
    expect((h.sent[0] as RdMsgHook).gitea?.host).toBe(SELF_HOSTED)

    h.sent.length = 0
    h.table.upsert(rule())
    expect((await post(h, issuePayload(), { eventType: 'issues', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitea?.host).toBeUndefined()
  })

  it('a daemon without gitea-v1 fails the dispatch closed, and heals when it gains the bit', async () => {
    h.giteaSupported = false
    h.table.upsert(rule({}, { events: ['push:*'] }))
    expect((await post(h, pushPayload(), { eventType: 'push' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])

    // The fence is re-read per attempt, so no convergence pass is needed.
    h.reports.length = 0
    h.giteaSupported = true
    expect((await post(h, pushPayload(), { eventType: 'push', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('membership denial skips silently for issues and comments; nothing reaches the daemon', async () => {
    h.authzResult = false
    h.table.upsert(rule({}, { commentFamilies: ['issues'] }))
    expect((await post(h, issuePayload(), { eventType: 'issues' })).statusCode).toBe(202)
    expect((await post(h, issueCommentPayload(), { eventType: 'issue_comment', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('verdict is pure: patterns gate before authz, and a foreign kind never matches', () => {
    const ctx = normalizeGiteaEvent('issues', issuePayload() as GiteaPayload)!
    expect(giteaRuleVerdict(rule(), ctx)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { events: ['issues:*'] }), ctx)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { events: ['merge_request:*'] }), ctx)).toBe('no-match')
    expect(giteaRuleVerdict(rule({ kind: 'gitlab' }), ctx)).toBe('no-match')
    // A created-cadence rule fires additively on a later summon in the same thread family.
    const summon = normalizeGiteaEvent(
      'issue_comment',
      issueCommentPayload({ comment: { id: 3, body: '@oncall ping' } }) as GiteaPayload
    )!
    expect(giteaRuleVerdict(rule({}, { events: ['issues:opened'], agentName: 'oncall' }), summon)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { events: ['issues:opened'] }), summon)).toBe('no-match')
    // A review submission is gated by the pull-request comment family, never by an event pattern.
    const review = normalizeGiteaEvent('pull_request_review_rejected', reviewPayload() as GiteaPayload)!
    expect(giteaRuleVerdict(rule({}, { events: ['merge_request:*'] }), review)).toBe('no-match')
    expect(giteaRuleVerdict(rule({}, { commentFamilies: ['pull_request'] }), review)).toBe('needs-authz')
  })
})
