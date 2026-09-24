import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac, randomBytes } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  GITEA_V1_FEATURE,
  HOOK_DECISION_ROUTING_V1_FEATURE,
  HOOK_DECISION_ROUTING_V2_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RD_CODEHOST_RELEASE_V1,
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
import {
  giteaRuleFamilies,
  giteaRuleVerdict,
  normalizeGiteaEvent,
  GITEA_ROUTING,
  type GiteaMatchCtx,
  type GiteaPayload
} from './events.js'
import { codeHostRecordOnlyEligible, HOOK_ROUTING_ACK_TIMEOUT_MS } from '../code-host-routing.js'

// Every identifier below is synthetic. The probe captures that shaped these fixtures carried real
// repository, user, and delivery identities; none of them appear here (publication policy).
const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const HOOK_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT_C = '99999999-9999-4999-8999-999999999999'
const DAEMON_B = '88888888-8888-4888-8888-888888888888'
const DAEMON_C = '77777777-7777-4777-8777-777777777777'
const ROUTING = '66666666-6666-4666-8666-666666666666'
const ROUTING_MR = '55555555-5555-4555-8555-555555555555'
const DECISION = '44444444-4444-4444-8444-444444444444'
const REPO = 7701234
const FORK_REPO = 7709999
const BOT_USER = 424242
const BOT_LOGIN = 'example-bot'
const HUMAN = 515151
const OUTSIDER = 606060
const REPO_OWNER = 'example-org'
const REPO_PATH = `${REPO_OWNER}/example-repo`
const REPO_OWNER_ID = 818181
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
  return { id: REPO, full_name: REPO_PATH, owner: { id: REPO_OWNER_ID, login: REPO_OWNER, username: REPO_OWNER } }
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

/** A release the connection's human publishes; `sender` is Gitea's actor, as on every delivery. */
function releasePayload(action = 'published', release: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    repository: repository(),
    sender: sender(),
    release: {
      tag_name: 'v1.2.0',
      target_commitish: 'main',
      name: 'v1.2.0 — faster sync',
      body: '## Changes\n- faster sync',
      html_url: `https://gitea.example.test/${REPO_PATH}/releases/tag/v1.2.0`,
      draft: false,
      prerelease: true,
      ...release
    }
  }
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsg[]
  dispatches: Array<{ daemonId: string; msg: RdMsg; opts?: unknown }>
  reports: RcRunReport[]
  /** Every `rc/codehost-delivery` the ingress emitted — one per verified delivery, matched or not. */
  observed: RcCodeHostDelivery[]
  authzRequests: RcCodeHostMembershipAuthz[]
  authzResult: boolean | ((request: RcCodeHostMembershipAuthz) => boolean | Promise<boolean>)
  ack: RdAck
  offline: boolean
  giteaSupported: boolean
  releaseSupported: boolean
  /** The routing host's answer to a host copy; the default selects every candidate as Otherwise. */
  routeAck: (msg: RdMsgHook) => RdAck | Promise<RdAck>
  routingSupported: boolean
  routingV2Supported: boolean
  /** When set, only these daemons are online. */
  onlineDaemons?: Set<string>
}

