import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac, randomBytes } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_INSTANCE_V1_FEATURE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  type RcCodeHostMembershipAuthz,
  type RcHookAssign,
  type RcHookRerun,
  type RcRunReport,
  type RdAck,
  type RdMsg,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import {
  dispatchGitlabRerun,
  registerGitlabIngress,
  gitlabRuleVerdict,
  normalizeGitlabEvent,
  type GitlabRerunDeps
} from './gitlab-ingress.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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
  reports: RcRunReport[]
  authzRequests: RcCodeHostMembershipAuthz[]
  authzResult: boolean | ((request: RcCodeHostMembershipAuthz) => boolean | Promise<boolean>)
  ack: RdAck
  offline: boolean
  gitlabSupported: boolean
  gitlabInstanceSupported: boolean
  /** The same deps the ingress runs on — the rerun path reuses them verbatim. */
  deps: GitlabRerunDeps
}

function makeHarness(): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> & Pick<Harness, 'sent' | 'reports' | 'authzRequests'> = {
    sent: [],
    reports: [],
    authzRequests: [],
    authzResult: true,
    ack: { msgId: 'x', accepted: true },
    offline: false,
    gitlabSupported: true,
    gitlabInstanceSupported: true
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
            if (capability === GITLAB_COM_V1_FEATURE) return h.gitlabSupported === true
            if (capability === GITLAB_INSTANCE_V1_FEATURE) return h.gitlabInstanceSupported === true
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
  h.deps = deps
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

  it('verdict is pure: event patterns gate before authz, and a stored label filter is ignored', async () => {
    const ctx = normalizeGitlabEvent(issuePayload() as never)!
    // The label filter is a removed feature. A rule compiled from a stored config
    // that still carries one matches exactly as if it carried none — matching or
    // non-matching labels make no difference to the verdict.
    expect(gitlabRuleVerdict(rule({}, { labelFilter: ['bug'] }), ctx)).toBe('needs-authz')
    expect(gitlabRuleVerdict(rule({}, { labelFilter: ['ops'] }), ctx)).toBe('needs-authz')
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
})

describe('gitlab rerun dispatch (§16.1 "Run again")', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  const frame = (over: Partial<RcHookRerun> = {}): RcHookRerun => ({
    hookId: HOOK,
    agentId: AGENT,
    deliveryKey: 'rerun_1',
    configRevision: '3',
    dispatchRevision: '5',
    event: 'merge_request:rerun',
    gitlab: {
      projectId: String(PROJECT),
      projectPath: 'example-group/example-project',
      target: { kind: 'merge_request', iid: 77, headSha: 'b'.repeat(40), explicitReviewRequest: true }
    },
    ...over
  })

  it('re-enters the ordinary dispatch path with the §12.3 key and the frame head', async () => {
    h.table.upsert(rule())
    expect(dispatchGitlabRerun(h.deps, frame())).toEqual({ admitted: true, deliveryKey: 'rerun_1' })
    await flush()
    const msg = h.sent[0] as RdMsgHook
    expect(msg.source).toBe('hook')
    expect(msg.hookId).toBe(HOOK)
    expect(msg.agentId).toBe(AGENT)
    expect(msg.sessionKey).toBe(`gitlab:${PROJECT}:merge_request:77`)
    expect(msg.msgId).toBe(`${HOOK}:rerun_1`)
    expect(msg.event).toBe('merge_request:rerun')
    expect(msg.gitlab?.target).toMatchObject({ kind: 'merge_request', iid: 77, headSha: 'b'.repeat(40) })
    // A control-authored envelope: no third-party excerpt rides it.
    expect(msg.context).toMatchObject({ source: 'gitlab', event: 'merge_request', action: 'rerun', number: 77 })
    expect(msg.context?.bodyExcerpt).toBeUndefined()
    // The dispatch reports through the same run-report leg an ingress fire does.
    expect(h.reports.map((report) => report.status)).toEqual(['accepted'])
    expect(h.reports[0]?.deliveryKey).toBe('rerun_1')
  })

  it('lands an issue rerun on the same thread key as the issue events', async () => {
    h.table.upsert(rule())
    dispatchGitlabRerun(
      h.deps,
      frame({ event: 'issues:rerun', gitlab: { ...frame().gitlab, target: { kind: 'issue', iid: 42 } } })
    )
    await flush()
    expect((h.sent[0] as RdMsgHook).sessionKey).toBe(`gitlab:${PROJECT}:issue:42`)
  })

  it('answers rule_mismatch for a frame whose fence no longer matches the compiled rule', async () => {
    h.table.upsert(rule())
    const mismatch = { admitted: false, code: 'rule_mismatch' }
    expect(dispatchGitlabRerun(h.deps, frame({ configRevision: '4' }))).toEqual(mismatch)
    expect(dispatchGitlabRerun(h.deps, frame({ dispatchRevision: '6' }))).toEqual(mismatch)
    expect(dispatchGitlabRerun(h.deps, frame({ agentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }))).toEqual(mismatch)
    expect(dispatchGitlabRerun(h.deps, frame({ gitlab: { ...frame().gitlab, projectId: '999' } }))).toEqual(mismatch)
    await flush()
    expect(h.sent).toHaveLength(0)
    // A definitive refusal leaves nothing behind for the CP to reconcile.
    expect(h.reports).toHaveLength(0)
  })

  it('answers replay_pending while its table holds no rule for the hook', async () => {
    expect(dispatchGitlabRerun(h.deps, frame())).toEqual({ admitted: false, code: 'replay_pending' })
    expect(dispatchGitlabRerun(h.deps, frame({ hookId: HOOK_B }))).toEqual({
      admitted: false,
      code: 'replay_pending'
    })
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('ADMITS a fire the daemon then refuses — the run row is the report, not the verdict', async () => {
    h.table.upsert(rule())
    h.gitlabSupported = false
    expect(dispatchGitlabRerun(h.deps, frame({ deliveryKey: 'rerun_2' }))).toEqual({
      admitted: true,
      deliveryKey: 'rerun_2'
    })
    await flush()
    expect(h.sent).toHaveLength(0)
    expect(h.reports).toEqual([expect.objectContaining({ status: 'failed', reason: 'rejected:unsupported' })])
  })

  it('answers limiter_exhausted once the shared per-hook run budget is spent', async () => {
    h.table.upsert(rule())
    const verdicts = Array.from({ length: 7 }, (_, i) => dispatchGitlabRerun(h.deps, frame({ deliveryKey: `r_${i}` })))
    await flush()
    // The harness limiter holds five tokens and does not refill.
    expect(verdicts.filter((v) => v.admitted)).toHaveLength(5)
    expect(verdicts.slice(5)).toEqual([
      { admitted: false, code: 'limiter_exhausted' },
      { admitted: false, code: 'limiter_exhausted' }
    ])
    expect(h.sent).toHaveLength(5)
  })
})
