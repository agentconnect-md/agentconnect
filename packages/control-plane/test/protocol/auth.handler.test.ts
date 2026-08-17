/**
 * FIRST FAILING TEST — Phase 2 (design §6 Phase 2).
 *
 * Drives the `auth` handler end-to-end through the connection FSM over the
 * `InMemoryDaemonStub` (no real socket), against the real Testcontainers
 * Postgres (so the `sessionEpoch` bump is genuinely persisted/monotonic):
 *
 *  - a valid `apiKey` → `auth/ok` whose `corr == auth.id`, carrying
 *    `sessionEpoch` one greater than the daemon's previous epoch, and
 *    `heartbeatSec: 15`;
 *  - an invalid key → close `4401` and NO epoch bump.
 *
 * (The transient-DB → 1011 mapping is covered deterministically in the unit test
 * `src/registry/authService.test.ts`.)
 */
import { describe, it, expect, vi } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { PgMemberSetRepo } from '../../src/persistence/repositories/member-set.repo.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUTH_ID = '11111111-1111-4111-8111-111111111111'

function authPayload(apiKey: string) {
  return { apiKey, daemonId: DAEMON, agentVersion: '1.4.0' }
}

describe('auth handler — valid key mints next epoch; invalid key closes 4401', () => {
  it('valid apiKey → auth/ok with corr==auth.id, sessionEpoch=prev+1, heartbeatSec=15', async () => {
    const h = buildWsHarness(prisma)
    const repo = new PgDaemonRepo(prisma)

    // Establish a PREVIOUS epoch for this daemon (a prior successful auth → epoch 1).
    const prev = await repo.upsertOnAuth({
      daemonId: DaemonId(DAEMON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentVersion: '1.0.0'
    })
    expect(prev.sessionEpoch).toBe(1n)

    const token = await h.mintToken(DAEMON)
    const { stub } = h.connect()
    stub.inject('auth', authPayload(token), { id: AUTH_ID })

    const ok = await stub.expectFrame('auth/ok')
    expect(isFrame('auth/ok')(ok)).toBe(true)
    if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')

    // corr ties the REP back to the auth REQ.
    expect(ok.corr).toBe(AUTH_ID)
    // sessionEpoch is exactly one greater than the daemon's previous epoch.
    expect(ok.payload.sessionEpoch).toBe(2)
    expect(ok.payload.heartbeatSec).toBe(15)
    expect(ok.payload.daemonId).toBe(DAEMON)

    // No close on the happy path.
    expect(stub.closed).toBeUndefined()

    // Persisted epoch advanced to 2.
    const row = await repo.getUnscoped(DaemonId(DAEMON))
    expect(row?.sessionEpoch).toBe(2n)
  })

  it('invalid token → close 4401 (AUTH_FAILED) and NO epoch bump', async () => {
    const h = buildWsHarness(prisma)
    const repo = new PgDaemonRepo(prisma)

    // Previous epoch = 1.
    await repo.upsertOnAuth({
      daemonId: DaemonId(DAEMON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentVersion: '1.0.0'
    })

    const { stub } = h.connect()
    stub.inject('auth', authPayload('not-a-valid-token'), { id: AUTH_ID })

    // The handler closes the socket; await that instead of an auth/ok.
    await vi.waitFor(() => {
      if (!stub.closed) throw new Error('not closed yet')
    })

    expect(stub.closed?.code).toBe(4401)
    expect(stub.closed?.reason).toBe('AUTH_FAILED')
    // No auth/ok was sent.
    expect(stub.lastSent('auth/ok')).toBeUndefined()

    // Crucially: the epoch did NOT bump (still 1).
    const row = await repo.getUnscoped(DaemonId(DAEMON))
    expect(row?.sessionEpoch).toBe(1n)
  })

  it('closes rather than admits when the settled membership cannot be read', async () => {
    // This second read is the ONLY guard on the window between the membership lookup that built
    // `auth/ok` and the connection reaching the registry (daemon-groups.md §3), so a blip must not
    // be taken as "the old value still holds" — that is exactly the hole it exists to close.
    const h = buildWsHarness(prisma)
    h.deps.memberSets.setIdOf = async () => {
      throw new Error('db down')
    }
    const apiKey = await h.mintToken(DAEMON)

    const { stub } = h.connect()
    stub.inject('auth', authPayload(apiKey), { id: AUTH_ID })

    await vi.waitFor(() => {
      if (!stub.closed) throw new Error('not closed yet')
    })
    expect(stub.closed?.code).toBe(1011)
    expect(stub.lastSent('auth/ok')).toBeUndefined()
  })

  it('closes 1012 when the membership changed during the handshake, so the daemon reads it afresh', async () => {
    const h = buildWsHarness(prisma)
    const apiKey = await h.mintToken(DAEMON)
    // The change lands after `authenticate` read "no set" and before the connection is indexed:
    // the route's own close finds nothing, so this read is what catches it.
    const setId = await new PgMemberSetRepo(prisma).createForOrg(DEFAULT_ORG_ID, 'lab')
    h.deps.memberSets.setIdOf = async () => setId.id

    const { stub } = h.connect()
    stub.inject('auth', authPayload(apiKey), { id: AUTH_ID })

    await vi.waitFor(() => {
      if (!stub.closed) throw new Error('not closed yet')
    })
    expect(stub.closed?.code).toBe(1012)
  })

  it('a key bound to a different daemonId is rejected 4401 (no bump)', async () => {
    const h = buildWsHarness(prisma)
    const repo = new PgDaemonRepo(prisma)

    const otherDaemon = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const tokenForOther = await h.mintToken(otherDaemon)

    const stub = new InMemoryDaemonStub()
    h.connect(stub)
    // Present a key bound to otherDaemon while claiming (echoing) to be DAEMON.
    stub.inject('auth', authPayload(tokenForOther), { id: AUTH_ID })

    await vi.waitFor(() => {
      if (!stub.closed) throw new Error('not closed yet')
    })
    expect(stub.closed?.code).toBe(4401)
    expect(await repo.getUnscoped(DaemonId(DAEMON))).toBeNull() // never created
  })

  it("key-only auth (no daemonId in the frame) → auth/ok with daemonId = the key's daemon", async () => {
    const h = buildWsHarness(prisma)
    const repo = new PgDaemonRepo(prisma)

    // The onboarding command omits --daemon-id, so the daemon sends NO daemonId.
    const token = await h.mintToken(DAEMON)
    const { stub } = h.connect()
    stub.inject('auth', { apiKey: token, agentVersion: '1.4.0' }, { id: AUTH_ID })

    const ok = await stub.expectFrame('auth/ok')
    if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')
    expect(ok.corr).toBe(AUTH_ID)
    // The CP derives the authoritative id from the token subject and echoes it.
    expect(ok.payload.daemonId).toBe(DAEMON)
    expect(ok.payload.sessionEpoch).toBe(1)
    expect(stub.closed).toBeUndefined()

    // The daemon row keeps the key's daemonId; first auth advanced epoch 0 → 1.
    const row = await repo.getUnscoped(DaemonId(DAEMON))
    expect(row?.sessionEpoch).toBe(1n)
  })

  it('delivers and arms a pending upgrade during bootstrap auth, then records installer failure', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(DAEMON)
    const op = await h.deps.lifecycleOps.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '2.0.0',
      commandEpoch: 0n,
      deadline: new Date(h.clock.now() + 60_000)
    })
    const { stub } = h.connect()
    stub.inject('auth', { ...authPayload(token), bootstrapProtocolVersion: 1 }, { id: AUTH_ID })

    const ok = await stub.expectFrame('auth/ok')
    if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')
    expect(ok.payload.lifecycle).toEqual({ operationId: op.id, action: 'upgrade', targetVersion: '2.0.0' })
    expect((await h.deps.lifecycleOps.getById(op.id))?.acceptedAt).not.toBeNull()
    expect((await h.deps.lifecycleOps.getById(op.id))?.commandEpoch).toBe(1n)

    stub.inject('daemon/bootstrap/result', {
      operationId: op.id,
      status: 'failed',
      reason: 'registry unavailable'
    })
    const ack = await stub.expectFrame('ack')
    if (!isFrame('ack')(ack)) throw new Error('expected ack')
    expect(ack.payload.ok).toBe(true)
    expect((await h.deps.lifecycleOps.getById(op.id))?.status).toBe('failed')
  })
})