function makeHarness(): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> & Pick<Harness, 'sent' | 'dispatches' | 'reports' | 'observed' | 'authzRequests'> = {
    sent: [],
    dispatches: [],
    reports: [],
    observed: [],
    authzRequests: [],
    authzResult: true,
    ack: { msgId: 'x', accepted: true },
    offline: false,
    giteaSupported: true,
    releaseSupported: true,
    routingSupported: true,
    routingV2Supported: true,
    routeAck: (msg) => ({
      msgId: msg.msgId,
      accepted: true,
      hookRoute: {
        targets: (msg.routing?.candidates ?? []).map((c) => ({
          hookId: c.hookId,
          selection: { routingId: msg.routing!.routingId, decisionId: msg.routing!.decisionId, reason: 'otherwise' }
        }))
      }
    })
  }
  const app = Fastify()
  const table = new HookTable()
  const deps = {
    table,
    daemons: () => ({
      get: (daemonId: string) => {
        if (h.offline || (h.onlineDaemons && !h.onlineDaemons.has(daemonId))) return undefined
        return {
          supports: (capability: string) => {
            if (capability === GITEA_V1_FEATURE) return h.giteaSupported === true
            if (capability === RD_CODEHOST_RELEASE_V1) return h.releaseSupported === true
            if (capability === HOOK_DECISION_ROUTING_V1_FEATURE) return h.routingSupported === true
            if (capability === HOOK_DECISION_ROUTING_V2_FEATURE) return h.routingV2Supported === true
            return true
          },
          sendMsg: async (msg: RdMsg, opts?: unknown) => {
            h.sent.push(msg)
            h.dispatches.push({ daemonId, msg, ...(opts ? { opts } : {}) })
            if (msg.source === 'hook' && msg.routing) return h.routeAck!(msg)
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
    // A label change normalizes to `:labeled` (the verdict admits it for filtered rows only); a cleared set never fires.
    expect(row('issue_label', issuePayload({ action: 'label_updated' }))).toBe('issues:labeled')
    expect(row('issue_label', issuePayload({ action: 'label_cleared' }))).toBeUndefined()
    expect(row('pull_request_label', pullPayload({ action: 'label_updated' }))).toBe('merge_request:labeled')
    expect(row('pull_request_label', pullPayload({ action: 'label_cleared' }))).toBeUndefined()
    // Assignment and milestone churn arrive under event types the table never names.
    expect(row('issue_assign', issuePayload({ action: 'assigned' }))).toBeUndefined()
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

  it('a release is relay-trusted in the repository’s one releases session, carrying its tag and flags', async () => {
    h.table.upsert(rule({}, { events: ['release:*'] }))
    for (const [action, delivery] of [
      ['published', 'r1'],
      ['updated', 'r2'],
      ['deleted', 'r3']
    ] as const) {
      expect((await post(h, releasePayload(action), { eventType: 'release', delivery })).statusCode).toBe(202)
    }
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    // A deletion is never new work; an update is the notes' edit.
    expect(h.sent.map((m) => (m as RdMsgHook).event)).toEqual(['release:published', 'release:edited'])
    const msg = h.sent[0] as RdMsgHook
    expect(msg.sessionKey).toBe(`gitea:${REPO}:releases`)
    expect(msg.gitea?.target).toEqual({ kind: 'release', tag: 'v1.2.0' })
    expect(msg.context).toMatchObject({
      event: 'release',
      action: 'published',
      title: 'v1.2.0 — faster sync',
      htmlUrl: `https://gitea.example.test/${REPO_PATH}/releases/tag/v1.2.0`,
      bodyExcerpt: '## Changes\n- faster sync',
      release: { tag: 'v1.2.0', target: 'main', prerelease: true, draft: false }
    })
  })

  it('the connection bot’s own release never re-triggers, and a published-only row skips an edit', async () => {
    h.table.upsert(rule({}, { events: ['release:published'] }))
    const own = { ...releasePayload(), sender: sender(BOT_USER, BOT_LOGIN) }
    expect((await post(h, own, { eventType: 'release', delivery: 'r1' })).statusCode).toBe(202)
    expect((await post(h, releasePayload('updated'), { eventType: 'release', delivery: 'r2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('refuses a release target to a daemon that cannot decode it', async () => {
    h.releaseSupported = false
    h.table.upsert(rule({}, { events: ['release:published'] }))
    expect((await post(h, releasePayload(), { eventType: 'release' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])
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

  it('the `@<owner>/<agent>` team form summons the agent and narrows a repository fan-out', async () => {
    h.table.upsert(rule({}, { mentionOnly: true, commentFamilies: ['issues'], agentName: 'oncall' }))
    h.table.upsert(
      rule(
        { hookId: HOOK_B, agentId: AGENT_B },
        { mentionOnly: true, commentFamilies: ['issues'], agentName: 'deploy' }
      )
    )
    const team = issueCommentPayload({ comment: { id: 2, body: `@${REPO_OWNER}/oncall please look` } })
    expect((await post(h, team, { eventType: 'issue_comment' })).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK])

    // The bare handle is unaffected by the second accepted form.
    h.sent.length = 0
    const bare = issueCommentPayload({ comment: { id: 3, body: '@deploy ship it' } })
    expect((await post(h, bare, { eventType: 'issue_comment', delivery: 'd2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK_B])
  })

  it('a label change fires only rows that filter on labels; the filter reads the CURRENT labels case-insensitively', () => {
    const labeled = normalizeGiteaEvent('issue_label', issuePayload({ action: 'label_updated' }) as GiteaPayload)!
    expect(labeled.eventAction).toBe('issues:labeled')
    // A filter-less row keeps today's veto: label churn is lifecycle noise to it.
    expect(giteaRuleVerdict(rule({}, { events: ['issues:*'] }), labeled)).toBe('no-match')
    // A filtered any-update row is entered by the label that now matches, casing aside.
    expect(giteaRuleVerdict(rule({}, { events: ['issues:*'], labelFilter: ['BUG'] }), labeled)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { events: ['issues:*'], labelFilter: ['docs'] }), labeled)).toBe('no-match')
    // Opened is literal: a filtered opened row fires for an issue filed with the label, not for one labeled later.
    const opened = normalizeGiteaEvent('issues', issuePayload() as GiteaPayload)!
    expect(giteaRuleVerdict(rule({}, { labelFilter: ['bug'] }), opened)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { labelFilter: ['docs'] }), opened)).toBe('no-match')
    expect(giteaRuleVerdict(rule({}, { labelFilter: ['bug'] }), labeled)).toBe('no-match')
    // Pull requests ride the same arm under their own event type.
    const pullLabeled = normalizeGiteaEvent(
      'pull_request_label',
      pullPayload({ action: 'label_updated', pull_request: { labels: [{ name: 'needs-review' }] } }) as GiteaPayload
    )!
    expect(pullLabeled.eventAction).toBe('merge_request:labeled')
    const filtered = { events: ['merge_request:*'], labelFilter: ['needs-review'] }
    expect(giteaRuleVerdict(rule({}, filtered), pullLabeled)).toBe('needs-authz')
    expect(giteaRuleVerdict(rule({}, { events: ['merge_request:*'] }), pullLabeled)).toBe('no-match')
  })

  it('the team form is never a bare mention of the owner, and is inert without an owner', () => {
    const body = `@${REPO_OWNER}/oncall please look`
    const ctx = normalizeGiteaEvent('issue_comment', issueCommentPayload({ comment: { id: 4, body } }) as GiteaPayload)!
    expect(ctx.teamOwnerLogin).toBe(REPO_OWNER)
    const mentionOnly = { mentionOnly: true, commentFamilies: ['issues' as const] }
    expect(giteaRuleVerdict(rule({}, { ...mentionOnly, agentName: 'oncall' }), ctx)).toBe('needs-authz')
    // `@<owner>/<slug>` is the TEAM form, so an agent named after the owner is not summoned by it.
    expect(giteaRuleVerdict(rule({}, { ...mentionOnly, agentName: REPO_OWNER }), ctx)).toBe('no-match')
    expect(giteaRuleVerdict(rule({}, { ...mentionOnly, agentName: 'deploy' }), ctx)).toBe('no-match')
    // A delivery naming no owner at all yields none, so the form selects nobody there.
    const ownerless = normalizeGiteaEvent(
      'issue_comment',
      issueCommentPayload({ comment: { id: 5, body }, repository: { id: REPO } }) as GiteaPayload
    )!
    expect(ownerless.teamOwnerLogin).toBeUndefined()
    expect(giteaRuleVerdict(rule({}, { ...mentionOnly, agentName: 'oncall' }), ownerless)).toBe('no-match')
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

  describe('Decision routing (code-host-decisions.md §4)', () => {
    const routingFor = (routingId = ROUTING, host = { agentId: AGENT, daemonId: DAEMON }) => ({
      routingId,
      decisionId: DECISION,
      evaluationAgentId: host.agentId,
      evaluationDaemonId: host.daemonId
    })
    // The CP compiles a routed scope with its Any update cadence; Gitea's comment scope names the subject.
    const anyIssues = { events: ['issues:*'], commentFamilies: ['issues' as const] }
    const anyPulls = { events: ['merge_request:*'], commentFamilies: ['pull_request' as const] }
    const routed = (
      overrides: Partial<RcHookAssign> = {},
      gitea: Partial<NonNullable<RcHookAssign['gitea']>> = anyIssues,
      routing = routingFor()
    ) => rule({ routing, ...overrides }, gitea)
    const peer = { hookId: HOOK_B, agentId: AGENT_B, daemonId: DAEMON_B, dispatchDaemonId: DAEMON_B }
    const hookMsgs = () => h.sent as RdMsgHook[]
    const hostCopies = () => hookMsgs().filter((m) => m.routing !== undefined)
    const fires = () => hookMsgs().filter((m) => m.routing === undefined)
    const unavailable = {
      routingId: ROUTING,
      decisionId: DECISION,
      reason: 'unavailable',
      unavailableReason: 'host_unavailable',
      scope: { repoId: String(REPO), family: 'issues' }
    }
    const settle = async () => {
      for (let i = 0; i < 3; i++) await flush()
    }
    const issues = { eventType: 'issues' }
    const issueComment = { eventType: 'issue_comment' }

    beforeEach(() => {
      h.onlineDaemons = new Set([DAEMON, DAEMON_B])
    })

    it('sends one host copy with every candidate, then fires exactly the selected hook', async () => {
      h.table.upsert(routed())
      h.table.upsert(routed(peer))
      const selection = { routingId: ROUTING, decisionId: DECISION, reason: 'decision' as const, verdictSeq: 3 }
      const fired = { ...selection, scope: { repoId: String(REPO), family: 'issues' } }
      h.routeAck = (msg) => ({
        msgId: msg.msgId,
        accepted: true,
        hookRoute: { targets: [{ hookId: HOOK_B, selection }] }
      })
      expect((await post(h, issuePayload(), issues)).statusCode).toBe(202)
      await settle()

      expect(h.authzRequests).toHaveLength(1)
      expect(hostCopies()).toHaveLength(1)
      expect(hostCopies()[0]).toMatchObject({
        hookId: HOOK,
        agentId: AGENT,
        msgId: `${HOOK}:${DELIVERY}:route`,
        deliveryKey: DELIVERY,
        sessionKey: `gitea:${REPO}:issue:42`,
        event: 'issues:opened',
        gitea: { repoId: String(REPO), target: { kind: 'issue', index: 42 } },
        context: expect.objectContaining({
          subject: { authorLogin: 'alice', body: 'the primary is unreachable' }
        }),
        routing: {
          routingId: ROUTING,
          decisionId: DECISION,
          candidates: [
            { hookId: HOOK, agentId: AGENT },
            { hookId: HOOK_B, agentId: AGENT_B }
          ]
        }
      })
      expect(h.dispatches.find((d) => (d.msg as RdMsgHook).routing)).toMatchObject({
        daemonId: DAEMON,
        opts: { ackTimeoutMs: HOOK_ROUTING_ACK_TIMEOUT_MS, maxTries: 1 }
      })
      expect(fires()).toEqual([
        expect.objectContaining({ hookId: HOOK_B, msgId: `${HOOK_B}:${DELIVERY}`, routeSelection: fired })
      ])
      expect(h.dispatches.find((d) => d.msg.msgId === `${HOOK_B}:${DELIVERY}`)?.daemonId).toBe(DAEMON_B)
      expect(h.reports).toEqual([expect.objectContaining({ hookId: HOOK_B, status: 'accepted' })])
    })

    it('keeps every routed rule a candidate when a targeted @agent mention names one of them', async () => {
      h.table.upsert(routed({}, { ...anyIssues, agentName: 'review-alpha' }))
      h.table.upsert(routed(peer, { ...anyIssues, agentName: 'review-beta' }))
      await post(h, issueCommentPayload({ comment: { id: 2, body: '@review-beta take this' } }), issueComment)
      await settle()
      expect(h.authzRequests).toHaveLength(2)
      expect(hostCopies()).toHaveLength(1)
      expect(hostCopies()[0]?.routing?.candidates).toEqual(
        expect.arrayContaining([
          { hookId: HOOK, agentId: AGENT },
          { hookId: HOOK_B, agentId: AGENT_B }
        ])
      )
      expect(hostCopies()[0]?.routing?.candidates).toHaveLength(2)
    })

    it('fires nothing when the host holds the event', async () => {
      h.table.upsert(routed())
      h.table.upsert(routed(peer))
      h.routeAck = (msg) => ({ msgId: msg.msgId, accepted: false, reason: 'pending_sync' })
      await post(h, issuePayload(), issues)
      await settle()
      expect(hostCopies()).toHaveLength(1)
      expect(fires()).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it.each<[string, (h: Harness) => ReturnType<typeof routingFor>]>([
      ['the host daemon is offline', () => routingFor(ROUTING, { agentId: AGENT, daemonId: DAEMON_C })],
      [
        'the host daemon predates code-host routing',
        (harness) => {
          harness.routingSupported = false
          return routingFor()
        }
      ],
      [
        'the host daemon routes only GitHub (no v2)',
        (harness) => {
          harness.routingV2Supported = false
          return routingFor()
        }
      ],
      [
        'the host does not answer in time',
        (harness) => {
          harness.routeAck = async () => {
            throw new Error('no ack after 1 tries')
          }
          return routingFor()
        }
      ],
      ['the host agent has no rule in the scope', () => routingFor(ROUTING, { agentId: AGENT_C, daemonId: DAEMON })]
    ])('fires every candidate as unavailable when %s', async (_name, setup) => {
      const routing = setup(h)
      h.table.upsert(routed({}, anyIssues, routing))
      h.table.upsert(routed(peer, anyIssues, routing))
      await post(h, issuePayload(), issues)
      await settle()
      expect(fires().map((m) => [m.hookId, m.routeSelection])).toEqual([
        [HOOK, unavailable],
        [HOOK_B, unavailable]
      ])
      expect(h.reports.map((r) => r.status)).toEqual(['accepted', 'accepted'])
    })

    it('skips a selected rule that changed while the host decided', async () => {
      h.table.upsert(routed())
      h.table.upsert(routed(peer))
      h.routeAck = (msg) => {
        h.table.upsert(routed({ ...peer, configRevision: '4' }))
        return {
          msgId: msg.msgId,
          accepted: true,
          hookRoute: {
            targets: [{ hookId: HOOK_B, selection: { routingId: ROUTING, decisionId: DECISION, reason: 'otherwise' } }]
          }
        }
      }
      await post(h, issuePayload(), issues)
      await settle()
      expect(fires()).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('fires no hook the host names outside the candidates', async () => {
      h.table.upsert(routed())
      h.table.upsert(routed(peer, { events: ['merge_request:*'] }))
      h.routeAck = (msg) => ({
        msgId: msg.msgId,
        accepted: true,
        hookRoute: {
          targets: [{ hookId: HOOK_B, selection: { routingId: ROUTING, decisionId: DECISION, reason: 'otherwise' } }]
        }
      })
      await post(h, issuePayload(), issues)
      await settle()
      expect(hostCopies()[0]?.routing?.candidates).toEqual([{ hookId: HOOK, agentId: AGENT }])
      expect(fires()).toHaveLength(0)
    })

    it('fires an unrouted rule directly beside a routed scope, with no routing fields', async () => {
      h.table.upsert(routed())
      h.table.upsert(rule({ hookId: HOOK_C, agentId: AGENT_C }))
      h.routeAck = () => new Promise<RdAck>(() => {})
      await post(h, issuePayload(), issues)
      await settle()
      expect(hostCopies()).toEqual([
        expect.objectContaining({
          routing: expect.objectContaining({ candidates: [{ hookId: HOOK, agentId: AGENT }] })
        })
      ])
      expect(fires()).toEqual([expect.objectContaining({ hookId: HOOK_C, msgId: `${HOOK_C}:${DELIVERY}` })])
      expect(fires()[0]).not.toHaveProperty('routeSelection')
    })

    it('routes an issues scope and a pull-request scope independently', async () => {
      const mrRouting = routingFor(ROUTING_MR, { agentId: AGENT_B, daemonId: DAEMON_B })
      h.table.upsert(routed())
      h.table.upsert(routed(peer, anyPulls, mrRouting))
      h.table.upsert(routed({ hookId: HOOK_C, agentId: AGENT_C }, anyPulls, mrRouting))
      await post(h, issuePayload(), issues)
      await post(h, pullPayload(), { eventType: 'pull_request', delivery: 'd2' })
      await settle()
      expect(
        h.dispatches
          .filter((d) => (d.msg as RdMsgHook).routing)
          .map((d) => [d.daemonId, (d.msg as RdMsgHook).routing!.routingId, (d.msg as RdMsgHook).routing!.candidates])
      ).toEqual([
        [DAEMON, ROUTING, [{ hookId: HOOK, agentId: AGENT }]],
        [
          DAEMON_B,
          ROUTING_MR,
          [
            { hookId: HOOK_B, agentId: AGENT_B },
            { hookId: HOOK_C, agentId: AGENT_C }
          ]
        ]
      ])
      expect(fires().map((m) => [m.hookId, m.routeSelection?.routingId])).toEqual([
        [HOOK, ROUTING],
        [HOOK_B, ROUTING_MR],
        [HOOK_C, ROUTING_MR]
      ])
    })

    it('sends a record-only copy for a thread event nothing fires on, without waiting or reporting', async () => {
      h.table.upsert(routed({}, { events: ['issues:opened'] }))
      h.routeAck = () => new Promise<RdAck>(() => {})
      await post(h, issueCommentPayload(), issueComment)
      await settle()
      expect(hookMsgs()).toHaveLength(1)
      expect(hostCopies()[0]).toMatchObject({
        hookId: HOOK,
        msgId: `${HOOK}:${DELIVERY}:route`,
        sessionKey: `gitea:${REPO}:issue:42`,
        event: 'note:created',
        routing: { routingId: ROUTING, decisionId: DECISION, candidates: [] },
        gitea: expect.objectContaining({ commentId: '1692903', target: { kind: 'issue', index: 42 } }),
        context: expect.objectContaining({
          event: 'note',
          number: 42,
          bodyExcerpt: 'what is the rollout plan?',
          subject: expect.objectContaining({ authorLogin: 'mallory' })
        })
      })
      expect(hostCopies()[0]).not.toHaveProperty('routeSelection')
      expect(h.reports).toHaveLength(0)
    })

    it('records nothing for an unrouted rule', async () => {
      h.table.upsert(rule({}, { events: ['issues:opened'] }))
      await post(h, issueCommentPayload(), issueComment)
      await settle()
      expect(h.sent).toHaveLength(0)
    })

    it('records a bot-authored comment, which the veto keeps from firing', async () => {
      h.table.upsert(routed())
      await post(h, issueCommentPayload({ sender: sender(BOT_USER, BOT_LOGIN) }), issueComment)
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ routing: expect.objectContaining({ candidates: [] }) })])
      expect(h.authzRequests).toHaveLength(0)
    })

    it('records a label change the §8 veto keeps from firing', async () => {
      h.table.upsert(routed())
      await post(h, issuePayload({ action: 'label_updated' }), { eventType: 'issue_label' })
      await settle()
      expect(hookMsgs()).toEqual([
        expect.objectContaining({ event: 'issues:labeled', routing: expect.objectContaining({ candidates: [] }) })
      ])
      expect(h.authzRequests).toHaveLength(0)
    })

    it('records an event the membership gate refused', async () => {
      h.table.upsert(routed())
      h.authzResult = false
      await post(h, issueCommentPayload(), issueComment)
      await settle()
      expect(h.authzRequests).toHaveLength(1)
      expect(hookMsgs()).toEqual([expect.objectContaining({ routing: expect.objectContaining({ candidates: [] }) })])
      expect(h.reports).toHaveLength(0)
    })

    it("records nothing when the host's hook moves to another repository during authz", async () => {
      h.table.upsert(routed())
      h.authzResult = async () => {
        h.table.upsert(routed({}, { ...anyIssues, repoId: '1', repoPath: 'example-org/other-repo' }))
        return false
      }
      await post(h, issueCommentPayload(), issueComment)
      await settle()
      expect(h.authzRequests).toHaveLength(1)
      expect(h.sent).toHaveLength(0)
    })

    it('records a denied external pull request beside its review-request-required row', async () => {
      h.table.upsert(routed({}, anyPulls))
      h.authzResult = false
      await post(
        h,
        pullPayload({
          pull_request: { user: sender(OUTSIDER, 'mallory'), head: { sha: HEAD_SHA, repo_id: FORK_REPO } }
        }),
        { eventType: 'pull_request' }
      )
      await settle()
      expect(hookMsgs()).toEqual([
        expect.objectContaining({ event: 'merge_request:opened', routing: expect.objectContaining({ candidates: [] }) })
      ])
      expect(h.reports).toEqual([
        expect.objectContaining({ status: 'failed', reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED })
      ])
    })

    it('records a review submission for a pull-request scope, carrying the review text', async () => {
      h.table.upsert(routed({}, { events: ['merge_request:opened'] }))
      await post(h, reviewPayload(), { eventType: 'pull_request_review_comment' })
      await settle()
      expect(hookMsgs()).toEqual([
        expect.objectContaining({
          event: 'review:commented',
          sessionKey: `gitea:${REPO}:pull:77`,
          routing: expect.objectContaining({ candidates: [] }),
          context: expect.objectContaining({
            bodyExcerpt: 'review body',
            subject: expect.objectContaining({ draft: false, body: 'please review' })
          })
        })
      ])
      expect(h.reports).toHaveLength(0)
    })

    it('lets a mention narrow only unrouted rules, while the routed scope still judges the event', async () => {
      h.table.upsert(routed({}, { ...anyIssues, agentName: 'review-alpha' }))
      h.table.upsert(rule({ hookId: HOOK_C, agentId: AGENT_C }, { ...anyIssues, agentName: 'review-gamma' }))
      await post(h, issueCommentPayload({ comment: { id: 2, body: '@review-gamma take this' } }), issueComment)
      await settle()
      expect(hostCopies()).toEqual([
        expect.objectContaining({
          routing: expect.objectContaining({ candidates: [{ hookId: HOOK, agentId: AGENT }] })
        })
      ])
      expect(fires().filter((m) => m.hookId === HOOK_C)).toEqual([
        expect.not.objectContaining({ routeSelection: expect.anything() })
      ])
    })

    it('records nothing when the host cannot take a Gitea copy', async () => {
      h.table.upsert(routed({}, { events: ['issues:opened'] }))
      h.routingV2Supported = false
      await post(h, issueCommentPayload(), issueComment)
      await settle()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('keeps record-only copies off the fire budget', async () => {
      h.table.upsert(routed({}, { events: ['issues:*'] }))
      // The harness budget is 5: a sixth record-only copy is dropped, yet the next fire still goes out.
      for (let i = 0; i < 6; i++) await post(h, issueCommentPayload(), { ...issueComment, delivery: `d-rec-${i}` })
      await post(h, issuePayload(), { ...issues, delivery: 'd-fire' })
      await settle()
      expect(hostCopies().filter((m) => m.routing!.candidates.length === 0)).toHaveLength(5)
      expect(fires().map((m) => m.deliveryKey)).toEqual(['d-fire'])
    })

    it('fires a push directly: no scope covers it', async () => {
      h.table.upsert(routed({}, { events: ['push:*'] }))
      await post(h, pushPayload(), { eventType: 'push' })
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ event: 'push' })])
      expect(hookMsgs()[0]).not.toHaveProperty('routing')
      expect(hookMsgs()[0]).not.toHaveProperty('routeSelection')
    })

    it('sends thread cleanup unrouted, as maintenance', async () => {
      h.table.upsert(routed({}, anyPulls))
      await post(h, pullPayload({ action: 'closed', pull_request: { merged: true } }), { eventType: 'pull_request' })
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ event: 'merge_request:merged' })])
      expect(hookMsgs()[0]).not.toHaveProperty('routing')
      expect(hookMsgs()[0]).not.toHaveProperty('routeSelection')
    })
  })

  describe('routing callbacks', () => {
    const routing = { routingId: ROUTING, decisionId: DECISION, evaluationAgentId: AGENT, evaluationDaemonId: DAEMON }
    const comment = normalizeGiteaEvent('issue_comment', issueCommentPayload() as GiteaPayload)!
    const pullComment = normalizeGiteaEvent('pull_request_comment', pullCommentPayload() as GiteaPayload)!
    const review = normalizeGiteaEvent('pull_request_review_approved', reviewPayload() as GiteaPayload)!
    const push = normalizeGiteaEvent('push', pushPayload() as GiteaPayload)!
    const eligible = (hostRule: RcHookAssign, ctx: GiteaMatchCtx, repoId = String(REPO)) =>
      codeHostRecordOnlyEligible(GITEA_ROUTING, hostRule, { ctx, repoId })

    it.each<[string, RcHookAssign, GiteaMatchCtx, string, boolean]>([
      ['routed issues rule, issue comment', rule({ routing }), comment, String(REPO), true],
      ['unrouted rule', rule(), comment, String(REPO), false],
      ['foreign kind', rule({ routing, kind: 'gitlab' }), comment, String(REPO), false],
      ['another repository', rule({ routing }), comment, '1', false],
      ['pull comment on an issues rule', rule({ routing }), pullComment, String(REPO), false],
      [
        'pull comment on a pull rule',
        rule({ routing }, { events: ['merge_request:*'] }),
        pullComment,
        String(REPO),
        true
      ],
      [
        'review on a pull comment scope',
        rule({ routing }, { commentFamilies: ['pull_request'] }),
        review,
        String(REPO),
        true
      ],
      ['push', rule({ routing }, { events: ['push:*'] }), push, String(REPO), false]
    ])('record-only eligibility: %s', (_name, hostRule, ctx, repoId, expected) => {
      expect(eligible(hostRule, ctx, repoId)).toBe(expected)
    })

    it('maps the comment-subject vocabulary onto the event families', () => {
      expect([...giteaRuleFamilies(rule({}, { events: ['push:*'], commentFamilies: ['pull_request'] }))]).toEqual([
        'merge_request'
      ])
      expect(GITEA_ROUTING.eventFamily({ ctx: review, repoId: String(REPO) })).toBe('merge_request')
      expect(GITEA_ROUTING.eventFamily({ ctx: push, repoId: String(REPO) })).toBeUndefined()
      expect(GITEA_ROUTING.hostFeatures).toEqual([HOOK_DECISION_ROUTING_V1_FEATURE, HOOK_DECISION_ROUTING_V2_FEATURE])
    })
  })
})
