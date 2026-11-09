import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { PgDaemonAdmissionRepo } from '../../src/persistence/repositories/daemon-admission.repo.js'
import { RelayAuthService } from '../../src/registry/relayAuthService.js'
import { PgApiKeyRepo } from '../../src/persistence/repositories/api-key.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { planDutyReconcile, toExistingDutyGroups } from '../../src/orchestrator/dutyGroup.js'

const daemonId = DaemonId('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
const agentId = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
let app: HttpApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  vi.restoreAllMocks()
})

async function registered(h: ReturnType<typeof buildWsHarness>, token: string) {
  const peer = h.connect()
  peer.stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.0.0' })
  await peer.stub.expectFrame('auth/ok')
  peer.stub.inject('register', {
    host: 'machine.example.test',
    maxAgents: 4,
    capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [] },
    localState: { assignments: [], crons: [], leases: [], agents: [{ agentId, origin: 'cp' }] }
  })
  await peer.stub.expectFrame('register/ok')
  await peer.stub.settled()
  return peer
}

async function change(
  h: ReturnType<typeof buildWsHarness>,
  status: 'approved' | 'revoked',
  revision: number,
  sessionEpoch: number
) {
  return h.deps.admission.change(
    { daemonId, orgId: OrgId(DEFAULT_ORG_ID), actorUserId: DEFAULT_OWNER_ID, status, revision, sessionEpoch },
    new Date(h.clock.now())
  )
}

