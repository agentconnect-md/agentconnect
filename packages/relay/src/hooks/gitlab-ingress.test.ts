import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac, randomBytes } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_INSTANCE_V1_FEATURE,
  HOOK_DECISION_ROUTING_V1_FEATURE,
  HOOK_DECISION_ROUTING_V2_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RD_CODEHOST_RELEASE_V1,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcRunReport,
  type RdAck,
  type RdMsg,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import {
  registerGitlabIngress,
  gitlabRuleFamilies,
  gitlabRuleVerdict,
  normalizeGitlabEvent,
  GITLAB_ROUTING,
  type GitlabMatchCtx
} from './gitlab-ingress.js'
import { codeHostRecordOnlyEligible, HOOK_ROUTING_ACK_TIMEOUT_MS } from './code-host-routing.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const HOOK_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const AGENT_C = '99999999-9999-4999-8999-999999999999'
const DAEMON_B = '88888888-8888-4888-8888-888888888888'
const DAEMON_C = '77777777-7777-4777-8777-777777777777'
const ROUTING = '66666666-6666-4666-8666-666666666666'
const ROUTING_MR = '55555555-5555-4555-8555-555555555555'
const DECISION = '44444444-4444-4444-8444-444444444444'
const PROJECT = 4455667
const SA_USER = 9042
const SIBLING_SA_USER = 9043
const KEY = randomBytes(32)
const TOKEN = `whsec_${KEY.toString('base64')}`

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function rule(
  overrides: Partial<RcHookAssign> = {},
  gitlab: Partial<NonNullable<RcHookAssign['gitlab']>> = {}
): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'gitlab',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    sessionMode: 'perThread',
    gitlab: {
      projectId: String(PROJECT),
      projectPath: 'example-group/example-project',
      sessionKeyPrefix: `gitlab:${PROJECT}`,
      events: ['issues:opened'],
      labelFilter: [],
      mentionOnly: false,
      serviceAccountUserId: String(SA_USER),
      serviceAccountUsername: `agentconnect-p${PROJECT}`,
      signingToken: TOKEN,
      ...gitlab
    },
    ...overrides
  }
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'issue',
    user: { id: 7001, username: 'alice', avatar_url: 'https://gitlab.com/a.png' },
    project: { id: PROJECT, path_with_namespace: 'example-group/example-project' },
    object_attributes: {
      iid: 42,
      title: 'db down',
      description: 'the primary is unreachable',
      action: 'open',
      author_id: 7001,
      url: 'https://gitlab.com/example-group/example-project/-/issues/42',
      ...((overrides.object_attributes as Record<string, unknown> | undefined) ?? {})
    },
    labels: [{ title: 'bug' }],
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'object_attributes'))
  }
}

function mrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'merge_request',
    user: { id: 7001, username: 'alice' },
    project: { id: PROJECT, path_with_namespace: 'example-group/example-project' },
    object_attributes: {
      iid: 77,
      title: 'tighten retry',
      description: 'please review',
      action: 'open',
      author_id: 7001,
      source_project_id: PROJECT,
      target_project_id: PROJECT,
      last_commit: { id: 'a'.repeat(40) },
      draft: false,
      url: 'https://gitlab.com/example-group/example-project/-/merge_requests/77',
      ...((overrides.object_attributes as Record<string, unknown> | undefined) ?? {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'object_attributes'))
  }
}

function notePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'note',
    user: { id: 7001, username: 'alice' },
    project: { id: PROJECT, path_with_namespace: 'example-group/example-project' },
    object_attributes: {
      note: 'what is the rollout plan?',
      noteable_type: 'Issue',
      url: 'https://gitlab.com/example-group/example-project/-/issues/42#note_1',
      ...((overrides.object_attributes as Record<string, unknown> | undefined) ?? {})
    },
    issue: { iid: 42, title: 'db down', labels: [{ title: 'bug' }], author_id: 7002 },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'object_attributes'))
  }
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsg[]
  dispatches: Array<{ daemonId: string; msg: RdMsg; opts?: unknown }>
  reports: RcRunReport[]
  authzRequests: RcCodeHostMembershipAuthz[]
  authzResult: boolean | ((request: RcCodeHostMembershipAuthz) => boolean | Promise<boolean>)
  ack: RdAck
  offline: boolean
  gitlabSupported: boolean
  gitlabInstanceSupported: boolean
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
  const h: Partial<Harness> & Pick<Harness, 'sent' | 'dispatches' | 'reports' | 'authzRequests'> = {
    sent: [],
    dispatches: [],
    reports: [],
    authzRequests: [],
    authzResult: true,
    ack: { msgId: 'x', accepted: true },
    offline: false,
    gitlabSupported: true,
    gitlabInstanceSupported: true,
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
            if (capability === GITLAB_COM_V1_FEATURE) return h.gitlabSupported === true
            if (capability === GITLAB_INSTANCE_V1_FEATURE) return h.gitlabInstanceSupported === true
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
    authorizeMembership: async (request: RcCodeHostMembershipAuthz) => {
      h.authzRequests.push(request)
      return typeof h.authzResult === 'function' ? h.authzResult(request) : h.authzResult!
    },
    authzLimiter: new HookRateLimiter(clock, { capacity: 20, refillPerSec: 0 }),
    limiter: new HookRateLimiter(clock, { capacity: 5, refillPerSec: 0 }),
    clock,
    log
  }
  registerGitlabIngress(app, deps)
  h.app = app
  h.table = table
  h.clock = clock
  return h as Harness
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

