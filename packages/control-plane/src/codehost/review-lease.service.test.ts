import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { CodeHostReviewAuthorize, CodeHostReviewResultReport, HookStart } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type { AgentRecord, HookRecord, HookRunRecord, HookStartInput } from '../persistence/ports.js'
import { FakeCodeHostReviewLeaseRepo } from '../../test/fakes/code-host-review-lease.js'
import {
  CodeHostReviewBrokerError,
  CodeHostReviewBrokerService,
  type CodeHostReviewBrokerDeps
} from './review-lease.service.js'

const ORG = OrgId('org-1')
const HOOK = HookId('11111111-1111-4111-8111-111111111111')
const AGENT = AgentId('22222222-2222-4222-8222-222222222222')
const DAEMON = DaemonId('33333333-3333-4333-8333-333333333333')
const OTHER_DAEMON = DaemonId('55555555-5555-4555-8555-555555555555')
const PROJECT = 4455667n
const IID = 42
const SERVICE_ACCOUNT = 99001n
const HEAD = 'a'.repeat(40)

const snapshot = {
  configRevision: '7',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON,
  reviewPolicy: 'full' as const,
  reportingMode: 'off' as const,
  gateMode: 'informational' as const
}

function run(overrides: Partial<HookRunRecord> = {}): HookRunRecord {
  return {
    id: 'run-1',
    hookId: HOOK,
    orgId: ORG,
    deliveryKey: 'delivery-1',
    event: 'merge_request:update',
    agentId: AGENT,
    configRevision: 7n,
    dispatchRevision: 9n,
    projectionEpoch: 1n,
    dispatchDaemonId: DAEMON,
    reviewPolicySnapshot: 'full',
    reportingModeSnapshot: 'off',
    gateModeSnapshot: 'informational',
    projectionIntent: null,
    repoId: PROJECT,
    repoFullName: 'example-group/example-project',
    sourceInstallationId: null,
    subjectKind: 'merge_request',
    pullNumber: null,
    headSha: null,
    baseSha: null,
    reportSha: null,
    isDraft: null,
    baseChanged: null,
    startedAt: new Date(0),
    turnStartedAt: null,
    completedAt: null,
    orphanedAt: null,
    projectionId: null,
    projectionGeneration: null,
    reviewAttemptId: null,
    reviewAttemptState: null,
    reviewErrorCode: null,
    reviewId: null,
    reviewEvent: null,
    verdict: null,
    reviewCommitId: null,
    publishedCommentKind: null,
    publishedCommentId: null,
    status: 'running',
    durationMs: null,
    sessionId: null,
    reason: null,
    redeliveryAttempts: 0,
    redeliveryLastRequestedAt: null,
    redeliveryNextAttemptAt: null,
    ...overrides
  }
}

function hook(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HOOK,
    orgId: ORG,
    agentId: AGENT,
    kind: 'gitlab',
    name: 'review',
    enabled: true,
    sessionMode: 'perThread',
    urlToken: null,
    hmacConfigured: true,
    repoId: PROJECT,
    repoFullName: 'example-group/example-project',
    events: ['merge_request:*'],
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    configRevision: 7n,
    dispatchRevision: 9n,
    projectionEpoch: 1n,
    reviewPolicy: 'full',
    reportingMode: 'off',
    gateMode: 'informational',
    requiredAcknowledgedAt: null,
    requiredAcknowledgedByUserId: null,
    requiredAcknowledgedConfigRevision: null,
    targetPlatform: 'slack',
    targetChannel: null,
    targetIntegrationId: null,
    lastFiredAt: null,
    createdBy: null,
    createdByUserId: null,
    createdAt: new Date(0),
    lastModifiedAt: new Date(0),
    lastModifiedBy: null,
    ...overrides
  }
}

const agent = { id: AGENT, orgId: ORG, daemonId: DAEMON, status: 'active' } as unknown as AgentRecord

/** The second agent's delivery: a different hook run, dispatched to a different daemon. */
const SECOND_DELIVERY = 'delivery-2'
const SECOND_SNAPSHOT = { ...snapshot, dispatchDaemonId: OTHER_DAEMON }

