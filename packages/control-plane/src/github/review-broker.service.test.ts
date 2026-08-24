import { describe, expect, it, vi } from 'vitest'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type { AgentRecord, HookRecord, HookRepo, HookRunRecord } from '../persistence/ports.js'
import { githubHookRun } from '../../test/fixtures/github-hook-run.js'
import { HOOK_DELIVERY_REASON_DAEMON_OFFLINE } from '@agentconnect.md/protocol'
import { GitCredDeniedError } from './service.js'
import {
  GithubReviewBrokerError,
  GithubReviewBrokerService,
  type GithubReviewBrokerDeps
} from './review-broker.service.js'

const HOOK = HookId('11111111-1111-4111-8111-111111111111')
const AGENT = AgentId('22222222-2222-4222-8222-222222222222')
const DAEMON = DaemonId('33333333-3333-4333-8333-333333333333')
const OLD_DAEMON = DaemonId('55555555-5555-4555-8555-555555555555')
const ATTEMPT = '44444444-4444-4444-8444-444444444444'

function run(overrides: Partial<HookRunRecord> = {}): HookRunRecord {
  return githubHookRun({
    id: 'run-1',
    hookId: HOOK,
    event: 'pull_request:synchronize',
    agentId: AGENT,
    configRevision: 7n,
    dispatchRevision: 9n,
    dispatchDaemonId: DAEMON,
    repoId: 123n,
    repoFullName: 'acme/widgets',
    sourceInstallationId: 456n,
    pullNumber: 42,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    reportSha: 'head-sha',
    startedAt: new Date(1_000),
    turnStartedAt: new Date(2_000),
    ...overrides
  })
}

