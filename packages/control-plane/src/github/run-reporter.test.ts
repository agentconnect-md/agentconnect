import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  HOOK_REPORT_REASON_AGENT_HANDOVER,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { githubHookRun } from '../../test/fixtures/github-hook-run.js'
import type {
  AgentRecord,
  GithubInstallationRecord,
  HookRepo,
  HookReviewProjectionRecord,
  HookRunRecord
} from '../persistence/ports.js'
import type { GithubService } from './service.js'
import { GithubRunCoordinator, GithubRunReporter } from './run-reporter.js'

const NOW = 1_700_000_000_000
const hookId = HookId('00000000-0000-4000-8000-000000000001')
const agentId = AgentId('00000000-0000-4000-8000-000000000002')
const daemonId = DaemonId('00000000-0000-4000-8000-000000000003')
const orgId = OrgId('org_1')

function run(overrides: Partial<HookRunRecord> = {}): HookRunRecord {
  return githubHookRun({
    id: 'run_1',
    hookId,
    agentId,
    configRevision: 3n,
    dispatchRevision: 5n,
    dispatchDaemonId: daemonId,
    repoId: 42n,
    repoFullName: 'acme/repo',
    sourceInstallationId: 77n,
    pullNumber: 9,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    reportSha: 'a'.repeat(40),
    startedAt: new Date(NOW),
    ...overrides
  })
}

function projection(overrides: Partial<HookReviewProjectionRecord> = {}): HookReviewProjectionRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    hookId,
    orgId,
    agentId,
    agentName: 'review-agent',
    lastResolvedInstallationId: null,
    repoId: 42n,
    repoFullName: 'acme/repo',
    headSha: 'c'.repeat(40),
    reportSha: 'a'.repeat(40),
    projectionEpoch: 1n,
    generation: 1n,
    currentHookRunId: 'run_1',
    externalId: '10000000-0000-4000-8000-000000000001',
    checkRunId: null,
    mode: 'check',
    gateMode: 'informational',
    desiredState: 'queued',
    observedState: null,
    sealedThrough: 0n,
    subjectSyncGeneration: 0n,
    subjectSyncErrorCode: null,
    leaseOwner: 'worker-1',
    leaseUntil: new Date(NOW + 30_000),
    nextAttemptAt: new Date(NOW),
    attempts: 0,
    lastErrorCode: null,
    pendingIntent: null,
    writeMarker: null,
    writePhase: null,
    writeStartedAt: null,
    tombstonedAt: null,
    updatedAt: new Date(NOW),
    ...overrides
  }
}

function agent(): AgentRecord {
  return {
    id: agentId,
    orgId,
    name: 'review-agent',
    workspace: {
      mode: 'git',
      gitRepo: 'https://github.com/acme/repo.git',
      credential: { provider: 'github', installationId: 'installation-row', access: 'write' }
    },
    workspaceRepoId: 42n
  } as AgentRecord
}

function installation(): GithubInstallationRecord {
  return {
    installationId: 77n,
    orgId,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    permissions: { checks: 'write', pull_requests: 'read' },
    suspendedAt: null,
    revokedAt: null
  } as unknown as GithubInstallationRecord
}

function mintChecksForAgent() {
  return vi.fn(async () => ({
    cred: {
      token: 'ghs_test',
      ttlSec: 3_000,
      expiresAt: new Date(NOW + 3_000_000).toISOString(),
      repoFullName: 'acme/repo',
      access: 'read' as const
    },
    resolved: {
      kind: 'workspace' as const,
      repoId: 42n,
      repoFullName: 'acme/repo',
      access: 'write' as const,
      installation: installation()
    }
  }))
}

function associatedPull(p: HookReviewProjectionRecord, pullNumber = 9, headSha = p.headSha) {
  return {
    number: pullNumber,
    state: 'open',
    head: { sha: headSha },
    base: { sha: 'b'.repeat(40) }
  }
}