function build(overrides: Partial<CodeHostReviewBrokerDeps> = {}) {
  const leases = new FakeCodeHostReviewLeaseRepo()
  const starts: HookStartInput[] = []
  let nowMs = 1_000_000
  const deps: CodeHostReviewBrokerDeps = {
    leases,
    hook: {
      getRun: async (_hookId, deliveryKey) =>
        deliveryKey === SECOND_DELIVERY ? run({ deliveryKey: SECOND_DELIVERY, dispatchDaemonId: OTHER_DAEMON }) : run(),
      getUnscoped: async () => hook(),
      recordStart: async (_hookId, _daemonId, input) => {
        starts.push(input)
        return true
      }
    } as CodeHostReviewBrokerDeps['hook'],
    agent: { getUnscoped: async () => agent } as CodeHostReviewBrokerDeps['agent'],
    // A pool member serves agents its row does not name, so placement equality is not the fence.
    placement: { mayAct: async () => true },
    publisher: async () => ({
      serviceAccountExternalId: SERVICE_ACCOUNT,
      projectPath: 'example-group/example-project'
    }),
    clock: { now: () => nowMs },
    ...overrides
  }
  return {
    leases,
    starts,
    service: new CodeHostReviewBrokerService(deps),
    advance: (ms: number) => {
      nowMs += ms
    }
  }
}

function authorizeInput(overrides: Partial<CodeHostReviewAuthorize> = {}): CodeHostReviewAuthorize {
  return {
    hookId: HOOK,
    deliveryKey: 'delivery-1',
    attemptId: randomUUID(),
    provider: 'gitlab',
    projectId: PROJECT.toString(),
    mergeRequestIid: IID,
    requestedEvent: 'COMMENT',
    requestedVerdict: 'pass',
    snapshot,
    headSha: HEAD,
    ...overrides
  }
}

function resultInput(attemptId: string, overrides: Partial<CodeHostReviewResultReport> = {}) {
  return {
    hookId: HOOK,
    deliveryKey: 'delivery-1',
    attemptId,
    snapshot,
    provider: 'gitlab',
    projectId: PROJECT.toString(),
    mergeRequestIid: IID,
    event: 'COMMENT' as const,
    verdict: 'pass' as const,
    headSha: HEAD,
    state: 'submitted' as const,
    ...overrides
  }
}

function startInput(overrides: Partial<HookStart> = {}): HookStart {
  return {
    hookId: HOOK,
    agentId: AGENT,
    deliveryKey: 'delivery-1',
    sessionId: 'acp-gitlab-1',
    event: 'merge_request:update',
    gitlab: {
      projectId: PROJECT.toString(),
      projectPath: 'example-group/example-project',
      target: { kind: 'merge_request', iid: IID, headSha: HEAD, baseSha: 'b'.repeat(40) }
    },
    ...snapshot,
    ...overrides
  }
}