function hook(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HOOK,
    orgId: OrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    agentId: AGENT,
    kind: 'github',
    name: 'review',
    enabled: true,
    sessionMode: 'perDelivery',
    urlToken: null,
    hmacConfigured: false,
    repoId: 123n,
    repoFullName: 'acme/widgets',
    events: ['pull_request:*'],
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    configRevision: 7n,
    dispatchRevision: 9n,
    projectionEpoch: 1n,
    reviewPolicy: 'full',
    reportingMode: 'check',
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

const agent = {
  id: AGENT,
  orgId: OrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  daemonId: DAEMON,
  status: 'active'
} as unknown as AgentRecord

const snapshot = {
  configRevision: '7',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON,
  reviewPolicy: 'full' as const,
  reportingMode: 'check' as const,
  gateMode: 'informational' as const
}

function authorizeInput(
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' = 'APPROVE',
  verdict: 'pass' | 'fail' | 'neutral' = event === 'APPROVE' ? 'pass' : event === 'REQUEST_CHANGES' ? 'fail' : 'neutral'
) {
  return {
    hookId: HOOK,
    deliveryKey: 'delivery-1',
    attemptId: ATTEMPT,
    requestedEvent: event,
    requestedVerdict: verdict,
    snapshot
  }
}

function setup(overrides: Partial<GithubReviewBrokerDeps> = {}) {
  let currentRun = run()
  const hookRepo = {
    getUnscoped: vi.fn(async () => hook()),
    getRun: vi.fn(async () => currentRun),
    recordStart: vi.fn<HookRepo['recordStart']>(async () => true),
    reserveReviewAttempt: vi.fn<HookRepo['reserveReviewAttempt']>(async (_hookId, _daemonId, input) => {
      currentRun = run({
        reviewAttemptId: input.attemptId,
        reviewAttemptState: 'reserved',
        reviewEvent: input.requestedEvent,
        verdict: input.requestedVerdict
      })
      return 'reserved' as const
    }),
    recordReviewResult: vi.fn(async (_hookId, _daemonId, input) => {
      if (input.state === 'released') currentRun = run()
      return true
    })
  }
  const deps = {
    hook: hookRepo,
    agent: { getUnscoped: vi.fn(async () => agent) },
    github: {
      mintReviewForAgent: vi.fn(async () => ({
        token: 'broker-secret',
        ttlSec: 3_540,
        expiresAt: '2026-07-11T01:00:00.000Z',
        repoFullName: 'acme/widgets',
        access: 'read' as const,
        installationId: 456n
      })),
      validateReviewForAgent: vi.fn(
        async () =>
          ({
            installation: { installationId: 456n }
          }) as never
      )
    },
    clock: { now: () => 3_000 },
    ...overrides
  } as GithubReviewBrokerDeps
  return {
    service: new GithubReviewBrokerService(deps),
    deps,
    hookRepo,
    setRun: (next: HookRunRecord) => (currentRun = next)
  }
}

describe('GithubReviewBrokerService', () => {
  it('records hook/start only across the exact accepted and current dispatch fence', async () => {
    const { service, hookRepo } = setup()
    await service.start(
      {
        hookId: HOOK,
        agentId: AGENT,
        deliveryKey: 'delivery-1',
        sessionId: 'session/with space',
        event: 'pull_request:synchronize',
        ...snapshot,
        github: {
          repoId: '123',
          repoFullName: 'acme/widgets',
          sourceInstallationId: '456',
          subjectKind: 'pull_request',
          pullNumber: 42,
          headSha: 'head-sha',
          baseSha: 'base-sha',
          reportSha: 'head-sha',
          isDraft: false,
          baseChanged: false
        }
      },
      DAEMON
    )
    expect(hookRepo.recordStart).toHaveBeenCalledWith(
      HOOK,
      DAEMON,
      expect.objectContaining({
        deliveryKey: 'delivery-1',
        agentId: AGENT,
        sessionId: 'session/with space',
        configRevision: 7n,
        dispatchRevision: 9n,
        dispatchDaemonId: DAEMON,
        startedAt: new Date(2_000),
        repoId: 123n,
        pullNumber: 42,
        headSha: 'head-sha',
        baseSha: 'base-sha'
      })
    )
  })

  it('uses exact-current hook/start to recover a claimed offline row when accepted reporting was lost', async () => {
    const state = setup()
    state.setRun(
      run({
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
        dispatchRevision: 8n,
        dispatchDaemonId: OLD_DAEMON,
        turnStartedAt: null,
        completedAt: new Date(1_000),
        redeliveryAttempts: 1,
        redeliveryLastRequestedAt: new Date(1_500),
        redeliveryNextAttemptAt: null
      })
    )
    state.hookRepo.recordStart.mockImplementation(async (_hookId, _daemonId, input) => {
      state.setRun(
        run({
          status: 'running',
          reason: null,
          dispatchRevision: input.dispatchRevision,
          dispatchDaemonId: input.dispatchDaemonId,
          turnStartedAt: input.startedAt,
          completedAt: null,
          redeliveryAttempts: 1,
          redeliveryLastRequestedAt: new Date(1_500),
          redeliveryNextAttemptAt: null
        })
      )
      return true
    })

    await state.service.start(
      {
        hookId: HOOK,
        agentId: AGENT,
        deliveryKey: 'delivery-1',
        event: 'pull_request:synchronize',
        ...snapshot,
        github: {
          repoId: '123',
          repoFullName: 'acme/widgets',
          sourceInstallationId: '456',
          subjectKind: 'pull_request',
          pullNumber: 42,
          headSha: 'head-sha',
          baseSha: 'base-sha',
          reportSha: 'head-sha',
          isDraft: false,
          baseChanged: false
        }
      },
      DAEMON
    )

    expect(state.hookRepo.recordStart).toHaveBeenCalledOnce()
    expect(state.hookRepo.recordStart).toHaveBeenCalledWith(
      HOOK,
      DAEMON,
      expect.objectContaining({
        dispatchRevision: 9n,
        dispatchDaemonId: DAEMON,
        reviewPolicySnapshot: 'full',
        reportingModeSnapshot: 'check',
        gateModeSnapshot: 'informational'
      })
    )
  })

  it('takes the lower of the fire snapshot and current policy before reserving', async () => {
    const { service, hookRepo } = setup()
    hookRepo.getUnscoped.mockResolvedValue(hook({ reviewPolicy: 'comment' }))
    await expect(service.authorize(authorizeInput('APPROVE'), DAEMON)).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    expect(hookRepo.reserveReviewAttempt).not.toHaveBeenCalled()
  })

  it('reserves first and returns only the HookRun trusted target with the broker token', async () => {
    const { service, deps, hookRepo } = setup()
    const result = await service.authorize(authorizeInput(), DAEMON)

    expect(hookRepo.reserveReviewAttempt).toHaveBeenCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      agentId: AGENT,
      configRevision: 7n,
      dispatchRevision: 9n,
      dispatchDaemonId: DAEMON,
      requestedEvent: 'APPROVE',
      requestedVerdict: 'pass'
    })
    expect(deps.github.mintReviewForAgent).toHaveBeenCalledWith(agent, 123n, 'acme/widgets', 'APPROVE')
    expect(deps.github.validateReviewForAgent).toHaveBeenCalledWith(agent, 123n, 'acme/widgets', 'APPROVE')
    expect(result).toEqual({
      attemptId: ATTEMPT,
      token: 'broker-secret',
      ttlSec: 3_540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoId: '123',
      repoFullName: 'acme/widgets',
      pullNumber: 42,
      expectedHeadSha: 'head-sha',
      expectedBaseSha: 'base-sha'
    })
  })

  it('releases a reservation when token minting fails before any review can be posted', async () => {
    const { service, hookRepo } = setup({
      github: {
        mintReviewForAgent: vi.fn(async () => {
          throw new GitCredDeniedError('installation unavailable', 'LEASE_DENIED', true)
        }),
        validateReviewForAgent: vi.fn()
      }
    })
    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toEqual(
      new GithubReviewBrokerError('LEASE_DENIED', 'installation unavailable', true)
    )
    expect(hookRepo.recordReviewResult).toHaveBeenCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'released'
    })
  })

  it('does not expose a token when the repo grant is revoked during mint', async () => {
    const { service, hookRepo } = setup({
      github: {
        mintReviewForAgent: vi.fn(async () => ({
          token: 'must-not-escape',
          ttlSec: 3_540,
          expiresAt: '2026-07-11T01:00:00.000Z',
          repoFullName: 'acme/widgets',
          access: 'read' as const,
          installationId: 456n
        })),
        validateReviewForAgent: vi.fn(async () => {
          throw new GitCredDeniedError('repository authorization was revoked', 'SCOPE_DENIED', false)
        })
      }
    })

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.recordReviewResult).toHaveBeenCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'released'
    })
  })

  it('does not expose a token when the live installation changes while minting', async () => {
    let markMintStarted!: () => void
    const mintStarted = new Promise<void>((resolve) => {
      markMintStarted = resolve
    })
    let releaseMint!: () => void
    const mintReleased = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    let liveInstallationId = 456n
    const { service, hookRepo } = setup({
      github: {
        mintReviewForAgent: vi.fn(async () => {
          markMintStarted()
          await mintReleased
          return {
            token: 'must-not-escape',
            ttlSec: 3_540,
            expiresAt: '2026-07-11T01:00:00.000Z',
            repoFullName: 'acme/widgets',
            access: 'read' as const,
            installationId: 456n
          }
        }),
        validateReviewForAgent: vi.fn(
          async () =>
            ({
              installation: { installationId: liveInstallationId }
            }) as never
        )
      }
    })

    const authorization = service.authorize(authorizeInput(), DAEMON)
    await mintStarted
    liveInstallationId = 789n
    releaseMint()

    await expect(authorization).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(hookRepo.recordReviewResult).toHaveBeenCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'released'
    })
  })

  it('rejects an accepted turn after its hook is retargeted to another repository', async () => {
    const { service, hookRepo } = setup()
    hookRepo.getUnscoped.mockResolvedValue(hook({ repoId: 999n, repoFullName: 'acme/other' }))

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.reserveReviewAttempt).not.toHaveBeenCalled()
  })

  it.each([
    ['review lifecycle', { projectionEpoch: 2n }],
    ['dispatch placement', { dispatchRevision: 10n }]
  ] as const)('rejects an old turn after a same-value %s ABA', async (_label, changed) => {
    const { service, hookRepo } = setup()
    hookRepo.getUnscoped.mockResolvedValue(hook(changed))

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.reserveReviewAttempt).not.toHaveBeenCalled()
  })

  it('does not expose a token when the review lifecycle epoch changes during mint', async () => {
    const { service, hookRepo } = setup()
    hookRepo.getUnscoped.mockResolvedValueOnce(hook()).mockResolvedValue(hook({ projectionEpoch: 2n }))

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.recordReviewResult).toHaveBeenCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'released'
    })
  })

  it('keeps an existing blocked reservation pinned when reconciliation authorization fails', async () => {
    const { service, deps, hookRepo, setRun } = setup()
    setRun(run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'blocked', reviewEvent: 'APPROVE', verdict: 'pass' }))
    hookRepo.reserveReviewAttempt.mockResolvedValue('idempotent')
    vi.mocked(deps.github.mintReviewForAgent).mockRejectedValue(
      new GitCredDeniedError('installation unavailable', 'LEASE_DENIED', true)
    )

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(hookRepo.recordReviewResult).not.toHaveBeenCalled()
  })

  it('reauthorizes the exact blocked event and verdict for marker reconciliation', async () => {
    const { service, hookRepo, setRun } = setup()
    setRun(run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'blocked', reviewEvent: 'COMMENT', verdict: 'neutral' }))
    hookRepo.reserveReviewAttempt.mockResolvedValue('idempotent')

    await expect(service.authorize(authorizeInput('COMMENT', 'neutral'), DAEMON)).resolves.toMatchObject({
      attemptId: ATTEMPT,
      expectedHeadSha: 'head-sha'
    })
    expect(hookRepo.recordReviewResult).not.toHaveBeenCalled()
  })

  it('does not release a blocked reservation when policy changes during reconciliation authorization', async () => {
    const { service, hookRepo, setRun } = setup()
    setRun(run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'blocked', reviewEvent: 'APPROVE', verdict: 'pass' }))
    hookRepo.reserveReviewAttempt.mockResolvedValue('idempotent')
    hookRepo.getUnscoped.mockResolvedValueOnce(hook()).mockResolvedValueOnce(hook({ reviewPolicy: 'off' }))

    await expect(service.authorize(authorizeInput(), DAEMON)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.recordReviewResult).not.toHaveBeenCalled()
  })

  it('rejects incompatible event/verdict pairs before reserving', async () => {
    const { service, hookRepo } = setup()
    await expect(service.authorize(authorizeInput('APPROVE', 'fail'), DAEMON)).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    expect(hookRepo.reserveReviewAttempt).not.toHaveBeenCalled()
  })

  it('maps submitted/not_submitted/ambiguous onto metadata-only persistence states', async () => {
    const { service, hookRepo, setRun } = setup()
    setRun(run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'reserved', reviewEvent: 'APPROVE', verdict: 'pass' }))
    await service.recordResult(
      {
        hookId: HOOK,
        deliveryKey: 'delivery-1',
        attemptId: ATTEMPT,
        snapshot,
        result: {
          state: 'submitted',
          reviewId: '9007199254740993',
          event: 'APPROVE',
          verdict: 'pass',
          commitId: 'head-sha'
        }
      },
      DAEMON
    )
    expect(hookRepo.recordReviewResult).toHaveBeenLastCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'submitted',
      reviewId: '9007199254740993',
      event: 'APPROVE',
      verdict: 'pass',
      commitId: 'head-sha'
    })

    setRun(
      run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'reserved', reviewEvent: 'COMMENT', verdict: 'neutral' })
    )
    await service.recordResult(
      {
        hookId: HOOK,
        deliveryKey: 'delivery-1',
        attemptId: ATTEMPT,
        snapshot,
        result: { state: 'not_submitted', code: 'validation' }
      },
      DAEMON
    )
    expect(hookRepo.recordReviewResult).toHaveBeenLastCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'released',
      code: 'validation'
    })

    setRun(
      run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'reserved', reviewEvent: 'COMMENT', verdict: 'neutral' })
    )
    await service.recordResult(
      {
        hookId: HOOK,
        deliveryKey: 'delivery-1',
        attemptId: ATTEMPT,
        snapshot,
        result: { state: 'ambiguous', code: 'timeout' }
      },
      DAEMON
    )
    expect(hookRepo.recordReviewResult).toHaveBeenLastCalledWith(HOOK, DAEMON, {
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT,
      state: 'blocked',
      code: 'timeout'
    })
  })

  it('rejects a submitted verdict that differs from the durable reservation', async () => {
    const { service, hookRepo, setRun } = setup()
    setRun(
      run({ reviewAttemptId: ATTEMPT, reviewAttemptState: 'reserved', reviewEvent: 'COMMENT', verdict: 'neutral' })
    )
    await expect(
      service.recordResult(
        {
          hookId: HOOK,
          deliveryKey: 'delivery-1',
          attemptId: ATTEMPT,
          snapshot,
          result: {
            state: 'submitted',
            reviewId: '9007199254740993',
            event: 'COMMENT',
            verdict: 'pass',
            commitId: 'head-sha'
          }
        },
        DAEMON
      )
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(hookRepo.recordReviewResult).not.toHaveBeenCalled()
  })
})
