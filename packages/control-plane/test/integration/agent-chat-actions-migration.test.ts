/**
 * The `agent_chat_actions` migration (product-conventions.md, "What people can do in chat").
 *
 * Existing agents keep their behavior: the boolean switched on becomes 'settings', and off or
 * never set becomes 'talk'. The test inserts old-shaped rows into the already-migrated database
 * and re-executes the migration file verbatim, which is why that file must be idempotent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261111000000_agent_chat_actions/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

async function row(runtimeOverrides: Record<string, unknown> | null): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id, runtimeOverrides ? { runtimeOverrides } : {})
  await prisma.agent.update({ where: { id }, data: { configRevision: 3n } })
  return id
}

describe('agent_chat_actions — the boolean becomes a level', () => {
  it('maps on to settings and off or absent to talk, drops the boolean, and is idempotent', async () => {
    const on = await row({ allowRuntimeChangesInChat: true, model: 'opus' })
    const off = await row({ allowRuntimeChangesInChat: false })
    const absent = await row({ fastMode: true })
    const none = await row(null)
    const current = await row({ chatActions: 'approve' })

    await prisma.$executeRawUnsafe(migrationSql)
    await prisma.$executeRawUnsafe(migrationSql)

    const read = async (id: string) => await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect((await read(on)).runtimeOverrides).toEqual({ model: 'opus', chatActions: 'settings' })
    expect((await read(off)).runtimeOverrides).toEqual({ chatActions: 'talk' })
    expect((await read(absent)).runtimeOverrides).toEqual({ fastMode: true, chatActions: 'talk' })
    expect((await read(none)).runtimeOverrides).toEqual({ chatActions: 'talk' })
    // Bumped exactly once across the two runs: the second saw nothing to convert.
    for (const id of [on, off, absent, none]) expect((await read(id)).configRevision).toBe(4n)
    // A row already on the new shape is untouched.
    expect((await read(current)).runtimeOverrides).toEqual({ chatActions: 'approve' })
    expect((await read(current)).configRevision).toBe(3n)
  })
})
