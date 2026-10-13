// The `assistant_mode_drop_routing_targets` migration: a stored responsible user or fallback conversation is dropped, never read again.
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AssistantModePolicy } from '@agentconnect.md/protocol'
import type { Prisma } from '../../src/generated/prisma/client.js'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261113000000_assistant_mode_drop_routing_targets/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

async function row(assistantMode: Prisma.InputJsonObject | null): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id)
  await prisma.agent.update({
    where: { id },
    data: { configRevision: 3n, ...(assistantMode ? { assistantMode } : {}) }
  })
  return id
}

describe('assistant_mode_drop_routing_targets — stored routing targets go', () => {
  it('drops both fields once, keeps the rest of the policy, and leaves other rows alone', async () => {
    const fallback = { integrationId: randomUUID(), channelId: 'C-EXAMPLE' }
    const both = await row({
      enabled: true,
      responsibleUserId: 'user-a',
      fallbackConversation: fallback,
      limits: { dailyPatrolBudget: 9 }
    })
    const onlyFallback = await row({ enabled: false, fallbackConversation: fallback })
    const clean = await row({ enabled: true, instructions: 'be brief' })
    const never = await row(null)

    await prisma.$executeRawUnsafe(migrationSql)
    await prisma.$executeRawUnsafe(migrationSql)

    const read = async (id: string) => await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect((await read(both)).assistantMode).toEqual({ enabled: true, limits: { dailyPatrolBudget: 9 } })
    expect((await read(onlyFallback)).assistantMode).toEqual({ enabled: false })
    // Bumped exactly once across the two runs: the second saw nothing to move.
    for (const id of [both, onlyFallback]) expect((await read(id)).configRevision).toBe(4n)
    expect((await read(clean)).assistantMode).toEqual({ enabled: true, instructions: 'be brief' })
    expect((await read(never)).assistantMode).toBeNull()
    for (const id of [clean, never]) expect((await read(id)).configRevision).toBe(3n)
    // Every remaining policy reads under the strict schema, so no agent silently reads as never configured.
    for (const id of [both, onlyFallback, clean]) {
      expect(AssistantModePolicy.safeParse((await read(id)).assistantMode).success).toBe(true)
    }
  })
})
