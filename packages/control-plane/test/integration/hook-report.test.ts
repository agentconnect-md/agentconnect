/**
 * HookRun two-stage bookkeeping, end to end on the CP side
 * (webhook-triggers-and-github-events.md decision 12):
 *
 *  - the relay's `rc/run-report` (`recordDelivery`) opens the row — `accepted`
 *    running, `failed` a delivery failure — and advances `lastFiredAt`;
 *  - the daemon's `hook/report` completion (`handleHookReport`) closes it,
 *    scoped to the owning daemon and last-writer-wins, keyed on
 *    (hookId, deliveryKey) so redeliveries and reconnect re-asserts never
 *    duplicate or regress;
 *  - a completion with no prior delivery row (CP down at fire time) still
 *    creates the run;
 *  - the reaper ages a stuck `running` row to `failed(orphaned)`, which a late
 *    completion can still overwrite.
 */
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgAgentRepo } from '../../src/persistence/index.js'
import { CodeHostReviewBrokerService } from '../../src/codehost/review-lease.service.js'
import { handleHookReport, handleHookStart } from '../../src/ws/handlers/index.js'
import { AgentId, DaemonId, HookId, OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
  type AnyFrame,
  type HookReport
} from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

const repo = () => new PgHookRepo(prisma)

/** Dispatch a hand-built `hook/report` completion REQ through the real handler. */
async function report(
  daemonId: string,
  hookId: string,
  agentId: string,
  deliveryKey: string,
  outcome: Omit<HookReport, 'hookId' | 'agentId' | 'deliveryKey'>
): Promise<{
  frame: AnyFrame
  conn: { daemonId: string; replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'hook/report',
    payload: { hookId, agentId, deliveryKey, ...outcome }
  } as AnyFrame
  const deps = { hook: repo(), clock: systemClock } as unknown as DaemonWsDeps
  const conn = { daemonId, orgId: DEFAULT_ORG_ID, replyTo: vi.fn(), sendError: vi.fn() }
  await handleHookReport(frame, conn as unknown as DaemonConnection, deps)
  return { frame, conn }
}

async function seedHook(agentId: string): Promise<string> {
  const hookId = randomUUID()
  await repo().upsert({
    hookId: HookId(hookId),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(agentId),
    kind: 'webhook',
    name: 'ci',
    sessionMode: 'perDelivery',
    urlToken: `whk_${randomUUID().replace(/-/g, '')}`,
    targetPlatform: 'slack'
  })
  return hookId
}

async function seedGithubHook(agentId: string): Promise<string> {
  const hookId = randomUUID()
  await repo().upsert({
    hookId: HookId(hookId),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(agentId),
    kind: 'github',
    name: 'github-ci',
    sessionMode: 'perThread',
    repoId: 987654321n,
    repoFullName: 'acme/infra',
    events: ['issues:*'],
    reviewPolicy: 'full',
    reportingMode: 'check',
    gateMode: 'informational',
    targetPlatform: 'slack'
  })
  return hookId
}

async function placedHook(daemonId = DAEMON): Promise<{ agentId: string; hookId: string }> {
  await seedDaemon(prisma, daemonId)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId })
  return { agentId, hookId: await seedHook(agentId) }
}

async function placedGithubHook(daemonId = DAEMON): Promise<{ agentId: string; hookId: string }> {
  await seedDaemon(prisma, daemonId)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId })
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
  return { agentId, hookId: await seedGithubHook(agentId) }
}

async function recordGithubDeliveryFailure(
  hookId: string,
  agentId: string,
  deliveryKey: string,
  firedAt: Date,
  reason: typeof HOOK_DELIVERY_REASON_DAEMON_OFFLINE | typeof HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
  daemonId = DAEMON
) {
  const hook = (await repo().getUnscoped(HookId(hookId)))!
  await repo().recordDelivery(HookId(hookId), {
    deliveryKey,
    firedAt,
    event: 'issues:opened',
    status: 'failed',
    reason,
    agentId: AgentId(agentId),
    configRevision: hook.configRevision,
    dispatchRevision: hook.dispatchRevision,
    dispatchDaemonId: DaemonId(daemonId),
    reviewPolicySnapshot: hook.reviewPolicy,
    reportingModeSnapshot: hook.reportingMode,
    gateModeSnapshot: hook.gateMode,
    repoId: hook.repoId ?? undefined,
    repoFullName: hook.repoFullName ?? undefined,
    subjectKind: 'issue'
  })
  return hook
}

async function recordGithubPullDeliveryFailure(hookId: string, agentId: string, deliveryKey: string, firedAt: Date) {
  const hook = (await repo().getUnscoped(HookId(hookId)))!
  await repo().recordDelivery(HookId(hookId), {
    deliveryKey,
    firedAt,
    event: 'pull_request:synchronize',
    status: 'failed',
    reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
    agentId: AgentId(agentId),
    configRevision: hook.configRevision,
    dispatchRevision: hook.dispatchRevision,
    dispatchDaemonId: DaemonId(DAEMON),
    reviewPolicySnapshot: hook.reviewPolicy,
    reportingModeSnapshot: hook.reportingMode,
    gateModeSnapshot: hook.gateMode,
    projectionIntent: 'revision_event',
    repoId: hook.repoId ?? undefined,
    repoFullName: hook.repoFullName ?? undefined,
    sourceInstallationId: 44n,
    subjectKind: 'pull_request',
    pullNumber: 42,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    reportSha: 'a'.repeat(40),
    isDraft: false,
    baseChanged: false
  })
  return hook
}

