// The computer_agent_access backfill (computer-use.md §4.1): re-executed verbatim on old-shaped rows, so it must be idempotent.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261207000001_computer_agent_access_backfill/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

async function computer(policy: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await prisma.computer.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: 'desk',
      ownerUserId: DEFAULT_OWNER_ID,
      os: 'linux',
      osVersion: 'Ubuntu 26.04',
      session: 'x11',
      desktopDaemonVersion: '0.1.0',
      driverVersion: '0.35.2',
      policy: { allowedMembers: [DEFAULT_OWNER_ID], agentMode: 'control', ...policy },
      ...extra
    }
  })
  return id
}

async function agent(runtimeOverrides?: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id, runtimeOverrides ? { runtimeOverrides } : {})
  return id
}

describe('computer_agent_access backfill', () => {
  it('turns allowed agents into Selected, an empty list into none, and keeps only the agent’s managed mode', async () => {
    const granted = await agent({ computerUse: { enabled: false, computers: [] } })
    const managed = await agent({
      model: 'opus',
      computerUse: { enabled: true, computers: [], managed: { mode: 'per-agent' } }
    })
    const switchedOff = await agent({ computerUse: { enabled: false, computers: [], managed: { mode: 'ephemeral' } } })
    const untouched = await agent({ model: 'sonnet' })
    const selected = await computer({ allowedAgents: [granted, granted] })
    const empty = await computer({ allowedAgents: [] })
    const perAgent = await computer(
      { allowedAgents: [managed] },
      { kind: 'managed', allocation: 'per_agent', ownerAgentId: managed }
    )
    const revisions = async () =>
      Object.fromEntries(
        (await prisma.agent.findMany({ where: { id: { in: [granted, managed, switchedOff, untouched] } } })).map(
          (a) => [a.id, a.configRevision]
        )
      )
    const before = await revisions()

    await prisma.$executeRawUnsafe(migrationSql)
    await prisma.$executeRawUnsafe(migrationSql)

    const read = (id: string) => prisma.computer.findUniqueOrThrow({ where: { id } })
    expect(await read(selected)).toMatchObject({ agentAccess: 'selected', accessAgentIds: [granted] })
    expect(await read(empty)).toMatchObject({ agentAccess: 'none', accessAgentIds: [] })
    expect(await read(perAgent)).toMatchObject({ agentAccess: 'selected', accessAgentIds: [managed] })
    for (const id of [selected, empty, perAgent]) expect((await read(id)).policy).not.toHaveProperty('allowedAgents')

    const overrides = async (id: string) => (await prisma.agent.findUniqueOrThrow({ where: { id } })).runtimeOverrides
    expect(await overrides(granted)).toEqual({})
    expect(await overrides(managed)).toEqual({ model: 'opus', computerUse: { managed: { mode: 'per-agent' } } })
    expect(await overrides(switchedOff)).toEqual({})
    expect(await overrides(untouched)).toEqual({ model: 'sonnet' })

    // A converted agent's revision moved in the first run only; an untouched one stays.
    const after = await revisions()
    expect(after[granted]).toBe(before[granted]! + 2n)
    expect(after[managed]).toBe(before[managed]! + 1n)
    expect(after[switchedOff]).toBe(before[switchedOff]! + 1n)
    expect(after[untouched]).toBe(before[untouched])
  })
})