function post(h: Harness, payload: Record<string, unknown>, overrides: Record<string, string | undefined> = {}) {
  const body = JSON.stringify(payload)
  const ts = String(Math.floor(h.clock.now() / 1000))
  const id = overrides['webhook-id'] ?? 'msg_delivery_1'
  const signature =
    overrides['webhook-signature'] ?? `v1,${createHmac('sha256', KEY).update(`${id}.${ts}.${body}`).digest('base64')}`
  return h.app.inject({
    method: 'POST',
    url: '/webhooks/gitlab',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': overrides['webhook-timestamp'] ?? ts,
      'webhook-signature': signature
    },
    payload: body
  })
}

describe('gitlab ingress', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  it('verified issue open → membership authz → dispatch with the §12.3 key and trusted metadata', async () => {
    h.table.upsert(rule())
    const res = await post(h, issuePayload())
    expect(res.statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toEqual([
      expect.objectContaining({
        provider: 'gitlab',
        repoExternalId: String(PROJECT),
        actorExternalId: '7001',
        configRevision: '3',
        dispatchRevision: '5'
      })
    ])
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0] as RdMsgHook
    expect(msg.sessionKey).toBe(`gitlab:${PROJECT}:issue:42`)
    expect(msg.msgId).toBe(`${HOOK}:msg_delivery_1`)
    expect(msg.event).toBe('issues:opened')
    expect(msg.gitlab).toEqual({
      projectId: String(PROJECT),
      projectPath: 'example-group/example-project',
      target: { kind: 'issue', iid: 42 }
    })
    expect(msg.context?.source).toBe('gitlab')
    expect(msg.context?.bodyExcerpt).toBe('the primary is unreachable')
    expect(h.reports.map((r) => r.status)).toEqual(['accepted'])
  })

  it('uniform 404: bad signature, stale timestamp, unknown project, malformed body, missing headers', async () => {
    h.table.upsert(rule())
    const bad = await post(h, issuePayload(), { 'webhook-signature': `v1,${'x'.repeat(43)}=` })
    expect(bad.statusCode).toBe(404)
    const stale = await post(h, issuePayload(), { 'webhook-timestamp': '100' })
    expect(stale.statusCode).toBe(404)
    const unknown = await post(h, issuePayload({ project: { id: 999 } }))
    expect(unknown.statusCode).toBe(404)
    const malformed = await h.app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: { 'content-type': 'application/json' },
      payload: 'not-json'
    })
    expect(malformed.statusCode).toBe(404)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('membership denial skips silently for issues; nothing reaches the daemon', async () => {
    h.authzResult = false
    h.table.upsert(rule())
    expect((await post(h, issuePayload())).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('a denied MR revision leaves the durable review-request-required row (§12.2)', async () => {
    h.authzResult = false
    h.table.upsert(rule({}, { events: ['merge_request:*'] }))
    const external = mrPayload({
      object_attributes: { author_id: 7999, source_project_id: 12345 },
      user: { id: 7999, username: 'mallory' }
    })
    expect((await post(h, external)).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([
      expect.objectContaining({ status: 'failed', reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED })
    ])
  })

  it('§12.1: service-account-authored events are vetoed, except its own same-project MR revision', async () => {
    h.table.upsert(rule({}, { events: ['issues:opened', 'merge_request:*'] }))
    const saIssue = issuePayload({ user: { id: SA_USER, username: `agentconnect-p${PROJECT}` } })
    expect((await post(h, saIssue)).statusCode).toBe(202)
    const saNote = notePayload({ user: { id: SA_USER, username: `agentconnect-p${PROJECT}` } })
    expect((await post(h, saNote)).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)

    // The internal CI lane: same-project revision authored by the SA is
    // TRUSTED — no membership call, straight to dispatch.
    const internal = mrPayload({
      object_attributes: { action: 'update', oldrev: 'c'.repeat(40), author_id: SA_USER },
      user: { id: SA_USER, username: `agentconnect-p${PROJECT}` }
    })
    expect((await post(h, internal)).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:synchronize')
  })

  it('§12.1: a SIBLING bound account is vetoed even for a same-project MR revision', async () => {
    const vetoSet = { boundServiceAccountUserIds: [String(SA_USER), String(SIBLING_SA_USER)] }
    h.table.upsert(rule({}, { events: ['merge_request:*'], commentFamilies: ['merge_request'], ...vetoSet }))
    const siblingNote = notePayload({
      user: { id: SIBLING_SA_USER, username: 'agentconnect-a2-g7' },
      issue: undefined,
      merge_request: { iid: 77, author_id: 7001 },
      object_attributes: { noteable_type: 'MergeRequest' }
    })
    expect((await post(h, siblingNote)).statusCode).toBe(202)
    const siblingRevision = mrPayload({
      object_attributes: { action: 'update', oldrev: 'c'.repeat(40), author_id: SIBLING_SA_USER },
      user: { id: SIBLING_SA_USER, username: 'agentconnect-a2-g7' }
    })
    expect((await post(h, siblingRevision, { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(0)

    // The rule's OWN account keeps the internal-CI exception under the same veto set.
    const ownRevision = mrPayload({
      object_attributes: { action: 'update', oldrev: 'c'.repeat(40), author_id: SA_USER },
      user: { id: SA_USER, username: `agentconnect-p${PROJECT}` }
    })
    expect((await post(h, ownRevision, { 'webhook-id': 'msg_delivery_3' })).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:synchronize')
  })

  it('assigning the service account as reviewer is the explicit start path', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:opened'] }))
    const assigned = mrPayload({
      object_attributes: { action: 'update', author_id: 7999 },
      user: { id: 7005, username: 'maintainer' },
      changes: { reviewers: { previous: [], current: [{ id: SA_USER }] } }
    })
    expect((await post(h, assigned)).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(1)
    // The ASSIGNING actor is authorized — never the (untrusted) MR author.
    expect(h.authzRequests[0]?.actorExternalId).toBe('7005')
    expect(h.authzRequests[0]?.subjectAuthorExternalId).toBeUndefined()
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0] as RdMsgHook
    expect(msg.event).toBe('merge_request:review_requested')
    expect(msg.gitlab?.target).toMatchObject({ kind: 'merge_request', iid: 77, explicitReviewRequest: true })
  })

  it('push is relay-trusted, matches only push:*, and keys the session by ref', async () => {
    h.table.upsert(rule({}, { events: ['push:*'] }))
    h.table.upsert(rule({ hookId: HOOK_B }, { events: ['issues:opened'] }))
    const push = {
      object_kind: 'push',
      ref: 'refs/heads/main',
      user_id: 7001,
      user_username: 'alice',
      project: { id: PROJECT, path_with_namespace: 'example-group/example-project' },
      project_id: PROJECT,
      commits: [{ message: 'fix: retry' }]
    }
    expect((await post(h, push)).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0] as RdMsgHook
    expect(msg.hookId).toBe(HOOK)
    expect(msg.sessionKey).toBe(`gitlab:${PROJECT}:push:refs/heads/main`)
    expect(msg.gitlab?.target).toEqual({ kind: 'push', ref: 'refs/heads/main' })
  })

  // GitLab's Release Hook carries its action at the top level and names no actor.
  const release = (action: string) => ({
    object_kind: 'release',
    action,
    tag: 'v1.2.0',
    name: 'v1.2.0 — faster sync',
    description: '## Changes\n- faster sync',
    url: 'https://gitlab.example.test/example-group/example-project/-/releases/v1.2.0',
    project: { id: PROJECT, path_with_namespace: 'example-group/example-project' }
  })

  it('a release is relay-trusted in the project’s one releases session: create publishes, update edits', async () => {
    h.table.upsert(rule({}, { events: ['release:*'] }))
    h.table.upsert(rule({ hookId: HOOK_B }, { events: ['release:published'] }))
    for (const action of ['create', 'update', 'delete']) {
      expect((await post(h, release(action), { 'webhook-id': `msg_${action}` })).statusCode).toBe(202)
    }
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent.map((m) => `${(m as RdMsgHook).hookId}:${(m as RdMsgHook).event}`).sort()).toEqual(
      [`${HOOK}:release:published`, `${HOOK_B}:release:published`, `${HOOK}:release:edited`].sort()
    )
    const msg = h.sent[0] as RdMsgHook
    expect(msg.sessionKey).toBe(`gitlab:${PROJECT}:releases`)
    expect(msg.gitlab?.target).toEqual({ kind: 'release', tag: 'v1.2.0' })
    expect(msg.context).toMatchObject({
      event: 'release',
      title: 'v1.2.0 — faster sync',
      htmlUrl: 'https://gitlab.example.test/example-group/example-project/-/releases/v1.2.0',
      bodyExcerpt: '## Changes\n- faster sync',
      release: { tag: 'v1.2.0' }
    })
  })

  it('refuses a release target to a daemon that cannot decode it', async () => {
    h.releaseSupported = false
    h.table.upsert(rule({}, { events: ['release:published'] }))
    expect((await post(h, release('create'))).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])
  })

  it('merged MRs and closed issues fan out as maintenance cleanup, bypassing the actor gate', async () => {
    h.authzResult = false // the gate would deny — cleanup must not care
    h.table.upsert(rule({}, { events: ['merge_request:*'] }))
    const merged = mrPayload({ object_attributes: { action: 'merge', state: 'merged' } })
    expect((await post(h, merged)).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:merged')
    expect((h.sent[0] as RdMsgHook).sessionKey).toBe(`gitlab:${PROJECT}:merge_request:77`)
  })

  it('comment families scope notes; a summon narrows the fan-out to the mentioned agent', async () => {
    h.table.upsert(rule({}, { commentFamilies: ['issues'], agentName: 'oncall' }))
    h.table.upsert(rule({ hookId: HOOK_B, agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, { agentName: 'deploy' }))
    // HOOK matches via its selected family; HOOK_B has no families and no summon.
    expect((await post(h, notePayload())).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK])

    h.sent.length = 0
    h.authzRequests.length = 0
    // An @mention of one agent name narrows a would-be fan-out.
    const mention = notePayload({ object_attributes: { note: '@oncall please look' } })
    expect((await post(h, mention, { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent.map((m) => (m as RdMsgHook).hookId)).toEqual([HOOK])
    // The summoned path authorizes the commenter only.
    expect(h.authzRequests[0]?.subjectAuthorExternalId).toBeUndefined()
  })

  it('carries the note that fired the delivery as the acknowledgement target', async () => {
    h.table.upsert(rule({}, { commentFamilies: ['issues'] }))
    const withId = notePayload({ object_attributes: { id: 8801 } })
    expect((await post(h, withId)).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitlab).toMatchObject({ noteId: '8801', target: { kind: 'issue', iid: 42 } })
  })

  it('omits the note id for a delivery the subject itself fired, and for an unusable id', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:merged'], commentFamilies: ['issues'] }))
    expect((await post(h, mrPayload({ object_attributes: { id: 8801, action: 'merge' } }))).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitlab?.noteId).toBeUndefined()

    h.sent.length = 0
    const unusable = notePayload({ object_attributes: { id: Number.MAX_SAFE_INTEGER + 1 } })
    expect((await post(h, unusable, { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitlab?.noteId).toBeUndefined()
  })

  it('an unmentioned continuation also fences the subject author (§12.2)', async () => {
    h.table.upsert(rule({}, { commentFamilies: ['issues'] }))
    expect((await post(h, notePayload())).statusCode).toBe(202)
    await flush()
    expect(h.authzRequests).toEqual([
      expect.objectContaining({ actorExternalId: '7001', subjectAuthorExternalId: '7002' })
    ])
  })

  it('mention-only rules stay silent without a summon', async () => {
    h.table.upsert(rule({}, { mentionOnly: true, commentFamilies: ['issues'], agentName: 'oncall' }))
    expect((await post(h, notePayload())).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    const summoned = notePayload({ object_attributes: { note: `@agentconnect-p${PROJECT} plan?` } })
    expect((await post(h, summoned, { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('copies the rule host onto the trusted metadata as opaque data (§24.4)', async () => {
    const SELF_MANAGED = 'https://gitlab.example.test/gitlab'
    h.table.upsert(rule({}, { host: SELF_MANAGED }))
    expect((await post(h, issuePayload())).statusCode).toBe(202)
    await flush()
    // Copied from the RULE, never read off the payload, and never parsed here: the relay
    // does not dial GitLab, and the daemon fences the turn on this value.
    expect((h.sent[0] as RdMsgHook).gitlab?.host).toBe(SELF_MANAGED)

    h.sent.length = 0
    h.table.upsert(rule())
    expect((await post(h, issuePayload(), { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitlab?.host).toBeUndefined()
  })

  it('a daemon without gitlab-instance-v1 fails a self-managed dispatch closed (§24.4)', async () => {
    const SELF_MANAGED = 'https://gitlab.example.test/gitlab'
    h.gitlabInstanceSupported = false
    h.table.upsert(rule({}, { host: SELF_MANAGED }))
    expect((await post(h, issuePayload())).statusCode).toBe(202)
    await flush()
    // The daemon would resolve the host to GitLab.com and act on the wrong instance.
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])

    // The default value of the axis needs nothing new from the same daemon…
    h.reports.length = 0
    h.table.upsert(rule({}, { host: GITLAB_DEFAULT_BASE_URL }))
    expect((await post(h, issuePayload(), { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(1)

    // …and the fence is re-read per attempt, so a daemon that gains the bit heals with no
    // convergence pass: the same standing rule now dispatches.
    h.sent.length = 0
    h.gitlabInstanceSupported = true
    h.table.upsert(rule({}, { host: SELF_MANAGED }))
    expect((await post(h, issuePayload(), { 'webhook-id': 'msg_delivery_3' })).statusCode).toBe(202)
    await flush()
    expect((h.sent[0] as RdMsgHook).gitlab?.host).toBe(SELF_MANAGED)
  })

  it('a daemon without gitlab-com-v1 fails the dispatch closed', async () => {
    h.gitlabSupported = false
    h.table.upsert(rule({}, { events: ['push:*'] }))
    const push = {
      object_kind: 'push',
      ref: 'refs/heads/main',
      user_id: 7001,
      project: { id: PROJECT, path_with_namespace: 'example-group/example-project' }
    }
    expect((await post(h, push)).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])
  })

  it('lifecycle noise never fires: edits, reopens, unmerged closes, draft toggles', async () => {
    h.table.upsert(rule({}, { events: ['issues:*', 'merge_request:*'] }))
    expect(normalizeGitlabEvent(issuePayload({ object_attributes: { action: 'update' } }) as never)).toBeUndefined()
    expect(normalizeGitlabEvent(issuePayload({ object_attributes: { action: 'reopen' } }) as never)).toBeUndefined()
    expect(normalizeGitlabEvent(mrPayload({ object_attributes: { action: 'close' } }) as never)).toBeUndefined()
    expect(
      normalizeGitlabEvent(
        mrPayload({
          object_attributes: { action: 'update' },
          changes: { draft: { previous: true, current: false } }
        }) as never
      )
    ).toBeUndefined()
    // System notes are never turns, and neither are comment EDITS (§12 veto):
    // a Note Hook update arrives with a fresh webhook-id and must not open a
    // duplicate turn. An absent action keeps meaning creation.
    expect(normalizeGitlabEvent(notePayload({ object_attributes: { system: true } }) as never)).toBeUndefined()
    expect(normalizeGitlabEvent(notePayload({ object_attributes: { action: 'update' } }) as never)).toBeUndefined()
    expect(normalizeGitlabEvent(notePayload({ object_attributes: { action: 'create' } }) as never)).toBeDefined()
    expect(normalizeGitlabEvent(notePayload() as never)).toBeDefined()
  })

  it('a native reviewer RE-request (same reviewer, re_requested flag) is a start path too', async () => {
    h.table.upsert(rule({}, { events: ['merge_request:opened'] }))
    const rerequested = mrPayload({
      object_attributes: { action: 'update', author_id: 7999 },
      user: { id: 7005, username: 'maintainer' },
      changes: {
        reviewers: { previous: [{ id: SA_USER }], current: [{ id: SA_USER, re_requested: true }] }
      }
    })
    expect((await post(h, rerequested)).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0] as RdMsgHook).event).toBe('merge_request:review_requested')
    // An unchanged reviewer set WITHOUT the flag (e.g. a submitted-review state
    // change) stays inert.
    h.sent.length = 0
    const inert = mrPayload({
      object_attributes: { action: 'update', author_id: 7999 },
      changes: { reviewers: { previous: [{ id: SA_USER }], current: [{ id: SA_USER }] } }
    })
    expect((await post(h, inert, { 'webhook-id': 'msg_delivery_2' })).statusCode).toBe(202)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('verdict is pure: event patterns gate before authz, and the label filter reads the CURRENT labels case-insensitively', async () => {
    const ctx = normalizeGitlabEvent(issuePayload() as never)! // labels: [bug]
    expect(gitlabRuleVerdict(rule({}, { labelFilter: ['bug'] }), ctx)).toBe('needs-authz')
    expect(gitlabRuleVerdict(rule({}, { labelFilter: ['BUG'] }), ctx)).toBe('needs-authz')
    expect(gitlabRuleVerdict(rule({}, { labelFilter: ['ops'] }), ctx)).toBe('no-match')
    // Absent (a CP predating the filter) and empty both admit every label.
    expect(gitlabRuleVerdict(rule({}, { labelFilter: undefined }), ctx)).toBe('needs-authz')
    expect(gitlabRuleVerdict(rule({}, { events: ['merge_request:*'] }), ctx)).toBe('no-match')
    expect(gitlabRuleVerdict(rule({ kind: 'github' }), ctx)).toBe('no-match')
  })

  it('§12.1: the veto set widens the author veto; a rule without one vetoes exactly its own account', () => {
    const siblingIssue = normalizeGitlabEvent(
      issuePayload({ user: { id: SIBLING_SA_USER, username: 'agentconnect-a2-g7' } }) as never
    )!
    const vetoSet = { boundServiceAccountUserIds: [String(SA_USER), String(SIBLING_SA_USER)] }
    expect(gitlabRuleVerdict(rule({}, vetoSet), siblingIssue)).toBe('no-match')
    // A rule the Control Plane compiled before the field vetoes only the ID it names.
    expect(gitlabRuleVerdict(rule(), siblingIssue)).toBe('needs-authz')
    expect(gitlabRuleVerdict(rule({}, { boundServiceAccountUserIds: [String(SA_USER)] }), siblingIssue)).toBe(
      'needs-authz'
    )
    const ownIssue = normalizeGitlabEvent(
      issuePayload({ user: { id: SA_USER, username: `agentconnect-p${PROJECT}` } }) as never
    )!
    expect(gitlabRuleVerdict(rule(), ownIssue)).toBe('no-match')
    expect(gitlabRuleVerdict(rule({}, vetoSet), ownIssue)).toBe('no-match')
  })

  describe('Decision routing (code-host-decisions.md §4)', () => {
    const routingFor = (routingId = ROUTING, host = { agentId: AGENT, daemonId: DAEMON }) => ({
      routingId,
      decisionId: DECISION,
      evaluationAgentId: host.agentId,
      evaluationDaemonId: host.daemonId
    })
    // The CP compiles a routed scope with its Any update cadence.
    const anyIssues = { events: ['issues:*'], commentFamilies: ['issues' as const] }
    const anyMrs = { events: ['merge_request:*'], commentFamilies: ['merge_request' as const] }
    const routed = (
      overrides: Partial<RcHookAssign> = {},
      gitlab: Partial<NonNullable<RcHookAssign['gitlab']>> = anyIssues,
      routing = routingFor()
    ) => rule({ routing, ...overrides }, gitlab)
    const peer = { hookId: HOOK_B, agentId: AGENT_B, daemonId: DAEMON_B, dispatchDaemonId: DAEMON_B }
    const hookMsgs = () => h.sent as RdMsgHook[]
    const hostCopies = () => hookMsgs().filter((m) => m.routing !== undefined)
    const fires = () => hookMsgs().filter((m) => m.routing === undefined)
    const unavailable = {
      routingId: ROUTING,
      decisionId: DECISION,
      reason: 'unavailable',
      unavailableReason: 'host_unavailable',
      scope: { repoId: String(PROJECT), family: 'issues' }
    }
    const settle = async () => {
      for (let i = 0; i < 3; i++) await flush()
    }

    beforeEach(() => {
      h.onlineDaemons = new Set([DAEMON, DAEMON_B])
    })

    it('sends one host copy with every candidate, then fires exactly the selected hook', async () => {
      h.table.upsert(routed())
      h.table.upsert(routed(peer))
      const selection = { routingId: ROUTING, decisionId: DECISION, reason: 'decision' as const, verdictSeq: 3 }
      const fired = { ...selection, scope: { repoId: String(PROJECT), family: 'issues' } }
      h.routeAck = (msg) => ({
        msgId: msg.msgId,
        accepted: true,
        hookRoute: { targets: [{ hookId: HOOK_B, selection }] }
      })
      expect((await post(h, issuePayload())).statusCode).toBe(202)
      await settle()

      // One membership decision fences both candidates before the scope is routed.
      expect(h.authzRequests).toHaveLength(1)
      expect(hostCopies()).toHaveLength(1)
      expect(hostCopies()[0]).toMatchObject({
        hookId: HOOK,
        agentId: AGENT,
        msgId: `${HOOK}:msg_delivery_1:route`,
        deliveryKey: 'msg_delivery_1',
        sessionKey: `gitlab:${PROJECT}:issue:42`,
        event: 'issues:opened',
        gitlab: { projectId: String(PROJECT), target: { kind: 'issue', iid: 42 } },
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
        expect.objectContaining({ hookId: HOOK_B, msgId: `${HOOK_B}:msg_delivery_1`, routeSelection: fired })
      ])
      expect(h.dispatches.find((d) => d.msg.msgId === `${HOOK_B}:msg_delivery_1`)?.daemonId).toBe(DAEMON_B)
      expect(h.reports).toEqual([expect.objectContaining({ hookId: HOOK_B, status: 'accepted' })])
    })

    it('keeps every routed rule a candidate when a targeted @agent mention names one of them', async () => {
      h.table.upsert(routed({}, { ...anyIssues, agentName: 'review-alpha' }))
      h.table.upsert(routed(peer, { ...anyIssues, agentName: 'review-beta' }))
      await post(h, notePayload({ object_attributes: { note: '@review-beta take this' } }))
      await settle()
      // The summoned and unsummoned authorizations both settle before the one host copy.
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
      await post(h, issuePayload())
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
      await post(h, issuePayload())
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
      await post(h, issuePayload())
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
      await post(h, issuePayload())
      await settle()
      expect(hostCopies()[0]?.routing?.candidates).toEqual([{ hookId: HOOK, agentId: AGENT }])
      expect(fires()).toHaveLength(0)
    })

    it('fires an unrouted rule directly beside a routed scope, with no routing fields', async () => {
      h.table.upsert(routed())
      h.table.upsert(rule({ hookId: HOOK_C, agentId: AGENT_C }))
      h.routeAck = () => new Promise<RdAck>(() => {})
      await post(h, issuePayload())
      await settle()
      expect(hostCopies()).toEqual([
        expect.objectContaining({
          routing: expect.objectContaining({ candidates: [{ hookId: HOOK, agentId: AGENT }] })
        })
      ])
      expect(fires()).toEqual([expect.objectContaining({ hookId: HOOK_C, msgId: `${HOOK_C}:msg_delivery_1` })])
      expect(fires()[0]).not.toHaveProperty('routeSelection')
    })

    it('routes an issues scope and a merge-request scope independently', async () => {
      const mrRouting = routingFor(ROUTING_MR, { agentId: AGENT_B, daemonId: DAEMON_B })
      h.table.upsert(routed())
      h.table.upsert(routed(peer, anyMrs, mrRouting))
      h.table.upsert(routed({ hookId: HOOK_C, agentId: AGENT_C }, anyMrs, mrRouting))
      await post(h, issuePayload())
      await post(h, mrPayload(), { 'webhook-id': 'msg_delivery_2' })
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
      await post(h, notePayload({ object_attributes: { id: 8801 } }))
      await settle()
      expect(hookMsgs()).toHaveLength(1)
      expect(hostCopies()[0]).toMatchObject({
        hookId: HOOK,
        msgId: `${HOOK}:msg_delivery_1:route`,
        sessionKey: `gitlab:${PROJECT}:issue:42`,
        event: 'note:created',
        routing: { routingId: ROUTING, decisionId: DECISION, candidates: [] },
        gitlab: expect.objectContaining({ noteId: '8801', target: { kind: 'issue', iid: 42 } }),
        context: expect.objectContaining({ event: 'note', number: 42, bodyExcerpt: 'what is the rollout plan?' })
      })
      expect(hostCopies()[0]).not.toHaveProperty('routeSelection')
      expect(h.reports).toHaveLength(0)
    })

    it('records nothing for an unrouted rule', async () => {
      h.table.upsert(rule({}, { events: ['issues:opened'] }))
      await post(h, notePayload())
      await settle()
      expect(h.sent).toHaveLength(0)
    })

    it('records a service-account-authored note, which the veto keeps from firing', async () => {
      h.table.upsert(routed())
      await post(h, notePayload({ user: { id: SA_USER, username: `agentconnect-p${PROJECT}` } }))
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ routing: expect.objectContaining({ candidates: [] }) })])
      expect(h.authzRequests).toHaveLength(0)
    })

    it('records an event the membership gate refused', async () => {
      h.table.upsert(routed())
      h.authzResult = false
      await post(h, notePayload())
      await settle()
      expect(h.authzRequests).toHaveLength(1)
      expect(hookMsgs()).toEqual([expect.objectContaining({ routing: expect.objectContaining({ candidates: [] }) })])
      expect(h.reports).toHaveLength(0)
    })

    it("records nothing when the host's hook moves to another project during authz", async () => {
      h.table.upsert(routed())
      h.authzResult = async () => {
        h.table.upsert(routed({}, { ...anyIssues, projectId: '1', projectPath: 'example-group/other' }))
        return false
      }
      await post(h, notePayload())
      await settle()
      expect(h.authzRequests).toHaveLength(1)
      expect(h.sent).toHaveLength(0)
    })

    it('records a denied external MR revision beside its review-request-required row', async () => {
      h.table.upsert(routed({}, anyMrs))
      h.authzResult = false
      await post(
        h,
        mrPayload({
          object_attributes: { author_id: 7999, source_project_id: 12345 },
          user: { id: 7999, username: 'mallory' }
        })
      )
      await settle()
      expect(hookMsgs()).toEqual([
        expect.objectContaining({ event: 'merge_request:opened', routing: expect.objectContaining({ candidates: [] }) })
      ])
      expect(h.reports).toEqual([
        expect.objectContaining({ status: 'failed', reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED })
      ])
    })

    it('lets a mention narrow only unrouted rules, while the routed scope still judges the event', async () => {
      h.table.upsert(routed({}, { ...anyIssues, agentName: 'review-alpha' }))
      h.table.upsert(rule({ hookId: HOOK_C, agentId: AGENT_C }, { ...anyIssues, agentName: 'review-gamma' }))
      await post(h, notePayload({ object_attributes: { note: '@review-gamma take this' } }))
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

    it('records nothing when the host cannot take a GitLab copy', async () => {
      h.table.upsert(routed({}, { events: ['issues:opened'] }))
      h.routingV2Supported = false
      await post(h, notePayload())
      await settle()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('keeps record-only copies off the fire budget', async () => {
      h.table.upsert(routed({}, { events: ['issues:*'] }))
      // The harness budget is 5: a sixth record-only copy is dropped, yet the next fire still goes out.
      for (let i = 0; i < 6; i++) await post(h, notePayload(), { 'webhook-id': `msg_rec_${i}` })
      await post(h, issuePayload(), { 'webhook-id': 'msg_fire' })
      await settle()
      expect(hostCopies().filter((m) => m.routing!.candidates.length === 0)).toHaveLength(5)
      expect(fires().map((m) => m.deliveryKey)).toEqual(['msg_fire'])
    })

    it('fires a push directly: no scope covers it', async () => {
      h.table.upsert(routed({}, { events: ['push:*'] }))
      await post(h, { object_kind: 'push', project: { id: PROJECT }, ref: 'refs/heads/main', user_id: 7001 })
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ event: 'push' })])
      expect(hookMsgs()[0]).not.toHaveProperty('routing')
      expect(hookMsgs()[0]).not.toHaveProperty('routeSelection')
    })

    it('sends thread cleanup unrouted, as maintenance', async () => {
      h.table.upsert(routed({}, anyMrs))
      await post(h, mrPayload({ object_attributes: { action: 'merge', state: 'merged' } }))
      await settle()
      expect(hookMsgs()).toEqual([expect.objectContaining({ event: 'merge_request:merged' })])
      expect(hookMsgs()[0]).not.toHaveProperty('routing')
      expect(hookMsgs()[0]).not.toHaveProperty('routeSelection')
    })

    it('fills the subject from the note payload: state, draft and the MR description', async () => {
      h.table.upsert(rule({}, { commentFamilies: ['merge_request'] }))
      await post(
        h,
        notePayload({
          issue: undefined,
          merge_request: {
            iid: 77,
            title: 't',
            description: 'x'.repeat(5000),
            state: 'opened',
            draft: true,
            author_id: 7002
          }
        })
      )
      await settle()
      const subject = hookMsgs()[0]?.context?.subject
      expect(subject).toMatchObject({ state: 'opened', draft: true })
      expect(subject?.authorLogin).toBeUndefined()
      expect(Buffer.byteLength(subject?.body ?? '')).toBeLessThanOrEqual(4 * 1024)
    })
  })

  describe('routing callbacks', () => {
    const routing = { routingId: ROUTING, decisionId: DECISION, evaluationAgentId: AGENT, evaluationDaemonId: DAEMON }
    const note = normalizeGitlabEvent(notePayload() as never)!
    const mrNote = normalizeGitlabEvent(
      notePayload({ issue: undefined, merge_request: { iid: 77, author_id: 7002 } }) as never
    )!
    const push = normalizeGitlabEvent({ object_kind: 'push', ref: 'refs/heads/main' } as never)!
    const eligible = (hostRule: RcHookAssign, ctx: GitlabMatchCtx, projectId = String(PROJECT)) =>
      codeHostRecordOnlyEligible(GITLAB_ROUTING, hostRule, { ctx, projectId })

    it.each<[string, RcHookAssign, GitlabMatchCtx, string, boolean]>([
      ['routed issues rule, issue note', rule({ routing }), note, String(PROJECT), true],
      ['unrouted rule', rule(), note, String(PROJECT), false],
      ['foreign kind', rule({ routing, kind: 'gitea' }), note, String(PROJECT), false],
      ['another project', rule({ routing }), note, '1', false],
      ['MR note on an issues rule', rule({ routing }), mrNote, String(PROJECT), false],
      [
        'MR note on an MR comment scope',
        rule({ routing }, { commentFamilies: ['merge_request'] }),
        mrNote,
        String(PROJECT),
        true
      ],
      ['push', rule({ routing }, { events: ['push:*'] }), push, String(PROJECT), false]
    ])('record-only eligibility: %s', (_name, hostRule, ctx, projectId, expected) => {
      expect(eligible(hostRule, ctx, projectId)).toBe(expected)
    })

    it('reads families from event patterns and the note scope', () => {
      expect(
        [...gitlabRuleFamilies(rule({}, { events: ['merge_request:*', 'push:*'], commentFamilies: ['issues'] }))].sort()
      ).toEqual(['issues', 'merge_request'])
      expect(gitlabRuleFamilies(rule({ kind: 'github' })).size).toBe(0)
      expect(GITLAB_ROUTING.hostFeatures).toEqual([HOOK_DECISION_ROUTING_V1_FEATURE, HOOK_DECISION_ROUTING_V2_FEATURE])
    })
  })
})