describe('HookRun bookkeeping — delivery opens, completion closes', () => {
  it('accepted delivery opens a running row + stamps lastFiredAt; completion closes it (same key)', async () => {
    const { agentId, hookId } = await placedHook()
    const firedAt = new Date('2026-07-03T09:00:00.000Z')

    await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-1', firedAt, status: 'accepted' })
    let runs = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ deliveryKey: 'd-1', status: 'running', durationMs: null, sessionId: null })
    expect((await repo().getUnscoped(HookId(hookId)))!.lastFiredAt).toEqual(firedAt)

    const completion = await report(DAEMON, hookId, agentId, 'd-1', {
      status: 'success',
      durationMs: 5200,
      sessionId: 'ses_9'
    })
    expect(completion.conn.replyTo).toHaveBeenCalledWith(completion.frame, 'ack', { ok: true })
    expect(completion.conn.sendError).not.toHaveBeenCalled()
    runs = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(runs).toHaveLength(1) // closed, not duplicated
    expect(runs[0]).toMatchObject({ status: 'success', durationMs: 5200, sessionId: 'ses_9' })
  })

  it('a failed delivery records the failure outright (no daemon report needed)', async () => {
    const { hookId } = await placedHook()
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'd-off',
      firedAt: new Date(),
      status: 'failed',
      reason: 'daemon_offline'
    })
    const runs = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(runs[0]).toMatchObject({ status: 'failed', reason: 'daemon_offline' })
  })

  it('persists the single safe redelivery claim and closes follow-up attempts across repo instances', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T09:00:00.000Z')
    const backoffMs = [30_000] as const
    await recordGithubDeliveryFailure(hookId, agentId, 'd-durable', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)

    expect(await repo().claimRetryableDeliveryRedelivery('d-durable', [HookId(hookId)], firedAt, backoffMs)).toBe(true)
    let run = (await new PgHookRepo(prisma).getRun(HookId(hookId), 'd-durable'))!
    expect(run).toMatchObject({
      redeliveryAttempts: 1,
      redeliveryLastRequestedAt: firedAt,
      redeliveryNextAttemptAt: new Date(firedAt.getTime() + 30_000)
    })

    // A newly constructed repository observes the same durable gate.
    const restarted = new PgHookRepo(prisma)
    expect(
      await restarted.claimRetryableDeliveryRedelivery(
        'd-durable',
        [HookId(hookId)],
        new Date(firedAt.getTime() + 29_999),
        backoffMs
      )
    ).toBe(false)
    expect(
      await restarted.claimRetryableDeliveryRedelivery(
        'd-durable',
        [HookId(hookId)],
        new Date(firedAt.getTime() + 30_000),
        backoffMs
      )
    ).toBe(false)
    run = (await restarted.getRun(HookId(hookId), 'd-durable'))!
    expect(run).toMatchObject({ redeliveryAttempts: 1, redeliveryNextAttemptAt: null })
  })

  it('claims all retryable hook rows for one GitHub GUID as one fanout redelivery', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const siblingHookId = await seedGithubHook(agentId)
    const firedAt = new Date('2026-07-03T10:00:00.000Z')
    for (const id of [hookId, siblingHookId]) {
      await recordGithubDeliveryFailure(id, agentId, 'shared-guid', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    }

    const claims = await Promise.all([
      new PgHookRepo(prisma).claimRetryableDeliveryRedelivery(
        'shared-guid',
        [HookId(hookId), HookId(siblingHookId)],
        firedAt,
        [30_000]
      ),
      new PgHookRepo(prisma).claimRetryableDeliveryRedelivery(
        'shared-guid',
        [HookId(hookId), HookId(siblingHookId)],
        firedAt,
        [30_000]
      )
    ])
    expect(claims.sort()).toEqual([false, true])
    const rows = await prisma.hookRun.findMany({ where: { deliveryKey: 'shared-guid' }, orderBy: { hookId: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.redeliveryAttempts)).toEqual([1, 1])
    expect(rows.every((row) => row.redeliveryLastRequestedAt?.getTime() === firedAt.getTime())).toBe(true)
  })

  it('blocks a GUID-wide redelivery when any current fanout sibling is nonretryable or missing', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const siblingHookId = await seedGithubHook(agentId)
    const firedAt = new Date('2026-07-03T10:30:00.000Z')
    await recordGithubDeliveryFailure(hookId, agentId, 'mixed-guid', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    const sibling = (await repo().getUnscoped(HookId(siblingHookId)))!
    await repo().recordDelivery(HookId(siblingHookId), {
      deliveryKey: 'mixed-guid',
      firedAt,
      event: 'issues:opened',
      status: 'failed',
      reason: 'rejected:paused',
      agentId: AgentId(agentId),
      configRevision: sibling.configRevision,
      dispatchRevision: sibling.dispatchRevision,
      dispatchDaemonId: DaemonId(DAEMON)
    })

    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'mixed-guid',
        [HookId(hookId), HookId(siblingHookId)],
        firedAt,
        [30_000]
      )
    ).toBe(false)
    expect(await repo().getRun(HookId(hookId), 'mixed-guid')).toMatchObject({ redeliveryNextAttemptAt: null })

    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'missing-sibling-guid',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'missing-sibling-guid',
        [HookId(hookId), HookId(siblingHookId)],
        firedAt,
        [30_000]
      )
    ).toBe(false)
    expect(await repo().getRun(HookId(hookId), 'missing-sibling-guid')).toMatchObject({
      redeliveryNextAttemptAt: null
    })
  })

  it('does not schedule ambiguous dispatch_timeout for automatic redelivery', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:45:00.000Z')
    await recordGithubDeliveryFailure(hookId, agentId, 'timeout-pinned', firedAt, HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT)
    expect(await repo().claimRetryableDeliveryRedelivery('timeout-pinned', [HookId(hookId)], firedAt, [30_000])).toBe(
      false
    )
    expect(await repo().getRun(HookId(hookId), 'timeout-pinned')).toMatchObject({
      status: 'failed',
      dispatchDaemonId: DAEMON,
      redeliveryAttempts: 0,
      redeliveryNextAttemptAt: null
    })
  })

  it('allows daemon_offline placement moves but rejects agent/config reinterpretation', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:46:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'offline-config-changed',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    await prisma.hookDef.update({ where: { id: hookId }, data: { configRevision: { increment: 1 } } })
    expect(
      await repo().claimRetryableDeliveryRedelivery('offline-config-changed', [HookId(hookId)], firedAt, [30_000])
    ).toBe(false)
    expect(await repo().getRun(HookId(hookId), 'offline-config-changed')).toMatchObject({
      redeliveryNextAttemptAt: null
    })
  })

  it('refreshes the failed-attempt fence before accepting its late completion', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:50:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'offline-then-timeout',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'offline-then-timeout',
        [HookId(hookId)],
        firedAt,
        [30_000, 120_000]
      )
    ).toBe(true)

    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: OTHER_DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    const current = (await repo().getUnscoped(HookId(hookId)))!
    const timeoutAt = new Date(firedAt.getTime() + 1_000)
    expect(
      await repo().recordDelivery(HookId(hookId), {
        deliveryKey: 'offline-then-timeout',
        firedAt: timeoutAt,
        event: 'issues:opened',
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
        agentId: AgentId(agentId),
        configRevision: current.configRevision,
        dispatchRevision: current.dispatchRevision,
        dispatchDaemonId: DaemonId(OTHER_DAEMON)
      })
    ).toBe(true)
    expect(await repo().getRun(HookId(hookId), 'offline-then-timeout')).toMatchObject({
      reason: HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
      dispatchDaemonId: OTHER_DAEMON,
      dispatchRevision: current.dispatchRevision,
      redeliveryNextAttemptAt: null
    })

    const completion = await report(OTHER_DAEMON, hookId, agentId, 'offline-then-timeout', {
      status: 'success',
      sessionId: 'ses_late',
      configRevision: current.configRevision.toString(),
      dispatchRevision: current.dispatchRevision.toString(),
      dispatchDaemonId: OTHER_DAEMON
    })
    expect(completion.conn.replyTo).toHaveBeenCalled()
  })

  it('converges an exact-current completion when the redelivery accepted report was lost', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:52:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'accepted-report-lost',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery('accepted-report-lost', [HookId(hookId)], firedAt, [30_000])
    ).toBe(true)
    expect(await repo().settleRetryableDeliveryRedeliveries(new Date(firedAt.getTime() + 30_000), new Date(0), 1)).toBe(
      1
    )
    expect(await repo().getRun(HookId(hookId), 'accepted-report-lost')).toMatchObject({
      redeliveryNextAttemptAt: null
    })

    // The external POST was claimed for D1, but placement moved before GitHub
    // reached the Relay. D2 admitted and completed the turn while the Relay's
    // accepted bookkeeping report was lost.
    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: OTHER_DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    const current = (await repo().getUnscoped(HookId(hookId)))!
    const completion = await report(OTHER_DAEMON, hookId, agentId, 'accepted-report-lost', {
      event: 'issues:opened',
      status: 'success',
      sessionId: 'ses_recovered',
      configRevision: current.configRevision.toString(),
      dispatchRevision: current.dispatchRevision.toString(),
      dispatchDaemonId: OTHER_DAEMON,
      reviewPolicy: current.reviewPolicy,
      reportingMode: current.reportingMode,
      gateMode: current.gateMode
    })
    expect(completion.conn.replyTo).toHaveBeenCalledWith(completion.frame, 'ack', { ok: true })
    expect(await repo().getRun(HookId(hookId), 'accepted-report-lost')).toMatchObject({
      status: 'success',
      sessionId: 'ses_recovered',
      dispatchDaemonId: OTHER_DAEMON,
      dispatchRevision: current.dispatchRevision,
      redeliveryAttempts: 1,
      redeliveryNextAttemptAt: null
    })
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'accepted-report-lost',
        [HookId(hookId)],
        new Date(firedAt.getTime() + 30_000),
        [30_000, 120_000]
      )
    ).toBe(false)
  })

  it('uses exact-current hook/start as the missing accepted edge and clears the retry gate', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:53:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'start-before-accepted',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery('start-before-accepted', [HookId(hookId)], firedAt, [30_000])
    ).toBe(true)
    expect(await repo().settleRetryableDeliveryRedeliveries(new Date(firedAt.getTime() + 30_000), new Date(0), 1)).toBe(
      1
    )

    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: OTHER_DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    const current = (await repo().getUnscoped(HookId(hookId)))!
    const startedAt = new Date(firedAt.getTime() + 1_000)
    expect(
      await repo().recordStart(HookId(hookId), DaemonId(OTHER_DAEMON), {
        deliveryKey: 'start-before-accepted',
        agentId: AgentId(agentId),
        configRevision: current.configRevision,
        dispatchRevision: current.dispatchRevision,
        dispatchDaemonId: DaemonId(OTHER_DAEMON),
        reviewPolicySnapshot: current.reviewPolicy,
        reportingModeSnapshot: current.reportingMode,
        gateModeSnapshot: current.gateMode,
        startedAt,
        projectionIntent: 'none',
        repoId: current.repoId ?? undefined,
        repoFullName: current.repoFullName ?? undefined,
        subjectKind: 'issue'
      })
    ).toBe(true)
    expect(await repo().getRun(HookId(hookId), 'start-before-accepted')).toMatchObject({
      status: 'running',
      turnStartedAt: startedAt,
      dispatchDaemonId: OTHER_DAEMON,
      dispatchRevision: current.dispatchRevision,
      reason: null,
      redeliveryAttempts: 1,
      redeliveryNextAttemptAt: null
    })
  })

  it('rejects a stale offline projection intent captured before claimed start recovery', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:53:20.000Z')
    const hook = await recordGithubPullDeliveryFailure(hookId, agentId, 'recovery-before-projection', firedAt)
    expect(
      await repo().claimRetryableDeliveryRedelivery('recovery-before-projection', [HookId(hookId)], firedAt, [30_000])
    ).toBe(true)
    const startedAt = new Date(firedAt.getTime() + 1_000)
    expect(
      await repo().recordStart(HookId(hookId), DaemonId(DAEMON), {
        deliveryKey: 'recovery-before-projection',
        agentId: AgentId(agentId),
        configRevision: hook.configRevision,
        dispatchRevision: hook.dispatchRevision,
        dispatchDaemonId: DaemonId(DAEMON),
        reviewPolicySnapshot: hook.reviewPolicy,
        reportingModeSnapshot: hook.reportingMode,
        gateModeSnapshot: hook.gateMode,
        startedAt,
        projectionIntent: 'revision_event',
        repoId: hook.repoId ?? undefined,
        repoFullName: hook.repoFullName ?? undefined,
        sourceInstallationId: 44n,
        subjectKind: 'pull_request',
        pullNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        reportSha: 'a'.repeat(40),
        isDraft: false,
        baseChanged: false
      })
    ).toBe(true)
    const recovered = (await repo().getRun(HookId(hookId), 'recovery-before-projection'))!
    await expect(
      repo().upsertReviewProjection({
        hookId: HookId(hookId),
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId: AgentId(agentId),
        agentName: 'github-ci-agent',
        repoId: hook.repoId!,
        repoFullName: hook.repoFullName!,
        headSha: 'a'.repeat(40),
        reportSha: 'a'.repeat(40),
        projectionEpoch: recovered.projectionEpoch!,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'skipped',
        currentHookRunId: recovered.id,
        nextAttemptAt: startedAt
      })
    ).rejects.toThrow('review projection intent is stale')
  })

  it('reopens through an already-bound offline projection and lets terminal completion converge it', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:53:40.000Z')
    const hook = await recordGithubPullDeliveryFailure(hookId, agentId, 'projection-before-recovery', firedAt)
    expect(
      await repo().claimRetryableDeliveryRedelivery('projection-before-recovery', [HookId(hookId)], firedAt, [30_000])
    ).toBe(true)
    await prisma.agent.update({
      where: { id: agentId },
      data: { workspaceMode: 'github', workspaceRepoId: hook.repoId, gitAccess: 'write' }
    })
    const failed = (await repo().getRun(HookId(hookId), 'projection-before-recovery'))!
    const projection = await repo().upsertReviewProjection({
      hookId: HookId(hookId),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(agentId),
      agentName: 'github-ci-agent',
      repoId: hook.repoId!,
      repoFullName: hook.repoFullName!,
      headSha: 'a'.repeat(40),
      reportSha: 'a'.repeat(40),
      projectionEpoch: failed.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'skipped',
      currentHookRunId: failed.id,
      nextAttemptAt: firedAt
    })
    expect(
      await repo().bindRunProjection(HookId(hookId), 'projection-before-recovery', projection.id, projection.generation)
    ).toBe(true)

    const startedAt = new Date(firedAt.getTime() + 1_000)
    expect(
      await repo().recordStart(HookId(hookId), DaemonId(DAEMON), {
        deliveryKey: 'projection-before-recovery',
        agentId: AgentId(agentId),
        configRevision: hook.configRevision,
        dispatchRevision: hook.dispatchRevision,
        dispatchDaemonId: DaemonId(DAEMON),
        reviewPolicySnapshot: hook.reviewPolicy,
        reportingModeSnapshot: hook.reportingMode,
        gateModeSnapshot: hook.gateMode,
        startedAt,
        projectionIntent: 'revision_event',
        repoId: hook.repoId ?? undefined,
        repoFullName: hook.repoFullName ?? undefined,
        sourceInstallationId: 44n,
        subjectKind: 'pull_request',
        pullNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        reportSha: 'a'.repeat(40),
        isDraft: false,
        baseChanged: false
      })
    ).toBe(true)
    expect(
      await repo().setProjectionDesired(projection.id, projection.generation, 'skipped', startedAt, failed.id)
    ).toBe(false)

    expect(
      await repo().recordReport(
        HookId(hookId),
        DaemonId(DAEMON),
        {
          deliveryKey: 'projection-before-recovery',
          event: 'pull_request:synchronize',
          status: 'success',
          agentId: AgentId(agentId),
          configRevision: hook.configRevision,
          dispatchRevision: hook.dispatchRevision,
          dispatchDaemonId: DaemonId(DAEMON),
          reviewPolicySnapshot: hook.reviewPolicy,
          reportingModeSnapshot: hook.reportingMode,
          gateModeSnapshot: hook.gateMode,
          projectionIntent: 'revision_event',
          repoId: hook.repoId ?? undefined,
          repoFullName: hook.repoFullName ?? undefined,
          sourceInstallationId: 44n,
          subjectKind: 'pull_request',
          pullNumber: 42,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          reportSha: 'a'.repeat(40),
          isDraft: false,
          baseChanged: false,
          publishedComment: { kind: 'issue_comment', commentId: '5199581711' },
          projectionDesiredState: 'neutral',
          projectionNextAttemptAt: new Date(firedAt.getTime() + 2_000)
        },
        new Date(firedAt.getTime() + 2_000)
      )
    ).toBe(true)
    expect(await repo().getReviewProjection(projection.id)).toMatchObject({
      desiredState: 'neutral',
      sealedThrough: projection.generation
    })
    expect(await repo().getRun(HookId(hookId), 'projection-before-recovery')).toMatchObject({
      publishedCommentKind: 'issue_comment',
      publishedCommentId: '5199581711'
    })
  })

  it('captures the first claim placement and refuses cross-daemon follow-up attempts', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T10:54:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'claim-placement-pin',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )

    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: OTHER_DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    const claimed = (await repo().getUnscoped(HookId(hookId)))!
    expect(
      await repo().claimRetryableDeliveryRedelivery('claim-placement-pin', [HookId(hookId)], firedAt, [30_000, 120_000])
    ).toBe(true)
    expect(await repo().getRun(HookId(hookId), 'claim-placement-pin')).toMatchObject({
      dispatchDaemonId: OTHER_DAEMON,
      dispatchRevision: claimed.dispatchRevision,
      redeliveryAttempts: 1
    })

    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'claim-placement-pin',
        [HookId(hookId)],
        new Date(firedAt.getTime() + 30_000),
        [30_000, 120_000]
      )
    ).toBe(false)
    expect(await repo().getRun(HookId(hookId), 'claim-placement-pin')).toMatchObject({
      redeliveryAttempts: 1,
      redeliveryNextAttemptAt: null
    })
  })

  it('settles skewed or expired GUID gates without issuing another redelivery claim', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const siblingHookId = await seedGithubHook(agentId)
    const firedAt = new Date('2026-07-03T10:55:00.000Z')
    for (const id of [hookId, siblingHookId]) {
      await recordGithubDeliveryFailure(id, agentId, 'skewed-guid', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    }
    await prisma.hookRun.update({
      where: { hookId_deliveryKey: { hookId, deliveryKey: 'skewed-guid' } },
      data: { redeliveryAttempts: 3 }
    })
    await prisma.hookRun.update({
      where: { hookId_deliveryKey: { hookId: siblingHookId, deliveryKey: 'skewed-guid' } },
      data: { redeliveryAttempts: 2 }
    })
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'skewed-guid',
        [HookId(hookId), HookId(siblingHookId)],
        firedAt,
        [1, 1, 1]
      )
    ).toBe(false)
    expect(
      (await prisma.hookRun.findMany({ where: { deliveryKey: 'skewed-guid' } })).every(
        (row) => row.redeliveryNextAttemptAt === null
      )
    ).toBe(true)

    await recordGithubDeliveryFailure(hookId, agentId, 'expired-guid', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    expect(
      await repo().settleRetryableDeliveryRedeliveries(
        new Date(firedAt.getTime() + 1),
        new Date(firedAt.getTime() + 1),
        3
      )
    ).toBe(1)
    expect(await repo().getRun(HookId(hookId), 'expired-guid')).toMatchObject({ redeliveryNextAttemptAt: null })
  })

  it('does not create a durable GitHub retry gate for Check rererequests', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'check-rerequest',
      firedAt: new Date('2026-07-03T10:58:00.000Z'),
      event: 'check_run:rerequested',
      status: 'failed',
      reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
      agentId: AgentId(agentId),
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: DaemonId(DAEMON)
    })
    expect(await repo().getRun(HookId(hookId), 'check-rerequest')).toMatchObject({
      redeliveryAttempts: 0,
      redeliveryNextAttemptAt: null
    })
  })

  it('reopens only a retryable delivery-stage failure with refreshed authority and retained audit', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T11:00:00.000Z')
    await recordGithubDeliveryFailure(hookId, agentId, 'd-reopen', firedAt, HOOK_DELIVERY_REASON_DAEMON_OFFLINE)
    expect(await repo().claimRetryableDeliveryRedelivery('d-reopen', [HookId(hookId)], firedAt, [30_000])).toBe(true)

    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: OTHER_DAEMON } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { dispatchRevision: { increment: 1 } } })
    const current = (await repo().getUnscoped(HookId(hookId)))!
    const acceptedAt = new Date('2026-07-03T11:00:01.000Z')
    expect(
      await repo().recordDelivery(HookId(hookId), {
        deliveryKey: 'd-reopen',
        firedAt: acceptedAt,
        event: 'issues:opened',
        status: 'accepted',
        agentId: AgentId(agentId),
        configRevision: current.configRevision,
        dispatchRevision: current.dispatchRevision,
        dispatchDaemonId: DaemonId(OTHER_DAEMON)
      })
    ).toBe(true)

    const reopened = (await repo().getRun(HookId(hookId), 'd-reopen'))!
    expect(reopened).toMatchObject({
      status: 'running',
      startedAt: acceptedAt,
      dispatchDaemonId: OTHER_DAEMON,
      dispatchRevision: current.dispatchRevision,
      completedAt: null,
      durationMs: null,
      sessionId: null,
      reason: null,
      redeliveryAttempts: 1,
      redeliveryLastRequestedAt: firedAt,
      redeliveryNextAttemptAt: null
    })

    const stale = await report(DAEMON, hookId, agentId, 'd-reopen', { status: 'success', sessionId: 'ses_old' })
    expect(stale.conn.sendError).toHaveBeenCalled()
    expect((await repo().getRun(HookId(hookId), 'd-reopen'))!.status).toBe('running')

    const currentCompletion = await report(OTHER_DAEMON, hookId, agentId, 'd-reopen', {
      status: 'success',
      sessionId: 'ses_new',
      configRevision: current.configRevision.toString(),
      dispatchRevision: current.dispatchRevision.toString(),
      dispatchDaemonId: OTHER_DAEMON
    })
    expect(currentCompletion.conn.replyTo).toHaveBeenCalled()
    expect(
      await repo().claimRetryableDeliveryRedelivery('d-reopen', [HookId(hookId)], new Date('2026-07-04'), [30_000])
    ).toBe(false)
  })

  it('requires complete completion fences after a retry reopens on the same daemon', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const firedAt = new Date('2026-07-03T11:30:00.000Z')
    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'same-daemon-reopen',
      firedAt,
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery('same-daemon-reopen', [HookId(hookId)], firedAt, [30_000])
    ).toBe(true)
    await prisma.hookDef.update({
      where: { id: hookId },
      data: { dispatchRevision: { increment: 1 } }
    })
    const current = (await repo().getUnscoped(HookId(hookId)))!
    expect(
      await repo().recordDelivery(HookId(hookId), {
        deliveryKey: 'same-daemon-reopen',
        firedAt: new Date(firedAt.getTime() + 1_000),
        event: 'issues:opened',
        status: 'accepted',
        agentId: AgentId(agentId),
        configRevision: current.configRevision,
        dispatchRevision: current.dispatchRevision,
        dispatchDaemonId: DaemonId(DAEMON)
      })
    ).toBe(true)

    const unfenced = await report(DAEMON, hookId, agentId, 'same-daemon-reopen', {
      status: 'success',
      sessionId: 'ses_unfenced'
    })
    expect(unfenced.conn.sendError).toHaveBeenCalled()
    expect((await repo().getRun(HookId(hookId), 'same-daemon-reopen'))!.status).toBe('running')

    const fenced = await report(DAEMON, hookId, agentId, 'same-daemon-reopen', {
      status: 'success',
      sessionId: 'ses_fenced',
      configRevision: current.configRevision.toString(),
      dispatchRevision: current.dispatchRevision.toString(),
      dispatchDaemonId: DAEMON
    })
    expect(fenced.conn.replyTo).toHaveBeenCalled()
  })

  it('never claims or reopens nonretryable and effect-bearing failed rows', async () => {
    const { agentId, hookId } = await placedGithubHook()
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    const accepted = {
      firedAt: new Date('2026-07-03T12:00:01.000Z'),
      status: 'accepted' as const,
      agentId: AgentId(agentId),
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: DaemonId(DAEMON)
    }

    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'd-paused',
      firedAt: new Date('2026-07-03T12:00:00.000Z'),
      status: 'failed',
      reason: 'rejected:paused'
    })
    expect(
      await repo().claimRetryableDeliveryRedelivery('d-paused', [HookId(hookId)], new Date('2026-07-04'), [1])
    ).toBe(false)
    expect(await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-paused', ...accepted })).toBe(true)
    expect((await repo().getRun(HookId(hookId), 'd-paused'))!.reason).toBe('rejected:paused')

    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'd-stops-retrying',
      new Date('2026-07-03T12:00:00.000Z'),
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'd-stops-retrying',
        [HookId(hookId)],
        new Date('2026-07-03T12:00:00.000Z'),
        [1]
      )
    ).toBe(true)
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'd-stops-retrying',
      firedAt: new Date('2026-07-03T12:00:01.000Z'),
      status: 'failed',
      reason: 'rejected:paused'
    })
    expect(await repo().getRun(HookId(hookId), 'd-stops-retrying')).toMatchObject({
      status: 'failed',
      reason: 'rejected:paused',
      redeliveryAttempts: 1,
      redeliveryNextAttemptAt: null
    })
    expect(
      await repo().claimRetryableDeliveryRedelivery(
        'd-stops-retrying',
        [HookId(hookId)],
        new Date('2026-07-04'),
        [1, 1]
      )
    ).toBe(false)

    await recordGithubDeliveryFailure(
      hookId,
      agentId,
      'd-effect',
      new Date('2026-07-03T12:00:00.000Z'),
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE
    )
    await prisma.hookRun.update({
      where: { hookId_deliveryKey: { hookId, deliveryKey: 'd-effect' } },
      data: { projectionId: randomUUID(), projectionGeneration: 1n }
    })
    expect(
      await repo().claimRetryableDeliveryRedelivery('d-effect', [HookId(hookId)], new Date('2026-07-04'), [1])
    ).toBe(false)
    expect(await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-effect', ...accepted })).toBe(true)
    expect((await repo().getRun(HookId(hookId), 'd-effect'))!.status).toBe('failed')
  })

  it('a duplicate delivery (redelivery) lands on the existing row and never resets it', async () => {
    const { agentId, hookId } = await placedHook()
    const firedAt = new Date('2026-07-03T09:00:00.000Z')
    await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-1', firedAt, status: 'accepted' })
    await report(DAEMON, hookId, agentId, 'd-1', { status: 'success', sessionId: 'ses_1' })
    // The redelivery re-posts `accepted` — must NOT reopen the closed run.
    await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-1', firedAt, status: 'accepted' })
    const runs = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('success')
  })

  it("a foreign daemon's completion report is rejected (scoped to the owning daemon)", async () => {
    const { agentId, hookId } = await placedHook()
    await seedDaemon(prisma, OTHER_DAEMON)
    await repo().recordDelivery(HookId(hookId), { deliveryKey: 'd-1', firedAt: new Date(), status: 'accepted' })

    const foreign = await report(OTHER_DAEMON, hookId, agentId, 'd-1', {
      status: 'success',
      sessionId: 'ses_x'
    })
    expect(foreign.conn.sendError).toHaveBeenCalledWith(
      foreign.frame.id,
      'CONFLICT',
      'hook completion does not match the accepted dispatch',
      false
    )
    expect(foreign.conn.replyTo).not.toHaveBeenCalled()
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]!.status).toBe('running') // untouched

    await report(DAEMON, hookId, agentId, 'd-1', { status: 'success', sessionId: 'ses_ok' })
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({
      status: 'success',
      sessionId: 'ses_ok'
    })
  })

  it('a metadata-light run still rejects a different agent on the same daemon', async () => {
    const { agentId, hookId } = await placedHook()
    const otherAgentId = randomUUID()
    await seedAgent(prisma, otherAgentId, { daemonId: DAEMON })
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'd-legacy',
      firedAt: new Date(),
      status: 'accepted'
    })

    const rejected = await report(DAEMON, hookId, otherAgentId, 'd-legacy', { status: 'success' })
    expect(rejected.conn.sendError).toHaveBeenCalledWith(
      rejected.frame.id,
      'CONFLICT',
      'hook completion does not match the accepted dispatch',
      false
    )
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]!.status).toBe('running')

    const accepted = await report(DAEMON, hookId, agentId, 'd-legacy', { status: 'success' })
    expect(accepted.conn.replyTo).toHaveBeenCalledWith(accepted.frame, 'ack', { ok: true })
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]!.status).toBe('success')
  })

  it('a completion with no prior delivery row (CP down at fire) still creates the run', async () => {
    const { agentId, hookId } = await placedHook()
    await report(DAEMON, hookId, agentId, 'd-late', {
      status: 'failed',
      durationMs: 800,
      reason: 'turn failed'
    })
    const runs = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ deliveryKey: 'd-late', status: 'failed', reason: 'turn failed' })
  })

  it('an unknown hookId completion is refused permanently — absent in the org the frame acts in', async () => {
    await seedDaemon(prisma, DAEMON)
    const rejected = await report(DAEMON, randomUUID(), randomUUID(), 'd-1', { status: 'success' })
    expect(rejected.conn.sendError).toHaveBeenCalledWith(
      rejected.frame.id,
      'SCOPE_DENIED',
      'hook is not in the organization this frame acts in',
      false
    )
    expect(rejected.conn.replyTo).not.toHaveBeenCalled()
  })

  it('the reaper ages a stuck running row to failed(orphaned); a late completion still overwrites it', async () => {
    const { agentId, hookId } = await placedHook()
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'd-slow',
      firedAt: new Date('2026-07-03T09:00:00.000Z'),
      status: 'accepted'
    })

    const reaped = await repo().reapStaleRuns(new Date('2026-07-03T09:05:00.000Z'))
    expect(reaped).toBe(1)
    const reapedRun = (await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]!
    expect(reapedRun.status).toBe('failed')
    expect(reapedRun.reason).toMatch(/no completion report/)

    // The daemon's report finally lands — last-writer-wins overwrites the reap.
    await report(DAEMON, hookId, agentId, 'd-slow', { status: 'success', sessionId: 'ses_late' })
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({
      status: 'success',
      sessionId: 'ses_late'
    })
  })
})