describe('provider-neutral hook start (gitlab-com-integration.md §17.2)', () => {
  it('records the started head and turn time on the accepted run', async () => {
    const { service, starts } = build()
    await service.start(startInput(), DAEMON, ORG)
    expect(starts).toEqual([
      expect.objectContaining({
        deliveryKey: 'delivery-1',
        agentId: AGENT,
        sessionId: 'acp-gitlab-1',
        configRevision: 7n,
        dispatchRevision: 9n,
        dispatchDaemonId: DAEMON,
        headSha: HEAD,
        baseSha: 'b'.repeat(40),
        startedAt: new Date(1_000_000)
      })
    ])
  })

  it('reuses the persisted barrier time so a retry stays idempotent', async () => {
    const persisted = new Date(500)
    const seen: HookStartInput[] = []
    const { service } = build({
      hook: {
        getRun: async () => run({ turnStartedAt: persisted, headSha: HEAD }),
        getUnscoped: async () => hook(),
        recordStart: async (_hookId, _daemonId, input) => {
          seen.push(input)
          return true
        }
      } as CodeHostReviewBrokerDeps['hook']
    })
    await service.start(startInput(), DAEMON, ORG)
    // CP time is not part of the request, so a retry re-asserts the barrier already on the row.
    expect(seen[0]?.startedAt).toEqual(persisted)
  })

  it('records only the turn for a subject that has no revision', async () => {
    const { service, starts } = build()
    await service.start(
      startInput({
        gitlab: {
          projectId: PROJECT.toString(),
          projectPath: 'example-group/example-project',
          target: { kind: 'push', ref: 'refs/heads/main' }
        }
      }),
      DAEMON,
      ORG
    )
    expect(starts[0]?.headSha).toBeUndefined()
    expect(starts[0]?.startedAt).toEqual(new Date(1_000_000))
  })

  it('refuses a start with no provider-neutral metadata', async () => {
    const { service, starts } = build()
    await expect(service.start(startInput({ gitlab: undefined }), DAEMON, ORG)).rejects.toBeInstanceOf(
      CodeHostReviewBrokerError
    )
    expect(starts).toEqual([])
  })

  it('refuses a start whose dispatch fence does not match the accepted run', async () => {
    const { service, starts } = build()
    await expect(service.start(startInput(), OTHER_DAEMON, ORG)).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
    await expect(service.start(startInput(), DAEMON, OrgId('org-2'))).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
    expect(starts).toEqual([])
  })

  it('refuses a start whose hook was disabled or retargeted', async () => {
    const { service } = build({
      hook: {
        getRun: async () => run(),
        getUnscoped: async () => hook({ enabled: false }),
        recordStart: async () => true
      } as CodeHostReviewBrokerDeps['hook']
    })
    await expect(service.start(startInput(), DAEMON, ORG)).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })
})

