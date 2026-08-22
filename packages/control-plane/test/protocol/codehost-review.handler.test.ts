/**
 * The provider-neutral formal-review control surface over the real daemon WS edge
 * (gitlab-com-integration.md §15.1, §17.2, §17.3): the feature is advertised on
 * register, all four frames reach their handler, and an unconfigured control
 * plane refuses them instead of dropping them silently.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CODEHOST_REVIEW_V1_FEATURE, isFrame, type FrameType } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { CodeHostReviewBrokerService } from '../../src/codehost/review-lease.service.js'
import { PgCodeHostReviewLeaseRepo } from '../../src/persistence/repositories/code-host-review.repo.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const HOOK = '11111111-1111-4111-8111-111111111111'
const PROJECT = 4_455_667n
const IID = 42
const HEAD = 'a'.repeat(40)
const DELIVERY = 'delivery-1'

const snapshot = {
  configRevision: '7',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON,
  reviewPolicy: 'full' as const,
  reportingMode: 'off' as const,
  gateMode: 'informational' as const
}

async function ready(h: ReturnType<typeof buildWsHarness>): Promise<InMemoryDaemonStub> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.agent.update({ where: { id: AGENT }, data: { status: 'active' } })
  const token = await h.mintToken(DAEMON)
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [CODEHOST_REVIEW_V1_FEATURE] },
    maxAgents: 8,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  await stub.expectFrame('register/ok')
  return stub
}

/** An enabled gitlab hook on the project, plus the accepted, running delivery it fired. */
async function seedAcceptedDelivery(): Promise<void> {
  await prisma.hookDef.create({
    data: {
      id: HOOK,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      kind: 'gitlab',
      name: 'review',
      sessionMode: 'perThread',
      repoId: PROJECT,
      repoFullName: 'example-group/example-project',
      configRevision: 7n,
      dispatchRevision: 9n,
      reviewPolicy: 'full'
    }
  })
  await prisma.hookRun.create({
    data: {
      hookId: HOOK,
      orgId: DEFAULT_ORG_ID,
      deliveryKey: DELIVERY,
      event: 'merge_request:update',
      startedAt: new Date(),
      agentId: AGENT,
      configRevision: 7n,
      dispatchRevision: 9n,
      dispatchDaemonId: DAEMON,
      reviewPolicySnapshot: 'full',
      reportingModeSnapshot: 'off',
      gateModeSnapshot: 'informational',
      repoId: PROJECT,
      subjectKind: 'merge_request',
      status: 'running'
    }
  })
}

function attachBroker(h: ReturnType<typeof buildWsHarness>): void {
  h.deps.codeHostReviewBroker = new CodeHostReviewBrokerService({
    leases: new PgCodeHostReviewLeaseRepo(prisma),
    hook: h.deps.hook,
    agent: h.deps.agent,
    clock: h.clock,
    placement: h.placement,
    publisher: async () => ({ serviceAccountExternalId: 99_001n, projectPath: 'example-group/example-project' })
  })
}

async function errorFor(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const err = stub.sent.find((f) => f.type === 'error' && f.corr === id)
  return err && isFrame('error')(err) ? err.payload : undefined
}

async function replyTo(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  return stub.sent.find((f) => f.corr === id && f.type !== 'error')
}

