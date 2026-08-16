/**
 * GitHub hooks and PR review for a POOL agent (#1025).
 *
 * Dispatch already addressed the duty holder, but every acceptance fence still compared
 * `agent.daemonId`, which a `set` placement leaves null — so the holder's own report was refused,
 * `hook/start` came back non-retryable, and the review broker denied every action. Authority is the
 * same seam as the reads (#1004): placement ∪ live duty holders, read through `PlacementResolver`.
 *
 * The completion fence follows the same seam (#1051): the member that dispatched a run can retire
 * mid-run, so the member that serves the agent afterwards may close it too.
 */
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { GithubReviewBrokerService } from '../../src/github/review-broker.service.js'
import { handleHookReport } from '../../src/ws/handlers/index.js'
import { AgentId, DaemonId, HookId, OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame, HookReport } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const HOLDER = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeee1'
const PEER = 'e2e2e2e2-eeee-4eee-8eee-eeeeeeeeeee2'
const MACHINE = 'e3e3e3e3-eeee-4eee-8eee-eeeeeeeeeee3'
const BYSTANDER = 'e4e4e4e4-eeee-4eee-8eee-eeeeeeeeeee4'
const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)

const placement = () => new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock })
const repo = () => new PgHookRepo(prisma, placement())

/** An install-wide pool member: an org-less daemon row enrolled in the org-less set. */
async function poolMember(daemonId: string): Promise<void> {
  await seedDaemon(prisma, daemonId)
  await prisma.daemon.update({ where: { id: daemonId }, data: { orgId: null } })
  await joinPool(prisma, daemonId)
}

/** A live, confirmed duty lease over one agent — what makes a member serve it. */
async function grantDuty(holder: string, agentId: string): Promise<void> {
  const groupId = randomUUID()
  await prisma.dutyGroup.create({
    data: {
      id: groupId,
      orgId: DEFAULT_ORG_ID,
      holder,
      term: 1n,
      confirmedTerm: 1n,
      confirmedHolder: holder,
      expiresAt: new Date(Date.now() + 600_000)
    }
  })
  await prisma.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID } })
}

/** Retire the current holder mid-run: the agent's lease is re-taken by another member. */
async function moveDuty(agentId: string, holder: string): Promise<void> {
  const member = await prisma.dutyGroupMember.findFirstOrThrow({ where: { kind: 'agent', refId: agentId } })
  await prisma.dutyGroup.update({
    where: { id: member.groupId },
    data: { holder, term: 2n, confirmedTerm: 2n, confirmedHolder: holder, expiresAt: new Date(Date.now() + 600_000) }
  })
}

async function seedGithubHook(agentId: string): Promise<string> {
  const hookId = randomUUID()
  await repo().upsert({
    hookId: HookId(hookId),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(agentId),
    kind: 'github',
    name: `review-${hookId.slice(0, 8)}`,
    sessionMode: 'perThread',
    repoId: 987654321n,
    repoFullName: 'acme/infra',
    events: ['pull_request:*'],
    reviewPolicy: 'full',
    reportingMode: 'check',
    gateMode: 'informational',
    targetPlatform: 'slack'
  })
  return hookId
}

/** A pool-placed, active agent whose duty `holder` currently holds, plus its github hook. */
async function pooledGithubHook(holder = HOLDER): Promise<{ agentId: string; hookId: string }> {
  await poolMember(holder)
  const agentId = randomUUID()
  await prisma.agent.create({
    data: {
      id: agentId,
      orgId: DEFAULT_ORG_ID,
      name: `pooled-${agentId.slice(0, 8)}`,
      runtime: 'claude',
      status: 'active',
      placementKind: 'set',
      setId: await poolSetId(prisma)
    }
  })
  await grantDuty(holder, agentId)
  return { agentId, hookId: await seedGithubHook(agentId) }
}

/** The machine-placed regression twin: same hook, one named daemon, no lease at all. */
async function machineGithubHook(): Promise<{ agentId: string; hookId: string }> {
  await seedDaemon(prisma, MACHINE)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: MACHINE })
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
  return { agentId, hookId: await seedGithubHook(agentId) }
}

/** The relay's accepted `rc/run-report` for a pull-request event, addressed at one member. */
async function acceptDelivery(
  hookId: string,
  agentId: string,
  deliveryKey: string,
  dispatchDaemonId: string
): Promise<boolean> {
  const hook = (await repo().getUnscoped(HookId(hookId)))!
  return repo().recordDelivery(HookId(hookId), {
    deliveryKey,
    firedAt: new Date('2026-08-15T09:00:00.000Z'),
    event: 'pull_request:synchronize',
    status: 'accepted',
    agentId: AgentId(agentId),
    configRevision: hook.configRevision,
    dispatchRevision: hook.dispatchRevision,
    dispatchDaemonId: DaemonId(dispatchDaemonId),
    reviewPolicySnapshot: hook.reviewPolicy,
    reportingModeSnapshot: hook.reportingMode,
    gateModeSnapshot: hook.gateMode,
    projectionIntent: 'revision_event',
    repoId: hook.repoId ?? undefined,
    repoFullName: hook.repoFullName ?? undefined,
    sourceInstallationId: 44n,
    subjectKind: 'pull_request',
    pullNumber: 42,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    reportSha: HEAD_SHA,
    isDraft: false,
    baseChanged: false
  })
}

