import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'

const AT = new Date('2026-09-25T00:00:00.000Z')

describe('PgHookRepo no-run redelivery claims', () => {
  it('grants at most maxAttempts claims per GUID, durably across repo instances', async () => {
    const claim = (repo: PgHookRepo) => repo.claimMissingDeliveryRedelivery('guid-1', AT, 3)
    const first = new PgHookRepo(prisma)
    await expect(claim(first)).resolves.toBe(true)
    await expect(claim(first)).resolves.toBe(true)

    const restarted = new PgHookRepo(prisma)
    await expect(claim(restarted)).resolves.toBe(true)
    await expect(claim(restarted)).resolves.toBe(false)
    await expect(restarted.claimMissingDeliveryRedelivery('guid-2', AT, 3)).resolves.toBe(true)
  })

  it('grants exactly the remaining budget to concurrent claims', async () => {
    const repo = new PgHookRepo(prisma)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.claimMissingDeliveryRedelivery('guid-race', AT, 3))
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    await expect(
      prisma.hookDeliveryRecovery.findUnique({ where: { deliveryKey: 'guid-race' } })
    ).resolves.toMatchObject({ attempts: 3 })
  })

  it('prunes counts last requested before the cutoff', async () => {
    const repo = new PgHookRepo(prisma)
    await repo.claimMissingDeliveryRedelivery('guid-old', AT, 3)
    await repo.claimMissingDeliveryRedelivery('guid-new', new Date(AT.getTime() + 60_000), 3)

    await expect(repo.pruneMissingDeliveryRedeliveries(new Date(AT.getTime() + 1))).resolves.toBe(1)
    await expect(prisma.hookDeliveryRecovery.findMany({ select: { deliveryKey: true } })).resolves.toEqual([
      { deliveryKey: 'guid-new' }
    ])
  })
})