/** gitlab-com-integration.md §17.2: the provider-neutral start barrier, end to end on real rows. */
describe('gitlab hook/start records the started head', () => {
  const PROJECT = 4455667n
  const HEAD = 'a'.repeat(40)

  async function placedGitlabHook(): Promise<{ agentId: string; hookId: string }> {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
    const hookId = randomUUID()
    await repo().upsert({
      hookId: HookId(hookId),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(agentId),
      kind: 'gitlab',
      name: 'gitlab-review',
      sessionMode: 'perThread',
      repoId: PROJECT,
      repoFullName: 'example-group/example-project',
      events: ['merge_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'off',
      gateMode: 'informational',
      targetPlatform: 'slack'
    })
    return { agentId, hookId }
  }

  async function start(hookId: string, agentId: string, deliveryKey: string) {
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    const frame = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'hook/start',
      payload: {
        hookId,
        agentId,
        deliveryKey,
        sessionId: 'ses_gitlab',
        event: 'merge_request:update',
        gitlab: {
          projectId: PROJECT.toString(),
          projectPath: 'example-group/example-project',
          target: { kind: 'merge_request', iid: 42, headSha: HEAD, baseSha: 'b'.repeat(40) }
        },
        configRevision: hook.configRevision.toString(),
        dispatchRevision: hook.dispatchRevision.toString(),
        dispatchDaemonId: DAEMON,
        reviewPolicy: hook.reviewPolicy,
        reportingMode: hook.reportingMode,
        gateMode: hook.gateMode
      }
    } as AnyFrame
    const afterStart = vi.fn(async () => {})
    const deps = {
      hook: repo(),
      clock: systemClock,
      codeHostReviewBroker: new CodeHostReviewBrokerService({
        leases: {} as never,
        hook: repo(),
        agent: new PgAgentRepo(prisma),
        publisher: async () => null,
        clock: systemClock
      }),
      codeHostNoteProjection: { afterStart } as never
    } as unknown as DaemonWsDeps
    const conn = { daemonId: DAEMON, orgId: DEFAULT_ORG_ID, replyTo: vi.fn(), sendError: vi.fn() }
    await handleHookStart(frame, conn as unknown as DaemonConnection, deps)
    return { frame, conn, afterStart, hook }
  }

  it('fills the head and turn time on the accepted run and offers the running edge', async () => {
    const { agentId, hookId } = await placedGitlabHook()
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'gl-1',
      firedAt: new Date('2026-07-03T09:00:00.000Z'),
      event: 'merge_request:update',
      status: 'accepted',
      agentId: AgentId(agentId),
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: DaemonId(DAEMON),
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode
    })
    // The relay's accepted report carries no revision for a gitlab run — the barrier is what does.
    expect(await repo().getRun(HookId(hookId), 'gl-1')).toMatchObject({ headSha: null, turnStartedAt: null })

    const first = await start(hookId, agentId, 'gl-1')
    expect(first.conn.sendError).not.toHaveBeenCalled()
    expect(first.conn.replyTo).toHaveBeenCalledWith(first.frame, 'hook/start/ok', { accepted: true })
    const started = (await repo().getRun(HookId(hookId), 'gl-1'))!
    expect(started).toMatchObject({ headSha: HEAD, baseSha: 'b'.repeat(40), sessionId: 'ses_gitlab' })
    expect(started.turnStartedAt).not.toBeNull()
    // The edge names the delivery, not an epoch — the projection resolves that from the accepted run.
    expect(first.afterStart).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', deliveryKey: 'gl-1' }))

    // A retried barrier re-asserts the same row rather than moving the recorded head.
    const retry = await start(hookId, agentId, 'gl-1')
    expect(retry.conn.replyTo).toHaveBeenCalledWith(retry.frame, 'hook/start/ok', { accepted: true })
    expect(await repo().getRun(HookId(hookId), 'gl-1')).toMatchObject({
      headSha: HEAD,
      turnStartedAt: started.turnStartedAt
    })
  })

  it('refuses a barrier whose delivery was never accepted', async () => {
    const { agentId, hookId } = await placedGitlabHook()
    const { conn, afterStart } = await start(hookId, agentId, 'gl-missing')
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(afterStart).not.toHaveBeenCalled()
  })
})