describe('daemon approval boundary', () => {
  it('grandfathers the migration cohort once, preserving keys and pending defaults', async () => {
    const migration = await readFile(
      new URL('../../prisma/migrations/20270102000000_daemon_approval/migration.sql', import.meta.url),
      'utf8'
    )
    // Global setup applies the enum DDL; temporary tables exercise the actual data migration in isolation.
    const statements = migration
      .replaceAll(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !/^(BEGIN|COMMIT|CREATE TYPE|ALTER TYPE)\b/.test(s))
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE daemon (id UUID PRIMARY KEY, "orgId" TEXT, "clusterIdentity" TEXT, "clusterPodUid" TEXT) ON COMMIT DROP'
      )
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE audit_event (kind "AuditKind", "orgId" TEXT, "daemonId" UUID, details JSONB) ON COMMIT DROP'
      )
      await tx.$executeRawUnsafe('CREATE TEMP TABLE api_key (id TEXT, "revokedAt" TIMESTAMPTZ) ON COMMIT DROP')
      await tx.$executeRaw`INSERT INTO daemon (id, "orgId") VALUES (${daemonId}::uuid, 'example-org')`
      await tx.$executeRaw`INSERT INTO api_key VALUES ('valid-key', NULL), ('revoked-key', CURRENT_TIMESTAMP)`
      for (const statement of statements) await tx.$executeRawUnsafe(statement)
      expect(await tx.$queryRaw`SELECT "approvalStatus", "approvalSource" FROM daemon`).toEqual([
        { approvalStatus: 'approved', approvalSource: 'legacy_migration' }
      ])
      const keys = await tx.$queryRaw<{ id: string; revokedAt: Date | null }[]>`SELECT * FROM api_key ORDER BY id`
      expect(keys[0]!.revokedAt).not.toBeNull()
      expect(keys[1]!.revokedAt).toBeNull()
      await tx.$executeRaw`UPDATE daemon SET "approvalStatus" = 'revoked'`
      await tx.$executeRaw`INSERT INTO daemon (id) VALUES (${randomUUID()}::uuid)`
      await tx.$executeRawUnsafe('SAVEPOINT repeat_migration')
      await expect(tx.$executeRawUnsafe(statements[0]!)).rejects.toThrow()
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT repeat_migration')
      expect(await tx.$queryRaw`SELECT "approvalStatus" FROM daemon ORDER BY "approvalStatus"`).toEqual([
        { approvalStatus: 'pending' },
        { approvalStatus: 'revoked' }
      ])
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM audit_event`).toEqual([{ n: 1 }])
      expect(await tx.$queryRaw`SELECT * FROM api_key ORDER BY id`).toEqual(keys)
    })
  })
  it('enrolls without managed data and rejects both requester identity forms, private placement and relay access', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(daemonId)
    await prisma.daemon.update({
      where: { id: daemonId },
      data: { sessionRetention: '90d', workspaceRetention: '3d', autoUpgrade: false }
    })
    await seedAgent(prisma, agentId, {
      daemonId,
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID],
      createdByUserId: DEFAULT_OWNER_ID
    })
    const { conn, stub } = await registered(h, token)
    const snapshot = stub.lastSent('register/ok')!
    expect(snapshot.payload).toMatchObject({
      sessionRetention: '90d',
      workspaceRetention: '3d',
      autoUpgrade: false,
      agents: [],
      integrations: [],
      leases: [],
      relays: [],
      mcpServers: [],
      memoryConnections: [],
      drop: { agents: [{ agentId, action: 'detach' }] }
    })
    expect(conn.approval.status).toBe('pending')
    conn.send('config/push', { keys: { 'upgrade.auto': true, 'sessions.retention': '30d' } })
    await conn.flush()
    expect(stub.lastSent('config/push')?.payload).toEqual({
      keys: { 'upgrade.auto': true, 'sessions.retention': '30d' }
    })
    const reader = vi.fn()
    h.deps.readAccess = reader
    for (const asker of [
      { consoleUserId: DEFAULT_OWNER_ID },
      { integrationId: randomUUID(), memberId: 'member-example' }
    ]) {
      const id = randomUUID()
      stub.inject('agent/read-access', { agentId, asker, sessionIds: [] }, { id, orgId: DEFAULT_ORG_ID })
      await stub.settled()
      expect(stub.lastSent('error')).toMatchObject({ corr: id, payload: { code: 'SCOPE_DENIED' } })
    }
    expect(reader).not.toHaveBeenCalled()
    expect(await h.placement.servingDaemons({ id: agentId, placementKind: 'daemon', daemonId, setId: null })).toEqual(
      []
    )
    await expect(h.deps.agent.setPlacement(agentId, { kind: 'daemon', daemonId })).rejects.toThrow('approval required')
    const relay = new RelayAuthService(
      h.codec,
      new PgApiKeyRepo(prisma),
      h.clock,
      { HEARTBEAT_SEC: 15 },
      h.deps.admission
    )
    expect(await relay.verifyDaemonKey(token)).toBeNull()
    const lease = vi.spyOn(h.deps.dutyLease, 'onHeartbeat')
    const heartbeat = stub.inject('heartbeat', {
      load: { cpu: 0.1, mem: 0.2, agents: 0 },
      health: 'ok',
      activeSessions: 0
    })
    await stub.settled()
    expect(stub.lastSent('error')?.corr).not.toBe(heartbeat)
    expect(stub.closed).toBeUndefined()
    expect(lease).not.toHaveBeenCalled()
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).load).toMatchObject({
      cpu: 0.1,
      mem: 0.2
    })
  })

  it('approves the reviewed connection, preserves approved recovery, and keeps revoked recovery unapproved', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(daemonId)
    const unreviewed = await h.mintToken(daemonId)
    const first = await registered(h, token)
    app = buildHttpApp(prisma, undefined, h.deps.connReg)
    const result = await app.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/daemons/${daemonId}/approval`,
      payload: { status: 'approved', revision: 0, sessionEpoch: first.conn.sessionEpoch }
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ approval: { status: 'approved', revision: 1 }, canManageApproval: true })
    const invalid = h.connect()
    invalid.stub.inject('auth', { apiKey: unreviewed, daemonId, agentVersion: '1.0.0' })
    await invalid.stub.settled()
    expect(invalid.stub.closed?.code).toBe(4401)
    const replacement = await h.mintToken(daemonId)
    const approved = await registered(h, replacement)
    expect(approved.conn.approval.status).toBe('approved')
    await seedAgent(prisma, agentId, { daemonId })
    expect(await h.placement.mayAct({ id: agentId, placementKind: 'daemon', daemonId, setId: null }, daemonId)).toBe(
      true
    )
    await change(h, 'revoked', 1, approved.conn.sessionEpoch)
    const revoked = await registered(h, await h.mintToken(daemonId))
    expect(revoked.conn.approval.status).toBe('revoked')
    expect(await h.placement.mayAct({ id: agentId, placementKind: 'daemon', daemonId, setId: null }, daemonId)).toBe(
      false
    )
    await change(h, 'approved', 2, revoked.conn.sessionEpoch)
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).approvalStatus).toBe('approved')
  })

  it('checks current owner membership, tenant and the reviewed epoch and revision', async () => {
    const h = buildWsHarness(prisma)
    const { conn } = await registered(h, await h.mintToken(daemonId))
    const input = {
      daemonId,
      orgId: OrgId(DEFAULT_ORG_ID),
      actorUserId: DEFAULT_OWNER_ID,
      status: 'approved' as const,
      revision: 0,
      sessionEpoch: conn.sessionEpoch
    }
    const now = new Date(h.clock.now())
    await expect(h.deps.admission.change({ ...input, sessionEpoch: conn.sessionEpoch - 1 }, now)).rejects.toThrow(
      'current connection'
    )
    await expect(h.deps.admission.change({ ...input, revision: 9 }, now)).rejects.toThrow('approval changed')
    await prisma.membership.update({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } },
      data: { role: 'collaborator' }
    })
    await expect(h.deps.admission.change(input, now)).rejects.toThrow('owner')
    await expect(h.deps.admission.change({ ...input, orgId: OrgId('other-org') }, now)).rejects.toThrow()
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).approvalStatus).toBe('pending')
  })

  it('withholds a delayed authority reply after revocation even without a local revoke push', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(daemonId)
    const first = await registered(h, token)
    await change(h, 'approved', 0, first.conn.sessionEpoch)
    await seedAgent(prisma, agentId, { daemonId })
    const { conn, stub } = await registered(h, token)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    h.deps.readAccess = async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { asker: 'linked', consoleUserId: DEFAULT_OWNER_ID, visibleSessionIds: [] }
    }
    stub.inject(
      'agent/read-access',
      { agentId, asker: { consoleUserId: DEFAULT_OWNER_ID }, sessionIds: [] },
      { orgId: DEFAULT_ORG_ID }
    )
    await started
    await change(h, 'revoked', 1, conn.sessionEpoch)
    release()
    await stub.settled()
    expect(stub.lastSent('agent/read-access/ok')).toBeUndefined()
    conn.send('relay/roster', { relays: [] })
    await conn.flush()
    expect(stub.closed?.code).toBe(1012)
  })

  it('never treats an org-less capability claim as verified pool trust', async () => {
    const admission = new PgDaemonAdmissionRepo(prisma)
    await prisma.daemon.create({
      data: { id: daemonId, orgId: null, approvalStatus: 'approved', capabilities: { pool: true } }
    })
    expect(await admission.allowed([daemonId])).toEqual([])
    const h = buildWsHarness(prisma)
    const poolId = randomUUID()
    await h.mintPoolMember(poolId)
    expect(await admission.allowed([poolId])).toEqual([poolId])
  })

  it('keeps revoked duties fenced until expiry without renewal or a composition regrant', async () => {
    const h = buildWsHarness(prisma)
    const peer = await registered(h, await h.mintToken(daemonId))
    await change(h, 'approved', 0, peer.conn.sessionEpoch)
    await seedAgent(prisma, agentId, { daemonId })
    const repo = new PgDutyGroupRepo(prisma)
    const now = new Date(h.clock.now())
    const orgId = OrgId(DEFAULT_ORG_ID)
    const granted = await repo.claimAgentHome(orgId, agentId, daemonId, now, 120_000)
    expect(granted.granted).toBe(true)
    const before = await repo.listForOrg(orgId)
    await change(h, 'revoked', 1, peer.conn.sessionEpoch)
    const later = new Date(now.getTime() + 30_000)
    expect(await repo.renewHeld(daemonId, later, 120_000)).toEqual([])
    expect((await repo.claimAgentHome(orgId, agentId, daemonId, later, 120_000)).granted).toBe(false)
    const members = [
      { kind: 'agent' as const, refId: agentId },
      { kind: 'bot' as const, refId: randomUUID() }
    ]
    const recompute = (at: Date) =>
      repo.applyReconcile(orgId, (existing) => planDutyReconcile(toExistingDutyGroups(existing, at), [{ members }]), {
        now: at,
        leaseMs: 120_000
      })
    expect((await recompute(later)).writes).toEqual([])
    expect(await repo.listForOrg(orgId)).toEqual(before)
    expect((await recompute(new Date(now.getTime() + 120_001))).writes).toHaveLength(1)
    expect((await repo.listForOrg(orgId))[0]!.expiresAt).toEqual(before[0]!.expiresAt)
  })
})
