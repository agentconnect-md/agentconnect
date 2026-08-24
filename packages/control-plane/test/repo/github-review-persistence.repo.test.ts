import { onDaemon, UNPLACED } from '../../src/domain/placement.js'
import { randomUUID } from 'node:crypto'
import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
} from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { PgGithubInstallationRepo } from '../../src/persistence/repositories/github.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { Prisma } from '../../src/generated/prisma/client.js'
import { lockHookReviewOrgLifecycleScope } from '../../src/persistence/review-projection-lock.js'
import { AgentWorkspaceIntegrationConflict, GithubInstallationClaimConflict } from '../../src/persistence/errors.js'
import { AgentId, DaemonId, HookId, OrgId } from '../../src/domain/ids.js'
import type { HookDeliveryInput, HookRecord } from '../../src/persistence/ports.js'

const D1 = DaemonId('d1d1d1d1-dddd-4ddd-8ddd-dddddddddddd')
const D2 = DaemonId('d2d2d2d2-dddd-4ddd-8ddd-dddddddddddd')

describe('R1/R2a persistence foundation', () => {
  it('reserves one safe redelivery for a partially persisted external-PR fan-out', async () => {
    await seedDaemon(prisma, D1)
    const agentId = AgentId(randomUUID())
    await seedAgent(prisma, agentId, { daemonId: D1, name: 'external-review-agent' })
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
    const hooks = new PgHookRepo(prisma)
    const hook1 = await hooks.upsert({
      hookId: HookId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'external review one',
      sessionMode: 'perThread',
      repoId: 47_799n,
      repoFullName: 'acme/external-review',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const hook2 = await hooks.upsert({
      hookId: HookId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'external review two',
      sessionMode: 'perThread',
      repoId: 47_799n,
      repoFullName: 'acme/external-review',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const firedAt = new Date('2026-07-11T00:00:00.000Z')
    const deliveryKey = `external-review-${randomUUID()}`
    expect(
      await hooks.recordDelivery(hook1.id, {
        deliveryKey,
        firedAt,
        event: 'pull_request:opened',
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
        agentId,
        configRevision: hook1.configRevision,
        dispatchRevision: hook1.dispatchRevision,
        dispatchDaemonId: D1,
        reviewPolicySnapshot: hook1.reviewPolicy,
        reportingModeSnapshot: hook1.reportingMode,
        gateModeSnapshot: hook1.gateMode,
        projectionIntent: 'revision_event',
        repoId: 47_799n,
        repoFullName: 'acme/external-review',
        sourceInstallationId: 77n,
        subjectKind: 'pull_request',
        pullNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        reportSha: 'a'.repeat(40)
      })
    ).toBe(true)

    const requestedAt = new Date('2026-07-11T00:03:00.000Z')
    expect(await hooks.claimReviewRequestRequiredFanoutRedelivery(deliveryKey, [hook1.id, hook2.id], requestedAt)).toBe(
      true
    )
    expect(await hooks.getRun(hook1.id, deliveryKey)).toMatchObject({
      redeliveryAttempts: 1,
      redeliveryLastRequestedAt: requestedAt,
      redeliveryNextAttemptAt: null
    })
    expect(await hooks.claimReviewRequestRequiredFanoutRedelivery(deliveryKey, [hook1.id, hook2.id], requestedAt)).toBe(
      false
    )
  })

  it('reverse-maps an opaque Check Run id to its durable projection', async () => {
    const hooks = new PgHookRepo(prisma)
    const id = randomUUID()
    await prisma.hookReviewProjection.create({
      data: {
        id,
        hookId: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId: randomUUID(),
        repoId: 47_700n,
        repoFullName: 'acme/rerequest',
        headSha: 'a'.repeat(40),
        reportSha: 'a'.repeat(40),
        projectionEpoch: 1n,
        generation: 1n,
        externalId: id,
        checkRunId: '86617583005',
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'failure',
        observedState: 'failure',
        sealedThrough: 1n
      }
    })

    await expect(hooks.findReviewProjectionByCheckRunId('86617583005')).resolves.toMatchObject({
      id,
      checkRunId: '86617583005'
    })
    await expect(hooks.findReviewProjectionByCheckRunId('86617583006')).resolves.toBeNull()
  })

  it('blocks a projection producer behind the exclusive org fence and rejects it after deletion', async () => {
    const orgs = new PgOrgRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const org = await orgs.create({
      name: 'Barrier',
      slug: `barrier-${randomUUID()}`,
      ownerUserId: DEFAULT_OWNER_ID
    })
    let releaseDelete!: () => void
    const release = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    let deletionLocked!: () => void
    const locked = new Promise<void>((resolve) => {
      deletionLocked = resolve
    })
    const deleting = prisma.$transaction(async (tx) => {
      await lockHookReviewOrgLifecycleScope(tx, org.id)
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "org" WHERE "id" = ${org.id} FOR UPDATE
      `)
      deletionLocked()
      await release
      await tx.org.delete({ where: { id: org.id } })
    })
    await locked

    let producerSettled = false
    const producer = hooks
      .upsertReviewProjection({
        hookId: HookId(randomUUID()),
        orgId: OrgId(org.id),
        agentId: AgentId(randomUUID()),
        agentName: 'barrier-agent',
        repoId: 47_704n,
        repoFullName: 'acme/barrier',
        headSha: '4'.repeat(40),
        reportSha: '4'.repeat(40),
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'queued',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
    void producer.then(() => {
      producerSettled = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(producerSettled).toBe(false)
    } finally {
      releaseDelete()
    }
    await deleting
    expect(await producer).toMatchObject({ ok: false })
    expect(await prisma.hookReviewProjection.count({ where: { orgId: org.id } })).toBe(0)
  })

  it('fences final org deletion against concurrent HookRun and HookDef creation', async () => {
    const orgs = new PgOrgRepo(prisma)
    const agents = new PgAgentRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const org = await orgs.create({
      name: 'Deleting',
      slug: `deleting-${randomUUID()}`,
      ownerUserId: DEFAULT_OWNER_ID
    })
    const agentId = AgentId(randomUUID())
    const hookId = HookId(randomUUID())
    const projectionId = randomUUID()
    await agents.create({ id: agentId, orgId: OrgId(org.id), name: 'deleting-agent', runtime: 'claude' })
    const hook = await hooks.upsert({
      hookId,
      orgId: OrgId(org.id),
      agentId,
      kind: 'github',
      name: 'deleting-hook',
      sessionMode: 'perThread',
      repoId: 47_701n,
      repoFullName: 'acme/deleting',
      events: ['pull_request:*'],
      reportingMode: 'check',
      gateMode: 'informational'
    })
    await prisma.hookReviewProjection.create({
      data: {
        id: projectionId,
        hookId,
        orgId: org.id,
        agentId,
        repoId: 47_701n,
        repoFullName: 'acme/deleting',
        headSha: 'd'.repeat(40),
        reportSha: 'd'.repeat(40),
        projectionEpoch: hook.projectionEpoch,
        generation: 1n,
        externalId: projectionId,
        checkRunId: '90071992547409932',
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        observedState: 'success',
        sealedThrough: 1n
      }
    })

    expect(await orgs.delete(org.id)).toMatchObject({ status: 'review_cleanup_pending' })
    const tombstoned = await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })
    await prisma.hookReviewProjection.update({
      where: { id: projectionId },
      data: { observedState: 'failure', nextAttemptAt: null }
    })

    const newHookId = HookId(randomUUID())
    const [deletion, lateDelivery, lateHook, phantomProjection] = await Promise.allSettled([
      orgs.delete(org.id),
      hooks.recordDelivery(hookId, {
        deliveryKey: 'org-delete-race',
        firedAt: new Date('2026-07-11T00:00:00.000Z'),
        status: 'failed',
        reason: 'dispatch_timeout'
      }),
      hooks.upsert({
        hookId: newHookId,
        orgId: OrgId(org.id),
        agentId,
        kind: 'github',
        name: 'late-hook',
        sessionMode: 'perThread',
        repoId: 47_701n,
        repoFullName: 'acme/deleting',
        events: ['pull_request:*']
      }),
      hooks.upsertReviewProjection({
        hookId: HookId(randomUUID()),
        orgId: OrgId(org.id),
        agentId,
        agentName: 'deleting-agent',
        repoId: 47_703n,
        repoFullName: 'acme/phantom',
        headSha: 'f'.repeat(40),
        reportSha: 'f'.repeat(40),
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'queued',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })
    ])

    expect(deletion).toEqual(
      expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ status: 'deleted' }) })
    )
    expect(['fulfilled', 'rejected']).toContain(lateDelivery.status)
    expect(['fulfilled', 'rejected']).toContain(lateHook.status)
    expect(['fulfilled', 'rejected']).toContain(phantomProjection.status)
    expect(await prisma.org.findUnique({ where: { id: org.id } })).toBeNull()
    expect(await prisma.hookDef.count({ where: { orgId: org.id } })).toBe(0)
    expect(await prisma.hookRun.count({ where: { orgId: org.id } })).toBe(0)
    expect(await prisma.hookReviewProjection.count({ where: { orgId: org.id } })).toBe(0)
    expect(tombstoned.tombstonedAt).not.toBeNull()
  })

  it('accepts only a persisted association block as settled org cleanup', async () => {
    const orgs = new PgOrgRepo(prisma)
    const org = await orgs.create({
      name: 'Association',
      slug: `association-${randomUUID()}`,
      ownerUserId: DEFAULT_OWNER_ID
    })
    const projectionId = randomUUID()
    await prisma.hookReviewProjection.create({
      data: {
        id: projectionId,
        hookId: randomUUID(),
        orgId: org.id,
        agentId: randomUUID(),
        repoId: 47_702n,
        repoFullName: 'acme/association',
        headSha: 'e'.repeat(40),
        reportSha: 'e'.repeat(40),
        projectionEpoch: 1n,
        generation: 1n,
        externalId: projectionId,
        checkRunId: '90071992547409933',
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        observedState: 'success',
        sealedThrough: 1n
      }
    })

    expect(await orgs.delete(org.id)).toMatchObject({ status: 'review_cleanup_pending' })
    const current = await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })
    await prisma.hookReviewProjection.update({
      where: { id: projectionId },
      data: { observedState: 'action_required', nextAttemptAt: null }
    })
    // A generic action_required is not proof that this cleanup generation was
    // the association-fail-closed write.
    expect(await orgs.delete(org.id)).toMatchObject({ status: 'review_cleanup_pending' })
    await prisma.hookReviewProjection.update({
      where: { id: projectionId },
      data: {
        subjectSyncGeneration: current.generation,
        subjectSyncErrorCode: 'no_current_pull_request',
        lastErrorCode: 'no_current_pull_request'
      }
    })
    expect(await orgs.delete(org.id)).toMatchObject({ status: 'deleted' })
    expect(await prisma.org.findUnique({ where: { id: org.id } })).toBeNull()
  })

  it('linearizes workspace-id repair with grant creation and never tombstones workspace projections', async () => {
    const agents = new PgAgentRepo(prisma)
    const grants = new PgAgentRepoAuthorizationRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const repoId = 776n

    const legacyAgent = AgentId(randomUUID())
    await seedAgent(prisma, legacyAgent, {
      gitRepo: 'https://github.com/acme/old-infra',
      installationId: 'legacy-installation'
    })
    const duplicate = await grants.create({
      agentId: legacyAgent,
      provider: 'github',
      repoId,
      repoFullName: 'acme/infra',
      access: 'write'
    })
    const projection = await hooks.upsertReviewProjection({
      hookId: HookId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: legacyAgent,
      agentName: 'legacy-agent',
      repoId,
      repoFullName: 'acme/infra',
      headSha: '7'.repeat(40),
      reportSha: '7'.repeat(40),
      projectionEpoch: 1n,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'success',
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    })

    expect(await agents.setWorkspaceRepoId(legacyAgent, repoId)).toBe(true)
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: legacyAgent } })).toMatchObject({
      workspaceRepoId: repoId
    })
    expect(await prisma.agentRepoAuthorization.findUnique({ where: { id: duplicate.id } })).toBeNull()
    expect(await hooks.getReviewProjection(projection.id)).toMatchObject({
      generation: projection.generation,
      desiredState: 'success',
      tombstonedAt: null
    })

    // Both race orders converge to workspace-only authority: create first is
    // deleted by repair; repair first makes create reject under the same lock.
    for (let i = 0; i < 6; i++) {
      const agentId = AgentId(randomUUID())
      await seedAgent(prisma, agentId, {
        gitRepo: 'https://github.com/acme/old-infra',
        installationId: 'legacy-installation'
      })
      await Promise.allSettled([
        grants.create({ agentId, provider: 'github', repoId, repoFullName: 'acme/infra', access: 'write' }),
        agents.setWorkspaceRepoId(agentId, repoId)
      ])
      expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
        workspaceRepoId: repoId
      })
      expect(await prisma.agentRepoAuthorization.count({ where: { agentId, repoId } })).toBe(0)
    }
  })

  it('serializes a workspace read downgrade with write-requiring GitHub hook creation', async () => {
    const agents = new PgAgentRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const repoId = 77_601n
    const agentId = AgentId(randomUUID())
    const hookId = HookId(randomUUID())
    await seedAgent(prisma, agentId, {
      gitRepo: 'https://github.com/acme/workspace-access',
      installationId: 'workspace-installation',
      gitAccess: 'write'
    })
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceMode: 'github', workspaceRepoId: repoId } })
    const original = await agents.get(OrgId(DEFAULT_ORG_ID), agentId)
    if (!original || original.workspace.mode !== 'github') throw new Error('expected GitHub workspace fixture')

    const settled = await Promise.allSettled([
      agents.setWorkspace(
        OrgId(DEFAULT_ORG_ID),
        agentId,
        original.lastModifiedAt,
        'github',
        { ...original.workspace, gitAccess: 'read' },
        repoId
      ),
      hooks.upsert({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        kind: 'github',
        name: 'workspace review',
        sessionMode: 'perThread',
        repoId,
        repoFullName: 'acme/workspace-access',
        events: ['pull_request:*'],
        reviewPolicy: 'full',
        reportingMode: 'check',
        gateMode: 'informational'
      })
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(AgentWorkspaceIntegrationConflict)
    })
    const [workspace, hook] = await Promise.all([
      prisma.agent.findUniqueOrThrow({ where: { id: agentId } }),
      prisma.hookDef.findUnique({ where: { id: hookId } })
    ])
    expect(workspace.gitAccess === 'read' && hook !== null).toBe(false)
  })

  it('tombstones only the projections covered by a revoked agent/repository grant', async () => {
    const repo = new PgHookRepo(prisma)
    const revokedAgentId = AgentId(randomUUID())
    const otherAgentId = AgentId(randomUUID())
    const revokedRepoId = 777n
    const at = new Date('2026-07-11T00:00:01.000Z')
    const makeProjection = (
      agentId: AgentId,
      repoId: bigint,
      hookId = HookId(randomUUID()),
      reportSha = randomUUID().replaceAll('-', '').padEnd(40, 'a').slice(0, 40)
    ) =>
      repo.upsertReviewProjection({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        agentName: 'grant-review-agent',
        repoId,
        repoFullName: `acme/repo-${repoId}`,
        headSha: reportSha,
        reportSha,
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })

    const revoked = await makeProjection(revokedAgentId, revokedRepoId)
    const otherRepo = await makeProjection(revokedAgentId, 778n)
    const otherAgent = await makeProjection(otherAgentId, revokedRepoId)

    expect(await repo.tombstoneReviewProjectionsForAgentRepo(revokedAgentId, revokedRepoId, at, 'failure')).toBe(1)
    expect(await repo.getReviewProjection(revoked.id)).toMatchObject({
      generation: revoked.generation + 1n,
      desiredState: 'failure',
      observedState: null,
      tombstonedAt: at,
      nextAttemptAt: at
    })
    expect(await repo.getReviewProjection(otherRepo.id)).toMatchObject({ tombstonedAt: null, desiredState: 'success' })
    expect(await repo.getReviewProjection(otherAgent.id)).toMatchObject({ tombstonedAt: null, desiredState: 'success' })

    // A delayed lifecycle repair for the revoked natural key cannot restore a
    // passing desired state or advance the tombstoned generation.
    const delayed = await makeProjection(revokedAgentId, revokedRepoId, revoked.hookId, revoked.reportSha)
    expect(delayed).toMatchObject({
      id: revoked.id,
      generation: revoked.generation + 1n,
      desiredState: 'failure',
      tombstonedAt: at
    })
  })

  it('only upgrades a tombstoned neutral cleanup to failure, including a pending write intent', async () => {
    const repo = new PgHookRepo(prisma)
    const agentId = AgentId(randomUUID())
    const neutralAt = new Date('2026-07-11T00:00:01.000Z')
    const failedAt = new Date('2026-07-11T00:00:02.000Z')
    const createProjection = (hookId: HookId, reportSha: string) =>
      repo.upsertReviewProjection({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        agentName: 'cleanup-agent',
        repoId: 779n,
        repoFullName: 'acme/cleanup-upgrade',
        headSha: reportSha,
        reportSha,
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })

    const hookId = HookId(randomUUID())
    const projection = await createProjection(hookId, '1'.repeat(40))
    expect(await repo.tombstoneReviewProjections([hookId], neutralAt, 'neutral')).toBe(1)
    expect(await repo.tombstoneReviewProjections([hookId], failedAt, 'failure')).toBe(1)
    const failed = (await repo.getReviewProjection(projection.id))!
    expect(failed).toMatchObject({
      generation: projection.generation + 2n,
      desiredState: 'failure',
      observedState: null,
      tombstonedAt: neutralAt,
      nextAttemptAt: failedAt
    })
    expect(await repo.tombstoneReviewProjections([hookId], new Date('2026-07-11T00:00:03.000Z'), 'neutral')).toBe(0)
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      generation: failed.generation,
      desiredState: 'failure',
      tombstonedAt: neutralAt
    })

    const pendingHookId = HookId(randomUUID())
    const pending = await createProjection(pendingHookId, '2'.repeat(40))
    await prisma.hookReviewProjection.update({
      where: { id: pending.id },
      data: { leaseOwner: 'cleanup-worker', leaseUntil: new Date('2026-07-11T00:01:00.000Z') }
    })
    const marker = randomUUID()
    expect(
      await repo.beginProjectionWrite(pending.id, pending.generation, 'cleanup-worker', marker, 'update', neutralAt)
    ).toBe(true)
    expect(await repo.tombstoneReviewProjections([pendingHookId], neutralAt, 'neutral')).toBe(1)
    expect(await repo.tombstoneReviewProjections([pendingHookId], failedAt, 'failure')).toBe(1)
    const upgradedPending = (await repo.getReviewProjection(pending.id))!
    expect(upgradedPending).toMatchObject({
      generation: pending.generation,
      tombstonedAt: neutralAt,
      writeMarker: marker,
      writePhase: 'update'
    })
    expect(upgradedPending.pendingIntent).toMatchObject({ desiredState: 'failure', tombstoned: true })
    expect(
      await repo.tombstoneReviewProjections([pendingHookId], new Date('2026-07-11T00:00:03.000Z'), 'neutral')
    ).toBe(0)
    expect((await repo.getReviewProjection(pending.id))?.pendingIntent).toMatchObject({ desiredState: 'failure' })
    expect(
      await repo.completeProjectionWrite({
        projectionId: pending.id,
        generation: pending.generation,
        leaseOwner: 'cleanup-worker',
        writeMarker: marker,
        observedState: 'success',
        checkRunId: '90071992547409936'
      })
    ).toBe(true)
    // A worker that parsed the earlier neutral pending JSON before the revoke
    // upgrade must consume the current locked failure intent, not its argument.
    expect(
      await repo.advancePendingReviewProjection(pending.id, pending.generation, new Date('2026-07-11T00:00:03.000Z'))
    ).toMatchObject({
      generation: pending.generation + 1n,
      desiredState: 'failure',
      checkRunId: '90071992547409936',
      nextAttemptAt: failedAt,
      tombstonedAt: neutralAt
    })
  })

  it('serializes agent deletion with hook create and update so no owned hook can leak', async () => {
    const agents = new PgAgentRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const hookInput = (agentId: AgentId, hookId: HookId, name: string) => ({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github' as const,
      name,
      sessionMode: 'perThread' as const,
      repoId: 780n,
      repoFullName: 'acme/agent-delete-race',
      events: ['pull_request:*'],
      reviewPolicy: 'off' as const,
      reportingMode: 'off' as const,
      gateMode: 'informational' as const
    })

    for (let i = 0; i < 6; i++) {
      const agentId = AgentId(randomUUID())
      const hookId = HookId(randomUUID())
      await seedAgent(prisma, agentId)
      const [deleted] = await Promise.allSettled([
        agents.delete(OrgId(DEFAULT_ORG_ID), agentId),
        hooks.upsert(hookInput(agentId, hookId, `create-race-${i}`))
      ])
      expect(deleted.status).toBe('fulfilled')
      expect(await prisma.agent.findUnique({ where: { id: agentId } })).toBeNull()
      expect(await prisma.hookDef.findUnique({ where: { id: hookId } })).toBeNull()
    }

    for (let i = 0; i < 6; i++) {
      const agentId = AgentId(randomUUID())
      const hookId = HookId(randomUUID())
      const agentName = `delete-race-agent-${i}`
      await seedAgent(prisma, agentId, { name: agentName })
      await hooks.upsert(hookInput(agentId, hookId, `before-update-${i}`))
      const projection = await hooks.upsertReviewProjection({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        agentName,
        repoId: 780n,
        repoFullName: 'acme/agent-delete-race',
        headSha: i.toString(16).padStart(40, 'a'),
        reportSha: i.toString(16).padStart(40, 'a'),
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })
      const [deleted] = await Promise.allSettled([
        agents.delete(OrgId(DEFAULT_ORG_ID), agentId),
        hooks.upsert(hookInput(agentId, hookId, `update-race-${i}`))
      ])
      expect(deleted.status).toBe('fulfilled')
      expect(await prisma.agent.findUnique({ where: { id: agentId } })).toBeNull()
      expect(await prisma.hookDef.findUnique({ where: { id: hookId } })).toBeNull()
      expect(await hooks.getReviewProjection(projection.id)).toMatchObject({
        agentName,
        desiredState: 'failure',
        tombstonedAt: expect.any(Date)
      })
    }

    // An update request carries the owner it observed before entering the repo.
    // If deletion linearizes first, update-only CAS must reject instead of
    // recreating the same hook id under another live agent.
    const deletedOwner = AgentId(randomUUID())
    const liveTarget = AgentId(randomUUID())
    const reboundHookId = HookId(randomUUID())
    await seedAgent(prisma, deletedOwner)
    await seedAgent(prisma, liveTarget)
    await hooks.upsert(hookInput(deletedOwner, reboundHookId, 'before-owner-delete'))
    await agents.delete(OrgId(DEFAULT_ORG_ID), deletedOwner)
    await expect(
      hooks.upsert({
        ...hookInput(liveTarget, reboundHookId, 'must-not-resurrect'),
        expectedAgentId: deletedOwner
      })
    ).rejects.toMatchObject({ code: 'P2025' })
    expect(await prisma.hookDef.findUnique({ where: { id: reboundHookId } })).toBeNull()
  })

  it('serializes concurrent projection upserts for one natural key', async () => {
    await seedDaemon(prisma, D1)
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const agentId = AgentId(randomUUID())
    const repoId = 777n
    const reportSha = 'c'.repeat(40)
    await seedAgent(prisma, agentId, { daemonId: D1, gitAccess: 'write', name: 'concurrent-agent' })
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceMode: 'github', workspaceRepoId: repoId } })
    const hook = await repo.upsert({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'concurrent review',
      sessionMode: 'perThread',
      repoId,
      repoFullName: 'acme/concurrent',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const accepted = {
      deliveryKey: 'concurrent-delivery-1',
      firedAt: new Date('2026-07-11T00:00:00.000Z'),
      event: 'pull_request:opened',
      status: 'accepted' as const,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event' as const,
      repoId,
      repoFullName: 'acme/concurrent',
      subjectKind: 'pull_request',
      pullNumber: 477,
      headSha: reportSha,
      baseSha: 'b'.repeat(40),
      reportSha
    }
    expect(await repo.recordDelivery(hookId, accepted)).toBe(true)
    const run = await repo.getRun(hookId, accepted.deliveryKey)
    expect(run).not.toBeNull()
    const input = {
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'concurrent-agent',
      repoId,
      repoFullName: 'acme/concurrent',
      headSha: reportSha,
      reportSha,
      projectionEpoch: run!.projectionEpoch!,
      mode: 'check' as const,
      gateMode: 'informational' as const,
      desiredState: 'queued',
      currentHookRunId: run!.id,
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    }

    const projections = await Promise.all(Array.from({ length: 8 }, () => repo.upsertReviewProjection(input)))
    expect(new Set(projections.map((projection) => projection.id)).size).toBe(1)
    expect(projections.map((projection) => projection.generation)).toEqual(Array<bigint>(8).fill(1n))
    expect(await prisma.hookReviewProjection.count({ where: { hookId, repoId: input.repoId, reportSha } })).toBe(1)
    await prisma.hookReviewProjection.update({
      where: { id: projections[0]!.id },
      data: { checkRunId: '90071992547409931', observedState: 'skipped' }
    })

    expect(
      await repo.recordDelivery(hookId, {
        ...accepted,
        deliveryKey: 'concurrent-delivery-2',
        firedAt: new Date('2026-07-11T00:00:01.000Z')
      })
    ).toBe(true)
    const newerRun = await repo.getRun(hookId, 'concurrent-delivery-2')
    expect(newerRun).not.toBeNull()
    const newerProjection = await repo.upsertReviewProjection({
      ...input,
      currentHookRunId: newerRun!.id
    })
    expect(newerProjection).toMatchObject({
      id: projections[0]!.id,
      generation: 2n,
      currentHookRunId: newerRun!.id,
      checkRunId: null
    })

    // The same detach happens when the next rerun arrived while an older
    // generation still had a GitHub write in flight.
    const leaseOwner = 'concurrent-worker'
    const marker = randomUUID()
    await prisma.hookReviewProjection.update({
      where: { id: newerProjection.id },
      data: {
        checkRunId: '90071992547409932',
        observedState: 'skipped',
        leaseOwner,
        leaseUntil: new Date('2026-07-11T00:01:00.000Z')
      }
    })
    expect(
      await repo.beginProjectionWrite(
        newerProjection.id,
        newerProjection.generation,
        leaseOwner,
        marker,
        'update',
        new Date('2026-07-11T00:00:02.000Z')
      )
    ).toBe(true)
    expect(
      await repo.recordDelivery(hookId, {
        ...accepted,
        deliveryKey: 'concurrent-delivery-3',
        firedAt: new Date('2026-07-11T00:00:03.000Z')
      })
    ).toBe(true)
    const pendingRun = await repo.getRun(hookId, 'concurrent-delivery-3')
    expect(pendingRun).not.toBeNull()
    expect(
      await repo.upsertReviewProjection({
        ...input,
        currentHookRunId: pendingRun!.id,
        nextAttemptAt: new Date('2026-07-11T00:00:03.000Z')
      })
    ).toMatchObject({
      generation: newerProjection.generation,
      checkRunId: '90071992547409932',
      pendingIntent: expect.objectContaining({ currentHookRunId: pendingRun!.id })
    })
    expect(
      await repo.completeProjectionWrite({
        projectionId: newerProjection.id,
        generation: newerProjection.generation,
        leaseOwner,
        writeMarker: marker,
        observedState: 'skipped',
        checkRunId: '90071992547409932'
      })
    ).toBe(true)
    expect(
      await repo.advancePendingReviewProjection(
        newerProjection.id,
        newerProjection.generation,
        new Date('2026-07-11T00:00:03.000Z')
      )
    ).toMatchObject({
      generation: newerProjection.generation + 1n,
      currentHookRunId: pendingRun!.id,
      checkRunId: null
    })
  })

  it('atomically seals terminal generations against delayed queued/start edges', async () => {
    const repo = new PgHookRepo(prisma)
    const base = {
      hookId: HookId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(randomUUID()),
      agentName: 'monotonic-agent',
      repoId: 778n,
      repoFullName: 'acme/monotonic',
      headSha: 'e'.repeat(40),
      reportSha: 'e'.repeat(40),
      projectionEpoch: 1n,
      mode: 'check' as const,
      gateMode: 'informational' as const,
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    }
    const queued = await repo.upsertReviewProjection({ ...base, desiredState: 'queued' })
    expect(queued).toMatchObject({ generation: 1n, desiredState: 'queued', sealedThrough: 0n })

    expect(
      await repo.setProjectionDesired(queued.id, queued.generation, 'success', new Date('2026-07-11T00:00:01.000Z'))
    ).toBe(true)
    expect(await repo.getReviewProjection(queued.id)).toMatchObject({ desiredState: 'success', sealedThrough: 1n })
    expect(
      await repo.setProjectionDesired(queued.id, queued.generation, 'in_progress', new Date('2026-07-11T00:00:02.000Z'))
    ).toBe(false)
    expect(await repo.getReviewProjection(queued.id)).toMatchObject({ desiredState: 'success', sealedThrough: 1n })

    const completionFirst = await repo.upsertReviewProjection({
      ...base,
      hookId: HookId(randomUUID()),
      reportSha: 'f'.repeat(40),
      headSha: 'f'.repeat(40),
      desiredState: 'failure'
    })
    expect(completionFirst).toMatchObject({ generation: 1n, desiredState: 'failure', sealedThrough: 1n })
    expect(
      await repo.setProjectionDesired(
        completionFirst.id,
        completionFirst.generation,
        'queued',
        new Date('2026-07-11T00:00:03.000Z')
      )
    ).toBe(false)
  })

  it('keeps a submitted formal verdict authoritative across stale generic terminal coordinators', async () => {
    const repo = new PgHookRepo(prisma)
    const createBound = async (state: 'reserved' | 'submitted', suffix: string) => {
      const hookId = HookId(randomUUID())
      const agentId = AgentId(randomUUID())
      const headSha = suffix.repeat(40)
      const projection = await repo.upsertReviewProjection({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        agentName: 'formal-review-agent',
        repoId: BigInt(8_000 + suffix.charCodeAt(0)),
        repoFullName: `acme/formal-${suffix}`,
        headSha,
        reportSha: headSha,
        projectionEpoch: 1n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'queued',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      })
      const attemptId = randomUUID()
      const run = await prisma.hookRun.create({
        data: {
          hookId,
          orgId: DEFAULT_ORG_ID,
          deliveryKey: `formal-${suffix}`,
          startedAt: new Date('2026-07-11T00:00:00.000Z'),
          agentId,
          dispatchDaemonId: D1,
          headSha,
          reviewAttemptId: attemptId,
          reviewAttemptState: state,
          reviewEvent: 'APPROVE',
          verdict: 'pass',
          ...(state === 'submitted' ? { reviewId: `review-${suffix}`, reviewCommitId: headSha } : {}),
          projectionId: projection.id,
          projectionGeneration: projection.generation
        }
      })
      await prisma.hookReviewProjection.update({
        where: { id: projection.id },
        data: { currentHookRunId: run.id }
      })
      return { hookId, headSha, projection, run, attemptId }
    }

    // Formal result wins first: a stale afterReport carrying generic failure
    // re-reads the locked HookRun and writes the formal pass instead.
    const submitted = await createBound('submitted', '7')
    expect(
      await repo.setProjectionDesired(
        submitted.projection.id,
        submitted.projection.generation,
        'failure',
        new Date('2026-07-11T00:00:01.000Z'),
        submitted.run.id
      )
    ).toBe(true)
    expect(await repo.getReviewProjection(submitted.projection.id)).toMatchObject({
      desiredState: 'success',
      sealedThrough: submitted.projection.generation
    })

    // Generic terminal wins first: the later formal-result transaction uses
    // the same run -> projection lock order and overwrites it authoritatively.
    const reserved = await createBound('reserved', '8')
    expect(
      await repo.setProjectionDesired(
        reserved.projection.id,
        reserved.projection.generation,
        'failure',
        new Date('2026-07-11T00:00:02.000Z'),
        reserved.run.id
      )
    ).toBe(true)
    expect(
      await repo.recordReviewResult(reserved.hookId, D1, {
        deliveryKey: reserved.run.deliveryKey,
        attemptId: reserved.attemptId,
        state: 'submitted',
        reviewId: 'review-8',
        event: 'APPROVE',
        verdict: 'pass',
        commitId: reserved.headSha
      })
    ).toBe(true)
    expect(await repo.getReviewProjection(reserved.projection.id)).toMatchObject({
      desiredState: 'success',
      sealedThrough: reserved.projection.generation
    })
  })

  it('keeps a submitted formal verdict authoritative when the stale-run reaper wins later', async () => {
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const agentId = AgentId(randomUUID())
    const headSha = '6'.repeat(40)
    const projection = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'reaper-agent',
      repoId: 8_006n,
      repoFullName: 'acme/reaper-formal',
      headSha,
      reportSha: headSha,
      projectionEpoch: 1n,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'success',
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    })
    const run = await prisma.hookRun.create({
      data: {
        hookId,
        orgId: DEFAULT_ORG_ID,
        deliveryKey: 'reaper-formal',
        startedAt: new Date('2026-07-11T00:00:00.000Z'),
        agentId,
        dispatchDaemonId: D1,
        headSha,
        reviewAttemptId: randomUUID(),
        reviewAttemptState: 'submitted',
        reviewId: 'review-reaper-formal',
        reviewEvent: 'APPROVE',
        verdict: 'pass',
        reviewCommitId: headSha,
        projectionId: projection.id,
        projectionGeneration: projection.generation
      }
    })
    await prisma.hookReviewProjection.update({
      where: { id: projection.id },
      data: { currentHookRunId: run.id, sealedThrough: projection.generation }
    })

    expect(await repo.reapStaleRuns(new Date('2026-07-11T00:01:00.000Z'))).toBe(1)
    expect(await repo.getRun(hookId, run.deliveryKey)).toMatchObject({
      status: 'failed',
      reviewAttemptState: 'submitted',
      verdict: 'pass'
    })
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      desiredState: 'success',
      sealedThrough: projection.generation
    })
  })

  it('keeps late review/report/reaper state off a tombstoned generation and drains only cleanup', async () => {
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const agentId = AgentId(randomUUID())
    const headSha = '5'.repeat(40)
    const projection = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'tombstone-agent',
      repoId: 8_005n,
      repoFullName: 'acme/tombstone-late-result',
      headSha,
      reportSha: headSha,
      projectionEpoch: 1n,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'queued',
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    })
    const attemptId = randomUUID()
    const run = await prisma.hookRun.create({
      data: {
        hookId,
        orgId: DEFAULT_ORG_ID,
        deliveryKey: 'tombstone-late-result',
        startedAt: new Date('2026-07-11T00:00:00.000Z'),
        agentId,
        dispatchDaemonId: D1,
        headSha,
        reviewAttemptId: attemptId,
        reviewAttemptState: 'reserved',
        reviewEvent: 'APPROVE',
        verdict: 'pass',
        projectionId: projection.id,
        projectionGeneration: projection.generation
      }
    })
    const worker = 'tombstone-crash-worker'
    const marker = randomUUID()
    await prisma.hookReviewProjection.update({
      where: { id: projection.id },
      data: {
        currentHookRunId: run.id,
        checkRunId: '90071992547409935',
        observedState: 'queued',
        leaseOwner: worker,
        leaseUntil: new Date('2026-07-11T00:01:00.000Z')
      }
    })
    expect(
      await repo.beginProjectionWrite(
        projection.id,
        projection.generation,
        worker,
        marker,
        'update',
        new Date('2026-07-11T00:00:01.000Z')
      )
    ).toBe(true)
    const tombstonedAt = new Date('2026-07-11T00:00:02.000Z')
    expect(await repo.tombstoneReviewProjections([hookId], tombstonedAt, 'failure')).toBe(1)

    // The formal effect remains durable history, but none of the result,
    // reaper, report, or coordinator paths may mutate the cleanup-owned row.
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: run.deliveryKey,
        attemptId,
        state: 'submitted',
        reviewId: 'review-after-tombstone',
        event: 'APPROVE',
        verdict: 'pass',
        commitId: headSha
      })
    ).toBe(true)
    expect(await repo.reapStaleRuns(new Date('2026-07-11T00:10:00.000Z'))).toBe(1)
    expect(
      await repo.recordReport(
        hookId,
        D1,
        {
          deliveryKey: run.deliveryKey,
          status: 'success',
          projectionDesiredState: 'success',
          projectionNextAttemptAt: new Date('2026-07-11T00:10:01.000Z')
        },
        new Date('2026-07-11T00:10:01.000Z')
      )
    ).toBe(true)
    expect(
      await repo.setProjectionDesired(
        projection.id,
        projection.generation,
        'success',
        new Date('2026-07-11T00:10:02.000Z'),
        run.id
      )
    ).toBe(false)
    expect(await repo.getRun(hookId, run.deliveryKey)).toMatchObject({
      status: 'success',
      reviewAttemptState: 'submitted',
      verdict: 'pass'
    })
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      generation: projection.generation,
      desiredState: 'queued',
      observedState: 'queued',
      writeMarker: marker,
      tombstonedAt,
      pendingIntent: expect.objectContaining({ desiredState: 'failure', tombstoned: true })
    })

    // Crash recovery confirms only the already-issued queued marker, then the
    // retained cleanup intent becomes the next generation claimed by a worker.
    expect(
      await repo.completeProjectionWrite({
        projectionId: projection.id,
        generation: projection.generation,
        leaseOwner: worker,
        writeMarker: marker,
        observedState: 'queued',
        checkRunId: '90071992547409935'
      })
    ).toBe(true)
    const claimed = await repo.claimDueReviewProjections(
      'cleanup-claim',
      new Date('2026-07-11T00:10:03.000Z'),
      new Date('2026-07-11T00:11:03.000Z')
    )
    expect(claimed.map((row) => row.id)).toContain(projection.id)
    const beforeAdvance = (await repo.getReviewProjection(projection.id))!
    expect(
      await repo.advancePendingReviewProjection(
        projection.id,
        projection.generation,
        new Date('2026-07-11T00:10:03.000Z')
      )
    ).toMatchObject({
      generation: projection.generation + 1n,
      desiredState: 'failure',
      tombstonedAt
    })
    expect(beforeAdvance.desiredState).not.toBe('success')
  })

  it('uses a fresh projection epoch for agent reassignment and disable/re-enable on the same SHA', async () => {
    await seedDaemon(prisma, D1)
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const firstAgent = AgentId(randomUUID())
    const secondAgent = AgentId(randomUUID())
    await seedAgent(prisma, firstAgent, { daemonId: D1, name: 'first-epoch-agent' })
    await seedAgent(prisma, secondAgent, { daemonId: D1, name: 'second-epoch-agent' })
    const reportSha = '9'.repeat(40)
    const hookInput = (agentId: AgentId, enabled: boolean) => ({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github' as const,
      name: 'epoch-hook',
      enabled,
      sessionMode: 'perThread' as const,
      repoId: 909n,
      repoFullName: 'acme/epoch',
      events: ['pull_request:*'],
      reviewPolicy: 'full' as const,
      reportingMode: 'check' as const,
      gateMode: 'informational' as const
    })
    await repo.upsert(hookInput(firstAgent, true))
    const firstEpoch = (await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).projectionEpoch
    const projectionInput = (agentId: AgentId, agentName: string, projectionEpoch: bigint) => ({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName,
      repoId: 909n,
      repoFullName: 'acme/epoch',
      headSha: reportSha,
      reportSha,
      projectionEpoch,
      mode: 'check' as const,
      gateMode: 'informational' as const,
      desiredState: 'success',
      nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
    })
    const first = await repo.upsertReviewProjection(projectionInput(firstAgent, 'first-epoch-agent', firstEpoch))

    await repo.upsert(hookInput(secondAgent, true))
    const reassignedEpoch = (await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).projectionEpoch
    expect(reassignedEpoch).toBe(firstEpoch + 1n)
    expect(await repo.getReviewProjection(first.id)).toMatchObject({
      agentId: firstAgent,
      tombstonedAt: expect.any(Date)
    })
    const reassigned = await repo.upsertReviewProjection(
      projectionInput(secondAgent, 'second-epoch-agent', reassignedEpoch)
    )
    expect(reassigned).toMatchObject({ agentId: secondAgent, projectionEpoch: reassignedEpoch, tombstonedAt: null })
    expect(reassigned.id).not.toBe(first.id)

    await repo.upsert(hookInput(secondAgent, false))
    const disabledEpoch = (await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).projectionEpoch
    expect(disabledEpoch).toBe(reassignedEpoch + 1n)
    expect(await repo.getReviewProjection(reassigned.id)).toMatchObject({ tombstonedAt: expect.any(Date) })

    await repo.upsert(hookInput(secondAgent, true))
    const reenabledEpoch = (await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).projectionEpoch
    expect(reenabledEpoch).toBe(disabledEpoch + 1n)
    const reenabled = await repo.upsertReviewProjection(
      projectionInput(secondAgent, 'second-epoch-agent', reenabledEpoch)
    )
    expect(reenabled).toMatchObject({ projectionEpoch: reenabledEpoch, tombstonedAt: null })
    expect(new Set([first.id, reassigned.id, reenabled.id]).size).toBe(3)
  })

  it('rejects completion-first projection metadata outside the current GitHub hook fence', async () => {
    await seedDaemon(prisma, D1)
    const repo = new PgHookRepo(prisma)
    const agentId = AgentId(randomUUID())
    await seedAgent(prisma, agentId, { daemonId: D1 })
    const hookId = HookId(randomUUID())
    const githubInput = {
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github' as const,
      name: 'completion-fence',
      enabled: true,
      sessionMode: 'perThread' as const,
      repoId: 477n,
      repoFullName: 'acme/fenced',
      events: ['pull_request:*'],
      reviewPolicy: 'full' as const,
      reportingMode: 'check' as const,
      gateMode: 'informational' as const
    }
    const hook = await repo.upsert(githubInput)
    const headSha = 'a'.repeat(40)
    const report = {
      event: 'pull_request:opened',
      status: 'success' as const,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event' as const,
      repoId: 477n,
      repoFullName: 'acme/fenced',
      sourceInstallationId: 99n,
      subjectKind: 'pull_request',
      pullNumber: 477,
      headSha,
      baseSha: 'b'.repeat(40),
      reportSha: headSha
    }
    const at = new Date('2026-07-11T00:10:00.000Z')

    expect(await repo.recordReport(hookId, D1, { ...report, deliveryKey: 'wrong-repo', repoId: 478n }, at)).toBe(false)
    expect(
      await repo.recordReport(hookId, D1, { ...report, deliveryKey: 'wrong-report-sha', reportSha: 'c'.repeat(40) }, at)
    ).toBe(false)

    const disabled = await repo.upsert({ ...githubInput, enabled: false })
    expect(
      await repo.recordReport(
        hookId,
        D1,
        {
          ...report,
          deliveryKey: 'disabled-hook',
          configRevision: disabled.configRevision,
          dispatchRevision: disabled.dispatchRevision
        },
        at
      )
    ).toBe(false)

    const webhookId = HookId(randomUUID())
    const webhook = await repo.upsert({
      hookId: webhookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'webhook',
      name: 'not-github',
      enabled: true,
      sessionMode: 'perDelivery'
    })
    expect(
      await repo.recordReport(
        webhookId,
        D1,
        {
          ...report,
          deliveryKey: 'non-github',
          configRevision: webhook.configRevision,
          dispatchRevision: webhook.dispatchRevision,
          reviewPolicySnapshot: webhook.reviewPolicy,
          reportingModeSnapshot: webhook.reportingMode,
          gateModeSnapshot: webhook.gateMode
        },
        at
      )
    ).toBe(false)
    expect(await prisma.hookRun.count({ where: { hookId: { in: [hookId, webhookId] } } })).toBe(0)
  })

  it('serializes generation advance against beginProjectionWrite', async () => {
    const repo = new PgHookRepo(prisma)
    for (let i = 0; i < 12; i++) {
      const hookId = HookId(randomUUID())
      const reportSha = i.toString(16).padStart(40, 'd')
      const base = {
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId: AgentId(randomUUID()),
        agentName: 'write-race-agent',
        repoId: BigInt(10_000 + i),
        repoFullName: `acme/write-race-${i}`,
        headSha: reportSha,
        reportSha,
        projectionEpoch: 1n,
        mode: 'check' as const,
        gateMode: 'informational' as const,
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      }
      const initial = await repo.upsertReviewProjection(base)
      const leaseOwner = `race-worker-${i}`
      await prisma.hookReviewProjection.update({
        where: { id: initial.id },
        data: { leaseOwner, leaseUntil: new Date('2026-07-11T00:01:00.000Z') }
      })
      const marker = randomUUID()

      const [began, advanced] = await Promise.all([
        repo.beginProjectionWrite(
          initial.id,
          initial.generation,
          leaseOwner,
          marker,
          'update',
          new Date('2026-07-11T00:00:01.000Z')
        ),
        repo.upsertReviewProjection({
          ...base,
          desiredState: 'queued',
          nextAttemptAt: new Date('2026-07-11T00:00:02.000Z')
        })
      ])
      const fresh = (await repo.getReviewProjection(initial.id))!

      if (began) {
        expect(fresh).toMatchObject({
          generation: initial.generation,
          writeMarker: marker,
          writePhase: 'update'
        })
        expect(fresh.pendingIntent).toMatchObject({ desiredState: 'queued' })
        expect(advanced.generation).toBe(initial.generation)
      } else {
        expect(fresh).toMatchObject({
          generation: initial.generation + 1n,
          desiredState: 'queued',
          writeMarker: null,
          writePhase: null
        })
        expect(advanced.generation).toBe(initial.generation + 1n)
      }
    }
  })

  it('serializes tombstone cleanup against begin and completion of an old write', async () => {
    const repo = new PgHookRepo(prisma)
    for (let i = 0; i < 12; i++) {
      const hookId = HookId(randomUUID())
      const reportSha = i.toString(16).padStart(40, 'e')
      const input = {
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId: AgentId(randomUUID()),
        agentName: 'tombstone-race-agent',
        repoId: BigInt(20_000 + i),
        repoFullName: `acme/tombstone-race-${i}`,
        headSha: reportSha,
        reportSha,
        projectionEpoch: 1n,
        mode: 'check' as const,
        gateMode: 'informational' as const,
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:00:00.000Z')
      }
      const initial = await repo.upsertReviewProjection(input)
      const leaseOwner = `cleanup-worker-${i}`
      await prisma.hookReviewProjection.update({
        where: { id: initial.id },
        data: { leaseOwner, leaseUntil: new Date('2026-07-11T00:01:00.000Z') }
      })
      const marker = randomUUID()
      const tombstonedAt = new Date(`2026-07-11T00:00:${String(10 + i).padStart(2, '0')}.000Z`)

      const [began, tombstoned] = await Promise.all([
        repo.beginProjectionWrite(
          initial.id,
          initial.generation,
          leaseOwner,
          marker,
          'update',
          new Date('2026-07-11T00:00:01.000Z')
        ),
        repo.tombstoneReviewProjections([hookId], tombstonedAt, 'neutral')
      ])
      expect(tombstoned).toBe(1)
      let fresh = (await repo.getReviewProjection(initial.id))!

      if (began) {
        expect(fresh).toMatchObject({
          generation: initial.generation,
          tombstonedAt,
          writeMarker: marker,
          writePhase: 'update'
        })
        expect(fresh.pendingIntent).toMatchObject({ desiredState: 'neutral', tombstoned: true })
        expect(
          await repo.completeProjectionWrite({
            projectionId: initial.id,
            generation: initial.generation,
            leaseOwner,
            writeMarker: marker,
            observedState: 'success',
            checkRunId: `check-${i}`
          })
        ).toBe(true)
        fresh = (await repo.getReviewProjection(initial.id))!
        expect(fresh).toMatchObject({ writeMarker: null, writePhase: null, tombstonedAt })
        expect(fresh.nextAttemptAt).not.toBeNull()
        expect(await repo.advancePendingReviewProjection(initial.id, initial.generation, tombstonedAt)).not.toBeNull()
      } else {
        expect(fresh).toMatchObject({
          generation: initial.generation + 1n,
          desiredState: 'neutral',
          tombstonedAt,
          writeMarker: null,
          writePhase: null
        })
      }

      fresh = (await repo.getReviewProjection(initial.id))!
      expect(fresh).toMatchObject({ desiredState: 'neutral', tombstonedAt })
      const delayed = await repo.upsertReviewProjection({
        ...input,
        desiredState: 'success',
        nextAttemptAt: new Date('2026-07-11T00:01:30.000Z')
      })
      expect(delayed).toMatchObject({
        id: initial.id,
        generation: fresh.generation,
        desiredState: 'neutral',
        tombstonedAt
      })
    }
  })

  it('round-trips workspaceRepoId and bumps every owned hook dispatch fence with placement', async () => {
    await seedDaemon(prisma, D1)
    await seedDaemon(prisma, D2)
    const agents = new PgAgentRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const agentId = AgentId(randomUUID())
    await agents.create({
      id: agentId,
      orgId: OrgId(DEFAULT_ORG_ID),
      name: `repo-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      daemonId: D1,
      workspace: { mode: 'github', gitRepo: 'github.com/acme/infra', installationId: randomUUID() },
      workspaceRepoId: 987654321n
    })
    expect((await agents.get(OrgId(DEFAULT_ORG_ID), agentId))?.workspaceRepoId).toBe(987654321n)

    const hookId = HookId(randomUUID())
    await hooks.upsert({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'review',
      sessionMode: 'perThread',
      repoId: 987654321n,
      repoFullName: 'acme/infra',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    expect((await hooks.getUnscoped(hookId))?.dispatchRevision).toBe(1n)

    expect(await agents.movePlacement(agentId, onDaemon(D1), onDaemon(D2))).not.toBeNull()
    expect((await hooks.getUnscoped(hookId))?.dispatchRevision).toBe(2n)
    await agents.setPlacement(agentId, UNPLACED)
    expect((await hooks.getUnscoped(hookId))?.dispatchRevision).toBe(3n)
  })

  it('converges renamed GitHub display fields without changing session affinity or accepting stale names', async () => {
    await seedDaemon(prisma, D1)
    const agents = new PgAgentRepo(prisma)
    const hooks = new PgHookRepo(prisma)
    const agentId = AgentId(randomUUID())
    await agents.create({
      id: agentId,
      orgId: OrgId(DEFAULT_ORG_ID),
      name: `rename-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      daemonId: D1
    })
    const workspaceAgentId = AgentId(randomUUID())
    const workspaceBefore = await agents.create({
      id: workspaceAgentId,
      orgId: OrgId(DEFAULT_ORG_ID),
      name: `workspace-rename-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      daemonId: D1,
      workspace: {
        mode: 'github',
        gitRepo: 'https://github.com/acme/old-name',
        installationId: randomUUID(),
        gitAccess: 'write'
      },
      workspaceRepoId: 44n
    })
    const manualWorkspaceAgentId = AgentId(randomUUID())
    await agents.create({
      id: manualWorkspaceAgentId,
      orgId: OrgId(DEFAULT_ORG_ID),
      name: `manual-workspace-rename-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      workspace: { mode: 'github', gitRepo: 'git@github.com:acme/old-name.git' },
      workspaceRepoId: 44n
    })
    const hookIds = [HookId(randomUUID()), HookId(randomUUID())]
    const hookRows = new Map<HookId, HookRecord>()
    for (const [index, hookId] of hookIds.entries()) {
      const hook = await hooks.upsert({
        hookId,
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId,
        kind: 'github',
        name: index === 0 ? 'acme/old-name' : `custom-${hookId}`,
        sessionMode: 'perThread',
        repoId: 44n,
        repoFullName: 'acme/old-name',
        events: ['issues:opened']
      })
      hookRows.set(hookId, hook)
    }
    await prisma.agentRepoAuthorization.create({
      data: {
        agentId,
        provider: 'github',
        repoId: 44n,
        repoFullName: 'acme/old-name',
        access: 'read'
      }
    })
    // The SAME agent may hold GitLab project 44 — the hosts number their
    // repositories independently, so the unique key permits both. A GitHub rename
    // must not reach across and rewrite this one's path (§8.1).
    await prisma.agentRepoAuthorization.create({
      data: {
        agentId,
        provider: 'gitlab',
        repoId: 44n,
        repoFullName: 'example-group/example-project',
        access: 'read'
      }
    })
    const delivery = (
      hookId: HookId,
      deliveryKey: string,
      firedAt: Date,
      repoFullName: string,
      status: HookDeliveryInput['status']
    ): HookDeliveryInput => {
      const hook = hookRows.get(hookId)!
      return {
        deliveryKey,
        firedAt,
        event: 'issues:opened',
        status,
        ...(status === 'failed' ? { reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE } : {}),
        agentId,
        configRevision: hook.configRevision,
        dispatchRevision: hook.dispatchRevision,
        dispatchDaemonId: D1,
        reviewPolicySnapshot: hook.reviewPolicy,
        reportingModeSnapshot: hook.reportingMode,
        gateModeSnapshot: hook.gateMode,
        repoId: 44n,
        repoFullName,
        sourceInstallationId: 99n,
        subjectKind: 'issue'
      }
    }
    const oldAt = new Date('2026-07-23T06:00:00.000Z')
    for (const hookId of hookIds) {
      await expect(
        hooks.recordDeliveryResult(hookId, delivery(hookId, 'old-delivery', oldAt, 'acme/old-name', 'failed'))
      ).resolves.toEqual({ accepted: true, newlyObserved: true })
    }
    const redeliveryRequestedAt = new Date(oldAt.getTime() + 1_000)
    await expect(
      hooks.claimRetryableDeliveryRedelivery('old-delivery', [...hookIds].sort(), redeliveryRequestedAt, [30_000])
    ).resolves.toBe(true)

    const renamedAt = new Date(oldAt.getTime() + 2_000)
    const renamed = await hooks.recordDeliveryResult(
      hookIds[0]!,
      delivery(hookIds[0]!, 'renamed-delivery', renamedAt, 'acme/new-name', 'accepted')
    )
    expect(renamed).toEqual({ accepted: true, newlyObserved: true })
    const changed = renamed.newlyObserved
      ? await hooks.refreshGithubRepoFullName(hookIds[0]!, 44n, 'acme/new-name', renamedAt)
      : { hooks: [], agentIds: [] }

    expect(changed.hooks.map((hook) => hook.id).sort()).toEqual([...hookIds].sort())
    // Both kinds of renamed agent converge: the App-backed workspace and the grant owner,
    // whose `workspace.additionalRepos` entry carries the same display name.
    expect([...changed.agentIds].sort()).toEqual([agentId, workspaceAgentId].sort())
    expect(
      await prisma.hookDef.findMany({
        where: { id: { in: hookIds } },
        orderBy: { id: 'asc' },
        select: { id: true, name: true, repoFullName: true, githubSessionKey: true }
      })
    ).toEqual(
      [...hookIds].sort().map((id) => ({
        id,
        name: id === hookIds[0] ? 'acme/new-name' : `custom-${id}`,
        repoFullName: 'acme/new-name',
        githubSessionKey: 'github:44'
      }))
    )
    expect(
      await prisma.agentRepoAuthorization.findUniqueOrThrow({
        where: { agentId_provider_repoId: { agentId, provider: 'github', repoId: 44n } },
        select: { repoFullName: true }
      })
    ).toEqual({ repoFullName: 'acme/new-name' })
    // The same-numbered GitLab grant kept its own path and its owner was counted once.
    expect(
      await prisma.agentRepoAuthorization.findUniqueOrThrow({
        where: { agentId_provider_repoId: { agentId, provider: 'gitlab', repoId: 44n } },
        select: { repoFullName: true }
      })
    ).toEqual({ repoFullName: 'example-group/example-project' })
    expect(await agents.get(OrgId(DEFAULT_ORG_ID), workspaceAgentId)).toMatchObject({
      workspace: { mode: 'github', gitRepo: 'https://github.com/acme/new-name' },
      workspaceRepoId: 44n,
      lastModifiedAt: workspaceBefore.lastModifiedAt
    })
    expect(await agents.get(OrgId(DEFAULT_ORG_ID), manualWorkspaceAgentId)).toMatchObject({
      workspace: { mode: 'github', gitRepo: 'git@github.com:acme/old-name.git' },
      workspaceRepoId: 44n
    })

    const redeliveredAt = new Date(redeliveryRequestedAt.getTime() + 30_000)
    for (const hookId of hookIds) {
      const reopened = await hooks.recordDeliveryResult(
        hookId,
        delivery(hookId, 'old-delivery', redeliveredAt, 'acme/old-name', 'accepted')
      )
      expect(reopened).toEqual({ accepted: true, newlyObserved: false })
      if (reopened.newlyObserved) {
        await hooks.refreshGithubRepoFullName(hookId, 44n, 'acme/old-name', redeliveredAt)
      }
    }
    expect(
      await prisma.hookDef.findUniqueOrThrow({
        where: { id: hookIds[1] },
        select: { repoFullName: true, lastFiredAt: true }
      })
    ).toEqual({ repoFullName: 'acme/new-name', lastFiredAt: redeliveredAt })
  })

  it('persists effective installation permissions and never moves an org claim', async () => {
    const repo = new PgGithubInstallationRepo(prisma)
    const installationId = BigInt(4_000_000 + Math.floor(Math.random() * 100_000))
    const first = await repo.upsertFromGithub(OrgId(DEFAULT_ORG_ID), {
      installationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      permissions: { pull_requests: 'write', checks: 'write' }
    })
    expect(first.permissions).toEqual({ pull_requests: 'write', checks: 'write' })

    const otherOrg = `org-${randomUUID()}`
    await prisma.org.create({ data: { id: otherOrg, slug: `s-${randomUUID()}` } })
    await expect(
      repo.upsertFromGithub(OrgId(otherOrg), {
        installationId,
        accountLogin: 'evil',
        accountType: 'Organization',
        repositorySelection: 'selected',
        suspendedAt: null,
        permissions: {}
      })
    ).rejects.toBeInstanceOf(GithubInstallationClaimConflict)
    const durable = await repo.get(OrgId(DEFAULT_ORG_ID), first.id)
    expect(durable).toMatchObject({ orgId: DEFAULT_ORG_ID, accountLogin: 'acme' })
    expect(durable?.permissions).toEqual({ pull_requests: 'write', checks: 'write' })

    await repo.markRevokedByInstallationId(installationId)
    expect((await repo.listForOrg(OrgId(DEFAULT_ORG_ID))).some((row) => row.installationId === installationId)).toBe(
      false
    )
    expect(await repo.listClaimsForOrg(OrgId(DEFAULT_ORG_ID))).toEqual([
      expect.objectContaining({ installationId, orgId: DEFAULT_ORG_ID, revokedAt: expect.any(Date) })
    ])
  })

  it('fences start/review/completion and drives the durable projection outbox', async () => {
    await seedDaemon(prisma, D1)
    const agentId = AgentId(randomUUID())
    await seedAgent(prisma, agentId, { daemonId: D1, name: 'review-agent' })
    await prisma.agent.update({
      where: { id: agentId },
      data: { workspaceMode: 'github', workspaceRepoId: 22n, gitAccess: 'write' }
    })
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const hook = await repo.upsert({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'review',
      sessionMode: 'perThread',
      repoId: 22n,
      repoFullName: 'acme/infra',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const firedAt = new Date('2026-07-11T01:00:00.000Z')
    const accepted = {
      deliveryKey: 'delivery-r2a',
      firedAt,
      event: 'pull_request:opened',
      status: 'accepted' as const,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event' as const,
      repoId: 22n,
      repoFullName: 'acme/infra',
      sourceInstallationId: 44n,
      subjectKind: 'pull_request',
      pullNumber: 477,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      reportSha: 'a'.repeat(40)
    }
    expect(await repo.recordDelivery(hookId, accepted)).toBe(true)
    expect(
      await repo.recordDelivery(hookId, {
        ...accepted,
        deliveryKey: 'delivery-stale',
        dispatchRevision: hook.dispatchRevision + 1n
      })
    ).toBe(false)

    const start = {
      deliveryKey: accepted.deliveryKey,
      agentId,
      sessionId: 'session/with space',
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      startedAt: new Date('2026-07-11T01:00:01.000Z'),
      projectionIntent: accepted.projectionIntent,
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      sourceInstallationId: accepted.sourceInstallationId,
      subjectKind: accepted.subjectKind,
      pullNumber: accepted.pullNumber,
      headSha: accepted.headSha,
      baseSha: accepted.baseSha,
      reportSha: accepted.reportSha
    }
    expect(await repo.recordStart(hookId, D1, start)).toBe(true)
    expect(await repo.recordStart(hookId, D1, start)).toBe(true)
    expect(
      await repo.recordStart(hookId, D1, {
        ...start,
        startedAt: new Date(start.startedAt.getTime() + 1)
      })
    ).toBe(false)
    expect(await repo.recordStart(hookId, D2, start)).toBe(false)
    expect((await repo.getRun(hookId, accepted.deliveryKey))?.sessionId).toBe('session/with space')

    const attemptId = randomUUID()
    const reservation = {
      deliveryKey: accepted.deliveryKey,
      attemptId,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      requestedEvent: 'APPROVE' as const,
      requestedVerdict: 'pass' as const
    }
    expect(await repo.reserveReviewAttempt(hookId, D1, reservation)).toBe('reserved')
    expect(await repo.reserveReviewAttempt(hookId, D1, reservation)).toBe('idempotent')
    expect(await repo.reserveReviewAttempt(hookId, D1, { ...reservation, requestedEvent: 'COMMENT' })).toBe('rejected')
    expect(await repo.reserveReviewAttempt(hookId, D1, { ...reservation, requestedVerdict: 'neutral' })).toBe(
      'rejected'
    )
    expect(await repo.reserveReviewAttempt(hookId, D1, { ...reservation, attemptId: randomUUID() })).toBe('rejected')
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: accepted.deliveryKey,
        attemptId,
        state: 'blocked',
        code: 'ambiguous_write'
      })
    ).toBe(true)
    expect(await repo.reserveReviewAttempt(hookId, D1, reservation)).toBe('idempotent')
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: accepted.deliveryKey,
        attemptId,
        state: 'submitted',
        reviewId: '9223372036854775807',
        event: 'APPROVE',
        verdict: 'neutral',
        commitId: accepted.headSha
      })
    ).toBe(false)
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: accepted.deliveryKey,
        attemptId,
        state: 'submitted',
        reviewId: '9223372036854775807',
        event: 'APPROVE',
        verdict: 'pass',
        commitId: accepted.headSha
      })
    ).toBe(true)

    const run = await repo.getRun(hookId, accepted.deliveryKey)
    expect(run).toMatchObject({
      reviewAttemptState: 'submitted',
      reviewId: '9223372036854775807',
      reviewEvent: 'APPROVE',
      verdict: 'pass'
    })

    const releasedDeliveryKey = 'delivery-release'
    expect(
      await repo.recordDelivery(hookId, {
        ...accepted,
        deliveryKey: releasedDeliveryKey,
        firedAt: new Date('2026-07-11T01:00:00.500Z')
      })
    ).toBe(true)
    expect(await repo.recordStart(hookId, D1, { ...start, deliveryKey: releasedDeliveryKey })).toBe(true)
    const releasedAttemptId = randomUUID()
    expect(
      await repo.reserveReviewAttempt(hookId, D1, {
        ...reservation,
        deliveryKey: releasedDeliveryKey,
        attemptId: releasedAttemptId,
        requestedEvent: 'COMMENT',
        requestedVerdict: 'neutral'
      })
    ).toBe('reserved')
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: releasedDeliveryKey,
        attemptId: releasedAttemptId,
        state: 'released',
        code: 'invalid_input'
      })
    ).toBe(true)
    expect(await repo.getRun(hookId, releasedDeliveryKey)).toMatchObject({
      reviewAttemptId: null,
      reviewAttemptState: null,
      reviewEvent: null,
      verdict: null,
      reviewErrorCode: 'invalid_input'
    })
    const projection = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'review-agent',
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      headSha: accepted.headSha,
      reportSha: accepted.reportSha,
      projectionEpoch: run!.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'queued',
      currentHookRunId: run!.id,
      nextAttemptAt: firedAt
    })
    expect(projection.generation).toBe(1n)
    expect(await repo.bindRunProjection(hookId, accepted.deliveryKey, projection.id, projection.generation)).toBe(true)
    await repo.upsertReviewSubject({
      projectionId: projection.id,
      pullNumber: accepted.pullNumber,
      headSha: accepted.headSha,
      baseSha: accepted.baseSha,
      isOpen: true
    })
    expect(await repo.listReviewSubjects(projection.id)).toHaveLength(1)
    expect(
      await repo.synchronizeReviewSubjects(
        projection.id,
        projection.generation,
        [{ pullNumber: 478, headSha: accepted.headSha, baseSha: accepted.baseSha }],
        null
      )
    ).toBe(true)
    expect(await repo.listReviewSubjects(projection.id)).toMatchObject([
      { pullNumber: 477, isOpen: false },
      { pullNumber: 478, isOpen: true, headSha: accepted.headSha }
    ])
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      subjectSyncGeneration: projection.generation,
      subjectSyncErrorCode: null,
      desiredState: 'queued'
    })
    // A capped/partial GitHub read records the generation-scoped block but
    // never closes rows from the last complete association snapshot.
    expect(
      await repo.synchronizeReviewSubjects(projection.id, projection.generation, null, 'pr_association_incomplete')
    ).toBe(true)
    expect((await repo.listReviewSubjects(projection.id)).find((subject) => subject.pullNumber === 478)?.isOpen).toBe(
      true
    )
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      subjectSyncGeneration: projection.generation,
      subjectSyncErrorCode: 'pr_association_incomplete',
      desiredState: 'queued'
    })

    expect(
      await repo.recordReport(
        hookId,
        D1,
        {
          deliveryKey: accepted.deliveryKey,
          status: 'success',
          reviewAttemptId: attemptId,
          reviewAttemptState: 'submitted',
          reviewId: '9223372036854775807',
          reviewEvent: 'APPROVE',
          verdict: 'neutral',
          reviewCommitId: accepted.headSha
        },
        new Date('2026-07-11T01:00:01.500Z')
      )
    ).toBe(false)
    expect(
      await repo.recordReport(
        hookId,
        D1,
        {
          deliveryKey: accepted.deliveryKey,
          status: 'success',
          reviewAttemptId: attemptId,
          reviewAttemptState: 'submitted',
          reviewId: '9223372036854775807',
          reviewEvent: 'APPROVE',
          verdict: 'pass',
          reviewCommitId: accepted.headSha,
          projectionDesiredState: 'success',
          projectionNextAttemptAt: new Date('2026-07-11T01:00:02.000Z')
        },
        new Date('2026-07-11T01:00:02.000Z')
      )
    ).toBe(true)
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({ desiredState: 'success', sealedThrough: 1n })
    expect((await repo.getRun(hookId, accepted.deliveryKey))?.sessionId).toBe('session/with space')
    expect(await repo.setProjectionDesired(projection.id, projection.generation, 'in_progress', firedAt)).toBe(false)
    // A lost start ACK may be replayed after completion, but only the exact
    // already-persisted barrier is idempotent; it cannot mutate terminal data.
    expect(await repo.recordStart(hookId, D1, start)).toBe(true)
    expect(
      await repo.recordStart(hookId, D1, {
        ...start,
        startedAt: new Date(start.startedAt.getTime() + 1)
      })
    ).toBe(false)
    // Crash repair may first create/bind the projection after the terminal
    // HookRun commit; terminal history must still accept an idempotent binding.
    expect(await repo.bindRunProjection(hookId, accepted.deliveryKey, projection.id, projection.generation)).toBe(true)

    const claimed = await repo.claimDueReviewProjections(
      'worker-1',
      new Date('2026-07-11T01:00:03.000Z'),
      new Date('2026-07-11T01:01:03.000Z')
    )
    expect(claimed.map((p) => p.id)).toContain(projection.id)
    const marker = randomUUID()
    expect(
      await repo.beginProjectionWrite(
        projection.id,
        projection.generation,
        'worker-1',
        marker,
        'create',
        new Date('2026-07-11T01:00:03.000Z')
      )
    ).toBe(true)
    expect(
      await repo.completeProjectionWrite({
        projectionId: projection.id,
        generation: projection.generation,
        leaseOwner: 'worker-1',
        writeMarker: marker,
        observedState: 'success',
        checkRunId: '9007199254740993',
        lastResolvedInstallationId: 44n
      })
    ).toBe(true)
    expect(await repo.setProjectionDesired(projection.id, 999n, 'failure', firedAt)).toBe(false)

    // A permission/authorization block suspends retries without destroying the
    // canonical intent. A later installation wake can therefore retry it.
    expect(await repo.blockProjection(projection.id, projection.generation, 'repo_authorization')).toBe(true)
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      desiredState: 'success',
      observedState: 'success',
      lastErrorCode: 'repo_authorization',
      nextAttemptAt: null
    })
    expect(await repo.wakeReviewProjectionsForOrg(OrgId(DEFAULT_ORG_ID), new Date('2026-07-11T01:00:04.000Z'))).toBe(1)
    expect((await repo.getReviewProjection(projection.id))?.nextAttemptAt).toEqual(new Date('2026-07-11T01:00:04.000Z'))

    const associationClaim = await repo.claimDueReviewProjections(
      'worker-association',
      new Date('2026-07-11T01:00:04.000Z'),
      new Date('2026-07-11T01:01:04.000Z')
    )
    expect(associationClaim.map((row) => row.id)).toContain(projection.id)
    const associationMarker = randomUUID()
    expect(
      await repo.beginProjectionWrite(
        projection.id,
        projection.generation,
        'worker-association',
        associationMarker,
        'update',
        new Date('2026-07-11T01:00:04.000Z')
      )
    ).toBe(true)
    expect(
      await repo.completeProjectionWrite({
        projectionId: projection.id,
        generation: projection.generation,
        leaseOwner: 'worker-association',
        writeMarker: associationMarker,
        observedState: 'action_required',
        settledErrorCode: 'stale_head'
      })
    ).toBe(true)
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      desiredState: 'success',
      observedState: 'action_required',
      lastErrorCode: 'stale_head',
      nextAttemptAt: null
    })

    // Once a newer same-SHA HookRun is current, a delayed repair for the older
    // run may not roll the projection generation/current pointer backwards.
    expect(
      await repo.recordDelivery(hookId, {
        ...accepted,
        deliveryKey: 'delivery-r2a-newer',
        firedAt: new Date('2026-07-11T01:00:10.000Z')
      })
    ).toBe(true)
    const newerRun = await repo.getRun(hookId, 'delivery-r2a-newer')
    const newerProjection = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'review-agent',
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      headSha: accepted.headSha,
      reportSha: accepted.reportSha,
      projectionEpoch: newerRun!.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'queued',
      currentHookRunId: newerRun!.id,
      nextAttemptAt: new Date('2026-07-11T01:00:10.000Z')
    })
    expect(newerProjection.generation).toBe(projection.generation + 1n)
    const delayedOlder = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'review-agent',
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      headSha: accepted.headSha,
      reportSha: accepted.reportSha,
      projectionEpoch: run!.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'failure',
      currentHookRunId: run!.id,
      nextAttemptAt: new Date('2026-07-11T01:00:11.000Z')
    })
    expect(delayedOlder).toMatchObject({
      generation: newerProjection.generation,
      currentHookRunId: newerRun!.id,
      desiredState: 'queued'
    })
    expect((await repo.listRunsNeedingReviewProjection()).map((candidate) => candidate.id)).toEqual([newerRun!.id])

    const tombstonedAt = new Date('2026-07-11T01:00:12.000Z')
    expect(await repo.tombstoneReviewProjections([hookId], tombstonedAt, 'neutral')).toBe(1)
    const tombstoned = (await repo.getReviewProjection(projection.id))!
    const delayedAfterTombstone = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'review-agent',
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      headSha: accepted.headSha,
      reportSha: accepted.reportSha,
      projectionEpoch: newerRun!.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'failure',
      currentHookRunId: newerRun!.id,
      nextAttemptAt: new Date('2026-07-11T01:00:13.000Z')
    })
    expect(delayedAfterTombstone).toMatchObject({
      generation: tombstoned.generation,
      desiredState: 'neutral',
      tombstonedAt
    })
    expect(await repo.listRunsNeedingReviewProjection()).toEqual([])

    // Hook deletion must not erase the historical run or durable external-effect row.
    await repo.remove(OrgId(DEFAULT_ORG_ID), hookId)
    expect(await repo.getRun(hookId, accepted.deliveryKey)).not.toBeNull()
    expect(await repo.getReviewProjection(projection.id)).not.toBeNull()
  })

  it('keeps a same-revision definitive verdict current across a newer neutral conversation review', async () => {
    await seedDaemon(prisma, D1)
    const agentId = AgentId(randomUUID())
    await seedAgent(prisma, agentId, { daemonId: D1, name: 'review-agent' })
    await prisma.agent.update({
      where: { id: agentId },
      data: { workspaceMode: 'github', workspaceRepoId: 24n, gitAccess: 'write' }
    })
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const hook = await repo.upsert({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'review continuity',
      sessionMode: 'perThread',
      repoId: 24n,
      repoFullName: 'acme/continuity',
      events: ['pull_request:*', 'issue_comment:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const firedAt = new Date('2026-07-11T01:30:00.000Z')
    const revision = {
      deliveryKey: 'delivery-review-fail',
      firedAt,
      event: 'pull_request:opened',
      status: 'accepted' as const,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event' as const,
      repoId: 24n,
      repoFullName: 'acme/continuity',
      sourceInstallationId: 46n,
      subjectKind: 'pull_request',
      pullNumber: 594,
      headSha: 'd'.repeat(40),
      baseSha: 'e'.repeat(40),
      reportSha: 'd'.repeat(40)
    }
    expect(await repo.recordDelivery(hookId, revision)).toBe(true)
    expect(
      await repo.recordStart(hookId, D1, {
        ...revision,
        startedAt: new Date('2026-07-11T01:30:01.000Z')
      })
    ).toBe(true)
    const failAttemptId = randomUUID()
    expect(
      await repo.reserveReviewAttempt(hookId, D1, {
        deliveryKey: revision.deliveryKey,
        attemptId: failAttemptId,
        agentId,
        configRevision: hook.configRevision,
        dispatchRevision: hook.dispatchRevision,
        dispatchDaemonId: D1,
        requestedEvent: 'REQUEST_CHANGES',
        requestedVerdict: 'fail'
      })
    ).toBe('reserved')
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: revision.deliveryKey,
        attemptId: failAttemptId,
        state: 'submitted',
        reviewId: '1001',
        event: 'REQUEST_CHANGES',
        verdict: 'fail',
        commitId: revision.headSha
      })
    ).toBe(true)
    const failedRun = (await repo.getRun(hookId, revision.deliveryKey))!
    const projection = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'review-agent',
      repoId: revision.repoId,
      repoFullName: revision.repoFullName,
      headSha: revision.headSha,
      reportSha: revision.reportSha,
      projectionEpoch: failedRun.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'action_required',
      currentHookRunId: failedRun.id,
      nextAttemptAt: firedAt
    })
    expect(await repo.bindRunProjection(hookId, revision.deliveryKey, projection.id, projection.generation)).toBe(true)
    await repo.upsertReviewSubject({
      projectionId: projection.id,
      pullNumber: revision.pullNumber,
      headSha: revision.headSha,
      baseSha: revision.baseSha,
      isOpen: true
    })

    const conversation = {
      ...revision,
      deliveryKey: 'delivery-conversation-neutral',
      firedAt: new Date('2026-07-11T01:30:10.000Z'),
      event: 'issue_comment:created',
      projectionIntent: 'review_action_only' as const
    }
    expect(await repo.recordDelivery(hookId, conversation)).toBe(true)
    expect(
      await repo.recordStart(hookId, D1, {
        ...conversation,
        startedAt: new Date('2026-07-11T01:30:11.000Z')
      })
    ).toBe(true)
    const neutralAttemptId = randomUUID()
    expect(
      await repo.reserveReviewAttempt(hookId, D1, {
        deliveryKey: conversation.deliveryKey,
        attemptId: neutralAttemptId,
        agentId,
        configRevision: hook.configRevision,
        dispatchRevision: hook.dispatchRevision,
        dispatchDaemonId: D1,
        requestedEvent: 'COMMENT',
        requestedVerdict: 'neutral'
      })
    ).toBe('reserved')
    expect(
      await repo.recordReviewResult(hookId, D1, {
        deliveryKey: conversation.deliveryKey,
        attemptId: neutralAttemptId,
        state: 'submitted',
        reviewId: '1002',
        event: 'COMMENT',
        verdict: 'neutral',
        commitId: conversation.headSha
      })
    ).toBe(true)

    expect(await repo.listRunsNeedingReviewProjection()).toEqual([])
    expect(await repo.getReviewProjection(projection.id)).toMatchObject({
      currentHookRunId: failedRun.id,
      desiredState: 'action_required'
    })
  })

  it.each([
    ['agent session start failure', 'session_start_failed'],
    ['provider quota exhaustion', HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED],
    ['provider authentication required', HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED],
    ['definite agent unavailability', HOOK_DELIVERY_REASON_DAEMON_OFFLINE]
  ])('repairs %s to a skipped projection', async (_label, reason) => {
    await seedDaemon(prisma, D1)
    const agentId = AgentId(randomUUID())
    await seedAgent(prisma, agentId, { daemonId: D1, name: 'quota-agent' })
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'active', workspaceMode: 'github', workspaceRepoId: 23n, gitAccess: 'write' }
    })
    const repo = new PgHookRepo(prisma)
    const hookId = HookId(randomUUID())
    const hook = await repo.upsert({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      kind: 'github',
      name: 'quota repair',
      sessionMode: 'perThread',
      repoId: 23n,
      repoFullName: 'acme/quota',
      events: ['pull_request:*'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    const accepted = {
      deliveryKey: `delivery-${randomUUID()}`,
      firedAt: new Date('2026-07-11T02:00:00.000Z'),
      event: 'pull_request:opened',
      status: 'accepted' as const,
      agentId,
      configRevision: hook.configRevision,
      dispatchRevision: hook.dispatchRevision,
      dispatchDaemonId: D1,
      reviewPolicySnapshot: hook.reviewPolicy,
      reportingModeSnapshot: hook.reportingMode,
      gateModeSnapshot: hook.gateMode,
      projectionIntent: 'revision_event' as const,
      repoId: 23n,
      repoFullName: 'acme/quota',
      sourceInstallationId: 45n,
      subjectKind: 'pull_request',
      pullNumber: 478,
      headSha: 'c'.repeat(40),
      baseSha: 'd'.repeat(40),
      reportSha: 'c'.repeat(40)
    }
    if (reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE) {
      expect(await repo.recordDelivery(hookId, { ...accepted, status: 'failed', reason })).toBe(true)
      // A retryable delivery failure stays free of external Check effects until
      // its durable budget is exhausted, preserving the safe reopen path.
      expect(await repo.listRunsNeedingReviewProjection()).toEqual([])
      expect(await repo.claimRetryableDeliveryRedelivery(accepted.deliveryKey, [hookId], accepted.firedAt, [1])).toBe(
        true
      )
      expect(await repo.listRunsNeedingReviewProjection()).toEqual([])
      // The next due sweep observes the cap, retires the gate, and only then
      // lets the final failed state converge to a skipped Check.
      expect(
        await repo.claimRetryableDeliveryRedelivery(
          accepted.deliveryKey,
          [hookId],
          new Date(accepted.firedAt.getTime() + 1),
          [1]
        )
      ).toBe(false)
    } else {
      expect(await repo.recordDelivery(hookId, accepted)).toBe(true)
      expect(
        await repo.recordReport(
          hookId,
          D1,
          {
            deliveryKey: accepted.deliveryKey,
            status: 'failed',
            reason
          },
          new Date('2026-07-11T02:00:01.000Z')
        )
      ).toBe(true)
    }
    const run = (await repo.getRun(hookId, accepted.deliveryKey))!
    expect(run).toMatchObject({ status: 'failed', reason })

    const stale = await repo.upsertReviewProjection({
      hookId,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId,
      agentName: 'quota-agent',
      repoId: accepted.repoId,
      repoFullName: accepted.repoFullName,
      headSha: accepted.headSha,
      reportSha: accepted.reportSha,
      projectionEpoch: run.projectionEpoch!,
      mode: 'check',
      gateMode: 'informational',
      desiredState: reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE ? 'skipped' : 'failure',
      currentHookRunId: run.id,
      nextAttemptAt: accepted.firedAt
    })
    expect(await repo.bindRunProjection(hookId, accepted.deliveryKey, stale.id, stale.generation)).toBe(true)
    await repo.upsertReviewSubject({
      projectionId: stale.id,
      pullNumber: accepted.pullNumber,
      headSha: accepted.headSha,
      baseSha: accepted.baseSha,
      isOpen: true
    })

    expect((await repo.listRunsNeedingReviewProjection()).map((candidate) => candidate.id)).toEqual(
      reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE ? [] : [run.id]
    )
    expect(
      await repo.setProjectionDesired(
        stale.id,
        stale.generation,
        'skipped',
        new Date('2026-07-11T02:00:02.000Z'),
        run.id
      )
    ).toBe(true)
    expect(await repo.listRunsNeedingReviewProjection()).toEqual([])
  })
})