/** Dispatch a hand-built `hook/report` completion REQ through the real handler. */
async function report(
  daemonId: string,
  hookId: string,
  agentId: string,
  deliveryKey: string,
  outcome: Omit<HookReport, 'hookId' | 'agentId' | 'deliveryKey'>
) {
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

function broker() {
  const github = {
    mintReviewForAgent: vi.fn(async () => ({
      token: 'broker-secret',
      ttlSec: 3_540,
      expiresAt: '2026-08-15T10:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'read' as const,
      installationId: 44n
    })),
    validateReviewForAgent: vi.fn(async () => ({ installation: { installationId: 44n } }) as never)
  }
  const service = new GithubReviewBrokerService({
    hook: repo(),
    agent: new PgAgentRepo(prisma),
    github,
    clock: systemClock,
    placement: placement()
  })
  return { service, github }
}

function startInput(
  hookId: string,
  agentId: string,
  deliveryKey: string,
  dispatchDaemonId: string,
  hook: {
    configRevision: bigint | null
    dispatchRevision: bigint | null
  }
) {
  return {
    hookId,
    agentId,
    deliveryKey,
    sessionId: 'ses_pool',
    event: 'pull_request:synchronize' as const,
    configRevision: hook.configRevision!.toString(),
    dispatchRevision: hook.dispatchRevision!.toString(),
    dispatchDaemonId,
    reviewPolicy: 'full' as const,
    reportingMode: 'check' as const,
    gateMode: 'informational' as const,
    github: {
      repoId: '987654321',
      repoFullName: 'acme/infra',
      sourceInstallationId: '44',
      subjectKind: 'pull_request' as const,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      reportSha: HEAD_SHA,
      isDraft: false,
      baseChanged: false
    }
  }
}

describe('hook dispatch authority follows the placement resolver', () => {
  it('accepts a pool agent delivery + completion from the member holding its duty', async () => {
    const { agentId, hookId } = await pooledGithubHook()

    expect(await acceptDelivery(hookId, agentId, 'pool-1', HOLDER)).toBe(true)
    const opened = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ status: 'running', dispatchDaemonId: HOLDER })

    const completion = await report(HOLDER, hookId, agentId, 'pool-1', {
      status: 'success',
      durationMs: 4200,
      sessionId: 'ses_pool'
    })
    expect(completion.conn.sendError).not.toHaveBeenCalled()
    expect(completion.conn.replyTo).toHaveBeenCalledWith(completion.frame, 'ack', { ok: true })
    const closed = await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))
    expect(closed[0]).toMatchObject({ status: 'success', durationMs: 4200, sessionId: 'ses_pool' })
  })

  it('refuses a delivery addressed at a member that holds no duty for the pool agent', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)

    expect(await acceptDelivery(hookId, agentId, 'pool-2', PEER)).toBe(false)
    expect(await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId))).toHaveLength(0)
  })

  it('refuses a completion from a member that does not serve the pool agent', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)
    expect(await acceptDelivery(hookId, agentId, 'pool-3', HOLDER)).toBe(true)

    const foreign = await report(PEER, hookId, agentId, 'pool-3', { status: 'success', durationMs: 10 })
    expect(foreign.conn.sendError).toHaveBeenCalledWith(
      foreign.frame.id,
      'CONFLICT',
      'hook completion does not match the accepted dispatch',
      false
    )
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({ status: 'running' })
  })

  it('accepts a completion from the member serving the pool agent after the duty moved (#1051)', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)
    expect(await acceptDelivery(hookId, agentId, 'pool-move-1', HOLDER)).toBe(true)
    await moveDuty(agentId, PEER)

    const completion = await report(PEER, hookId, agentId, 'pool-move-1', {
      status: 'success',
      durationMs: 900,
      sessionId: 'ses_moved'
    })
    expect(completion.conn.sendError).not.toHaveBeenCalled()
    expect(completion.conn.replyTo).toHaveBeenCalledWith(completion.frame, 'ack', { ok: true })
    // The accepted dispatch target stays the provenance snapshot of who the run was addressed at.
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({
      status: 'success',
      durationMs: 900,
      sessionId: 'ses_moved',
      dispatchDaemonId: HOLDER
    })
  })

  it('lets the retired dispatch target close its own run after the duty moved', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)
    expect(await acceptDelivery(hookId, agentId, 'pool-move-2', HOLDER)).toBe(true)
    await moveDuty(agentId, PEER)

    const completion = await report(HOLDER, hookId, agentId, 'pool-move-2', { status: 'success', durationMs: 12 })
    expect(completion.conn.sendError).not.toHaveBeenCalled()
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({ status: 'success' })
  })

  it('refuses a completion from a member that serves nothing once the duty moved', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)
    await poolMember(BYSTANDER)
    expect(await acceptDelivery(hookId, agentId, 'pool-move-3', HOLDER)).toBe(true)
    await moveDuty(agentId, PEER)

    const foreign = await report(BYSTANDER, hookId, agentId, 'pool-move-3', { status: 'success', durationMs: 10 })
    expect(foreign.conn.sendError).toHaveBeenCalledWith(
      foreign.frame.id,
      'CONFLICT',
      'hook completion does not match the accepted dispatch',
      false
    )
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({ status: 'running' })
  })

  it('keeps the machine placement working with no duty lease in play', async () => {
    const { agentId, hookId } = await machineGithubHook()

    expect(await acceptDelivery(hookId, agentId, 'machine-1', MACHINE)).toBe(true)
    const completion = await report(MACHINE, hookId, agentId, 'machine-1', { status: 'success', durationMs: 11 })
    expect(completion.conn.replyTo).toHaveBeenCalledWith(completion.frame, 'ack', { ok: true })
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({ status: 'success' })
  })

  it('refuses a machine-placed completion from a daemon the agent is not placed on', async () => {
    const { agentId, hookId } = await machineGithubHook()
    await poolMember(PEER)
    expect(await acceptDelivery(hookId, agentId, 'machine-2', MACHINE)).toBe(true)

    const foreign = await report(PEER, hookId, agentId, 'machine-2', { status: 'success', durationMs: 5 })
    expect(foreign.conn.sendError).toHaveBeenCalledWith(
      foreign.frame.id,
      'CONFLICT',
      'hook completion does not match the accepted dispatch',
      false
    )
    expect((await repo().listRuns(OrgId(DEFAULT_ORG_ID), HookId(hookId)))[0]).toMatchObject({ status: 'running' })
  })

  it('captures the duty holder as the redelivery dispatch target for a pool agent', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    const firedAt = new Date('2026-08-15T09:00:00.000Z')
    await repo().recordDelivery(HookId(hookId), {
      deliveryKey: 'pool-offline',
      firedAt,
      event: 'pull_request:synchronize',
      status: 'failed',
      reason: 'daemon_offline',
      agentId: AgentId(agentId),
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: DaemonId(HOLDER),
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event',
      repoId: hook.repoId ?? undefined,
      repoFullName: hook.repoFullName ?? undefined,
      sourceInstallationId: 44n,
      subjectKind: 'pull_request',
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      reportSha: HEAD_SHA,
      isDraft: false,
      baseChanged: false
    })

    expect(await repo().claimRetryableDeliveryRedelivery('pool-offline', [HookId(hookId)], firedAt, [30_000])).toBe(
      true
    )
    const run = await repo().getRun(HookId(hookId), 'pool-offline')
    expect(run).toMatchObject({ dispatchDaemonId: HOLDER, redeliveryAttempts: 1 })
  })
})

