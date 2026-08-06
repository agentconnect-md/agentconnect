/**
 * FIRST FAILING TEST (design §6 Phase 1).
 *
 * `upsertOnAuth` called twice for the same `daemonId` returns a STRICTLY
 * increasing `sessionEpoch` (e2 > e1) — the fencing root bump — exercised
 * against REAL Postgres so `BigInt` monotonicity is genuinely tested.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'

const DAEMON_A = '11111111-1111-4111-8111-111111111111'
const DAEMON_B = '22222222-2222-4222-8222-222222222222'

function authInput(daemonId: string) {
  return {
    daemonId: DaemonId(daemonId),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentVersion: '1.0.0'
  }
}

describe('DaemonRepo.upsertOnAuth — monotonic sessionEpoch (real Postgres)', () => {
  it('returns strictly increasing sessionEpoch on repeated auth for the same daemon', async () => {
    const repo = new PgDaemonRepo(prisma)

    const first = await repo.upsertOnAuth(authInput(DAEMON_A))
    const second = await repo.upsertOnAuth(authInput(DAEMON_A))

    expect(typeof first.sessionEpoch).toBe('bigint')
    expect(second.sessionEpoch).toBeGreaterThan(first.sessionEpoch)
    // first successful auth mints epoch 1; the second bumps to 2
    expect(first.sessionEpoch).toBe(1n)
    expect(second.sessionEpoch).toBe(2n)
    // the returned daemon record echoes the bumped epoch and is in `authenticating`
    expect(second.daemon.sessionEpoch).toBe(2n)
    expect(second.daemon.status).toBe('authenticating')
  })

  it('first auth creates the row; the row persists with the latest epoch', async () => {
    const repo = new PgDaemonRepo(prisma)

    expect(await repo.getUnscoped(DaemonId(DAEMON_A))).toBeNull()
    await repo.upsertOnAuth(authInput(DAEMON_A))
    await repo.upsertOnAuth(authInput(DAEMON_A))

    const got = await repo.getUnscoped(DaemonId(DAEMON_A))
    expect(got).not.toBeNull()
    expect(got?.sessionEpoch).toBe(2n)
  })

  it('tracks sessionEpoch independently per daemon', async () => {
    const repo = new PgDaemonRepo(prisma)

    await repo.upsertOnAuth(authInput(DAEMON_A))
    const a2 = await repo.upsertOnAuth(authInput(DAEMON_A))
    const b1 = await repo.upsertOnAuth(authInput(DAEMON_B))

    expect(a2.sessionEpoch).toBe(2n)
    expect(b1.sessionEpoch).toBe(1n) // B's first auth — independent counter
  })
})