describe('GithubRunCoordinator', () => {
  it('opens queued only from a complete authoritative revision_event snapshot', async () => {
    const row = run()
    const p = projection()
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(async () => p),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const kick = vi.fn()
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as unknown as Pick<
        HookRepo,
        | 'getRun'
        | 'listRunsNeedingReviewProjection'
        | 'upsertReviewProjection'
        | 'bindRunProjection'
        | 'setProjectionDesired'
        | 'upsertReviewSubject'
      >,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW),
      kick
    })

    await coordinator.afterAccepted(hookId, row.deliveryKey)

    expect(hooks.upsertReviewProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        hookId,
        orgId,
        agentId,
        agentName: 'review-agent',
        reportSha: row.reportSha,
        desiredState: 'queued',
        mode: 'check',
        gateMode: 'informational'
      })
    )
    expect(hooks.bindRunProjection).toHaveBeenCalledWith(hookId, row.deliveryKey, p.id, 1n)
    expect(hooks.upsertReviewSubject).toHaveBeenCalledWith(
      expect.objectContaining({ projectionId: p.id, pullNumber: 9, headSha: row.headSha })
    )
    expect(kick).toHaveBeenCalledOnce()
  })

  it('never binds or converges a delayed edge onto a tombstoned projection', async () => {
    const row = run()
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(async () => projection({ tombstonedAt: new Date(NOW - 1_000) })),
      bindRunProjection: vi.fn(),
      setProjectionDesired: vi.fn(),
      upsertReviewSubject: vi.fn()
    }
    const kick = vi.fn()
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW),
      kick
    })

    await coordinator.afterAccepted(hookId, row.deliveryKey)

    expect(hooks.bindRunProjection).not.toHaveBeenCalled()
    expect(hooks.setProjectionDesired).not.toHaveBeenCalled()
    expect(hooks.upsertReviewSubject).not.toHaveBeenCalled()
    expect(kick).not.toHaveBeenCalled()
  })

  it('does not project comments or incomplete/stale reporting snapshots', async () => {
    const hooks = {
      getRun: vi.fn(async () => run({ projectionIntent: 'review_action_only' })),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(),
      bindRunProjection: vi.fn(),
      setProjectionDesired: vi.fn(),
      upsertReviewSubject: vi.fn()
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })
    await coordinator.afterAccepted(hookId, 'delivery-1')
    expect(hooks.upsertReviewProjection).not.toHaveBeenCalled()

    hooks.getRun.mockResolvedValue(run({ reportSha: null }))
    await coordinator.afterAccepted(hookId, 'delivery-1')
    expect(hooks.upsertReviewProjection).not.toHaveBeenCalled()
  })

  it('preserves the current revision verdict across a review-only COMMENT + neutral turn', async () => {
    const row = run({
      status: 'success',
      completedAt: new Date(NOW + 1_000),
      projectionIntent: 'review_action_only',
      reviewAttemptState: 'submitted',
      reviewEvent: 'COMMENT',
      verdict: 'neutral'
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(),
      bindRunProjection: vi.fn(),
      setProjectionDesired: vi.fn(),
      upsertReviewSubject: vi.fn()
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.afterReviewResult(hookId, row.deliveryKey)
    await coordinator.afterReport(hookId, row.deliveryKey)

    expect(hooks.upsertReviewProjection).not.toHaveBeenCalled()
    expect(hooks.bindRunProjection).not.toHaveBeenCalled()
    expect(hooks.setProjectionDesired).not.toHaveBeenCalled()
  })

  it('seals REQUEST_CHANGES over a later successful runtime report', async () => {
    const row = run({
      status: 'success',
      completedAt: new Date(NOW + 1_000),
      reviewAttemptState: 'submitted',
      reviewEvent: 'REQUEST_CHANGES',
      verdict: 'neutral'
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'neutral' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })
    await coordinator.afterReport(hookId, row.deliveryKey)
    expect(hooks.setProjectionDesired).toHaveBeenCalledWith(
      expect.any(String),
      1n,
      'action_required',
      expect.any(Date),
      row.id
    )
  })

  it.each([
    ['agent session start failure', 'session_start_failed'],
    ['provider quota exhaustion', HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED],
    ['provider authentication required', HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED]
  ])('projects and repairs %s as skipped', async (_label, reason) => {
    const row = run({
      status: 'failed',
      completedAt: new Date(NOW + 1_000),
      reason
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'failure' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.afterReport(hookId, row.deliveryKey)
    expect(hooks.setProjectionDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'skipped',
      expect.any(Date),
      row.id
    )

    hooks.setProjectionDesired.mockClear()
    await coordinator.repair()
    expect(hooks.setProjectionDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'skipped',
      expect.any(Date),
      row.id
    )
  })

  it('repairs definite pre-dispatch agent unavailability as skipped', async () => {
    const row = run({
      status: 'failed',
      completedAt: new Date(NOW + 1_000),
      reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'failure' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.repair()

    expect(hooks.setProjectionDesired).toHaveBeenCalledWith(expect.any(String), 1n, 'skipped', expect.any(Date), row.id)
  })

  it('keeps a failed formal-review effect authoritative over quota exhaustion', async () => {
    const row = run({
      status: 'failed',
      completedAt: new Date(NOW + 1_000),
      reason: HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
      reviewErrorCode: 'ambiguous_write',
      reviewAttemptState: 'blocked'
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'skipped' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.afterReport(hookId, row.deliveryKey)
    expect(hooks.setProjectionDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'failure',
      expect.any(Date),
      row.id
    )

    hooks.setProjectionDesired.mockClear()
    await coordinator.repair()
    expect(hooks.setProjectionDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'failure',
      expect.any(Date),
      row.id
    )
  })

  it('periodically repairs a committed start edge whose projection is still queued', async () => {
    const row = run({ turnStartedAt: new Date(NOW + 100) })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'queued' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const kick = vi.fn()
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW),
      kick
    })

    await expect(coordinator.repair()).resolves.toBe(1)

    expect(hooks.setProjectionDesired).toHaveBeenCalledWith(
      expect.any(String),
      1n,
      'in_progress',
      expect.any(Date),
      row.id
    )
    expect(kick).not.toHaveBeenCalled()
  })

  it('does not ask persistence to regress a terminal generation for a delayed start edge', async () => {
    const row = run({ turnStartedAt: new Date(NOW + 100) })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => []),
      upsertReviewProjection: vi.fn(async () =>
        projection({ desiredState: 'success', sealedThrough: 1n, observedState: 'success' })
      ),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.afterStart(hookId, row.deliveryKey)

    expect(hooks.bindRunProjection).toHaveBeenCalled()
    expect(hooks.setProjectionDesired).not.toHaveBeenCalled()
  })

  it('repairs a completion-first review_action_only row only after a submitted review', async () => {
    const row = run({
      status: 'success',
      completedAt: new Date(NOW + 500),
      projectionIntent: 'review_action_only',
      reviewAttemptState: 'submitted',
      reviewEvent: 'APPROVE',
      verdict: 'pass'
    })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'queued' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.repair()

    expect(hooks.setProjectionDesired).toHaveBeenCalledWith(expect.any(String), 1n, 'success', expect.any(Date), row.id)
  })

  it('repairs an unbound reaper outcome as timed_out rather than generic failure', async () => {
    const orphanedAt = new Date(NOW + 500)
    const row = run({ status: 'failed', completedAt: orphanedAt, orphanedAt })
    const hooks = {
      getRun: vi.fn(async () => row),
      listRunsNeedingReviewProjection: vi.fn(async () => [row]),
      upsertReviewProjection: vi.fn(async () => projection({ desiredState: 'queued' })),
      bindRunProjection: vi.fn(async () => true),
      setProjectionDesired: vi.fn(async () => true),
      upsertReviewSubject: vi.fn(async () => {})
    }
    const coordinator = new GithubRunCoordinator({
      hooks: hooks as never,
      agents: { getUnscoped: vi.fn(async () => agent()) },
      clock: new FakeClock(NOW)
    })

    await coordinator.repair()

    expect(hooks.setProjectionDesired).toHaveBeenCalledWith(
      expect.any(String),
      1n,
      'timed_out',
      expect.any(Date),
      row.id
    )
  })
})

describe('GithubRunReporter', () => {
  function worker(
    p: HookReviewProjectionRecord,
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    overrides: Partial<HookRepo> = {},
    currentAgent: AgentRecord | null = agent(),
    appSlug?: string
  ) {
    const hooks = {
      claimDueReviewProjections: vi.fn(async () => [p]),
      beginProjectionWrite: vi.fn(async () => true),
      completeProjectionWrite: vi.fn(async () => true),
      advancePendingReviewProjection: vi.fn(async () => null),
      retryProjectionWrite: vi.fn(async () => true),
      blockProjection: vi.fn(async () => true),
      settleReviewProjection: vi.fn(async () => true),
      getReviewProjection: vi.fn(async () => ({ ...p, observedState: p.desiredState, nextAttemptAt: null })),
      refreshReviewProjectionTarget: vi.fn(async () => true),
      synchronizeReviewSubjects: vi.fn(async () => true),
      getRunById: vi.fn(async () => run()),
      listReviewSubjects: vi.fn(async () => [
        {
          projectionId: p.id,
          pullNumber: 9,
          headSha: p.headSha,
          baseSha: 'b'.repeat(40),
          isOpen: true,
          updatedAt: new Date(NOW)
        }
      ]),
      ...overrides
    }
    const mint = mintChecksForAgent()
    const cleanupMint = vi.fn(async () => ({
      cred: {
        token: 'ghs_cleanup',
        ttlSec: 3_000,
        expiresAt: new Date(NOW + 3_000_000).toISOString(),
        repoFullName: 'acme/repo',
        access: 'read' as const
      },
      repoId: 42n,
      repoFullName: 'acme/repo',
      installation: installation()
    }))
    const github = {
      mintChecksForAgent: mint,
      mintChecksForProjectionCleanup: cleanupMint,
      invalidateInstallationTokens: vi.fn(),
      refreshInstallationFacts: vi.fn(async () => installation())
    }
    const reporter = new GithubRunReporter({
      hooks: hooks as unknown as Pick<
        HookRepo,
        | 'claimDueReviewProjections'
        | 'beginProjectionWrite'
        | 'completeProjectionWrite'
        | 'advancePendingReviewProjection'
        | 'retryProjectionWrite'
        | 'blockProjection'
        | 'settleReviewProjection'
        | 'getReviewProjection'
        | 'refreshReviewProjectionTarget'
        | 'synchronizeReviewSubjects'
        | 'listReviewSubjects'
        | 'getRunById'
      >,
      agents: { getUnscoped: vi.fn(async () => currentAgent) },
      orgs: { slugById: vi.fn(async () => 'acme') },
      webAppUrl: 'https://console.example.com/',
      ...(appSlug ? { appSlug } : {}),
      github: github as unknown as Pick<
        GithubService,
        | 'mintChecksForAgent'
        | 'mintChecksForProjectionCleanup'
        | 'invalidateInstallationTokens'
        | 'refreshInstallationFacts'
      >,
      clock: new FakeClock(NOW),
      workerId: 'worker-1',
      batchSize: 10,
      fetchImpl
    })
    return { reporter, hooks, mint, github }
  }

  it('uses cleanup-only authority for a revoked-repo tombstone even while the agent still exists', async () => {
    const p = projection({
      desiredState: 'failure',
      tombstonedAt: new Date(NOW - 1_000)
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls`)) return Response.json([associatedPull(p)])
      if (init?.method === 'POST') {
        return Response.json(
          { id: '90071992547409931', external_id: p.externalId, status: 'completed', conclusion: 'failure' },
          { status: 201 }
        )
      }
      expect(init?.method).toBe('PATCH')
      expect(JSON.parse(String(init?.body))).toEqual({ name: CHECK_NAME_FOR_TEST })
      return Response.json({ id: '90071992547409931' })
    })
    const { reporter, hooks, mint, github } = worker(p, fetchImpl)

    await reporter.tick()

    expect(github.mintChecksForProjectionCleanup).toHaveBeenCalledWith(orgId, p.repoId, p.repoFullName)
    expect(mint).not.toHaveBeenCalled()
    const mutation = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
    const body = JSON.parse(String(mutation?.[1]?.body)) as {
      status: string
      conclusion: string
      actions: Array<{ identifier: string }>
      output: { summary: string }
    }
    expect(body).toMatchObject({ status: 'completed', conclusion: 'failure' })
    expect(body.actions).toEqual([])
    expect(body.output.summary).toContain(`Agent: [review-agent](https://console.example.com/acme/agents/${agentId})`)
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ projectionId: p.id, generation: p.generation, observedState: 'failure' })
    )
  })

  it('keeps a superseded revision non-passing under a cleanup tombstone', async () => {
    const p = projection({ desiredState: 'failure', tombstonedAt: new Date(NOW - 1_000) })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls?')) return Response.json([])
      return Response.json(
        { id: '90071992547409931', external_id: p.externalId, status: 'completed', conclusion: 'action_required' },
        { status: 201 }
      )
    })
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    const mutation = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
    const body = JSON.parse(String(mutation?.[1]?.body)) as {
      conclusion: string
      output: { title: string }
    }
    // Organization deletion settles a tombstone only on `failure` or an association
    // `action_required`; a neutral cleanup Check would leave the barrier pending forever.
    expect(body.conclusion).toBe('action_required')
    expect(body.output.title).toBe('Pull request association needs attention')
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ observedState: 'action_required', settledErrorCode: 'no_current_pull_request' })
    )
  })

  it('keeps snapshotted attribution as plain text after the Agent has been deleted', async () => {
    const p = projection({ desiredState: 'failure', tombstonedAt: new Date(NOW - 1_000) })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls`)) return Response.json([associatedPull(p)])
      if (init?.method === 'POST') {
        return Response.json(
          { id: '90071992547409931', external_id: p.externalId, status: 'completed', conclusion: 'failure' },
          { status: 201 }
        )
      }
      return Response.json({ id: '90071992547409931' })
    })
    const { reporter } = worker(p, fetchImpl, {}, null)

    await reporter.tick()

    const mutation = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
    const body = JSON.parse(String(mutation?.[1]?.body)) as {
      details_url?: string
      output: { summary: string }
    }
    expect(body.details_url).toBeUndefined()
    expect(body.output.summary).toContain('Agent: review-agent')
    expect(body.output.summary).not.toContain('[review-agent]')
  })

  it('never emits a passing or nonterminal mutation from a corrupt tombstone claim', async () => {
    const p = projection({
      desiredState: 'success',
      tombstonedAt: new Date(NOW - 1_000),
      nextAttemptAt: new Date(NOW)
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks, mint, github } = worker(p, fetchImpl)

    await reporter.tick()

    expect(hooks.blockProjection).toHaveBeenCalledWith(p.id, p.generation, 'invalid_tombstone_state')
    expect(mint).not.toHaveBeenCalled()
    expect(github.mintChecksForProjectionCleanup).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('advances cleanup pending behind a tombstone instead of writing stale success', async () => {
    const p = projection({
      desiredState: 'success',
      tombstonedAt: new Date(NOW - 1_000),
      pendingIntent: {
        desiredState: 'neutral',
        nextAttemptAt: new Date(NOW).toISOString()
      }
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks, mint } = worker(p, fetchImpl)

    await reporter.tick()

    expect(hooks.advancePendingReviewProjection).toHaveBeenCalledWith(p.id, p.generation, new Date(NOW))
    expect(mint).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('creates one stable informational check with metadata-only output', async () => {
    const p = projection()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(
          `{"id":90071992547409931,"external_id":"${p.externalId}","status":"queued","conclusion":null}`,
          {
            status: 201,
            headers: { 'content-type': 'application/json' }
          }
        )
      }
      return Response.json({ id: '90071992547409931' })
    })
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    // One request settles the Check: it is created under its display name, so
    // no follow-up write exists that could strip the create's actions.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/acme/repo/check-runs')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.name).toBe(CHECK_NAME_FOR_TEST)
    expect(body.head_sha).toBe(p.reportSha)
    expect(body.external_id).toBe(p.externalId)
    expect(body.details_url).toBeUndefined()
    expect(body.actions).toEqual([])
    expect(JSON.stringify(body)).not.toContain('reason')
    expect(body.output).toMatchObject({ title: 'Waiting for review' })
    const output = body.output as { summary: string }
    expect(output.summary.split('\n').slice(0, 4)).toEqual([
      'Phase: queued',
      `Agent: [review-agent](https://console.example.com/acme/agents/${agentId})`,
      `Revision: ${p.reportSha}`,
      'Pull requests: #9'
    ])
    expect(JSON.stringify(body.output)).not.toContain(hookId)
    expect(JSON.stringify(body.output)).not.toContain('Generation:')
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionId: p.id,
        generation: 1n,
        checkRunId: '90071992547409931',
        observedState: 'queued'
      })
    )
  })

  it.each(['review-bot', 'review-bot-fast'])(
    'qualifies the check name for concurrent reviewer %s',
    async (agentName) => {
      const p = projection({ agentName })
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Response.json(
            { id: '90071992547409931', external_id: p.externalId, status: 'queued', conclusion: null },
            { status: 201 }
          )
        }
        return Response.json({ id: '90071992547409931' })
      })
      const { reporter } = worker(p, fetchImpl)

      await reporter.tick()

      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toMatchObject({
        name: `AgentConnect PR Review: ${agentName}`,
        actions: []
      })
    }
  )

  it('omits details_url while a reused check awaits session confirmation', async () => {
    const p = projection({
      desiredState: 'in_progress',
      observedState: 'queued',
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'in_progress',
        conclusion: null
      })
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    const mutation = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH')
    const body = JSON.parse(String(mutation?.[1]?.body)) as Record<string, unknown>
    expect(body.status).toBe('in_progress')
    expect(body).not.toHaveProperty('details_url')
    expect(body).not.toHaveProperty('conclusion')
    expect(body).not.toHaveProperty('completed_at')
    expect(body.output).toMatchObject({ title: 'Analyzing this revision' })
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ observedState: 'in_progress' })
    )
  })

  it('updates the same check run to a terminal conclusion', async () => {
    const p = projection({
      desiredState: 'action_required',
      observedState: 'in_progress',
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'action_required',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter, hooks } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () => run({ sessionId: 'session/with space' }))
    })

    await reporter.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]![0]).toContain(`/commits/${p.headSha}/pulls?per_page=100&page=1`)
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('GET')
    expect(hooks.synchronizeReviewSubjects).toHaveBeenCalledWith(
      p.id,
      p.generation,
      [{ pullNumber: 9, headSha: p.headSha, baseSha: 'b'.repeat(40) }],
      null
    )
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hooks.beginProjectionWrite).mock.invocationCallOrder[0]!
    )
    const [url, init] = fetchImpl.mock.calls[1]!
    expect(url.endsWith(`/check-runs/${p.checkRunId}`)).toBe(true)
    expect(init?.method).toBe('PATCH')
    const body = JSON.parse(String(init?.body)) as {
      name: string
      status: string
      conclusion: string
      completed_at: string
      output: { title: string; summary: string }
    }
    expect(body).toMatchObject({
      name: CHECK_NAME_FOR_TEST,
      status: 'completed',
      conclusion: 'action_required',
      completed_at: new Date(NOW).toISOString(),
      details_url: 'https://console.example.com/acme/sessions/session%2Fwith%20space?source=github',
      output: { title: 'Review findings need attention' }
    })
    expect(body.output.summary).toContain(`Agent: [review-agent](https://console.example.com/acme/agents/${agentId})`)
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: p.checkRunId, observedState: 'action_required' })
    )
  })

  it.each([
    [
      'formal review',
      {
        reviewAttemptState: 'submitted',
        reviewId: '4870130035',
        reviewEvent: 'APPROVE',
        verdict: 'pass'
      } satisfies Partial<HookRunRecord>,
      'https://github.com/acme/repo/pull/9#pullrequestreview-4870130035'
    ],
    [
      'fallback PR comment',
      { publishedCommentKind: 'issue_comment', publishedCommentId: '5199581711' } satisfies Partial<HookRunRecord>,
      'https://github.com/acme/repo/pull/9#issuecomment-5199581711'
    ],
    [
      'fallback inline reply',
      { publishedCommentKind: 'review_comment', publishedCommentId: '3566000000' } satisfies Partial<HookRunRecord>,
      'https://github.com/acme/repo/pull/9#discussion_r3566000000'
    ]
  ])('links the Check to its own %s', async (_label, runOverrides, expectedUrl) => {
    const p = projection({
      desiredState: 'success',
      observedState: 'in_progress',
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'success',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () => run({ status: 'success', ...runOverrides }))
    })

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as { output: { summary: string } }
    expect(body.output.summary).toContain(`Pull requests: [#9](<${expectedUrl}>)`)
  })

  it.each([
    ['success', 'No blocking findings'],
    ['action_required', 'Review findings need attention'],
    ['neutral', 'No blocking verdict'],
    ['skipped', 'Review was not run'],
    ['failure', 'Review could not be completed'],
    ['timed_out', 'Review exceeded its time limit']
  ] as const)('publishes a Request review action for every active terminal %s Check', async (desiredState, title) => {
    const p = projection({
      desiredState,
      observedState: 'in_progress',
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: desiredState,
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      status: string
      conclusion: string
      actions: Array<{ label: string; description: string; identifier: string }>
      output: { title: string; summary: string }
    }
    expect(body).toMatchObject({
      status: 'completed',
      conclusion: desiredState,
      actions: [
        {
          label: 'Request review',
          description: 'Start AgentConnect review',
          identifier: 'request_review'
        }
      ],
      output: { title }
    })
    expect(body.output.summary).toContain(`Phase: ${desiredState}`)
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: p.checkRunId, observedState: desiredState })
    )
  })

  it('presents definite daemon unavailability as Agent unavailable', async () => {
    const p = projection({
      desiredState: 'skipped',
      observedState: null,
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'skipped',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter, hooks } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () =>
        run({
          status: 'failed',
          completedAt: new Date(NOW + 1_000),
          reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE
        })
      )
    })

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      details_url?: string
      conclusion: string
      output: { title: string; summary: string }
    }
    expect(body).toMatchObject({
      conclusion: 'skipped',
      output: { title: 'Agent unavailable' }
    })
    expect(body.details_url).toBeUndefined()
    expect(body.output.summary).toContain('Phase: skipped')
    expect(JSON.stringify(body)).not.toContain(HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: p.checkRunId, observedState: 'skipped' })
    )
  })

  it('publishes a Request review action when an external PR is waiting for a maintainer', async () => {
    const p = projection({
      desiredState: 'skipped',
      observedState: null,
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'skipped',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () =>
        run({
          status: 'failed',
          completedAt: new Date(NOW),
          reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
        })
      )
    })

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      conclusion: string
      actions: Array<{ label: string; description: string; identifier: string }>
      output: { title: string; summary: string }
    }
    expect(body).toMatchObject({
      conclusion: 'skipped',
      actions: [
        {
          label: 'Request review',
          description: 'Start AgentConnect review',
          identifier: 'request_review'
        }
      ],
      output: { title: 'Review requires a maintainer request' }
    })
    // No configured App slug ⇒ no handle to mention, so the copy points at the
    // button alone. The write marker stays last for recovery matching.
    expect(body.output.summary).toContain('How to start this review')
    expect(body.output.summary).toContain('**Request review** button')
    expect(body.output.summary).toContain('Approve and run workflows')
    expect(body.output.summary).toContain('starts the waiting review')
    expect(body.output.summary).not.toContain('comment `@')
    expect(body.output.summary.trimEnd().endsWith('-->')).toBe(true)
    expect(JSON.stringify(body)).not.toContain(HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED)
  })

  it('names the mention handle in the title and summary when the App slug is configured', async () => {
    const p = projection({
      desiredState: 'skipped',
      observedState: null,
      checkRunId: '90071992547409932'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'skipped',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter } = worker(
      p,
      fetchImpl,
      {
        getRunById: vi.fn(async () =>
          run({
            status: 'failed',
            completedAt: new Date(NOW),
            reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
          })
        )
      },
      agent(),
      'example-app'
    )

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      actions: Array<{ identifier: string }>
      output: { title: string; summary: string }
    }
    // The Conversation tab renders only the title, so the reachable entry point
    // has to live there; the Checks tab keeps the why and the second path.
    expect(body.output.title).toBe('Comment @example-app to start the review')
    expect(body.output.summary).toContain('comment `@example-app` on this pull request')
    expect(body.output.summary).toContain('**Request review** button')
    expect(body.actions).toEqual([
      { label: 'Request review', description: 'Start AgentConnect review', identifier: 'request_review' }
    ])
  })

  it('offers a retry when a started review turn was killed by an infrastructure handover', async () => {
    // The state the fence incidents produced: the turn crossed the start barrier, ran, and was
    // interrupted with no verdict. It must not read like the runtime failed on the change.
    const p = projection({
      desiredState: 'skipped',
      observedState: null,
      checkRunId: '90071992547409934'
    })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      return Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'skipped',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter } = worker(
      p,
      fetchImpl,
      {
        getRunById: vi.fn(async () =>
          run({
            status: 'failed',
            turnStartedAt: new Date(NOW),
            completedAt: new Date(NOW + 90_000),
            durationMs: 90_000,
            reason: HOOK_REPORT_REASON_AGENT_HANDOVER
          })
        )
      },
      agent(),
      'example-app'
    )

    await reporter.tick()

    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      conclusion: string
      actions: Array<{ identifier: string }>
      output: { title: string; summary: string }
    }
    expect(body.conclusion).toBe('skipped')
    expect(body.output.title).toBe('Comment @example-app to retry the interrupted review')
    expect(body.output.summary).toContain('How to run this review again')
    expect(body.output.summary).toContain('nothing in this pull request has been judged')
    expect(body.output.summary).toContain('**Request review** button')
    expect(body.actions).toEqual([
      { label: 'Request review', description: 'Start AgentConnect review', identifier: 'request_review' }
    ])
    // The reason code and the topology behind it stay on the operational side.
    expect(JSON.stringify(body)).not.toContain(HOOK_REPORT_REASON_AGENT_HANDOVER)
    expect(JSON.stringify(body)).not.toMatch(/daemon|lease|duty/i)
  })

  it('publishes the Request review action on the create itself', async () => {
    // The create is the only request for a Check that is already terminal, so
    // the button it publishes can never be stripped by a follow-up write.
    const p = projection({ desiredState: 'skipped', observedState: null, checkRunId: null })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([associatedPull(p)])
      if (init?.method === 'POST') return Response.json({ id: '90071992547409933', external_id: p.externalId })
      return Response.json({ id: '90071992547409933' })
    })
    const { reporter } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () =>
        run({
          status: 'failed',
          completedAt: new Date(NOW),
          reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
        })
      )
    })

    await reporter.tick()

    const creates = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(creates).toHaveLength(1)
    expect(JSON.parse(String(creates[0]![1]?.body))).toMatchObject({
      name: CHECK_NAME_FOR_TEST,
      conclusion: 'skipped',
      actions: [{ label: 'Request review', description: 'Start AgentConnect review', identifier: 'request_review' }]
    })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
  })

  it('retries before writing when skipped presentation metadata is temporarily unavailable', async () => {
    const p = projection({
      desiredState: 'skipped',
      subjectSyncGeneration: 1n,
      subjectSyncErrorCode: null
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks } = worker(p, fetchImpl, {
      getRunById: vi.fn(async () => {
        throw new Error('temporary database failure')
      })
    })

    await reporter.tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.retryProjectionWrite).toHaveBeenCalledWith(
      p.id,
      p.generation,
      'worker-1',
      new Date(NOW + 2_000),
      'worker_error',
      false
    )
  })

  it.each([
    ['no current PR', [], 'no_current_pull_request', 'neutral', 'Revision is no longer current'],
    [
      'stale head',
      [{ pullNumber: 9, headSha: 'd'.repeat(40) }],
      'stale_head',
      'neutral',
      'Revision is no longer current'
    ],
    [
      'shared head across open PRs',
      [
        { pullNumber: 9, headSha: 'c'.repeat(40) },
        { pullNumber: 10, headSha: 'c'.repeat(40) }
      ],
      'shared_head_multiple_prs',
      'action_required',
      'Pull request association needs attention'
    ]
  ] as const)(
    'fails closed for %s without replacing canonical desired intent',
    async (_label, pulls, errorCode, blockedState, blockedTitle) => {
      const p = projection({
        desiredState: 'success',
        observedState: 'in_progress',
        checkRunId: '90071992547409931'
      })
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/pulls?')) {
          return Response.json(pulls.map((pull) => associatedPull(p, pull.pullNumber, pull.headSha)))
        }
        return Response.json({
          id: p.checkRunId,
          external_id: p.externalId,
          status: 'completed',
          conclusion: blockedState,
          output: { summary: JSON.parse(String(init?.body)).output.summary }
        })
      })
      const { reporter, hooks } = worker(p, fetchImpl)

      await reporter.tick()

      const expectedSubjects =
        errorCode === 'stale_head'
          ? []
          : pulls.map((pull) => ({ pullNumber: pull.pullNumber, headSha: pull.headSha, baseSha: 'b'.repeat(40) }))
      expect(hooks.synchronizeReviewSubjects).toHaveBeenCalledWith(p.id, p.generation, expectedSubjects, errorCode)
      const patchCall = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH')
      const patchBody = JSON.parse(String(patchCall?.[1]?.body)) as {
        conclusion: string
        output: { title: string; summary: string }
      }
      expect(patchBody.conclusion).toBe(blockedState)
      expect(patchBody.output.title).toBe(blockedTitle)
      expect(patchBody.output.summary).toContain(`Association: ${errorCode}`)
      expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          observedState: blockedState,
          settledErrorCode: errorCode
        })
      )
      expect(p.desiredState).toBe('success')
    }
  )

  it('falls back to the base repository open-PR list for a fork head SHA', async () => {
    const p = projection({ desiredState: 'success', observedState: 'in_progress' })
    const forkPull = associatedPull(p, 910)
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(`/commits/${p.headSha}/pulls?`)) return Response.json([])
      if (url.includes('/pulls?state=open')) return Response.json([forkPull])
      return Response.json({
        id: '90071992547409931',
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'success',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/commits/${p.headSha}/pulls?per_page=100&page=1`),
        expect.stringContaining('/pulls?state=open&per_page=100&page=1')
      ])
    )
    expect(hooks.synchronizeReviewSubjects).toHaveBeenCalledWith(
      p.id,
      p.generation,
      [{ pullNumber: 910, headSha: p.headSha, baseSha: 'b'.repeat(40) }],
      null
    )
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(expect.objectContaining({ observedState: 'success' }))
  })

  it('fails closed when commit association pagination reaches the safety cap', async () => {
    const p = projection({ desiredState: 'success', observedState: 'in_progress' })
    const fullPage = Array.from({ length: 100 }, (_, i) => associatedPull(p, i + 1))
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls?')) return Response.json(fullPage)
      return Response.json({
        id: '90071992547409931',
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'action_required',
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    })
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/pulls?'))).toHaveLength(10)
    expect(hooks.synchronizeReviewSubjects).toHaveBeenCalledWith(p.id, p.generation, null, 'pr_association_incomplete')
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        observedState: 'action_required',
        settledErrorCode: 'pr_association_incomplete'
      })
    )
  })

  it('does not re-read or rewrite a settled association block in the same generation', async () => {
    const p = projection({
      desiredState: 'success',
      observedState: 'neutral',
      subjectSyncGeneration: 1n,
      subjectSyncErrorCode: 'stale_head',
      lastErrorCode: 'stale_head',
      checkRunId: '90071992547409931'
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.blockProjection).toHaveBeenCalledWith(p.id, p.generation, 'stale_head')
  })

  it('advances a crash-left pending intent after a settled association block', async () => {
    const p = projection({
      desiredState: 'success',
      observedState: 'action_required',
      subjectSyncGeneration: 1n,
      subjectSyncErrorCode: 'shared_head_multiple_prs',
      lastErrorCode: 'shared_head_multiple_prs',
      checkRunId: '90071992547409931',
      pendingIntent: {
        desiredState: 'queued',
        currentHookRunId: 'run_2',
        nextAttemptAt: new Date(NOW + 1_000).toISOString()
      }
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.advancePendingReviewProjection).toHaveBeenCalledWith(p.id, p.generation, new Date(NOW + 1_000))
  })

  it('retries the canonical desired state after an authorization block is woken', async () => {
    const p = projection({
      desiredState: 'in_progress',
      observedState: 'queued',
      checkRunId: '90071992547409931',
      lastErrorCode: 'repo_authorization',
      nextAttemptAt: new Date(NOW)
    })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'in_progress',
        conclusion: null,
        output: { summary: JSON.parse(String(init?.body)).output.summary }
      })
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('PATCH')
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ projectionId: p.id, observedState: 'in_progress' })
    )
  })

  it('settles a projection GitHub already agrees with instead of re-publishing it', async () => {
    // The claim is a bounded FIFO over everything whose due time has passed, so a row that
    // never leaves it both re-writes a settled Check and holds up the rows behind it. Observed
    // live: 3027 of 3680 due rows had nothing to publish, and a genuinely pending one sat
    // behind 3671 of them.
    const p = projection({
      desiredState: 'success',
      observedState: 'success',
      checkRunId: '90071992547409931',
      subjectSyncGeneration: 1n
    })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.settleReviewProjection).toHaveBeenCalledWith(p.id, p.generation, expect.any(String))
  })

  it('still publishes when a newer intent is queued behind the state GitHub shows', async () => {
    const p = projection({
      desiredState: 'success',
      observedState: 'success',
      checkRunId: '90071992547409931',
      pendingIntent: JSON.stringify({ desiredState: 'failure', generation: '2' })
    })
    const { reporter, hooks } = worker(
      p,
      vi.fn(async () => Response.json({}))
    )

    await reporter.tick()

    expect(hooks.settleReviewProjection).not.toHaveBeenCalled()
  })

  it('retains the durable mutex after an ambiguous POST and does not complete', async () => {
    const p = projection()
    const { reporter, hooks } = worker(
      p,
      vi.fn(async () => Promise.reject(new Error('socket reset')))
    )

    await reporter.tick()

    expect(hooks.retryProjectionWrite).toHaveBeenCalledWith(
      p.id,
      p.generation,
      'worker-1',
      expect.any(Date),
      'internal',
      true
    )
    expect(hooks.completeProjectionWrite).not.toHaveBeenCalled()
  })

  it('reconciles an ambiguous create to the marker-bound state when the same generation advanced', async () => {
    const marker = 'durable-marker'
    const p = projection({
      desiredState: 'success',
      sealedThrough: 1n,
      writeMarker: marker,
      writePhase: 'create',
      writeStartedAt: new Date(NOW - 1_000)
    })
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          `{"total_count":1,"check_runs":[{"id":12345678901234567,"external_id":"${p.externalId}","status":"queued","conclusion":null,"output":{"summary":"Phase: queued\\n<!-- agentconnect-write:${marker} -->"}}]}`,
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    // Creates publish the display name, so the first lookup finds it and
    // recovery writes nothing further.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('GET')
    expect(fetchImpl.mock.calls[0]![0]).toContain(`/commits/${p.reportSha}/check-runs?`)
    expect(fetchImpl.mock.calls[0]![0]).toContain(`check_name=${encodeURIComponent(CHECK_NAME_FOR_TEST)}`)
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        writeMarker: marker,
        checkRunId: '12345678901234567',
        // The lost response belonged to queued. `success` still needs its own
        // association barrier + PATCH after this mutex is cleared.
        observedState: 'queued'
      })
    )
  })

  it('recovers an ambiguous create left in flight under the legacy name', async () => {
    // An earlier binary named its creates for recovery and repaired the label
    // afterwards. Such a POST may still be in flight across the upgrade, so the
    // legacy name stays searchable after the display-name lookup misses.
    const marker = 'legacy-named-marker'
    const p = projection({
      desiredState: 'success',
      sealedThrough: 1n,
      writeMarker: marker,
      writePhase: 'create',
      writeStartedAt: new Date(NOW - 1_000)
    })
    const legacyName = encodeURIComponent(`${LEGACY_CHECK_NAME_PREFIX_FOR_TEST}${hookId}`)
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes(`check_name=${legacyName}`)
        ? Response.json({
            total_count: 1,
            check_runs: [
              {
                id: '12345678901234567',
                external_id: p.externalId,
                status: 'queued',
                conclusion: null,
                output: { summary: `Phase: queued\n<!-- agentconnect-write:${marker} -->` }
              }
            ]
          })
        : Response.json({ total_count: 0, check_runs: [] })
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]![0]).toContain(`check_name=${encodeURIComponent(CHECK_NAME_FOR_TEST)}`)
    expect(fetchImpl.mock.calls[1]![0]).toContain(`check_name=${legacyName}`)
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({ writeMarker: marker, checkRunId: '12345678901234567', observedState: 'queued' })
    )
  })

  it('recovers an ambiguous skipped update from its durable marker', async () => {
    const marker = 'durable-skipped-marker'
    const p = projection({
      desiredState: 'skipped',
      sealedThrough: 1n,
      checkRunId: '12345678901234567',
      writeMarker: marker,
      writePhase: 'update',
      writeStartedAt: new Date(NOW - 1_000)
    })
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({
        id: p.checkRunId,
        external_id: p.externalId,
        status: 'completed',
        conclusion: 'skipped',
        output: { summary: `Phase: skipped\n<!-- agentconnect-write:${marker} -->` }
      })
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]![0]).toContain(`/check-runs/${p.checkRunId}`)
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('GET')
    expect(hooks.beginProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.completeProjectionWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        writeMarker: marker,
        checkRunId: p.checkRunId,
        observedState: 'skipped'
      })
    )
  })

  it('keeps the write mutex when a recovered marker has no trustworthy encoded state', async () => {
    const marker = 'durable-marker'
    const p = projection({ writeMarker: marker, writePhase: 'create', writeStartedAt: new Date(NOW - 1_000) })
    const fetchImpl = vi.fn(async () =>
      Response.json({
        total_count: 1,
        check_runs: [
          {
            id: '12345678901234567',
            external_id: p.externalId,
            status: 'queued',
            conclusion: null,
            output: { summary: `<!-- agentconnect-write:${marker} -->` }
          }
        ]
      })
    )
    const { reporter, hooks } = worker(p, fetchImpl)

    await reporter.tick()

    expect(hooks.completeProjectionWrite).not.toHaveBeenCalled()
    expect(hooks.retryProjectionWrite).toHaveBeenCalledWith(
      p.id,
      p.generation,
      'worker-1',
      expect.any(Date),
      'ambiguous_write_state',
      true
    )
  })

  it('clears a definite 429 marker and retries with exponential backoff', async () => {
    const p = projection({ attempts: 2 })
    const { reporter, hooks } = worker(
      p,
      vi.fn(async () => Response.json({ message: 'slow down' }, { status: 429 }))
    )

    await reporter.tick()

    expect(hooks.retryProjectionWrite).toHaveBeenCalledWith(
      p.id,
      p.generation,
      'worker-1',
      new Date(NOW + 8_000),
      'rate_limited',
      false
    )
  })

  it('re-pulls installation facts before retrying a definite permission write denial', async () => {
    const p = projection({ checkRunId: '90071992547409931' })
    const { reporter, hooks, github } = worker(
      p,
      vi.fn(async () => Response.json({ message: 'permission changed' }, { status: 403 }))
    )

    await reporter.tick()

    expect(github.invalidateInstallationTokens).toHaveBeenCalledWith(77n)
    expect(github.refreshInstallationFacts).toHaveBeenCalledWith(77n)
    expect(hooks.retryProjectionWrite).toHaveBeenCalledWith(
      p.id,
      p.generation,
      'worker-1',
      expect.any(Date),
      'installation_facts_refreshed',
      false
    )
    expect(hooks.blockProjection).not.toHaveBeenCalled()
  })

  it('blocks required/status rows before token mint or GitHub I/O', async () => {
    const p = projection({ gateMode: 'required' })
    const fetchImpl = vi.fn(async () => Response.json({}))
    const { reporter, hooks, mint } = worker(p, fetchImpl)

    await reporter.tick()

    expect(hooks.blockProjection).toHaveBeenCalledWith(p.id, p.generation, 'unsupported_mode')
    expect(mint).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

const CHECK_NAME_FOR_TEST = 'AgentConnect PR Review: review-agent'
const LEGACY_CHECK_NAME_PREFIX_FOR_TEST = 'agentconnect/info/review/'
