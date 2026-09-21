// A group agent's holder on the agent DTO: a group has no shared store, so the console resumes only a session its holder recorded.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { poolSetId } from '../fakes/member-set.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** One of the org's own groups, with two self-hosted members. */
async function seedGroup(): Promise<string> {
  await seedDaemon(prisma, MEMBER_A)
  await seedDaemon(prisma, MEMBER_B)
  const setId = randomUUID()
  await prisma.memberSet.create({ data: { id: setId, orgId: DEFAULT_ORG_ID, name: 'lab' } })
  await prisma.memberSetMember.createMany({ data: [MEMBER_A, MEMBER_B].map((daemonId) => ({ setId, daemonId })) })
  return setId
}

describe('GET /agents — a group agent names the member holding it', () => {
  it('reports the confirmed holder on a list and a single read, and null while no hold is confirmed', async () => {
    const setId = await seedGroup()
    const held = randomUUID()
    const installing = randomUUID()
    const pinned = randomUUID()
    const pooled = randomUUID()
    await seedAgent(prisma, held, { setId })
    await seedAgent(prisma, installing, { setId })
    await seedAgent(prisma, pinned, { daemonId: MEMBER_A })
    await seedAgent(prisma, pooled, { setId: await poolSetId(prisma) })
    await seedDutyGroup(prisma, randomUUID(), MEMBER_B, [held], { confirmed: true })
    // A grant the member has not reported installing is a lease, not a route.
    await seedDutyGroup(prisma, randomUUID(), MEMBER_A, [installing])
    running = buildHttpApp(prisma)

    const list = await running.app.inject({ method: 'GET', url: `${ORG}/agents` })
    expect(list.statusCode, list.body).toBe(200)
    const byId = new Map((list.json() as Array<{ id: string; holderDaemonId?: string | null }>).map((a) => [a.id, a]))
    expect(byId.get(held)?.holderDaemonId).toBe(MEMBER_B)
    expect(byId.get(installing)?.holderDaemonId).toBeNull()
    // A machine placement names its daemon, and the pool's content is shared: neither carries a holder.
    expect(byId.get(pinned)).not.toHaveProperty('holderDaemonId')
    expect(byId.get(pooled)).not.toHaveProperty('holderDaemonId')

    const one = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${held}` })
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json()).toMatchObject({ holderDaemonId: MEMBER_B })
    const pool = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${pooled}` })
    expect(pool.json()).not.toHaveProperty('holderDaemonId')
  })
})