describe('code-host review authorization (gitlab-com-integration.md §15)', () => {
  it('grants the publication lease with a fence and the shared publisher identity', async () => {
    const { service } = build()
    const input = authorizeInput()
    const answer = await service.authorize(input, DAEMON, ORG)
    expect(answer.authorized).toBe(true)
    if (!answer.authorized) return
    expect(answer.lease).toMatchObject({ attemptId: input.attemptId, fence: '1', serviceAccountUserId: '99001' })
    expect(answer.expectedHeadSha).toBe(HEAD)
  })

  it('admits ONE owner across two daemons racing the same merge request', async () => {
    const { service } = build()
    const first = authorizeInput()
    const second = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    expect((await service.authorize(first, DAEMON, ORG)).authorized).toBe(true)
    const contender = await service.authorize(second, OTHER_DAEMON, ORG)
    expect(contender).toEqual({
      authorized: false,
      attemptId: second.attemptId,
      reason: 'lease_held',
      retryable: true
    })
  })

  it('never lets an expired lease escape an outstanding operation record', async () => {
    const { service, advance, leases } = build()
    const first = authorizeInput()
    const granted = await service.authorize(first, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    const issued = await service.operate(
      {
        op: 'issue',
        attemptId: first.attemptId,
        fence: granted.lease.fence,
        kind: 'bulk_publish',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes/bulk_publish',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    await service.operate(
      {
        op: 'start',
        attemptId: first.attemptId,
        fence: granted.lease.fence,
        recordId: issued.recordId,
        startToken: randomUUID()
      },
      DAEMON,
      ORG
    )

    // Time alone is never sufficient. Once the request started, the row locks.
    advance(10 * 24 * 60 * 60 * 1000)
    const second = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    expect(await service.authorize(second, OTHER_DAEMON, ORG)).toEqual({
      authorized: false,
      attemptId: second.attemptId,
      reason: 'ambiguous_locked',
      retryable: false
    })
    // …and it stays locked forever: there is no timeout and no force unlock.
    advance(365 * 24 * 60 * 60 * 1000)
    const third = authorizeInput()
    expect(await service.authorize(third, DAEMON, ORG)).toMatchObject({ reason: 'ambiguous_locked' })
    expect([...leases.leases.values()][0]?.phase).toBe('ambiguous_locked')
  })

  it('transfers an expired lease whose permits were all durably returned unused', async () => {
    const { service, advance } = build()
    const first = authorizeInput()
    const granted = await service.authorize(first, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    const issued = await service.operate(
      {
        op: 'issue',
        attemptId: first.attemptId,
        fence: granted.lease.fence,
        kind: 'draft_create',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    await service.operate(
      { op: 'return-unused', attemptId: first.attemptId, fence: granted.lease.fence, recordId: issued.recordId },
      DAEMON,
      ORG
    )
    advance(10 * 60 * 1000)
    const second = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    const taken = await service.authorize(second, OTHER_DAEMON, ORG)
    expect(taken.authorized).toBe(true)
    // The fence is monotonic across the transfer, so a stale broker asks with a dead one.
    if (taken.authorized) expect(taken.lease.fence).toBe('2')
  })

  it('refuses request-changes before any draft when the service account is not a reviewer', async () => {
    const { service } = build()
    const input = authorizeInput({ requestedEvent: 'REQUEST_CHANGES', requestedVerdict: 'fail' })
    expect(await service.authorize(input, DAEMON, ORG)).toEqual({
      authorized: false,
      attemptId: input.attemptId,
      reason: 'reviewer_assignment_required',
      retryable: false
    })
  })

  it('fences the head of every run the start barrier crossed', async () => {
    const { service } = build({
      hook: {
        getRun: async () => run({ turnStartedAt: new Date(1_000), headSha: HEAD }),
        getUnscoped: async () => hook(),
        recordStart: async () => true
      } as CodeHostReviewBrokerDeps['hook']
    })
    expect(await service.authorize(authorizeInput(), DAEMON, ORG)).toMatchObject({ authorized: true })
    const moved = authorizeInput({ headSha: 'c'.repeat(40) })
    expect(await service.authorize(moved, DAEMON, ORG)).toEqual({
      authorized: false,
      attemptId: moved.attemptId,
      reason: 'head_changed',
      retryable: false
    })
  })

  it('refuses a started run whose barrier recorded no head at all', async () => {
    const { service } = build({
      hook: {
        getRun: async () => run({ turnStartedAt: new Date(1_000) }),
        getUnscoped: async () => hook(),
        recordStart: async () => true
      } as CodeHostReviewBrokerDeps['hook']
    })
    const input = authorizeInput()
    expect(await service.authorize(input, DAEMON, ORG)).toMatchObject({ reason: 'head_changed', retryable: false })
  })

  it('stays graceful for a run started before the provider-neutral barrier existed', async () => {
    const { service } = build()
    expect(await service.authorize(authorizeInput(), DAEMON, ORG)).toMatchObject({ authorized: true })
  })

  it('refuses an event the live review policy does not allow', async () => {
    const { service } = build({
      hook: {
        getRun: async () => run(),
        getUnscoped: async () => hook({ reviewPolicy: 'comment' }),
        recordStart: async () => true
      } as CodeHostReviewBrokerDeps['hook']
    })
    const input = authorizeInput({ requestedEvent: 'APPROVE', requestedVerdict: 'pass' })
    expect(await service.authorize(input, DAEMON, ORG)).toMatchObject({ reason: 'policy_denied' })
  })

  it('refuses a contradictory event and verdict before any provider effect', async () => {
    const { service } = build()
    await expect(
      service.authorize(authorizeInput({ requestedEvent: 'APPROVE', requestedVerdict: 'fail' }), DAEMON, ORG)
    ).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('refuses a project with no ready publishing identity, and lets the adapter retry', async () => {
    const { service } = build({ publisher: async () => null })
    const input = authorizeInput()
    expect(await service.authorize(input, DAEMON, ORG)).toEqual({
      authorized: false,
      attemptId: input.attemptId,
      reason: 'binding_unavailable',
      retryable: true
    })
  })

  it('denies a daemon that is not the accepted dispatch daemon', async () => {
    const { service } = build()
    await expect(service.authorize(authorizeInput(), OTHER_DAEMON, ORG)).rejects.toBeInstanceOf(
      CodeHostReviewBrokerError
    )
  })

  it('denies a foreign organization on the same accepted run', async () => {
    const { service } = build()
    await expect(service.authorize(authorizeInput(), DAEMON, 'org-2')).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })
})

describe('operation-record ledger', () => {
  async function withLease() {
    const built = build()
    const input = authorizeInput()
    const granted = await built.service.authorize(input, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    return { ...built, attemptId: input.attemptId, fence: granted.lease.fence }
  }

  it('permits exactly one outbound request per record', async () => {
    const { service, attemptId, fence } = await withLease()
    const issued = await service.operate(
      {
        op: 'issue',
        attemptId,
        fence,
        kind: 'draft_create',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    const token = randomUUID()
    const started = await service.operate(
      { op: 'start', attemptId, fence, recordId: issued.recordId, startToken: token },
      DAEMON,
      ORG
    )
    expect(started.state).toBe('request_started')
    // The SAME intended request retransmitted after a lost reply is idempotent…
    expect(
      (
        await service.operate(
          { op: 'start', attemptId, fence, recordId: issued.recordId, startToken: token },
          DAEMON,
          ORG
        )
      ).state
    ).toBe('request_started')
    // …but a second, different one is refused, so no second request is ever permitted.
    await expect(
      service.operate(
        { op: 'start', attemptId, fence, recordId: issued.recordId, startToken: randomUUID() },
        DAEMON,
        ORG
      )
    ).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('refuses to hand a used permit back out under the same coordinates', async () => {
    const { service, attemptId, fence } = await withLease()
    const coords = {
      op: 'issue' as const,
      attemptId,
      fence,
      kind: 'draft_create' as const,
      method: 'POST' as const,
      target: '/projects/4455667/merge_requests/42/draft_notes',
      ordinal: 0
    }
    const issued = await service.operate(coords, DAEMON, ORG)
    // A retransmitted issue returns the same permit while it is still unused.
    expect((await service.operate(coords, DAEMON, ORG)).recordId).toBe(issued.recordId)
    await service.operate(
      { op: 'start', attemptId, fence, recordId: issued.recordId, startToken: randomUUID() },
      DAEMON,
      ORG
    )
    await expect(service.operate(coords, DAEMON, ORG)).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('moves the lease phase on publication and refuses a stale fence', async () => {
    const { service, attemptId, fence } = await withLease()
    const issued = await service.operate(
      {
        op: 'issue',
        attemptId,
        fence,
        kind: 'bulk_publish',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes/bulk_publish',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    expect(issued.phase).toBe('publishing')
    await service.operate(
      { op: 'start', attemptId, fence, recordId: issued.recordId, startToken: randomUUID() },
      DAEMON,
      ORG
    )
    const settled = await service.operate(
      { op: 'settle', attemptId, fence, recordId: issued.recordId, outcome: { kind: 'deterministic', status: 204 } },
      DAEMON,
      ORG
    )
    expect(settled.phase).toBe('classifying')
    await expect(
      service.operate(
        {
          op: 'issue',
          attemptId,
          fence: '999',
          kind: 'approval',
          method: 'POST',
          target: '/projects/4455667/merge_requests/42/approve',
          ordinal: 0
        },
        DAEMON,
        ORG
      )
    ).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('renews only for the owning daemon at the current fence', async () => {
    const { service, attemptId, fence } = await withLease()
    expect((await service.renew({ attemptId, fence }, DAEMON, ORG)).phase).toBe('open')
    await expect(service.renew({ attemptId, fence }, OTHER_DAEMON, ORG)).rejects.toBeInstanceOf(
      CodeHostReviewBrokerError
    )
    await expect(service.renew({ attemptId, fence: '999' }, DAEMON, ORG)).rejects.toBeInstanceOf(
      CodeHostReviewBrokerError
    )
  })
})

describe('review result recording (§15.2)', () => {
  async function withLease() {
    const built = build()
    const input = authorizeInput()
    const granted = await built.service.authorize(input, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    return { ...built, attemptId: input.attemptId, fence: granted.lease.fence }
  }

  it('stores the normalized outcome and its external ids, and nothing else', async () => {
    const { service, attemptId, leases } = await withLease()
    const accepted = await service.recordResult(
      resultInput(attemptId, { externalIds: [{ kind: 'note', externalId: '778899' }] }),
      DAEMON,
      ORG
    )
    expect(accepted).toEqual({ accepted: true, phase: 'settled' })
    const stored = leases.outcomes.get(attemptId)
    expect(stored).toEqual({ state: 'submitted', externalIds: ['note:778899'] })
    // No field on the stored outcome can hold a body, and the encoding proves it.
    expect(stored?.externalIds.every((ref) => /^[a-z_]+:\d+$/.test(ref))).toBe(true)
  })

  it('releases the lease for a classified outcome so the next attempt may start', async () => {
    const { service, attemptId } = await withLease()
    await service.recordResult(resultInput(attemptId, { state: 'approval_not_recorded' }), DAEMON, ORG)
    const next = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    expect((await service.authorize(next, OTHER_DAEMON, ORG)).authorized).toBe(true)
  })

  it('locks the merge request when the outcome proves nothing', async () => {
    const { service, attemptId } = await withLease()
    const locked = await service.recordResult(resultInput(attemptId, { state: 'ambiguous_locked' }), DAEMON, ORG)
    expect(locked.phase).toBe('ambiguous_locked')
    const next = authorizeInput()
    expect(await service.authorize(next, DAEMON, ORG)).toMatchObject({
      reason: 'ambiguous_locked',
      retryable: false
    })
  })

  it('is idempotent on a retransmit and refuses a second, different classification', async () => {
    const { service, attemptId } = await withLease()
    await service.recordResult(resultInput(attemptId), DAEMON, ORG)
    expect(await service.recordResult(resultInput(attemptId), DAEMON, ORG)).toEqual({
      accepted: true,
      phase: 'settled'
    })
    await expect(
      service.recordResult(resultInput(attemptId, { state: 'not_submitted' }), DAEMON, ORG)
    ).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('refuses a result whose event or verdict is not the reserved one', async () => {
    const { service, attemptId } = await withLease()
    await expect(
      service.recordResult(
        resultInput(attemptId, { event: 'REQUEST_CHANGES', verdict: 'fail', state: 'submitted' }),
        DAEMON,
        ORG
      )
    ).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })
})

describe('a result releases the lease only through the ledger (§15.1)', () => {
  async function withPermit(kind: 'draft_create' | 'bulk_publish' = 'bulk_publish') {
    const built = build()
    const input = authorizeInput()
    const granted = await built.service.authorize(input, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    const fence = granted.lease.fence
    const issued = await built.service.operate(
      {
        op: 'issue',
        attemptId: input.attemptId,
        fence,
        kind,
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    return { ...built, attemptId: input.attemptId, fence, recordId: issued.recordId }
  }

  it('an outstanding started record keeps the attempt owned, and the next one meets a lock', async () => {
    const { service, advance, attemptId, fence, recordId, leases } = await withPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)

    // The outcome IS recorded — the daemon's classification is not lost — but ownership stays.
    expect(await service.recordResult(resultInput(attemptId), DAEMON, ORG)).toEqual({
      accepted: true,
      phase: 'classifying'
    })
    expect(leases.outcomes.get(attemptId)).toEqual({ state: 'submitted', externalIds: [] })
    expect([...leases.leases.values()][0]?.attemptId).toBe(attemptId)

    // A newer attempt gets contention now and a lock later — never the settled fast path.
    const contender = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    expect(await service.authorize(contender, OTHER_DAEMON, ORG)).toMatchObject({ reason: 'lease_held' })
    advance(10 * 60 * 1000)
    const later = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    expect(await service.authorize(later, OTHER_DAEMON, ORG)).toEqual({
      authorized: false,
      attemptId: later.attemptId,
      reason: 'ambiguous_locked',
      retryable: false
    })
  })

  it('settling that record afterwards re-runs the release and lets the next attempt in', async () => {
    const { service, advance, attemptId, fence, recordId, leases } = await withPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.recordResult(resultInput(attemptId), DAEMON, ORG)

    const settled = await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'deterministic', status: 204 } },
      DAEMON,
      ORG
    )
    expect(settled.phase).toBe('settled')
    expect([...leases.leases.values()][0]?.attemptId).toBeNull()

    advance(1_000)
    const next = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    const taken = await service.authorize(next, OTHER_DAEMON, ORG)
    expect(taken.authorized).toBe(true)
    if (taken.authorized) expect(taken.lease.fence).toBe('2')
  })

  it('an ambiguous record holds the attempt until its marker is positively identified', async () => {
    const { service, attemptId, fence, recordId } = await withPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'ambiguous', code: 'response_ambiguous' } },
      DAEMON,
      ORG
    )
    expect(await service.recordResult(resultInput(attemptId), DAEMON, ORG)).toEqual({
      accepted: true,
      phase: 'classifying'
    })
    const identified = await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'deterministic', status: 200, externalId: '99' } },
      DAEMON,
      ORG
    )
    expect(identified.phase).toBe('settled')
  })

  it('returning the last unused permit is the other way the lease settles', async () => {
    const { service, attemptId, fence, recordId } = await withPermit('draft_create')
    expect(await service.recordResult(resultInput(attemptId, { state: 'not_submitted' }), DAEMON, ORG)).toEqual({
      accepted: true,
      phase: 'classifying'
    })
    const returned = await service.operate({ op: 'return-unused', attemptId, fence, recordId }, DAEMON, ORG)
    expect(returned.phase).toBe('settled')
  })

  it('an attempt that issued no permit at all still releases immediately', async () => {
    const built = build()
    const input = authorizeInput()
    expect((await built.service.authorize(input, DAEMON, ORG)).authorized).toBe(true)
    expect(await built.service.recordResult(resultInput(input.attemptId), DAEMON, ORG)).toEqual({
      accepted: true,
      phase: 'settled'
    })
  })
})

describe('a terminal operation stays idempotent after the lease is released (§15.1)', () => {
  async function withStartedPermit(kind: 'draft_create' | 'bulk_publish' = 'bulk_publish') {
    const built = build()
    const input = authorizeInput()
    const granted = await built.service.authorize(input, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    const fence = granted.lease.fence
    const issued = await built.service.operate(
      {
        op: 'issue',
        attemptId: input.attemptId,
        fence,
        kind,
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    return { ...built, attemptId: input.attemptId, fence, recordId: issued.recordId }
  }

  it('answers a retransmitted settle from the durable record after release', async () => {
    const { service, attemptId, fence, recordId, leases } = await withStartedPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.recordResult(resultInput(attemptId), DAEMON, ORG)
    const settle = {
      op: 'settle' as const,
      attemptId,
      fence,
      recordId,
      outcome: { kind: 'deterministic' as const, status: 204 }
    }
    const first = await service.operate(settle, DAEMON, ORG)
    expect(first).toMatchObject({ state: 'settled', phase: 'settled' })
    // The lease is gone, so a lost reply must still be answerable from the record alone.
    expect([...leases.leases.values()][0]?.attemptId).toBeNull()
    expect(await service.operate(settle, DAEMON, ORG)).toEqual(first)
  })

  it('answers a retransmitted return-unused from the durable record after release', async () => {
    const { service, attemptId, fence, recordId } = await withStartedPermit('draft_create')
    await service.recordResult(resultInput(attemptId, { state: 'not_submitted' }), DAEMON, ORG)
    const ret = { op: 'return-unused' as const, attemptId, fence, recordId }
    const first = await service.operate(ret, DAEMON, ORG)
    expect(first).toMatchObject({ state: 'unused', phase: 'settled' })
    expect(await service.operate(ret, DAEMON, ORG)).toEqual(first)
  })

  it('refuses a DIFFERENT outcome on the now-terminal record instead of replaying it', async () => {
    const { service, attemptId, fence, recordId } = await withStartedPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.recordResult(resultInput(attemptId), DAEMON, ORG)
    await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'deterministic', status: 204 } },
      DAEMON,
      ORG
    )
    await expect(
      service.operate(
        { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'deterministic', status: 201 } },
        DAEMON,
        ORG
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      service.operate({ op: 'return-unused', attemptId, fence, recordId }, DAEMON, ORG)
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a replay from a foreign attempt or a foreign organization', async () => {
    const { service, attemptId, fence, recordId } = await withStartedPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.recordResult(resultInput(attemptId), DAEMON, ORG)
    const settle = {
      op: 'settle' as const,
      attemptId,
      fence,
      recordId,
      outcome: { kind: 'deterministic' as const, status: 204 }
    }
    await service.operate(settle, DAEMON, ORG)
    await expect(service.operate({ ...settle, attemptId: randomUUID() }, DAEMON, ORG)).rejects.toBeInstanceOf(
      CodeHostReviewBrokerError
    )
    await expect(service.operate(settle, DAEMON, 'org-2')).rejects.toBeInstanceOf(CodeHostReviewBrokerError)
  })

  it('still routes a positive identification of an ambiguous record through the lease', async () => {
    const { service, attemptId, fence, recordId } = await withStartedPermit()
    await service.operate({ op: 'start', attemptId, fence, recordId, startToken: randomUUID() }, DAEMON, ORG)
    await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'ambiguous', code: 'response_ambiguous' } },
      DAEMON,
      ORG
    )
    // An ambiguous record is terminal-looking but still advanceable, so this must MUTATE.
    const identified = await service.operate(
      { op: 'settle', attemptId, fence, recordId, outcome: { kind: 'deterministic', status: 200, externalId: '99' } },
      DAEMON,
      ORG
    )
    expect(identified.state).toBe('settled')
  })
})

describe('a replayed terminal operation reports its own fence phase (§15.1)', () => {
  it('does not dress a completed release in a successor attempt lifecycle', async () => {
    const built = build()
    const input = authorizeInput()
    const granted = await built.service.authorize(input, DAEMON, ORG)
    if (!granted.authorized) throw new Error('expected a lease')
    const fence = granted.lease.fence
    const issued = await built.service.operate(
      {
        op: 'issue',
        attemptId: input.attemptId,
        fence,
        kind: 'bulk_publish',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes/bulk_publish',
        ordinal: 0
      },
      DAEMON,
      ORG
    )
    await built.service.operate(
      { op: 'start', attemptId: input.attemptId, fence, recordId: issued.recordId, startToken: randomUUID() },
      DAEMON,
      ORG
    )
    await built.service.recordResult(resultInput(input.attemptId), DAEMON, ORG)
    const settle = {
      op: 'settle' as const,
      attemptId: input.attemptId,
      fence,
      recordId: issued.recordId,
      outcome: { kind: 'deterministic' as const, status: 204 }
    }
    const first = await built.service.operate(settle, DAEMON, ORG)
    expect(first.phase).toBe('settled')

    // A waiting attempt takes the freed subject and starts publishing at the next fence.
    built.advance(1_000)
    const successor = authorizeInput({ deliveryKey: SECOND_DELIVERY, snapshot: SECOND_SNAPSHOT })
    const taken = await built.service.authorize(successor, OTHER_DAEMON, ORG)
    if (!taken.authorized) throw new Error('expected the successor to acquire')
    expect(taken.lease.fence).toBe('2')
    await built.service.operate(
      {
        op: 'issue',
        attemptId: successor.attemptId,
        fence: taken.lease.fence,
        kind: 'bulk_publish',
        method: 'POST',
        target: '/projects/4455667/merge_requests/42/draft_notes/bulk_publish',
        ordinal: 0
      },
      OTHER_DAEMON,
      ORG
    )
    expect([...built.leases.leases.values()][0]?.phase).toBe('publishing')

    // The lost acknowledgement replays with the OLD record's fence-coherent phase.
    expect(await built.service.operate(settle, DAEMON, ORG)).toEqual(first)
    // …and the successor's live state is untouched by that read.
    expect([...built.leases.leases.values()][0]).toMatchObject({
      attemptId: successor.attemptId,
      fence: 2n,
      phase: 'publishing'
    })
  })
})
