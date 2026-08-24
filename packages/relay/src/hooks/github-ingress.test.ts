import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import {
  GITHUB_REQUEST_REVIEW_ACTION,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
  type RcGithubCommentAuthz,
  type RcGithubInstallation,
  type RcGithubRerequest,
  type RcGithubRerequestResult,
  type RcHookAssign,
  type RcRunReport,
  type RdAck,
  type RdMsg
} from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { HookRateLimiter } from './rate-limit.js'
import {
  registerGithubIngress,
  githubRuleVerdict,
  buildGithubContext,
  buildTrustedGithubMetadata,
  GITHUB_BODY_EXCERPT_MAX
} from './github-ingress.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DAEMON_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SECRET = 'ghw_sekret'
const REPO_ID = 987654321
const INSTALLATION = 1234567
const APP_ID = 4157507

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function rule(
  overrides: Partial<RcHookAssign> = {},
  github: Partial<NonNullable<RcHookAssign['github']>> = {}
): RcHookAssign {
  return {
    hookId: HOOK,
    kind: 'github',
    agentId: AGENT,
    daemonId: DAEMON,
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: DAEMON,
    reviewPolicy: 'full',
    reportingMode: 'check',
    gateMode: 'informational',
    sessionMode: 'perThread',
    github: {
      repoId: String(REPO_ID),
      repoFullName: 'acme/infra',
      sessionKeyPrefix: 'acme/infra',
      events: ['issues:opened'],
      labelFilter: [],
      mentionOnly: false,
      installationIds: [String(INSTALLATION)],
      ...github
    },
    ...overrides
  }
}

/** A minimal `issues` payload; override to shape other events. */
function issuesPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sender = (overrides.sender as Record<string, unknown> | undefined) ?? { login: 'alice', type: 'User' }
  const issue = {
    number: 42,
    title: 'db down',
    body: 'the primary is unreachable',
    html_url: 'https://github.com/acme/infra/issues/42',
    user: { login: 'alice' },
    author_association: 'MEMBER',
    labels: [{ name: 'bug' }],
    ...((overrides.issue as Record<string, unknown> | undefined) ?? {})
  }
  const commentOverride = overrides.comment as Record<string, unknown> | undefined
  const comment = commentOverride ? { user: { login: sender.login }, ...commentOverride } : undefined
  return {
    action: 'opened',
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: 'acme/infra' },
    sender,
    ...overrides,
    issue,
    ...(comment ? { comment } : {})
  }
}

function pullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: 'acme/infra' },
    sender: { login: 'alice', type: 'User' },
    pull_request: {
      number: 77,
      title: 'tighten retry',
      body: 'please review',
      html_url: 'https://github.com/acme/infra/pull/77',
      user: { login: 'alice' },
      author_association: 'NONE',
      head: { sha: 'a'.repeat(40), repo: { full_name: 'alice/infra' } },
      base: { sha: 'b'.repeat(40), repo: { full_name: 'acme/infra' } },
      draft: false,
      labels: []
    },
    ...overrides
  }
}

function rerequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'rerequested',
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: 'acme/infra' },
    sender: { login: 'alice', type: 'User' },
    check_run: {
      id: 86617583005,
      head_sha: 'a'.repeat(40),
      pull_requests: [
        {
          number: 585,
          head: { sha: 'a'.repeat(40), repo: { id: REPO_ID } },
          base: { sha: 'b'.repeat(40), repo: { id: REPO_ID } }
        }
      ]
    },
    ...overrides
  }
}

function suiteRerequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'rerequested',
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: 'acme/infra' },
    sender: { login: 'alice', type: 'User' },
    check_suite: {
      id: 81913432144,
      head_sha: 'a'.repeat(40),
      app: { id: APP_ID }
    },
    ...overrides
  }
}

function workflowRunPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'in_progress',
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: 'acme/infra' },
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    workflow_run: {
      event: 'pull_request',
      head_sha: 'a'.repeat(40),
      triggering_actor: { login: 'maintainer' },
      pull_requests: []
    },
    ...overrides
  }
}

interface Harness {
  app: FastifyInstance
  table: HookTable
  clock: FakeClock
  sent: RdMsg[]
  dispatches: Array<{ daemonId: string; msg: RdMsg }>
  reports: RcRunReport[]
  doorbells: RcGithubInstallation[]
  authzRequests: RcGithubCommentAuthz[]
  rerequestRequests: RcGithubRerequest[]
  rerequestResult: RcGithubRerequestResult | (() => Promise<RcGithubRerequestResult>)
  authzResult: boolean | ((request: RcGithubCommentAuthz) => boolean | Promise<boolean>)
  ack: RdAck | (() => Promise<RdAck>)
  offline: boolean
  cleanupSupported: boolean
  onlineDaemons: Set<string>
}