describe('codehost review frames on the daemon WS edge', () => {
  it('advertises the feature so a daemon may name these frames at all', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const registered = stub.sent.find((f) => f.type === 'register/ok')
    expect(registered && isFrame('register/ok')(registered) && registered.payload.serverFeatures).toContain(
      CODEHOST_REVIEW_V1_FEATURE
    )
  })

  it('refuses every frame on a control plane with no code-host review broker', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const frames: Array<{ type: FrameType; payload: unknown }> = [
      {
        type: 'codehost/review-authz',
        payload: {
          hookId: HOOK,
          deliveryKey: DELIVERY,
          attemptId: randomUUID(),
          provider: 'gitlab',
          projectId: PROJECT.toString(),
          mergeRequestIid: IID,
          requestedEvent: 'COMMENT',
          requestedVerdict: 'pass',
          snapshot,
          headSha: HEAD
        }
      },
      {
        type: 'codehost/review-op',
        payload: {
          op: 'issue',
          attemptId: randomUUID(),
          fence: '1',
          kind: 'draft_create',
          method: 'POST',
          target: '/projects/4455667/merge_requests/42/draft_notes',
          ordinal: 0
        }
      },
      { type: 'codehost/review-lease-renew', payload: { attemptId: randomUUID(), fence: '1' } },
      {
        type: 'codehost/review-result',
        payload: {
          hookId: HOOK,
          deliveryKey: DELIVERY,
          attemptId: randomUUID(),
          snapshot,
          provider: 'gitlab',
          projectId: PROJECT.toString(),
          mergeRequestIid: IID,
          event: 'COMMENT',
          verdict: 'pass',
          headSha: HEAD,
          state: 'submitted'
        }
      }
    ]
    for (const { type, payload } of frames) {
      const id = stub.inject(type, payload)
      // A typed refusal, never a silent drop: the daemon must not burn its retransmit budget.
      expect({ type, error: await errorFor(stub, id) }).toMatchObject({
        type,
        error: { code: 'SCOPE_DENIED', retryable: false }
      })
    }
  })

  it('runs one attempt end to end: lease, permit, renewal, and a body-free result', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    await seedAcceptedDelivery()
    attachBroker(h)

    const attemptId = randomUUID()
    const authzId = stub.inject('codehost/review-authz', {
      hookId: HOOK,
      deliveryKey: DELIVERY,
      attemptId,
      provider: 'gitlab',
      projectId: PROJECT.toString(),
      mergeRequestIid: IID,
      requestedEvent: 'COMMENT',
      requestedVerdict: 'pass',
      snapshot,
      headSha: HEAD
    })
    const authorized = await replyTo(stub, authzId)
    expect(authorized?.type).toBe('codehost/review-authz/result')
    if (!authorized || !isFrame('codehost/review-authz/result')(authorized)) return
    expect(authorized.payload.authorized).toBe(true)
    if (!authorized.payload.authorized) return
    const fence = authorized.payload.lease.fence
    expect(fence).toBe('1')
    expect(authorized.payload.lease.serviceAccountUserId).toBe('99001')

    const issueId = stub.inject('codehost/review-op', {
      op: 'issue',
      attemptId,
      fence,
      kind: 'bulk_publish',
      method: 'POST',
      target: '/projects/4455667/merge_requests/42/draft_notes/bulk_publish',
      ordinal: 0
    })
    const issued = await replyTo(stub, issueId)
    expect(issued?.type).toBe('codehost/review-op/ok')
    if (!issued || !isFrame('codehost/review-op/ok')(issued)) return
    expect(issued.payload).toMatchObject({ state: 'issued', phase: 'publishing' })

    const renewId = stub.inject('codehost/review-lease-renew', { attemptId, fence })
    const renewed = await replyTo(stub, renewId)
    expect(renewed?.type).toBe('codehost/review-lease-renew/ok')
    if (renewed && isFrame('codehost/review-lease-renew/ok')(renewed)) {
      expect(renewed.payload.phase).toBe('publishing')
    }

    const startId = stub.inject('codehost/review-op', {
      op: 'start',
      attemptId,
      fence,
      recordId: issued.payload.recordId,
      startToken: randomUUID()
    })
    expect((await replyTo(stub, startId))?.type).toBe('codehost/review-op/ok')
    const settleId = stub.inject('codehost/review-op', {
      op: 'settle',
      attemptId,
      fence,
      recordId: issued.payload.recordId,
      outcome: { kind: 'deterministic', status: 204 }
    })
    expect((await replyTo(stub, settleId))?.type).toBe('codehost/review-op/ok')

    const resultId = stub.inject('codehost/review-result', {
      hookId: HOOK,
      deliveryKey: DELIVERY,
      attemptId,
      snapshot,
      provider: 'gitlab',
      projectId: PROJECT.toString(),
      mergeRequestIid: IID,
      event: 'COMMENT',
      verdict: 'pass',
      headSha: HEAD,
      state: 'submitted',
      externalIds: [{ kind: 'note', externalId: '778899' }]
    })
    const settled = await replyTo(stub, resultId)
    expect(settled?.type).toBe('codehost/review-result/ok')
    if (settled && isFrame('codehost/review-result/ok')(settled)) expect(settled.payload.phase).toBe('settled')

    const outcome = await prisma.codeHostReviewAttemptOutcome.findUniqueOrThrow({ where: { attemptId } })
    expect(outcome.externalIds).toEqual(['note:778899'])
    expect(outcome.state).toBe('submitted')
  })

  it('a second start on the same record is refused, so one record is one outbound request', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    await seedAcceptedDelivery()
    attachBroker(h)

    const attemptId = randomUUID()
    const authzId = stub.inject('codehost/review-authz', {
      hookId: HOOK,
      deliveryKey: DELIVERY,
      attemptId,
      provider: 'gitlab',
      projectId: PROJECT.toString(),
      mergeRequestIid: IID,
      requestedEvent: 'COMMENT',
      requestedVerdict: 'pass',
      snapshot,
      headSha: HEAD
    })
    const authorized = await replyTo(stub, authzId)
    if (!authorized || !isFrame('codehost/review-authz/result')(authorized) || !authorized.payload.authorized) {
      throw new Error('expected a publication lease')
    }
    const fence = authorized.payload.lease.fence
    const issueId = stub.inject('codehost/review-op', {
      op: 'issue',
      attemptId,
      fence,
      kind: 'draft_create',
      method: 'POST',
      target: '/projects/4455667/merge_requests/42/draft_notes',
      ordinal: 0
    })
    const issued = await replyTo(stub, issueId)
    if (!issued || !isFrame('codehost/review-op/ok')(issued)) throw new Error('expected a permit')
    const recordId = issued.payload.recordId

    const firstStart = stub.inject('codehost/review-op', {
      op: 'start',
      attemptId,
      fence,
      recordId,
      startToken: randomUUID()
    })
    expect((await replyTo(stub, firstStart))?.type).toBe('codehost/review-op/ok')
    const secondStart = stub.inject('codehost/review-op', {
      op: 'start',
      attemptId,
      fence,
      recordId,
      startToken: randomUUID()
    })
    expect(await errorFor(stub, secondStart)).toMatchObject({ code: 'CONFLICT', retryable: false })
  })
})
