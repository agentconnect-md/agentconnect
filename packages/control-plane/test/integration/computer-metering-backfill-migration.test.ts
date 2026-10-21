// The metering backfill (computer-use.md §15.5): a managed desktop that predates metering is billed from the upgrade on.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261210000001_computer_metering_backfill/migration.sql', import.meta.url)
)

async function computer(extra: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await prisma.computer.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `desk-${id.slice(0, 8)}`,
      ownerUserId: DEFAULT_OWNER_ID,
      os: 'linux',
      osVersion: 'Ubuntu 26.04',
      session: 'x11',
      desktopDaemonVersion: '0.1.0',
      driverVersion: '0.35.2',
      policy: { allowedMembers: [DEFAULT_OWNER_ID], agentMode: 'control' },
      createdAt: new Date(Date.now() - 30 * 86_400_000),
      ...extra
    }
  })
  return id
}

describe('computer metering backfill', () => {
  it('stamps pre-existing managed desktops with the upgrade time and leaves the rest alone', async () => {
    const managed = await computer({ kind: 'managed', allocation: 'manual', poolPhase: 'awake' })
    const metered = new Date('2026-12-01T00:00:00Z')
    const already = await computer({
      kind: 'managed',
      allocation: 'manual',
      poolPhase: 'sleeping',
      poolMeteredAt: metered
    })
    const selfHosted = await computer({})
    const before = Date.now()

    await prisma.$executeRawUnsafe(await readFile(MIGRATION, 'utf8'))

    const read = (id: string) => prisma.computer.findUniqueOrThrow({ where: { id } })
    expect((await read(managed)).poolMeteredAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect((await read(already)).poolMeteredAt).toEqual(metered)
    expect((await read(selfHosted)).poolMeteredAt).toBeNull()
  })
})
