// The `agent_chat_actions_existing_default` migration: existing agents at 'talk' move to the new agents' default, 'approve'.
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261112000000_agent_chat_actions_existing_default/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

async function row(runtimeOverrides: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id, { runtimeOverrides })
  await prisma.agent.update({ where: { id }, data: { configRevision: 3n } })
  return id
}

describe('agent_chat_actions_existing_default — talk becomes approve', () => {
  it('moves talk to approve once, keeps every other override, and leaves settings and approve alone', async () => {
    const talk = await row({ chatActions: 'talk', model: 'opus' })
    const settings = await row({ chatActions: 'settings' })
    const approve = await row({ chatActions: 'approve' })

    await prisma.$executeRawUnsafe(migrationSql)
    await prisma.$executeRawUnsafe(migrationSql)

    const read = async (id: string) => await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect((await read(talk)).runtimeOverrides).toEqual({ model: 'opus', chatActions: 'approve' })
    // Bumped exactly once across the two runs: the second saw nothing to move.
    expect((await read(talk)).configRevision).toBe(4n)
    for (const id of [settings, approve]) expect((await read(id)).configRevision).toBe(3n)
    expect((await read(settings)).runtimeOverrides).toEqual({ chatActions: 'settings' })
    expect((await read(approve)).runtimeOverrides).toEqual({ chatActions: 'approve' })
  })
})