describe('review broker authority follows the placement resolver', () => {
  it('starts and authorizes a review for the member holding the pool agent duty', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    expect(await acceptDelivery(hookId, agentId, 'review-1', HOLDER)).toBe(true)
    const hook = (await repo().getUnscoped(HookId(hookId)))!
    const { service, github } = broker()

    await service.start(startInput(hookId, agentId, 'review-1', HOLDER, hook), DaemonId(HOLDER))
    expect((await repo().getRun(HookId(hookId), 'review-1'))!.turnStartedAt).not.toBeNull()

    const authorized = await service.authorize(
      {
        hookId,
        deliveryKey: 'review-1',
        attemptId: randomUUID(),
        requestedEvent: 'APPROVE',
        requestedVerdict: 'pass',
        snapshot: {
          configRevision: hook.configRevision!.toString(),
          dispatchRevision: hook.dispatchRevision!.toString(),
          dispatchDaemonId: HOLDER,
          reviewPolicy: 'full',
          reportingMode: 'check',
          gateMode: 'informational'
        }
      },
      DaemonId(HOLDER)
    )
    expect(authorized).toMatchObject({ token: 'broker-secret', pullNumber: 42, expectedHeadSha: HEAD_SHA })
    expect(github.mintReviewForAgent).toHaveBeenCalledOnce()
  })

  it('denies hook/start from a member that holds no duty for the pool agent', async () => {
    const { agentId, hookId } = await pooledGithubHook()
    await poolMember(PEER)
    expect(await acceptDelivery(hookId, agentId, 'review-2', HOLDER)).toBe(true)
    const hook = (await repo().getUnscoped(HookId(hookId)))!

    await expect(
      broker().service.start(startInput(hookId, agentId, 'review-2', PEER, hook), DaemonId(PEER))
    ).rejects.toThrow()
  })

  it('keeps the machine placement start path working', async () => {
    const { agentId, hookId } = await machineGithubHook()
    expect(await acceptDelivery(hookId, agentId, 'review-3', MACHINE)).toBe(true)
    const hook = (await repo().getUnscoped(HookId(hookId)))!

    await broker().service.start(startInput(hookId, agentId, 'review-3', MACHINE, hook), DaemonId(MACHINE))
    expect((await repo().getRun(HookId(hookId), 'review-3'))!.turnStartedAt).not.toBeNull()
  })
})
