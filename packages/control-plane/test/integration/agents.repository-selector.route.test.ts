// The agent's repository selector evaluator (multi-repository-workspaces.md decision 15) over the REST surface and real Postgres.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { REPOSITORY_SELECTOR_UNSUPPORTED } from '../../src/agents/repository-selector.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-ddddddddd0a1'
const SELECTOR = { providerId: 'typesafe', model: 'jev-latest' }

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records the spec pushes the routes make. */
class SpyControl {
  readonly upserts: AgentUpsert[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async agentRemove(): Promise<void> {}
  async collaborationRoutes(): Promise<void> {}
}

function withSpy(): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  return { app, spy }
}

async function columns(agentId: string) {
  return prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { repositorySelectorProviderId: true, repositorySelectorModel: true, configRevision: true }
  })
}

describe('agent repository selector', () => {
  it('is stored on create, read back, and refused when it cannot answer Choice', async () => {
    const { app } = withSpy()
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'selector-bot', runtime: 'claude', repositorySelector: SELECTOR }
    })
    expect(created.statusCode).toBe(201)
    const { id } = created.json() as { id: string }
    expect(created.json()).toMatchObject({ repositorySelector: SELECTOR })
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${id}` })).json()).toMatchObject({
      repositorySelector: SELECTOR
    })
    expect(await columns(id)).toMatchObject({
      repositorySelectorProviderId: 'typesafe',
      repositorySelectorModel: 'jev-latest'
    })

    const plain = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'plain-bot', runtime: 'claude' }
    })
    expect(plain.json()).toMatchObject({ repositorySelector: null })

    const refused = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'refused-bot', runtime: 'claude', repositorySelector: { providerId: 'example', model: 'x' } }
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toMatchObject({ message: REPOSITORY_SELECTOR_UNSUPPORTED })
    expect(await prisma.agent.count({ where: { name: 'refused-bot' } })).toBe(0)
  })

  it('is set, refused, and cleared by PATCH, advancing the revision and replicating each change', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()
    const patch = (payload: Record<string, unknown>) =>
      app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload })
    const before = (await columns(agentId)).configRevision

    const set = await patch({ repositorySelector: SELECTOR })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ repositorySelector: SELECTOR })
    expect((await columns(agentId)).configRevision).toBe(before + 1n)
    expect(spy.upserts.at(-1)?.spec).toMatchObject({ repositorySelector: SELECTOR, configRevision: `${before + 1n}` })

    const unknownModel = await patch({ repositorySelector: { providerId: 'typesafe', model: 'example-model' } })
    expect(unknownModel.statusCode).toBe(400)
    expect(unknownModel.json()).toMatchObject({ message: REPOSITORY_SELECTOR_UNSUPPORTED })
    expect(await columns(agentId)).toMatchObject({ repositorySelectorModel: 'jev-latest', configRevision: before + 1n })
    expect(spy.upserts).toHaveLength(1)

    // An edit that leaves the selector out keeps it.
    expect((await patch({ description: 'Reviews pull requests.' })).json()).toMatchObject({
      repositorySelector: SELECTOR
    })

    const cleared = await patch({ repositorySelector: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ repositorySelector: null })
    expect(await columns(agentId)).toEqual({
      repositorySelectorProviderId: null,
      repositorySelectorModel: null,
      configRevision: before + 3n
    })
    expect(spy.upserts.at(-1)?.spec).toHaveProperty('repositorySelector', null)
  })

  it('keeps the pair whole in the database', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    await expect(
      prisma.agent.update({ where: { id: agentId }, data: { repositorySelectorProviderId: 'typesafe' } })
    ).rejects.toThrow()
  })
})