function makeHarness(authzCapacity = 20): Harness {
  const clock = new FakeClock()
  const h: Partial<Harness> &
    Pick<
      Harness,
      'sent' | 'dispatches' | 'reports' | 'doorbells' | 'authzRequests' | 'rerequestRequests' | 'onlineDaemons'
    > = {
    sent: [],
    dispatches: [],
    reports: [],
    doorbells: [],
    authzRequests: [],
    rerequestRequests: [],
    authzResult: true,
    rerequestResult: { allowed: false },
    ack: { msgId: 'x', accepted: true },
    offline: false,
    cleanupSupported: true,
    onlineDaemons: new Set([DAEMON])
  }
  const app = Fastify()
  const table = new HookTable()
  registerGithubIngress(app, {
    table,
    daemons: () => ({
      get: (daemonId: string) => {
        if (h.offline || !h.onlineDaemons.has(daemonId)) return undefined
        return {
          supports: (capability: string) => {
            if (capability === RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2) return h.cleanupSupported === true
            return true
          },
          sendMsg: async (msg: RdMsg) => {
            h.sent.push(msg)
            h.dispatches.push({ daemonId, msg })
            return typeof h.ack === 'function' ? h.ack() : h.ack!
          }
        } as never
      }
    }),
    report: (r) => h.reports.push(r),
    doorbell: (p) => h.doorbells.push(p),
    authorizeComment: async (request) => {
      h.authzRequests.push(request)
      return typeof h.authzResult === 'function' ? h.authzResult(request) : h.authzResult!
    },
    authorizeRerequest: async (request) => {
      h.rerequestRequests.push(request)
      return typeof h.rerequestResult === 'function' ? h.rerequestResult() : h.rerequestResult!
    },
    authzLimiter: new HookRateLimiter(clock, { capacity: authzCapacity, refillPerSec: 0 }),
    limiter: new HookRateLimiter(clock, { capacity: 3, refillPerSec: 0 }),
    clock,
    log,
    webhookSecret: () => SECRET
  })
  h.app = app
  h.table = table
  h.clock = clock
  return h as Harness
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

const sign = (payload: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`

describe('github ingress', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  const post = (event: string, body: unknown, opts: { headers?: Record<string, string>; secret?: string } = {}) => {
    const payload = JSON.stringify(body)
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(payload, opts.secret ?? SECRET),
        'x-github-event': event,
        'x-github-delivery': 'gh-delivery-1',
        ...(opts.headers ?? {})
      },
      payload
    })
  }

  it('answers 404 before a startup snapshot supplies the secret', async () => {
    const snapshot: { secret?: string } = {}
    const bare = Fastify()
    registerGithubIngress(bare, {
      table: new HookTable(),
      daemons: () => undefined,
      report: () => {},
      doorbell: () => {},
      authorizeComment: async () => false,
      authorizeRerequest: async () => ({ allowed: false }),
      authzLimiter: new HookRateLimiter(new FakeClock()),
      limiter: new HookRateLimiter(new FakeClock()),
      clock: new FakeClock(),
      log,
      webhookSecret: () => snapshot.secret
    })
    const res = await bare.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json' },
      payload: '{}'
    })
    expect(res.statusCode).toBe(404)
    snapshot.secret = SECRET
    const payload = JSON.stringify({ zen: 'ready' })
    const ready = await bare.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(payload)
      },
      payload
    })
    expect(ready.statusCode).toBe(204)
    await bare.close()
  })

  describe('signature gate', () => {
    it('rejects a wrong-key signature with 401 and emits nothing', async () => {
      h.table.upsert(rule())
      const res = await post('issues', issuesPayload(), { secret: 'ghw_other' })
      expect(res.statusCode).toBe(401)
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
      expect(h.doorbells).toHaveLength(0)
    })

    it('rejects a missing/malformed signature header with 401', async () => {
      const payload = JSON.stringify(issuesPayload())
      for (const headers of [{}, { 'x-hub-signature-256': 'sha1=zz' }]) {
        const res = await h.app.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: { 'content-type': 'application/json', 'x-github-event': 'issues', ...headers },
          payload
        })
        expect(res.statusCode).toBe(401)
      }
    })

    it('a verified ping answers 204 (and an unverified one 401)', async () => {
      expect((await post('ping', { zen: 'Design for failure.' })).statusCode).toBe(204)
      expect((await post('ping', { zen: 'x' }, { secret: 'ghw_other' })).statusCode).toBe(401)
    })
  })

  describe('installation doorbell (decision 11)', () => {
    it('forwards installation events as a poke — no dispatch, no run-report', async () => {
      h.table.upsert(rule())
      for (const [event, action] of [
        ['installation', 'created'],
        ['installation_repositories', 'added']
      ] as const) {
        const res = await post(event, { action, installation: { id: INSTALLATION } })
        expect(res.statusCode).toBe(202)
      }
      await flush()
      expect(h.doorbells).toEqual([
        { installationId: String(INSTALLATION), action: 'created' },
        { installationId: String(INSTALLATION), action: 'added' }
      ])
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })
  })

  describe('check_run rerequest', () => {
    const allowed: RcGithubRerequestResult = {
      allowed: true,
      hookId: HOOK,
      pullNumber: 585,
      configRevision: '3',
      dispatchRevision: '5'
    }
    const allowedWithBase: RcGithubRerequestResult = {
      ...allowed,
      baseSha: 'b'.repeat(40)
    }

    it('asks the CP to resolve the Check id, then dispatches a new metadata-only review generation', async () => {
      h.table.upsert(rule())
      h.rerequestResult = allowed
      h.authzResult = true

      const res = await post('check_run', rerequestPayload())
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ deliveryKey: 'gh-delivery-1' })
      await flush()

      expect(h.rerequestRequests).toEqual([
        {
          checkRunId: '86617583005',
          repoId: String(REPO_ID),
          headSha: 'a'.repeat(40),
          deliveryKey: 'gh-delivery-1'
        }
      ])
      expect(h.authzRequests).toEqual([
        {
          hookId: HOOK,
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          repoFullName: 'acme/infra',
          senderLogin: 'alice',
          configRevision: '3',
          dispatchRevision: '5'
        }
      ])
      expect(h.sent).toHaveLength(1)
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg).toMatchObject({
        hookId: HOOK,
        agentId: AGENT,
        deliveryKey: 'gh-delivery-1',
        msgId: `${HOOK}:gh-delivery-1`,
        sessionKey: 'acme/infra#585',
        event: 'check_run:rerequested',
        github: {
          repoId: String(REPO_ID),
          repoFullName: 'acme/infra',
          sourceInstallationId: String(INSTALLATION),
          subjectKind: 'pull_request',
          pullNumber: 585,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          reportSha: 'a'.repeat(40)
        },
        context: {
          source: 'github',
          event: 'check_run',
          action: 'rerequested',
          repo: 'acme/infra',
          number: 585,
          senderLogin: 'alice',
          truncated: false
        }
      })
      expect(h.reports).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          deliveryKey: 'gh-delivery-1',
          event: 'check_run:rerequested',
          status: 'accepted',
          github: msg.github
        })
      ])
    })

    it('accepts the first-review Check action even when GitHub omits fork PR associations', async () => {
      h.table.upsert(rule())
      h.rerequestResult = allowedWithBase
      h.authzResult = true

      await post(
        'check_run',
        rerequestPayload({
          action: 'requested_action',
          requested_action: { identifier: GITHUB_REQUEST_REVIEW_ACTION },
          check_run: {
            id: 86617583005,
            head_sha: 'a'.repeat(40),
            pull_requests: []
          }
        })
      )
      await flush()

      expect(h.rerequestRequests).toEqual([
        {
          checkRunId: '86617583005',
          repoId: String(REPO_ID),
          headSha: 'a'.repeat(40),
          deliveryKey: 'gh-delivery-1',
          includeBaseSha: true
        }
      ])
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]).toMatchObject({
        event: 'check_run:requested_action',
        github: {
          pullNumber: 585,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40)
        },
        context: { event: 'check_run', action: 'requested_action' }
      })
    })

    it('fails closed for an unowned Check, stale rule, malformed payload, or unavailable CP', async () => {
      h.table.upsert(rule())

      await post('check_run', rerequestPayload())
      await flush()
      expect(h.sent).toHaveLength(0)

      h.rerequestResult = { ...allowed, configRevision: '4' }
      await post('check_run', rerequestPayload())
      await flush()
      expect(h.sent).toHaveLength(0)

      const callsBeforeMalformed = h.rerequestRequests.length
      await post('check_run', rerequestPayload({ check_run: { id: 0, head_sha: 'a'.repeat(40) } }))
      await flush()
      expect(h.rerequestRequests).toHaveLength(callsBeforeMalformed)

      h.rerequestResult = async () => {
        throw new Error('CP unavailable')
      }
      await post('check_run', rerequestPayload())
      await flush()
      expect(h.sent).toHaveLength(0)

      h.rerequestResult = allowed
      await post(
        'check_run',
        rerequestPayload({
          check_run: {
            id: 86617583005,
            head_sha: 'a'.repeat(40),
            pull_requests: [
              {
                number: 585,
                head: { sha: 'a'.repeat(40), repo: { id: REPO_ID + 1 } },
                base: { sha: 'b'.repeat(40), repo: { id: REPO_ID } }
              }
            ]
          }
        })
      )
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('exhausts the authorization budget before doing another CP projection lookup', async () => {
      await h.app.close()
      h = makeHarness(3)
      h.table.upsert(rule())

      for (let i = 0; i < 4; i++) {
        await post('check_run', rerequestPayload(), {
          headers: { 'x-github-delivery': `rerun-budget-${i}` }
        })
      }
      await flush()

      expect(h.rerequestRequests).toHaveLength(3)
      expect(h.rerequestRequests.map((request) => request.deliveryKey)).toEqual([
        'rerun-budget-0',
        'rerun-budget-1',
        'rerun-budget-2'
      ])
      expect(h.sent).toHaveLength(0)
    })
  })

  describe('check_suite rerequest', () => {
    it('resolves the App suite once, authorizes the complete fan-out, and dispatches every target', async () => {
      h.table.upsert(rule())
      h.table.upsert(
        rule({
          hookId: HOOK_B,
          agentId: AGENT_B,
          daemonId: DAEMON_B,
          dispatchDaemonId: DAEMON_B,
          configRevision: '4',
          dispatchRevision: '6'
        })
      )
      h.onlineDaemons.add(DAEMON_B)
      h.rerequestResult = {
        allowed: true,
        targets: [
          {
            hookId: HOOK,
            pullNumber: 585,
            baseSha: 'b'.repeat(40),
            configRevision: '3',
            dispatchRevision: '5'
          },
          {
            hookId: HOOK_B,
            pullNumber: 586,
            baseSha: 'c'.repeat(40),
            configRevision: '4',
            dispatchRevision: '6'
          }
        ]
      }
      h.authzResult = true

      const res = await post('check_suite', suiteRerequestPayload())
      expect(res.statusCode).toBe(202)
      await flush()

      expect(h.rerequestRequests).toEqual([
        {
          scope: 'suite',
          appId: String(APP_ID),
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          headSha: 'a'.repeat(40),
          deliveryKey: 'gh-delivery-1'
        }
      ])
      expect(h.authzRequests).toEqual([
        {
          hookId: HOOK,
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          repoFullName: 'acme/infra',
          senderLogin: 'alice',
          configRevision: '3',
          dispatchRevision: '5',
          siblingFences: [{ hookId: HOOK_B, configRevision: '4', dispatchRevision: '6' }]
        }
      ])
      expect(h.sent).toHaveLength(2)
      expect(h.sent).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          agentId: AGENT,
          sessionKey: 'acme/infra#585',
          event: 'check_suite:rerequested',
          context: expect.objectContaining({ event: 'check_suite', action: 'rerequested', number: 585 }),
          github: expect.objectContaining({ pullNumber: 585, baseSha: 'b'.repeat(40) })
        }),
        expect.objectContaining({
          hookId: HOOK_B,
          agentId: AGENT_B,
          sessionKey: 'acme/infra#586',
          event: 'check_suite:rerequested',
          context: expect.objectContaining({ event: 'check_suite', action: 'rerequested', number: 586 }),
          github: expect.objectContaining({ pullNumber: 586, baseSha: 'c'.repeat(40) })
        })
      ])
      expect(h.reports.map((report) => report.event)).toEqual(['check_suite:rerequested', 'check_suite:rerequested'])
    })

    it('fails closed before the CP lookup when suite identity is malformed', async () => {
      await post('check_suite', suiteRerequestPayload({ check_suite: { id: 0, app: { id: APP_ID } } }))
      await flush()
      expect(h.rerequestRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
    })
  })

  describe('workflow approval', () => {
    it('preserves GitHub signed PR identity when the workflow payload supplies it', async () => {
      await post(
        'workflow_run',
        workflowRunPayload({
          workflow_run: {
            event: 'pull_request',
            head_sha: 'a'.repeat(40),
            triggering_actor: { login: 'maintainer' },
            pull_requests: [{ number: 585, head: { sha: 'a'.repeat(40) } }]
          }
        })
      )
      await flush()

      expect(h.rerequestRequests).toEqual([expect.objectContaining({ scope: 'workflow', pullNumber: 585 })])
    })

    it('authorizes the triggering maintainer and starts every waiting external-PR review', async () => {
      h.table.upsert(rule({ reportingMode: 'off' }))
      h.table.upsert(
        rule({
          hookId: HOOK_B,
          agentId: AGENT_B,
          daemonId: DAEMON_B,
          dispatchDaemonId: DAEMON_B,
          configRevision: '4',
          dispatchRevision: '6'
        })
      )
      h.onlineDaemons.add(DAEMON_B)
      h.rerequestResult = {
        allowed: true,
        targets: [
          {
            hookId: HOOK,
            pullNumber: 585,
            baseSha: 'b'.repeat(40),
            configRevision: '3',
            dispatchRevision: '5'
          },
          {
            hookId: HOOK_B,
            pullNumber: 585,
            baseSha: 'b'.repeat(40),
            configRevision: '4',
            dispatchRevision: '6'
          }
        ]
      }

      const res = await post('workflow_run', workflowRunPayload())
      expect(res.statusCode).toBe(202)
      await flush()

      expect(h.rerequestRequests).toEqual([
        {
          scope: 'workflow',
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          headSha: 'a'.repeat(40),
          deliveryKey: 'gh-delivery-1'
        }
      ])
      expect(h.authzRequests).toEqual([
        {
          hookId: HOOK,
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          repoFullName: 'acme/infra',
          senderLogin: 'maintainer',
          configRevision: '3',
          dispatchRevision: '5',
          siblingFences: [{ hookId: HOOK_B, configRevision: '4', dispatchRevision: '6' }]
        }
      ])
      const stableDeliveryKey = `workflow-approval:${REPO_ID}:585:${'a'.repeat(40)}`
      expect(h.sent).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          deliveryKey: stableDeliveryKey,
          msgId: `${HOOK}:${stableDeliveryKey}`,
          event: 'workflow_run:in_progress',
          github: expect.objectContaining({ pullNumber: 585, explicitReviewRequest: true }),
          context: expect.objectContaining({
            event: 'workflow_run',
            action: 'in_progress',
            senderLogin: 'maintainer'
          })
        }),
        expect.objectContaining({
          hookId: HOOK_B,
          deliveryKey: stableDeliveryKey,
          msgId: `${HOOK_B}:${stableDeliveryKey}`,
          event: 'workflow_run:in_progress',
          github: expect.objectContaining({ pullNumber: 585, explicitReviewRequest: true })
        })
      ])
    })

    it('ignores workflow runs that are not a pull-request workflow start', async () => {
      await post('workflow_run', workflowRunPayload({ action: 'completed' }))
      await post('workflow_run', workflowRunPayload({ workflow_run: { event: 'push', head_sha: 'a'.repeat(40) } }))
      await flush()
      expect(h.rerequestRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
    })
  })

  describe('matching', () => {
    it('an exact event:action hit fires the daemon with the perThread sessionKey', async () => {
      h.table.upsert(rule())
      const res = await post('issues', issuesPayload())
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ deliveryKey: 'gh-delivery-1' })
      await flush()
      expect(h.sent).toHaveLength(1)
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg).toMatchObject({
        agentId: AGENT,
        hookId: HOOK,
        deliveryKey: 'gh-delivery-1',
        msgId: `${HOOK}:gh-delivery-1`,
        sessionKey: 'acme/infra#42',
        configRevision: '3',
        dispatchRevision: '5',
        dispatchDaemonId: DAEMON,
        reviewPolicy: 'full',
        reportingMode: 'check',
        gateMode: 'informational'
      })
      expect(msg.github).toEqual({
        repoId: String(REPO_ID),
        repoFullName: 'acme/infra',
        sourceInstallationId: String(INSTALLATION),
        subjectKind: 'issue'
      })
      expect(msg.context).toMatchObject({
        source: 'github',
        event: 'issues',
        action: 'opened',
        repo: 'acme/infra',
        number: 42,
        title: 'db down',
        senderLogin: 'alice',
        authorAssociation: 'MEMBER',
        labels: ['bug'],
        htmlUrl: 'https://github.com/acme/infra/issues/42',
        bodyExcerpt: 'the primary is unreachable',
        truncated: false
      })
      // The run-report carries the event:action metadata for the HookRun row.
      expect(h.reports).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          status: 'accepted',
          event: 'issues:opened',
          daemonId: DAEMON,
          configRevision: '3',
          dispatchRevision: '5',
          dispatchDaemonId: DAEMON,
          github: msg.github
        })
      ])
    })

    it('keeps the signed GitHub envelope stable while a retry follows a fenced placement move', async () => {
      h.table.upsert(rule({ target: { platform: 'slack', channel: 'C123' } }, { sessionKeyPrefix: undefined }))
      h.offline = true
      const res = await post('issues', issuesPayload(), {
        headers: { 'x-github-delivery': 'gh-placement-move' }
      })
      expect(res.statusCode).toBe(202)
      expect(h.reports).toHaveLength(0)

      h.table.upsert(
        rule(
          {
            daemonId: DAEMON_B,
            dispatchDaemonId: DAEMON_B,
            dispatchRevision: '6',
            target: { platform: 'slack', channel: 'C123' }
          },
          { repoFullName: 'acme/infra-renamed' }
        )
      )
      h.onlineDaemons.add(DAEMON_B)
      h.offline = false
      h.clock.advance(1_000)
      await flush()

      expect(h.dispatches).toHaveLength(1)
      const { daemonId, msg } = h.dispatches[0]!
      expect(daemonId).toBe(DAEMON_B)
      expect(msg).toMatchObject({
        hookId: HOOK,
        deliveryKey: 'gh-placement-move',
        msgId: `${HOOK}:gh-placement-move`,
        sessionKey: 'acme/infra#42',
        event: 'issues:opened',
        configRevision: '3',
        dispatchRevision: '6',
        dispatchDaemonId: DAEMON_B,
        target: { platform: 'slack', channel: 'C123' }
      })
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.github).toEqual({
        repoId: String(REPO_ID),
        repoFullName: 'acme/infra',
        sourceInstallationId: String(INSTALLATION),
        subjectKind: 'issue'
      })
      expect(msg.context).toMatchObject({
        source: 'github',
        event: 'issues',
        action: 'opened',
        number: 42,
        bodyExcerpt: 'the primary is unreachable'
      })
      expect(h.reports).toEqual([
        expect.objectContaining({
          status: 'accepted',
          daemonId: DAEMON_B,
          dispatchRevision: '6',
          dispatchDaemonId: DAEMON_B,
          github: msg.github
        })
      ])
    })

    it('propagates trusted PR revision facts to both rd/msg and rc/run-report', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:*'] }))
      h.authzResult = true
      const headSha = 'a'.repeat(40)
      const baseSha = 'b'.repeat(40)
      await post('pull_request', {
        action: 'synchronize',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra-renamed' },
        sender: { login: 'alice', type: 'User' },
        pull_request: {
          number: 77,
          title: 'tighten retry',
          user: { login: 'alice' },
          author_association: 'MEMBER',
          head: { sha: headSha, repo: { full_name: 'alice/infra' } },
          base: { sha: baseSha, repo: { full_name: 'acme/infra-renamed' } },
          merge_commit_sha: 'c'.repeat(40),
          draft: false,
          labels: []
        }
      })
      await flush()

      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.event).toBe('pull_request:synchronize')
      expect(msg.sessionKey).toBe('acme/infra#77')
      expect(msg.github).toEqual({
        repoId: String(REPO_ID),
        repoFullName: 'acme/infra-renamed',
        sourceInstallationId: String(INSTALLATION),
        subjectKind: 'pull_request',
        pullNumber: 77,
        headSha,
        baseSha,
        reportSha: headSha,
        headRepoFullName: 'alice/infra',
        mergeCommitSha: 'c'.repeat(40),
        isDraft: false
      })
      expect(h.reports[0]).toMatchObject({
        event: 'pull_request:synchronize',
        github: msg.github,
        configRevision: '3',
        dispatchRevision: '5',
        dispatchDaemonId: DAEMON
      })
    })

    it.each(['opened', 'synchronize'] as const)(
      'keeps an external PR %s out of the daemon and publishes the manual-request Check intent',
      async (action) => {
        h.table.upsert(rule({}, { events: ['pull_request:*'], appSlug: 'example-review-app' }))
        h.authzResult = false

        await post('pull_request', pullPayload({ action }))
        await flush()

        expect(h.authzRequests).toEqual([
          expect.objectContaining({
            repoId: String(REPO_ID),
            senderLogin: 'alice'
          })
        ])
        expect(h.sent).toHaveLength(0)
        expect(h.reports).toEqual([
          expect.objectContaining({
            hookId: HOOK,
            event: `pull_request:${action}`,
            status: 'failed',
            reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
            github: expect.objectContaining({
              subjectKind: 'pull_request',
              pullNumber: 77,
              headSha: 'a'.repeat(40),
              baseSha: 'b'.repeat(40)
            })
          })
        ])
      }
    )

    it.each(['opened', 'synchronize'] as const)(
      'dispatches a same-repository PR %s authored by this App without human-author authorization',
      async (action) => {
        h.table.upsert(rule({}, { events: ['pull_request:*'], appSlug: 'example-review-app' }))
        h.authzResult = false
        const pullRequest = pullPayload().pull_request as Record<string, unknown>
        const appBot = 'example-review-app[bot]'

        await post(
          'pull_request',
          pullPayload({
            action,
            sender: { login: 'release-manager', type: 'User' },
            pull_request: {
              ...pullRequest,
              user: { login: appBot, type: 'Bot' },
              head: { sha: 'a'.repeat(40), repo: { full_name: 'acme/infra' } },
              base: { sha: 'b'.repeat(40), repo: { full_name: 'acme/infra' } }
            }
          })
        )
        await flush()

        expect(h.authzRequests).toHaveLength(0)
        expect(h.sent).toHaveLength(1)
        expect(h.sent[0]).toMatchObject({ event: `pull_request:${action}`, agentId: AGENT })
        expect(h.reports).toEqual([expect.objectContaining({ status: 'accepted' })])
      }
    )

    it('keeps an App-authored fork PR behind the workflow-approval marker', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:*'], appSlug: 'example-review-app' }))
      h.authzResult = false
      const pullRequest = pullPayload().pull_request as Record<string, unknown>

      await post(
        'pull_request',
        pullPayload({
          sender: { login: 'example-review-app[bot]', type: 'Bot' },
          pull_request: {
            ...pullRequest,
            user: { login: 'example-review-app[bot]', type: 'Bot' },
            head: { sha: 'a'.repeat(40), repo: { full_name: 'example-fork/infra' } },
            base: { sha: 'b'.repeat(40), repo: { full_name: 'acme/infra' } }
          }
        })
      )
      await flush()

      expect(h.authzRequests).toEqual([expect.objectContaining({ senderLogin: 'example-review-app[bot]' })])
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toEqual([
        expect.objectContaining({ reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED, status: 'failed' })
      ])
    })

    it.each(['OWNER', 'MEMBER', 'COLLABORATOR'] as const)(
      'live-checks a PR author even when the payload association is %s',
      async (authorAssociation) => {
        h.table.upsert(rule({}, { events: ['pull_request:*'] }))
        const pullRequest = pullPayload().pull_request as Record<string, unknown>

        await post(
          'pull_request',
          pullPayload({
            pull_request: {
              ...pullRequest,
              author_association: authorAssociation
            }
          })
        )
        await flush()

        expect(h.authzRequests).toEqual([expect.objectContaining({ senderLogin: 'alice' })])
        expect(h.sent).toHaveLength(1)
        expect(h.reports).toEqual([expect.objectContaining({ status: 'accepted' })])
      }
    )

    it('live-checks a PR author once before dispatching the complete fan-out', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:*'] }))
      h.table.upsert(
        rule(
          {
            hookId: HOOK_B,
            agentId: AGENT_B,
            daemonId: DAEMON_B,
            dispatchDaemonId: DAEMON_B
          },
          { events: ['pull_request:*'] }
        )
      )
      h.onlineDaemons.add(DAEMON_B)
      const pullRequest = pullPayload().pull_request as Record<string, unknown>

      await post(
        'pull_request',
        pullPayload({
          pull_request: {
            ...pullRequest,
            author_association: 'MEMBER'
          }
        })
      )
      await flush()

      expect(h.authzRequests).toEqual([
        expect.objectContaining({
          senderLogin: 'alice',
          siblingFences: [{ hookId: HOOK_B, configRevision: '3', dispatchRevision: '5' }]
        })
      ])
      expect(h.sent).toHaveLength(2)
      expect(h.reports).toHaveLength(2)
      expect(h.reports.every((report) => report.status === 'accepted')).toBe(true)
    })

    it('resolves a stale NONE association once before dispatching the complete PR fan-out', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:*'] }))
      h.table.upsert(
        rule(
          {
            hookId: HOOK_B,
            agentId: AGENT_B,
            daemonId: DAEMON_B,
            dispatchDaemonId: DAEMON_B
          },
          { events: ['pull_request:*'] }
        )
      )
      h.onlineDaemons.add(DAEMON_B)
      h.authzResult = true
      const pullRequest = pullPayload().pull_request as Record<string, unknown>

      await post(
        'pull_request',
        pullPayload({
          sender: { login: 'release-manager', type: 'User' },
          pull_request: { ...pullRequest, user: { login: 'pr-author' } }
        })
      )
      await flush()

      expect(h.authzRequests).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          repoId: String(REPO_ID),
          senderLogin: 'pr-author',
          siblingFences: [{ hookId: HOOK_B, configRevision: '3', dispatchRevision: '5' }]
        })
      ])
      expect(h.sent).toHaveLength(2)
      expect(h.reports).toHaveLength(2)
      expect(h.reports.every((report) => report.status === 'accepted')).toBe(true)
    })

    it('does not trust a PR-body mention from an external author, while the existing maintainer mention still fires', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['pull_request:opened'],
            commentFamilies: ['pull_request'],
            appSlug: 'example-review-app'
          }
        )
      )
      const external = pullPayload()
      const externalSubject = external.pull_request as Record<string, unknown>
      externalSubject.body = '@example-review-app please review'
      h.authzResult = false

      await post('pull_request', external, { headers: { 'x-github-delivery': 'external-body-mention' } })
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports[0]).toMatchObject({
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
      })
      h.authzResult = true

      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 77, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/77' } },
          comment: { body: '@example-review-app please review', author_association: 'MEMBER' }
        }),
        { headers: { 'x-github-delivery': 'maintainer-mention' } }
      )
      await flush()

      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]).toMatchObject({
        event: 'issue_comment:created',
        sessionKey: 'acme/infra#77',
        github: { explicitReviewRequest: true }
      })
    })

    it('keeps the PR mention trigger while formal reviews are off', async () => {
      h.table.upsert(
        rule(
          { reviewPolicy: 'off', reportingMode: 'off' },
          {
            events: ['issue_comment:created'],
            commentFamilies: ['pull_request'],
            mentionOnly: true,
            appSlug: 'example-review-app'
          }
        )
      )

      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 77, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/77' } },
          comment: { body: '@example-review-app fix the failing test', author_association: 'MEMBER' }
        })
      )
      await flush()

      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]).toMatchObject({
        event: 'issue_comment:created',
        sessionKey: 'acme/infra#77',
        reviewPolicy: 'off',
        reportingMode: 'off'
      })
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.github?.explicitReviewRequest).toBeUndefined()
      expect(h.reports).toEqual([expect.objectContaining({ status: 'accepted', reviewPolicy: 'off' })])
    })

    it('treats a native App reviewer request as an explicit maintainer trigger', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:opened'], appSlug: 'example-review-app' }))
      h.authzResult = true

      await post(
        'pull_request',
        pullPayload({
          action: 'review_requested',
          requested_reviewer: { login: 'example-review-app[bot]', type: 'Bot' }
        })
      )
      await flush()

      expect(h.authzRequests).toHaveLength(1)
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]).toMatchObject({
        event: 'pull_request:review_requested',
        github: { pullNumber: 77, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }
      })
    })

    it('ignores reviewer requests for anyone other than the configured App bot', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:*'], appSlug: 'example-review-app' }))
      h.authzResult = true

      await post(
        'pull_request',
        pullPayload({
          action: 'review_requested',
          requested_reviewer: { login: 'some-human', type: 'User' }
        })
      )
      await flush()

      expect(h.authzRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('does not let an App reviewer request cross an issues-only hook boundary', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['issues:*', 'issue_comment:created'],
            commentFamilies: ['issues'],
            appSlug: 'example-review-app'
          }
        )
      )
      h.authzResult = true

      await post(
        'pull_request',
        pullPayload({
          action: 'review_requested',
          requested_reviewer: { login: 'example-review-app[bot]', type: 'Bot' }
        })
      )
      await flush()

      expect(h.authzRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
    })

    it('silences all PR edits, including base-branch retargets', async () => {
      h.table.upsert(rule({}, { events: ['pull_request:edited'] }))
      const basePayload = {
        action: 'edited',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' },
        pull_request: {
          number: 77,
          head: { sha: 'a'.repeat(40), repo: { full_name: 'alice/infra' } },
          base: { sha: 'b'.repeat(40), repo: { full_name: 'acme/infra' } },
          labels: []
        }
      }
      await post(
        'pull_request',
        { ...basePayload, changes: { title: { from: 'old' } } },
        {
          headers: { 'x-github-delivery': 'edited-title' }
        }
      )
      await post(
        'pull_request',
        { ...basePayload, changes: { base: { ref: { from: 'develop' } } } },
        {
          headers: { 'x-github-delivery': 'edited-base' }
        }
      )
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('identifies a PR issue_comment but leaves revision unresolved for hook/start', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'], commentFamilies: ['pull_request'] }))
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment: { body: 'please review', author_association: 'MEMBER' }
        })
      )
      await flush()
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.github).toEqual({
        repoId: String(REPO_ID),
        repoFullName: 'acme/infra',
        sourceInstallationId: String(INSTALLATION),
        subjectKind: 'pull_request',
        pullNumber: 43
      })
      expect(msg.github?.headSha).toBeUndefined()
      expect(h.reports[0]?.github).toEqual(msg.github)
    })

    it('fails closed when a rolling rule lacks the complete dispatch fence', async () => {
      h.table.upsert(
        rule({
          configRevision: undefined,
          dispatchRevision: undefined,
          dispatchDaemonId: undefined,
          reviewPolicy: 'full',
          reportingMode: 'check'
        })
      )
      await post('issues', issuesPayload())
      await flush()
      expect(h.authzRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('event:* wildcard matches every action of the family', async () => {
      h.table.upsert(rule({}, { events: ['issues:*'] }))
      await post('issues', issuesPayload({ action: 'labeled' }))
      await flush()
      expect(h.sent).toHaveLength(1)
    })

    it('dispatches issue close/delete and merged PR as workspace-cleanup lifecycle fires', async () => {
      h.table.upsert(rule({}, { events: [] }))
      const merged = pullPayload({ action: 'closed' })
      ;(merged.pull_request as Record<string, unknown>).merged = true

      expect(
        (
          await post('issues', issuesPayload({ action: 'closed' }), {
            headers: { 'x-github-delivery': 'issue-closed' }
          })
        ).statusCode
      ).toBe(202)
      expect(
        (
          await post('issues', issuesPayload({ action: 'deleted' }), {
            headers: { 'x-github-delivery': 'issue-deleted' }
          })
        ).statusCode
      ).toBe(202)
      expect(
        (
          await post('pull_request', merged, {
            headers: { 'x-github-delivery': 'pr-merged' }
          })
        ).statusCode
      ).toBe(202)

      await flush()
      const hooks = h.sent.filter((msg) => msg.source === 'hook')
      expect(hooks).toHaveLength(3)
      expect(hooks[0]).toMatchObject({
        sessionKey: 'acme/infra#42',
        event: 'issues:closed',
        github: { subjectKind: 'issue' },
        context: { event: 'issues', action: 'closed' }
      })
      expect(hooks[1]).toMatchObject({
        sessionKey: 'acme/infra#42',
        event: 'issues:deleted',
        github: { subjectKind: 'issue' },
        context: { event: 'issues', action: 'deleted' }
      })
      expect(hooks[2]).toMatchObject({
        sessionKey: 'acme/infra#77',
        event: 'pull_request:merged',
        github: { subjectKind: 'pull_request', pullNumber: 77 },
        context: { event: 'pull_request', action: 'closed' }
      })
      expect(h.authzRequests).toHaveLength(0)
    })

    it.each(['closed', 'deleted'] as const)(
      'does not send issue %s cleanup to a daemon without the lifecycle cleanup capability',
      async (action) => {
        h.table.upsert(rule({}, { events: [] }))
        h.cleanupSupported = false

        expect((await post('issues', issuesPayload({ action }))).statusCode).toBe(202)
        await flush()

        expect(h.sent).toHaveLength(0)
        expect(h.reports).toContainEqual(
          expect.objectContaining({ event: `issues:${action}`, status: 'failed', reason: 'rejected:unsupported' })
        )
      }
    )

    it('silently ignores issue metadata edits/reopen and unmerged PR close/reopen noise', async () => {
      h.table.upsert(rule({}, { events: ['issues:*', 'pull_request:*'] }))

      expect((await post('issues', issuesPayload({ action: 'reopened' }))).statusCode).toBe(202)
      expect(
        (await post('issues', issuesPayload({ action: 'edited', changes: { body: { from: 'old instructions' } } })))
          .statusCode
      ).toBe(202)
      expect(
        (
          await post(
            'pull_request',
            issuesPayload({
              action: 'closed',
              issue: undefined,
              pull_request: {
                number: 43,
                title: 'fix replication',
                body: 'ready for review',
                html_url: 'https://github.com/acme/infra/pull/43',
                author_association: 'MEMBER',
                labels: [{ name: 'bug' }]
              }
            })
          )
        ).statusCode
      ).toBe(202)
      expect(
        (
          await post(
            'pull_request',
            issuesPayload({
              action: 'reopened',
              issue: undefined,
              pull_request: {
                number: 43,
                title: 'fix replication',
                body: 'ready for review',
                html_url: 'https://github.com/acme/infra/pull/43',
                author_association: 'MEMBER',
                labels: [{ name: 'bug' }]
              }
            })
          )
        ).statusCode
      ).toBe(202)

      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('an action miss / unknown repo / unsubscribed event all answer 202 with no fire', async () => {
      h.table.upsert(rule())
      expect((await post('issues', issuesPayload({ action: 'reopened' }))).statusCode).toBe(202)
      expect((await post('issues', issuesPayload({ repository: { id: 1, full_name: 'x/y' } }))).statusCode).toBe(202)
      expect((await post('release', { action: 'published' })).statusCode).toBe(202)
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('the attribution gate vetoes a foreign or absent installation (decision 6)', async () => {
      h.table.upsert(rule())
      await post('issues', issuesPayload({ installation: { id: 999 } }))
      await post('issues', issuesPayload({ installation: undefined }))
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('labelFilter requires an intersection with the subject CURRENT labels', async () => {
      h.table.upsert(rule({}, { labelFilter: ['p0', 'bug'] }))
      await post('issues', issuesPayload()) // labels: [bug] — hit
      await post('issues', issuesPayload({ issue: { number: 42, labels: [{ name: 'docs' }] } })) // miss
      await flush()
      expect(h.sent).toHaveLength(1)
    })

    it('a [bot] sender is vetoed even on a full match (decision 10)', async () => {
      h.table.upsert(rule())
      await post('issues', issuesPayload({ sender: { login: 'agent[bot]', type: 'Bot' } }))
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('issue_comment sources body/url/association from the comment and continues the thread session', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          comment: {
            body: 'try staging only',
            html_url: 'https://github.com/acme/infra/issues/42#issuecomment-1',
            author_association: 'COLLABORATOR'
          }
        })
      )
      await flush()
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.sessionKey).toBe('acme/infra#42')
      expect(msg.context).toMatchObject({
        bodyExcerpt: 'try staging only',
        htmlUrl: 'https://github.com/acme/infra/issues/42#issuecomment-1',
        authorAssociation: 'COLLABORATOR'
      })
    })

    it('issue_comment stays inside the issue family selected alongside the shared comment event', async () => {
      h.table.upsert(rule({}, { events: ['issues:*', 'issue_comment:created'], commentFamilies: ['issues'] }))
      const comment = { body: 'please investigate', author_association: 'MEMBER' }

      await post('issue_comment', issuesPayload({ action: 'created', comment }), {
        headers: { 'x-github-delivery': 'issue-comment' }
      })
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment
        }),
        { headers: { 'x-github-delivery': 'pr-comment' } }
      )
      await flush()

      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]?.sessionKey).toBe('acme/infra#42')
    })

    it('issue_comment stays inside the pull-request family selected alongside the shared comment event', async () => {
      h.table.upsert(
        rule({}, { events: ['pull_request:*', 'issue_comment:created'], commentFamilies: ['pull_request'] })
      )
      const comment = { body: 'please investigate', author_association: 'MEMBER' }

      await post('issue_comment', issuesPayload({ action: 'created', comment }), {
        headers: { 'x-github-delivery': 'issue-comment' }
      })
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment
        }),
        { headers: { 'x-github-delivery': 'pr-comment' } }
      )
      await flush()

      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]?.sessionKey).toBe('acme/infra#43')
    })

    it('a legacy mixed API rule without explicit commentFamilies remains repo-wide', async () => {
      h.table.upsert(rule({}, { events: ['issues:*', 'issue_comment:created'] }))
      const comment = { body: 'please investigate', author_association: 'MEMBER' }

      await post('issue_comment', issuesPayload({ action: 'created', comment }), {
        headers: { 'x-github-delivery': 'issue-comment' }
      })
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment
        }),
        { headers: { 'x-github-delivery': 'pr-comment' } }
      )
      await flush()

      expect(h.sent.map((m) => m.sessionKey)).toEqual(['acme/infra#42', 'acme/infra#43'])
    })

    it('an explicit scope containing both thread families accepts both comment subjects', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['issues:*', 'pull_request:*', 'issue_comment:created'],
            commentFamilies: ['issues', 'pull_request']
          }
        )
      )
      const comment = { body: 'please investigate', author_association: 'MEMBER' }

      await post('issue_comment', issuesPayload({ action: 'created', comment }), {
        headers: { 'x-github-delivery': 'issue-comment' }
      })
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment
        }),
        { headers: { 'x-github-delivery': 'pr-comment' } }
      )
      await flush()

      expect(h.sent.map((m) => m.sessionKey)).toEqual(['acme/infra#42', 'acme/infra#43'])
    })

    it('keeps an external Issue out of the daemon until a live maintainer explicitly summons the agent', async () => {
      h.table.upsert(
        rule({}, { events: ['issues:*', 'issue_comment:created'], commentFamilies: ['issues'], appSlug: 'example-app' })
      )
      h.authzResult = (request) => request.senderLogin === 'maintainer'

      await post(
        'issues',
        issuesPayload({
          sender: { login: 'external-author', type: 'User' },
          issue: {
            number: 43,
            user: { login: 'external-author' },
            body: '@example-app please investigate',
            author_association: 'MEMBER'
          }
        }),
        { headers: { 'x-github-delivery': 'external-issue' } }
      )
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.authzRequests).toEqual([expect.objectContaining({ senderLogin: 'external-author' })])

      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          sender: { login: 'maintainer', type: 'User' },
          issue: { number: 43, user: { login: 'external-author' } },
          comment: { body: '@example-app please investigate', author_association: 'MEMBER' }
        }),
        { headers: { 'x-github-delivery': 'maintainer-summon' } }
      )
      await flush()

      expect(h.sent).toHaveLength(1)
      expect(h.authzRequests[1]).toEqual(expect.objectContaining({ senderLogin: 'maintainer' }))
      expect(h.authzRequests[1]?.subjectAuthorLogin).toBeUndefined()
    })

    it('requires both live commenter and thread-author authority for an unmentioned follow-up', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'], appSlug: 'example-app' }))
      h.authzResult = (request) => request.subjectAuthorLogin === undefined

      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          sender: { login: 'maintainer', type: 'User' },
          issue: { number: 43, user: { login: 'external-author' } },
          comment: { body: 'ordinary follow-up', author_association: 'MEMBER' }
        })
      )
      await flush()

      expect(h.authzRequests).toEqual([
        expect.objectContaining({ senderLogin: 'maintainer', subjectAuthorLogin: 'external-author' })
      ])
      expect(h.sent).toHaveLength(0)
    })

    it('rejects deleted comment content before live authorization', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:*'], appSlug: 'example-app' }))
      h.authzResult = (request) => request.senderLogin === 'maintainer'

      await post(
        'issue_comment',
        issuesPayload({
          action: 'deleted',
          sender: { login: 'maintainer', type: 'User' },
          comment: {
            user: { login: 'external-commenter' },
            body: '@example-app run these instructions',
            author_association: 'NONE'
          }
        })
      )
      await flush()

      expect(h.authzRequests).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
    })

    it('live-checks comments regardless of OWNER/MEMBER/COLLABORATOR association', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      for (const [i, assoc] of ['OWNER', 'MEMBER', 'COLLABORATOR'].entries()) {
        await post(
          'issue_comment',
          issuesPayload({ action: 'created', comment: { body: 'ship it', author_association: assoc } }),
          { headers: { 'x-github-delivery': `trusted-${i}` } }
        )
      }
      await flush()
      expect(h.sent).toHaveLength(3)
      expect(h.authzRequests).toHaveLength(3)
    })

    it.each(['issue_comment', 'pull_request_review_comment'] as const)(
      '%s uses live authorization for an untrusted payload association',
      async (event) => {
        h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
        const body =
          event === 'issue_comment'
            ? issuesPayload({
                action: 'created',
                comment: {
                  user: { login: 'alice' },
                  body: 'please retry',
                  author_association: 'CONTRIBUTOR'
                }
              })
            : {
                action: 'created',
                installation: { id: INSTALLATION },
                repository: { id: REPO_ID, full_name: 'acme/infra' },
                sender: { login: 'alice', type: 'User' },
                pull_request: { number: 7, user: { login: 'alice' } },
                comment: {
                  user: { login: 'alice' },
                  body: 'please retry',
                  author_association: 'CONTRIBUTOR'
                }
              }

        h.authzResult = true
        expect((await post(event, body, { headers: { 'x-github-delivery': `${event}-allow` } })).statusCode).toBe(202)
        await flush()
        expect(h.sent).toHaveLength(1)
        expect(h.authzRequests[0]).toEqual({
          hookId: HOOK,
          installationId: String(INSTALLATION),
          repoId: String(REPO_ID),
          repoFullName: 'acme/infra',
          senderLogin: 'alice',
          configRevision: '3',
          dispatchRevision: '5'
        })
      }
    )

    it('fails closed when the live permission lookup errors', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      h.authzResult = async () => {
        throw new Error('CP unavailable')
      }

      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          comment: { body: 'please retry', author_association: 'CONTRIBUTOR' }
        })
      )
      await flush()
      expect(h.authzRequests).toHaveLength(1)
      expect(h.sent).toHaveLength(0)
    })

    it('does not dispatch a stale rule when the hook changes while authz is pending', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      let resolveAuthz!: (allowed: boolean) => void
      h.authzResult = () =>
        new Promise<boolean>((resolve) => {
          resolveAuthz = resolve
        })

      const response = await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          comment: { body: 'please retry', author_association: 'CONTRIBUTOR' }
        })
      )
      expect(response.statusCode).toBe(202)
      expect(h.authzRequests).toHaveLength(1)

      h.table.upsert(rule({ configRevision: '4' }, { events: ['issue_comment:created'] }))
      resolveAuthz(true)
      await flush()
      expect(h.sent).toHaveLength(0)
      expect(h.reports).toHaveLength(0)
    })

    it('batches matching hooks into one repository-scoped authorization', async () => {
      await h.app.close()
      h = makeHarness(1)
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      h.table.upsert(rule({ hookId: HOOK_B }, { events: ['issue_comment:created'] }))
      const payload = issuesPayload({
        action: 'created',
        comment: { body: 'please retry', author_association: 'CONTRIBUTOR' }
      })

      await post('issue_comment', payload, { headers: { 'x-github-delivery': 'fanout' } })
      await flush()

      expect(h.authzRequests).toEqual([
        expect.objectContaining({
          hookId: HOOK,
          siblingFences: [{ hookId: HOOK_B, configRevision: '3', dispatchRevision: '5' }]
        })
      ])
      expect(h.sent).toHaveLength(2)
    })

    it('created mode accepts later explicit summons but not ordinary or out-of-scope updates', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['issues:opened'],
            commentFamilies: ['issues'],
            appSlug: 'example-review-app'
          }
        )
      )
      const comment = (body: string, association: string, key: string) =>
        post(
          'issue_comment',
          issuesPayload({ action: 'created', comment: { body, author_association: association } }),
          { headers: { 'x-github-delivery': key } }
        )

      h.authzResult = false
      await comment('ordinary follow-up', 'MEMBER', 'created-summon-0')
      await comment('@example-review-app please look', 'NONE', 'created-summon-1')
      await post('issues', issuesPayload({ action: 'labeled', issue: { number: 42, body: 'ordinary update' } }), {
        headers: { 'x-github-delivery': 'created-summon-2' }
      })
      await flush()
      expect(h.sent).toHaveLength(0)

      h.authzResult = true
      await comment('@example-review-app please look', 'COLLABORATOR', 'created-summon-3')
      await post(
        'issues',
        issuesPayload({ action: 'labeled', issue: { number: 42, body: 'cc @example-review-app' } }),
        { headers: { 'x-github-delivery': 'created-summon-4' } }
      )
      await flush()
      expect(h.sent).toHaveLength(2)

      // A PR-thread summon remains outside an issue-only created cadence.
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment: { body: '@example-review-app please look', author_association: 'MEMBER' }
        }),
        { headers: { 'x-github-delivery': 'created-summon-5' } }
      )
      await flush()
      expect(h.sent).toHaveLength(2)
    })

    it('mention mode accepts the App or assigned agent handle as a whole token', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['issues:*', 'issue_comment:created'],
            commentFamilies: ['issues'],
            mentionOnly: true,
            appSlug: 'example-review-app',
            agentName: 'review-agent'
          }
        )
      )
      const comment = (body: string, key: string) =>
        post('issue_comment', issuesPayload({ action: 'created', comment: { body, author_association: 'MEMBER' } }), {
          headers: { 'x-github-delivery': key }
        })

      await comment('please look at this', 'm-0') // no mention
      await comment('cc @example-review-apps', 'm-1') // slug is a strict prefix — not a mention
      await comment('cc @example-review', 'm-2') // a DIFFERENT app whose slug prefixes ours
      await comment('mail team@example-review-app.test about it', 'm-2b') // email, not a mention
      // An issue whose body does NOT summon the app stays silent too.
      await post('issues', issuesPayload(), { headers: { 'x-github-delivery': 'm-3' } })
      // Even a valid summon stays out when the shared comment belongs to a PR
      // outside this issue-only scope.
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
          comment: { body: '@example-review-app please look', author_association: 'MEMBER' }
        }),
        { headers: { 'x-github-delivery': 'm-pr' } }
      )
      await flush()
      expect(h.sent).toHaveLength(0)

      await comment('Hey @Example-Review-App, can you retry only on staging?', 'm-4') // case-insensitive hit
      await flush()
      expect(h.sent).toHaveLength(1)

      await comment('Could @Review-Agent take this one?', 'm-4b')
      await flush()
      expect(h.sent).toHaveLength(2)

      // A summoning ISSUE BODY fires — and its later events keep flowing (the
      // thread summoned the agent), e.g. a labeled update on the same issue.
      await post(
        'issues',
        issuesPayload({
          action: 'labeled',
          issue: { number: 42, body: 'please have a look @example-review-app', labels: [{ name: 'bug' }] }
        }),
        { headers: { 'x-github-delivery': 'm-5' } }
      )
      await flush()
      expect(h.sent).toHaveLength(3)
    })

    it('narrows an explicit agent mention while the App mention broadcasts to every review agent', async () => {
      const github = {
        events: ['issue_comment:created'],
        commentFamilies: ['pull_request' as const],
        appSlug: 'example-review-app'
      }
      h.table.upsert(rule({}, { ...github, agentName: 'review-alpha' }))
      h.table.upsert(rule({ hookId: HOOK_B, agentId: AGENT_B }, { ...github, agentName: 'review-beta' }))
      const comment = (body: string, key: string) =>
        post(
          'issue_comment',
          issuesPayload({
            action: 'created',
            issue: { number: 43, pull_request: { url: 'https://api.github.com/repos/acme/infra/pulls/43' } },
            comment: { body, author_association: 'MEMBER' }
          }),
          { headers: { 'x-github-delivery': key } }
        )

      await comment('@review-alpha please take another look', 'target-agent')
      await flush()
      expect(h.sent.map((msg) => msg.agentId)).toEqual([AGENT])

      await comment('@review-alpha and @example-review-app please run every reviewer', 'broadcast-app')
      await flush()
      expect(h.sent.map((msg) => msg.agentId)).toEqual([AGENT, AGENT, AGENT_B])
    })

    it('mention mode fails closed when an older rule carries no mention handles', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'], mentionOnly: true }))
      await post(
        'issue_comment',
        issuesPayload({
          action: 'created',
          comment: { body: '@example-review-app do it', author_association: 'OWNER' }
        })
      )
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('a diff-line review comment rides the issue_comment subscription (alias) with all comment gates', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      const reviewComment = (assoc: string | undefined, key: string) =>
        post(
          'pull_request_review_comment',
          {
            action: 'created',
            installation: { id: INSTALLATION },
            repository: { id: REPO_ID, full_name: 'acme/infra' },
            sender: { login: 'alice', type: 'User' },
            pull_request: { number: 7, title: 'tighten backoff', user: { login: 'alice' } },
            comment: {
              id: 3565283658,
              in_reply_to_id: null,
              user: { login: 'alice' },
              body: 'should this retry be exponential?',
              html_url: 'https://github.com/acme/infra/pull/7#discussion_r1',
              author_association: assoc
            }
          },
          { headers: { 'x-github-delivery': key } }
        )

      h.authzResult = false
      await reviewComment('NONE', 'rc-0')
      await flush()
      expect(h.sent).toHaveLength(0)

      h.authzResult = true
      await reviewComment('COLLABORATOR', 'rc-1')
      await flush()
      expect(h.sent).toHaveLength(1)
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.sessionKey).toBe('acme/infra#7') // SAME session as the PR thread
      expect(msg.github).toMatchObject({
        reviewCommentId: '3565283658',
        reviewThreadRootCommentId: '3565283658'
      })
      expect(msg.context).toMatchObject({
        event: 'pull_request_review_comment',
        bodyExcerpt: 'should this retry be exponential?',
        htmlUrl: 'https://github.com/acme/infra/pull/7#discussion_r1'
      })
      await flush()
      expect(h.reports[0]?.event).toBe('pull_request_review_comment:created')
    })

    it('normalizes a review-comment reply to its thread root in trusted metadata', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'] }))
      await post('pull_request_review_comment', {
        action: 'created',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' },
        pull_request: { number: 7, title: 'tighten backoff', user: { login: 'alice' } },
        comment: {
          id: 3565656411,
          in_reply_to_id: 3565283658,
          user: { login: 'alice' },
          body: 'translate this?',
          author_association: 'COLLABORATOR'
        }
      })
      await flush()

      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.github).toMatchObject({
        reviewCommentId: '3565656411',
        reviewThreadRootCommentId: '3565283658'
      })
      expect(h.reports[0]?.github).toEqual(msg.github)
    })

    it('a diff-line review comment is isolated to the pull-request family', async () => {
      const reviewPayload = {
        action: 'created',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' },
        pull_request: { number: 7, title: 'tighten backoff', user: { login: 'alice' } },
        comment: {
          user: { login: 'alice' },
          body: 'should this retry be exponential?',
          author_association: 'MEMBER'
        }
      }

      h.table.upsert(rule({}, { events: ['issues:*', 'issue_comment:created'], commentFamilies: ['issues'] }))
      await post('pull_request_review_comment', reviewPayload, {
        headers: { 'x-github-delivery': 'issue-scoped-review' }
      })
      await flush()
      expect(h.sent).toHaveLength(0)

      h.table.upsert(
        rule({}, { events: ['pull_request:*', 'issue_comment:created'], commentFamilies: ['pull_request'] })
      )
      await post('pull_request_review_comment', reviewPayload, {
        headers: { 'x-github-delivery': 'pr-scoped-review' }
      })
      await flush()
      expect(h.sent).toHaveLength(1)
    })

    it('a created-cadence diff-line summon still honors comment family scope', async () => {
      const reviewPayload = {
        action: 'created',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' },
        pull_request: { number: 7, title: 'tighten backoff', user: { login: 'alice' } },
        comment: {
          user: { login: 'alice' },
          body: '@example-review-app is this right?',
          author_association: 'MEMBER'
        }
      }

      h.table.upsert(
        rule(
          {},
          {
            events: ['pull_request:opened'],
            commentFamilies: ['issues'],
            appSlug: 'example-review-app'
          }
        )
      )
      await post('pull_request_review_comment', reviewPayload, {
        headers: { 'x-github-delivery': 'created-review-out-of-scope' }
      })
      await flush()
      expect(h.sent).toHaveLength(0)

      h.table.upsert(
        rule(
          {},
          {
            events: ['pull_request:opened'],
            commentFamilies: ['pull_request'],
            appSlug: 'example-review-app'
          }
        )
      )
      await post('pull_request_review_comment', reviewPayload, {
        headers: { 'x-github-delivery': 'created-review-in-scope' }
      })
      await flush()
      expect(h.sent).toHaveLength(1)
    })

    it('an explicit review-comment API subscription bypasses issue_comment alias family scoping', async () => {
      h.table.upsert(
        rule(
          {},
          {
            events: ['issues:*', 'pull_request_review_comment:created'],
            commentFamilies: ['issues']
          }
        )
      )
      await post('pull_request_review_comment', {
        action: 'created',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' },
        pull_request: { number: 7, user: { login: 'alice' } },
        comment: { user: { login: 'alice' }, body: 'explicitly subscribed', author_association: 'MEMBER' }
      })
      await flush()

      expect(h.sent).toHaveLength(1)
    })

    it('mention mode covers @-mentions on diff lines (alias inherits the mention gate)', async () => {
      h.table.upsert(rule({}, { events: ['issue_comment:created'], mentionOnly: true, appSlug: 'example-review-app' }))
      const reviewComment = (body: string, key: string) =>
        post(
          'pull_request_review_comment',
          {
            action: 'created',
            installation: { id: INSTALLATION },
            repository: { id: REPO_ID, full_name: 'acme/infra' },
            sender: { login: 'alice', type: 'User' },
            pull_request: { number: 7, user: { login: 'alice' } },
            comment: { user: { login: 'alice' }, body, author_association: 'MEMBER' }
          },
          { headers: { 'x-github-delivery': key } }
        )
      await reviewComment('is this right?', 'rm-0') // no mention ⇒ silent
      await flush()
      expect(h.sent).toHaveLength(0)
      await reviewComment('@example-review-app is this right?', 'rm-1')
      await flush()
      expect(h.sent).toHaveLength(1)
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.github?.explicitReviewRequest).toBeUndefined()
    })

    it('push ("commits") fires via the family wildcard with per-branch session affinity', async () => {
      h.table.upsert(rule({}, { events: ['push:*'] }))
      const res = await post('push', {
        ref: 'refs/heads/main',
        compare: 'https://github.com/acme/infra/compare/abc...def',
        head_commit: { message: 'fix: tighten relay backoff' },
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' }
      })
      expect(res.statusCode).toBe(202)
      await flush()
      expect(h.sent).toHaveLength(1)
      const msg = h.sent[0]!
      if (msg.source !== 'hook') throw new Error('expected hook member')
      expect(msg.sessionKey).toBe('acme/infra#refs/heads/main')
      expect(msg.context).toMatchObject({
        source: 'github',
        event: 'push',
        repo: 'acme/infra',
        senderLogin: 'alice',
        htmlUrl: 'https://github.com/acme/infra/compare/abc...def',
        bodyExcerpt: 'fix: tighten relay backoff'
      })
      expect(msg.context?.action).toBeUndefined()
      expect(msg.context?.number).toBeUndefined()
      // The delivery-stage report is stamped with the bare event name.
      await flush()
      expect(h.reports[0]?.event).toBe('push')
    })

    it('mention mode scans EVERY pushed commit message, not just the head', async () => {
      h.table.upsert(rule({}, { events: ['push:*'], mentionOnly: true, appSlug: 'example-review-app' }))
      await post(
        'push',
        {
          ref: 'refs/heads/main',
          head_commit: { message: 'chore: bump deps' },
          commits: [{ message: 'fix: flaky test' }, { message: 'docs: ask @example-review-app to review' }],
          installation: { id: INSTALLATION },
          repository: { id: REPO_ID, full_name: 'acme/infra' },
          sender: { login: 'alice', type: 'User' }
        },
        { headers: { 'x-github-delivery': 'push-m-1' } }
      )
      await flush()
      expect(h.sent).toHaveLength(1)
    })

    it('push never matches an exact family:action subscription (wildcard only)', async () => {
      h.table.upsert(rule({}, { events: ['issues:opened', 'pull_request:*'] }))
      const res = await post('push', {
        ref: 'refs/heads/main',
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        sender: { login: 'alice', type: 'User' }
      })
      expect(res.statusCode).toBe(202)
      await flush()
      expect(h.sent).toHaveLength(0)
    })

    it('fan-out: two hooks on one repo each fire with their own msgId, same sessionKey', async () => {
      h.table.upsert(rule())
      h.table.upsert(rule({ hookId: HOOK_B }))
      await post('issues', issuesPayload())
      await flush()
      expect(h.sent.map((m) => m.msgId).sort()).toEqual([`${HOOK}:gh-delivery-1`, `${HOOK_B}:gh-delivery-1`])
      expect(new Set(h.sent.map((m) => m.sessionKey))).toEqual(new Set(['acme/infra#42']))
    })
  })

  it('truncates the body excerpt at 4 KiB and flags it', async () => {
    h.table.upsert(rule())
    await post('issues', issuesPayload({ issue: { number: 42, body: 'x'.repeat(GITHUB_BODY_EXCERPT_MAX + 100) } }))
    await flush()
    const msg = h.sent[0]!
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.context?.truncated).toBe(true)
    expect(msg.context?.bodyExcerpt).toHaveLength(GITHUB_BODY_EXCERPT_MAX)
  })

  it('a rate-limited hook is skipped (still 202, no run-report row)', async () => {
    h.table.upsert(rule())
    for (let i = 0; i < 3; i++) expect((await post('issues', issuesPayload())).statusCode).toBe(202)
    const res = await post('issues', issuesPayload())
    expect(res.statusCode).toBe(202) // never 429 toward GitHub
    await flush()
    expect(h.sent).toHaveLength(3)
    expect(h.reports).toHaveLength(3)
  })

  it('daemon offline / rejected ack / timeout land as failed run-reports with the event stamped', async () => {
    h.table.upsert(rule())
    h.offline = true
    await post('issues', issuesPayload())
    h.clock.advance(12_000)
    h.offline = false
    h.ack = { msgId: 'x', accepted: false, reason: 'paused' }
    await post('issues', issuesPayload())
    await flush()
    h.ack = () => Promise.reject(new Error('timeout'))
    await post('issues', issuesPayload())
    await flush()
    expect(h.reports.map((r) => r.reason)).toEqual(['daemon_offline', 'rejected:paused', 'dispatch_timeout'])
    for (const r of h.reports) expect(r.event).toBe('issues:opened')
  })

  it('truncates the excerpt on a UTF-8 BYTE budget, never splitting a code point', async () => {
    h.table.upsert(rule())
    // 2000 three-byte UTF-8 characters total about 6000 bytes, over the 4 KiB cap at about 1365 chars.
    await post('issues', issuesPayload({ issue: { number: 42, body: '€'.repeat(2000) } }))
    await flush()
    const msg = h.sent[0]!
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.context?.truncated).toBe(true)
    expect(Buffer.byteLength(msg.context!.bodyExcerpt!, 'utf8')).toBeLessThanOrEqual(GITHUB_BODY_EXCERPT_MAX)
    expect(msg.context!.bodyExcerpt!).toMatch(/^€+$/) // whole characters only — no replacement char
  })

  it('sanitizes the title to one capped line (it rides the daemon trusted header)', async () => {
    h.table.upsert(rule())
    await post('issues', issuesPayload({ issue: { number: 42, title: `line1\nline2\t${'x'.repeat(300)}` } }))
    await flush()
    const msg = h.sent[0]!
    if (msg.source !== 'hook') throw new Error('expected hook member')
    expect(msg.context?.title).not.toContain('\n')
    expect(msg.context!.title!.length).toBeLessThanOrEqual(200)
    expect(msg.context?.title).toMatch(/^line1 line2 x+…$/)
  })

  it('non-JSON content types fail closed (415 for form posts, 401 for text/plain)', async () => {
    h.table.upsert(rule())
    const payload = JSON.stringify(issuesPayload())
    const form = await h.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-hub-signature-256': sign(payload),
        'x-github-event': 'issues'
      },
      payload
    })
    expect(form.statusCode).toBe(415)
    // text/plain parses as a string, not the raw buffer the signature needs —
    // the check runs over an empty buffer and a valid body signature fails.
    const text = await h.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'text/plain', 'x-hub-signature-256': sign(payload), 'x-github-event': 'issues' },
      payload
    })
    expect(text.statusCode).toBe(401)
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('rejects oversized bodies via the per-route limit', async () => {
    const payload = JSON.stringify({ pad: 'x'.repeat(1100 * 1024) })
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload), 'x-github-event': 'issues' },
      payload
    })
    expect(res.statusCode).toBe(413)
  })
})

describe('buildTrustedGithubMetadata review comment ids', () => {
  const metadata = (id: number, inReplyToId: number | null | undefined, reviewId: number = 456) =>
    buildTrustedGithubMetadata(
      'pull_request_review_comment',
      {
        installation: { id: INSTALLATION },
        repository: { id: REPO_ID, full_name: 'acme/infra' },
        pull_request: { number: 7 },
        comment: {
          id,
          pull_request_review_id: reviewId,
          ...(inReplyToId !== undefined ? { in_reply_to_id: inReplyToId } : {})
        }
      },
      rule({}, { events: ['issue_comment:created'] })
    )

  it('accepts Number.MAX_SAFE_INTEGER for both a triggering comment and its root', () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(metadata(max, null)).toMatchObject({
      pullRequestReviewId: '456',
      reviewCommentId: String(max),
      reviewThreadRootCommentId: String(max)
    })
  })

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5])(
    'omits an unsafe, non-positive, or fractional triggering comment id (%s)',
    (id) => {
      const github = metadata(id, null)
      expect(github?.reviewCommentId).toBeUndefined()
      expect(github?.reviewThreadRootCommentId).toBeUndefined()
    }
  )

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5])('omits an invalid review id (%s)', (reviewId) => {
    expect(metadata(123, null, reviewId)?.pullRequestReviewId).toBeUndefined()
  })

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5])(
    'does not fall back to the child id when a present root id is invalid (%s)',
    (rootId) => {
      const github = metadata(123, rootId)
      expect(github?.reviewCommentId).toBe('123')
      expect(github?.reviewThreadRootCommentId).toBeUndefined()
    }
  )
})

describe('githubRuleVerdict (pure predicate)', () => {
  const ctx = {
    event: 'issues',
    eventAction: 'issues:opened',
    installationId: String(INSTALLATION),
    labels: ['bug'],
    senderType: 'User' as string | undefined,
    mentionText: undefined as string | undefined,
    commentSubjectFamily: undefined as 'issues' | 'pull_request' | undefined
  }
  const matches = (candidate: RcHookAssign, context = ctx) => githubRuleVerdict(candidate, context) !== 'no-match'

  it('treats summons as additive in created mode and exclusive in mention-only mode', () => {
    const update = { ...ctx, eventAction: 'issues:labeled', mentionText: 'ordinary update' }
    const summoned = { ...update, mentionText: 'please check @example-review-app' }
    const created = rule({}, { events: ['issues:opened'], appSlug: 'example-review-app' })
    const updated = rule({}, { events: ['issues:*'], appSlug: 'example-review-app' })
    const mentionOnly = rule({}, { events: ['issues:*'], mentionOnly: true, appSlug: 'example-review-app' })

    expect(matches(created, update)).toBe(false)
    expect(matches(created, summoned)).toBe(true)
    expect(matches(updated, update)).toBe(true)
    expect(matches(updated, summoned)).toBe(true)
    expect(matches(mentionOnly, update)).toBe(false)
    expect(matches(mentionOnly, summoned)).toBe(true)
  })

  it('mention mode gates EVERY event on its text — no mention (or no text) fails closed', () => {
    const r = rule({}, { mentionOnly: true, appSlug: 'example-review-app' })
    expect(matches(r, ctx)).toBe(false) // no text at all
    expect(matches(r, { ...ctx, mentionText: 'just an issue body' })).toBe(false)
    expect(matches(r, { ...ctx, mentionText: 'summon @example-review-app please' })).toBe(true)
    // Bounded on BOTH sides — emails/URLs are not mentions, and neither is a
    // longer login that merely starts with our slug.
    expect(matches(r, { ...ctx, mentionText: 'mail team@example-review-app.test' })).toBe(false)
    expect(matches(r, { ...ctx, mentionText: 'see /apps/@example-review-app/config' })).toBe(true) // '/' is a boundary
    expect(matches(r, { ...ctx, mentionText: 'cc @example-review-apper' })).toBe(false)
  })

  it.each([
    ['issues', 'issues:closed'],
    ['issues', 'issues:deleted'],
    ['issues', 'issues:edited'],
    ['issues', 'issues:reopened'],
    ['pull_request', 'pull_request:closed'],
    ['pull_request', 'pull_request:deleted'],
    ['pull_request', 'pull_request:edited'],
    ['pull_request', 'pull_request:reopened'],
    ['pull_request', 'pull_request:ready_for_review'],
    ['pull_request', 'pull_request:converted_to_draft'],
    ['issue_comment', 'issue_comment:deleted'],
    ['pull_request_review_comment', 'pull_request_review_comment:deleted']
  ])('hard-vetoes silent %s action even for an explicit legacy subscription', (event, eventAction) => {
    expect(matches(rule({}, { events: [eventAction] }), { ...ctx, event, eventAction })).toBe(false)
  })

  it('keeps PR synchronize while vetoing every edited action', () => {
    const r = rule({}, { events: ['pull_request:*'] })
    const pr = { ...ctx, event: 'pull_request' }
    expect(githubRuleVerdict(r, { ...pr, eventAction: 'pull_request:synchronize' })).toBe('needs-authz')
    expect(matches(r, { ...pr, eventAction: 'pull_request:edited' })).toBe(false)
  })

  it('trusts only same-repository revisions authored by this App', () => {
    const r = rule({}, { events: ['pull_request:*'], appSlug: 'example-review-app' })
    const appPr = {
      ...ctx,
      event: 'pull_request',
      eventAction: 'pull_request:synchronize',
      subjectAuthorLogin: 'example-review-app[bot]',
      subjectAuthorType: 'Bot',
      headRepoFullName: 'acme/infra',
      baseRepoFullName: 'acme/infra'
    }

    expect(githubRuleVerdict(r, appPr)).toBe('trusted')
    expect(githubRuleVerdict(r, { ...appPr, headRepoFullName: 'fork/infra', baseRepoFullName: 'acme/infra' })).toBe(
      'needs-authz'
    )
    expect(githubRuleVerdict(r, { ...appPr, senderType: 'Bot', subjectAuthorLogin: 'dependabot[bot]' })).toBe(
      'no-match'
    )
  })

  it('applies comment subject scope only when commentFamilies is non-empty', () => {
    const commentCtx = {
      ...ctx,
      event: 'issue_comment',
      eventAction: 'issue_comment:created',
      mentionText: 'reply',
      commentSubjectFamily: 'pull_request' as const
    }
    const mixed = { events: ['issues:*', 'issue_comment:created'] }

    expect(matches(rule({}, mixed), commentCtx)).toBe(true)
    expect(matches(rule({}, { ...mixed, commentFamilies: [] }), commentCtx)).toBe(true)
    expect(matches(rule({}, { ...mixed, commentFamilies: ['issues'] }), commentCtx)).toBe(false)
    expect(matches(rule({}, { ...mixed, commentFamilies: ['pull_request'] }), commentCtx)).toBe(true)
  })

  it('a webhook-kind rule never matches', () => {
    expect(matches({ ...rule(), kind: 'webhook', github: undefined, webhook: { urlToken: 't' } }, ctx)).toBe(false)
  })
})

describe('buildGithubContext', () => {
  it('pull_request deliveries source the subject from payload.pull_request', () => {
    const c = buildGithubContext('pull_request', {
      action: 'opened',
      repository: { id: REPO_ID, full_name: 'acme/infra' },
      sender: { login: 'alice', type: 'User', avatar_url: 'https://avatars.example.test/alice.png' },
      pull_request: { number: 7, title: 'fix', body: 'diff', html_url: 'u', author_association: 'OWNER', labels: [] }
    })
    expect(c).toMatchObject({
      source: 'github',
      number: 7,
      title: 'fix',
      senderAvatarUrl: 'https://avatars.example.test/alice.png',
      bodyExcerpt: 'diff'
    })
  })

  it('a null subject body yields no excerpt and truncated:false', () => {
    const c = buildGithubContext('issues', {
      action: 'opened',
      repository: { id: REPO_ID, full_name: 'acme/infra' },
      issue: { number: 1, title: 't', body: null }
    })
    expect(c.bodyExcerpt).toBeUndefined()
    expect(c.truncated).toBe(false)
  })
})
